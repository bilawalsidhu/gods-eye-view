import { matchFlowToRoads } from '../../data/flowMatch.js';
import { TRAFFIC_TIMING_ENABLED, FLOW_RENDER_RACE_MS } from './policy.js';

export function createFlow({ state: layerState, services, parts, source }) {
  const { registerDynamicCredit, TOMTOM_CREDIT } = services.credits;
  const { fetchFlowForBounds } = source;

  // ─── Live Flow (TomTom) ────────────────────────────────────

  /**
   * Map a failed flow fetch onto one short, honest user-facing reason.
   *
   * `fetchFlowForBounds` only rejects when EVERY covering tile failed, so a
   * non-null result here always means "there is no live flow to show right
   * now" — the dots fall back to simulated white. Mirrors the
   * `deriveAisFeedError` honesty helper.
   *
   * @param {Error|{name?:string, message?:string}|null|undefined} error - Rejection from the flow fetch.
   * @returns {string|null} Short reason, or null for an aborted (superseded) fetch.
   */

  function deriveTrafficFlowError(error) {
    if (!error || error.name === 'AbortError') return null;
    const message = String(error.message || error);
    const status = Number(message.match(/HTTP (\d{3})/)?.[1]);
    if (status === 503) return 'TomTom key unavailable';
    if (status === 429) return 'TomTom daily budget reached';
    if (status === 502 || status === 504) return 'TomTom upstream unreachable';
    if (Number.isFinite(status)) return `TomTom flow error (HTTP ${status})`;
    return 'TomTom flow unavailable';
  }

  /**
   * Check `/api/tomtom/status` once per session and cache the result.
   * Live mode iff the server holds a TomTom key; the TomTom attribution credit
   * registers the first time live mode activates. Keyless or unreachable →
   * simulation mode, exactly today's behavior.
   *
   * @returns {Promise<void>} Resolves when `_liveMode` is settled.
   */

  function ensureFlowStatus() {
    if (!layerState._flowStatusPromise) {
      layerState._flowStatusPromise = source
        .getStatus()
        .then((status) => {
          layerState._liveMode = Boolean(status?.hasKey);
          layerState._flowStatusUnavailable = false;
          if (layerState._liveMode) {
            console.log('[Data:Traffic] TomTom key present — live flow mode');
            registerDynamicCredit(layerState._viewer, TOMTOM_CREDIT);
          }
        })
        .catch((e) => {
          // Simulating because we could not ask, which is NOT the same as
          // "server says no key" — getStats() distinguishes the two.
          layerState._liveMode = false;
          layerState._flowStatusUnavailable = true;
          console.warn(
            '[Data:Traffic] TomTom status unreachable — simulated traffic:',
            e?.message || e,
          );
        });
    }
    return layerState._flowStatusPromise;
  }

  /**
   * Live mode only: fetch TomTom flow for the clamped bounds, match it onto the
   * parsed roads, and attach `road.flow` (`{level, closure}` or null).
   *
   * Reuses the load-generation guard: stale flow responses are discarded, and
   * the shared AbortController lets `cancelActiveFetch()` (next load / disable)
   * cancel an in-flight flow fetch. Any failure leaves roads unmatched — the
   * dots then render in today's simulated white, never a phantom color — and is
   * recorded in `_flowError` so `getStats()` degrades honestly instead of
   * reporting a stale "LIVE · N% cov" over simulated dots.
   *
   * @param {Array} roads - Parsed road objects (mutated: `road.flow`).
   * @param {{south:number,west:number,north:number,east:number}} clamped - Fetch bounds.
   * @param {number} generation - `_loadGeneration` at call time.
   * @returns {Promise<void>}
   */

  async function applyFlowToRoads(roads, clamped, generation) {
    // Claim the work synchronously, before the first await, so `stats.loading`
    // covers this request from the same tick the caller started it — the
    // loading batch must not be able to close underneath an in-flight fetch.
    layerState._flowPending += 1;
    try {
      if (!layerState._flowStatusPromise) return; // status check not started — sim mode
      await layerState._flowStatusPromise;
      if (!layerState._liveMode || !layerState._enabled) return;
      if (generation !== layerState._loadGeneration) return;
      if (!Array.isArray(roads) || roads.length === 0) return;
      try {
        // Cached paths reach here without a live controller; the fetch paths
        // reuse theirs so one cancel covers both roads and flow.
        if (!layerState._activeFetchAbort)
          layerState._activeFetchAbort = new AbortController();
        const segments = await fetchFlowForBounds(clamped, {
          signal: layerState._activeFetchAbort.signal,
        });
        if (generation !== layerState._loadGeneration) return;
        const { matches, matchedCount, candidateCount } = matchFlowToRoads(
          roads,
          segments,
        );
        for (let i = 0; i < roads.length; i++) {
          roads[i].flow = matches[i];
        }
        layerState._flowCoveragePct =
          candidateCount > 0
            ? Math.round((matchedCount / candidateCount) * 100)
            : 0;
        layerState._flowError = null;
      } catch (e) {
        if (e?.name === 'AbortError') return;
        // Same guard the success path gets: a superseded request rejecting late
        // (or after disable() cleared the state) must not restore a stale
        // outage over newer good data.
        if (generation !== layerState._loadGeneration || !layerState._enabled)
          return;
        // Every covering tile failed: there is no live flow on screen. Drop the
        // now-false coverage number and surface the reason through getStats().
        layerState._flowError = deriveTrafficFlowError(e);
        layerState._flowCoveragePct = 0;
        console.warn(
          '[Data:Traffic] Flow fetch failed (sim colors remain):',
          e?.message || e,
        );
      }
    } finally {
      if (generation === layerState._loadGeneration)
        layerState._flowPending -= 1;
    }
  }

  /**
   * Race flow application against the paint deadline, render, and schedule an
   * in-place recolor if flow lost the race.
   * @param {Array} roads - Parsed road objects.
   * @param {{south:number,west:number,north:number,east:number}} clamped - Fetch bounds.
   * @param {number} generation - `_loadGeneration` at call time.
   * @param {number} altitude - Camera altitude in meters.
   * @param {string} label - Render log label.
   * @param {Object|null} [trace=null] - Development-only correlated load trace.
   * @returns {Promise<boolean>} True if this generation rendered.
   */

  async function applyFlowThenRender(
    roads,
    clamped,
    generation,
    altitude,
    label,
    trace = null,
  ) {
    const state =
      TRAFFIC_TIMING_ENABLED && trace
        ? parts.timing.trafficTimingRenderState(trace, label)
        : null;
    const flowRaceStart = state
      ? parts.timing.trafficTimingMark(state, 'flow-render-race-start', {
          deadlineMs: FLOW_RENDER_RACE_MS,
        })
      : null;
    const flowJob = applyFlowToRoads(roads, clamped, generation);
    const outcome = await Promise.race([
      flowJob.then(() => 'flow'),
      new Promise((resolve) =>
        setTimeout(() => resolve('timeout'), FLOW_RENDER_RACE_MS),
      ),
    ]);
    if (state) {
      const flowRaceEnd = parts.timing.trafficTimingMark(
        state,
        'flow-render-race-end',
        {
          deadlineMs: FLOW_RENDER_RACE_MS,
          outcome,
        },
      );
      parts.timing.trafficTimingMeasure(
        'flow-render-race',
        state,
        flowRaceStart,
        flowRaceEnd,
        {
          deadlineMs: FLOW_RENDER_RACE_MS,
          outcome,
        },
      );
    }
    if (generation !== layerState._loadGeneration) return false;
    parts.rendering.renderRoadsForAltitude(roads, altitude, label, trace);
    if (outcome === 'timeout') {
      flowJob
        .then(() => {
          if (generation !== layerState._loadGeneration) return;
          parts.model.recolorDotsInPlace(label);
        })
        .catch(() => {
          /* applyFlowToRoads settles its own failures */
        });
    }
    return true;
  }
  return {
    deriveTrafficFlowError,
    ensureFlowStatus,
    applyFlowToRoads,
    applyFlowThenRender,
  };
}
