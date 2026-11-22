import { msg } from '../i18n/index.js';

/** The layers that get a count tile, in this order: feeds not billed per request. */
export const COUNT_TILE_LAYERS = Object.freeze([
  { id: 'flights', label: msg('Flights'), icon: 'flight' },
  { id: 'satellites', label: msg('Satellites'), icon: 'satellite_alt' },
  { id: 'cctv', label: msg('Cameras'), icon: 'videocam' },
  { id: 'ais-live-vessels', label: msg('Vessels'), icon: 'directions_boat' },
  { id: 'local-firms', label: msg('Fires'), icon: 'local_fire_department' },
]);
const TILE_IDS = new Set(COUNT_TILE_LAYERS.map((layer) => layer.id));

/** Minimum time between attempts on entry to the nothing-on view. */
export const LAYER_COUNTS_REFETCH_MS = 30 * 60_000;

function keep(counts, layerId, count, at, live) {
  if (!TILE_IDS.has(layerId) || !Number.isFinite(count) || count <= 0)
    return counts;
  at = Number.isFinite(at) ? at : null;
  const known = counts[layerId];
  if (known && known.at === at && known.count === count && known.live === live)
    return counts;
  // Unknown age cannot replace a known time. A newer count keeps its source.
  if (Number.isFinite(known?.at) && (at === null || known.at > at))
    return counts;
  if (known?.at === at && known.live && !live) return counts;
  return { ...counts, [layerId]: { count, at, live } };
}

/** Own one Inspector's request lifetime and publish counts to its app snapshot. */
export function createLayerCounts({
  getCounts,
  readState,
  writeState,
  readShown,
  now = Date.now,
}) {
  let shown = false;
  let eligible = false;
  let active = null;
  let stopped = false;

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
    let body;
    try {
      body = await getCounts({
        signal: attempt.controller.signal,
        onTimeout() {
          // The deadline takes effect before a later hide can cancel it.
          if (active === attempt) active = null;
        },
      });
    } catch {
      // Failure and timeout keep the attempt's cooldown and saved counts.
    }
    if (active !== attempt) return;
    if (!readShown()) {
      shown = false;
      eligible = false;
      cancel();
      return;
    }
    active = null;
    if (!Array.isArray(body?.counts)) return;
    const state = readState();
    let counts = state.counts;
    for (const row of body.counts) {
      const at = row?.at == null ? null : Number(row.at);
      counts = keep(counts, row?.layerId, Number(row?.count), at, false);
    }
    if (counts !== state.counts) writeState({ ...state, counts });
  }

  return {
    update(snapshot) {
      if (stopped) return;
      const wasEligible = eligible;
      shown = snapshot.shown;
      eligible = shown && snapshot.nothingOn;
      if (!shown) cancel();
      if (!eligible || wasEligible || active) return;
      const state = readState();
      const startedAt = now();
      if (
        state.lastAttemptAt !== null &&
        startedAt - state.lastAttemptAt < LAYER_COUNTS_REFETCH_MS
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
    note(rows) {
      if (stopped || !shown || !readShown()) return;
      const state = readState();
      let counts = state.counts;
      for (const { id, tone, worldTotal, updatedAt } of rows) {
        if (tone === 'nominal' && updatedAt && Number.isFinite(updatedAt))
          counts = keep(counts, id, Number(worldTotal), updatedAt, true);
      }
      if (counts !== state.counts) writeState({ ...state, counts });
    },
    stop() {
      stopped = true;
      cancel();
    },
  };
}
