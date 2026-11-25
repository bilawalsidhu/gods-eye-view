import { msg } from '../i18n/index.js';

/** The layers that get a count tile, in this order: feeds not billed per request. */
export const COUNT_TILE_LAYERS = Object.freeze([
  { id: 'flights', label: msg('Flights'), icon: 'flight' },
  { id: 'satellites', label: msg('Satellites'), icon: 'satellite_alt' },
  { id: 'cctv', label: msg('Cameras'), icon: 'videocam' },
  { id: 'ais-live-vessels', label: msg('Vessels'), icon: 'directions_boat' },
  {
    id: 'local-firms',
    label: msg('Fire detections'),
    hint: msg('last 24 h'),
    icon: 'local_fire_department',
  },
]);
const TILE_IDS = new Set(COUNT_TILE_LAYERS.map((layer) => layer.id));

/** Minimum time between attempts on entry to the nothing-on view. */
export const LAYER_COUNTS_REFETCH_MS = 30 * 60_000;

function setCount(counts, layerId, row) {
  const known = counts[layerId];
  if (known === row || (known?.at === row?.at && known?.count === row?.count))
    return counts;
  const next = { ...counts };
  if (row) next[layerId] = row;
  else delete next[layerId];
  return next;
}

/** Own an Inspector's count request: one per entry to the nothing-on view, cancelled when the Inspector hides. */
export function createLayerCounts({
  getCounts,
  readState,
  writeState,
  readShown,
  now = Date.now,
}) {
  let eligible = false;
  let active = null;
  let stopped = false;
  function ownsVisibleAttempt(attempt) {
    if (active !== attempt) return false;
    if (readShown()) return true;
    eligible = false;
    cancel();
    return false;
  }

  function cancel() {
    if (!active) return;
    const { controller, previousAttemptAt, startedAt } = active;
    active = null;
    const state = readState();
    if (state.lastAttemptAt === startedAt)
      writeState({ ...state, lastAttemptAt: previousAttemptAt });
    controller.abort();
  }

  async function ask(attempt) {
    if (!ownsVisibleAttempt(attempt)) return;
    let body;
    try {
      body = await getCounts({ signal: attempt.controller.signal });
    } catch {
      // Keep the last successful counts on a failed read.
    }
    if (!ownsVisibleAttempt(attempt)) return;
    active = null;
    const state = readState();
    if (!Array.isArray(body?.counts)) return;
    // Translate server observations to the display clock on receipt.
    const clockOffsetMs = Number.isFinite(body.now) ? now() - body.now : 0;
    let complete = true;
    const reported = {};
    for (const row of body.counts) {
      const layerId = row?.layerId;
      const count = row?.count == null ? NaN : Number(row.count);
      if (
        typeof layerId !== 'string' ||
        !layerId ||
        !Number.isFinite(count) ||
        count < 0
      ) {
        complete = false;
        continue;
      }
      if (!TILE_IDS.has(layerId) || count === 0) continue;
      const stamp = row.at == null ? null : Number(row.at);
      const at = Number.isFinite(stamp) ? stamp : null;
      reported[layerId] = {
        count,
        at: at === null ? null : at + clockOffsetMs,
      };
    }
    let counts = state.counts;
    // A complete response replaces every tile. A malformed row means only
    // named layers are updated. An undated count never replaces a dated one.
    for (const layerId of TILE_IDS) {
      const row = reported[layerId];
      if (!row && !complete) continue;
      if (row?.at === null && Number.isFinite(counts[layerId]?.at)) continue;
      counts = setCount(counts, layerId, row);
    }
    if (counts !== state.counts) writeState({ ...state, counts });
  }

  return {
    update({ shown, nothingOn }) {
      if (stopped) return;
      const wasEligible = eligible;
      eligible = shown && nothingOn;
      if (!shown) return cancel();
      if (!eligible || wasEligible || active) return;
      const state = readState();
      const startedAt = now();
      if (
        state.lastAttemptAt !== null &&
        startedAt < state.lastAttemptAt + LAYER_COUNTS_REFETCH_MS
      )
        return;
      const attempt = {
        controller: new AbortController(),
        previousAttemptAt: state.lastAttemptAt,
        startedAt,
      };
      active = attempt;
      writeState({ ...state, lastAttemptAt: startedAt });
      if (active === attempt) return ask(attempt);
    },
    stop() {
      stopped = true;
      cancel();
    },
  };
}
