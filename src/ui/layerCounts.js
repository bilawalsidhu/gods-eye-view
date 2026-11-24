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

/** Age a count on the clock that produced its observation timestamp. */
export function countAgeMs(known, now) {
  if (!Number.isFinite(known.at)) return null;
  return Math.max(0, now - (known.at + (known.clockOffsetMs ?? 0)));
}

function setCount(counts, layerId, row) {
  const known = counts[layerId];
  if (
    known === row ||
    (known?.at === row?.at &&
      known?.count === row?.count &&
      known?.clockOffsetMs === row?.clockOffsetMs)
  )
    return counts;
  const next = { ...counts };
  if (row) next[layerId] = row;
  else delete next[layerId];
  return next;
}

/** Own an Inspector's cached count request and its visibility fence. */
export function createLayerCounts({
  getCounts,
  readState,
  writeState,
  readSourceBinding,
  bindSource,
  readShown,
  now = Date.now,
}) {
  let eligible = false;
  let active = null;
  let stopped = false;
  let sourceBinding;
  let updateVersion = 0;

  function refreshSourceBinding() {
    const binding = readSourceBinding?.();
    if (binding === sourceBinding) return;
    sourceBinding = binding;
    const previous = active;
    active = null;
    eligible = false;
    bindSource?.(binding);
    previous?.controller.abort();
  }
  refreshSourceBinding();

  function ownsVisibleAttempt(attempt) {
    if (active !== attempt) return false;
    refreshSourceBinding();
    if (active !== attempt) return false;
    if (readShown()) return true;
    eligible = false;
    cancel();
    return false;
  }

  function cancel() {
    if (!active) return;
    const { controller, previousAttemptAt, previousRetryAt, startedAt } =
      active;
    active = null;
    if (sourceBinding === readSourceBinding?.()) {
      const state = readState();
      if (state.lastAttemptAt === startedAt)
        writeState({
          ...state,
          lastAttemptAt: previousAttemptAt,
          ...(previousRetryAt != null && { retryAt: previousRetryAt }),
        });
    }
    controller.abort();
  }

  async function ask(attempt) {
    if (!ownsVisibleAttempt(attempt)) return;
    let body;
    let retryAfterMs;
    try {
      body = await getCounts({
        signal: attempt.controller.signal,
        onTimeout() {
          // A later hide cannot roll back the cooldown of a timed-out attempt.
          if (active === attempt) active = null;
        },
      });
    } catch (error) {
      retryAfterMs = error?.retryAfterMs;
    }
    if (!ownsVisibleAttempt(attempt)) return;
    active = null;
    const state = readState();
    if (Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
      const retryAt = now() + retryAfterMs;
      if (Number.isFinite(retryAt)) writeState({ ...state, retryAt });
      return;
    }
    if (!Array.isArray(body?.counts)) return;
    // Keep the server observation timestamp separate from its display clock offset.
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
      const earlier = reported[layerId];
      if (Number.isFinite(earlier?.at) && (at === null || earlier.at > at))
        continue;
      reported[layerId] = {
        count,
        at,
        ...(at !== null &&
          Number.isFinite(clockOffsetMs) &&
          clockOffsetMs !== 0 && { clockOffsetMs }),
      };
    }
    let counts = state.counts;
    for (const layerId of TILE_IDS) {
      const row = reported[layerId];
      if (!row && !complete) continue;
      // A successful snapshot may add older observations. An undated row
      // still doesn't replace one with a known observation time.
      if (row?.at === null && Number.isFinite(counts[layerId]?.at)) continue;
      counts = setCount(counts, layerId, row);
    }
    if (counts !== state.counts) writeState({ ...state, counts });
  }

  return {
    update({ shown, nothingOn }) {
      if (stopped) return;
      const version = ++updateVersion;
      refreshSourceBinding();
      // An abort listener can synchronously deliver a newer Inspector sample.
      if (stopped || version !== updateVersion) return;
      const wasEligible = eligible;
      eligible = shown && nothingOn;
      if (!shown) return cancel();
      if (!eligible || wasEligible || active) return;
      const { retryAt, ...state } = readState();
      const startedAt = now();
      const eligibleAt =
        retryAt ??
        (state.lastAttemptAt === null
          ? -Infinity
          : state.lastAttemptAt + LAYER_COUNTS_REFETCH_MS);
      if (startedAt < eligibleAt) return;
      const attempt = {
        controller: new AbortController(),
        previousAttemptAt: state.lastAttemptAt,
        previousRetryAt: retryAt,
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
