import { matchFlowToRoads } from '../../data/flowMatch.js';
import {
  TRAFFIC_TIMING_ENABLED,
  FLOW_RENDER_RACE_MS,
  FLOW_STATUS_RETRY_MS,
  FLOW_STATUS_REFRESH_MS,
} from './policy.js';

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
   * The proxy's structured failures (flowSource.js `tileError`: `code` +
   * `provider.error`) name the real cause — a rejected key, a rate limit, an
   * unreachable upstream — and a bare HTTP code is the legacy fallback.
   *
   * @param {Error|{name?:string, message?:string, code?:string, status?:number, provider?:{error?:string|null}}|null|undefined} error - Rejection from the flow fetch.
   * @returns {string|null} Short reason, or null for an aborted (superseded) fetch.
   */

  function deriveTrafficFlowError(error) {
    if (!error || error.name === 'AbortError') return null;
    const message = String(error.message || error);
    const status = Number.isFinite(error.status)
      ? error.status
      : Number(message.match(/HTTP (\d{3})/)?.[1]);
    const providerError =
      typeof error.provider?.error === 'string' && error.provider.error.trim()
        ? error.provider.error.trim()
        : null;
    switch (error.code) {
      case 'bad_key':
        return 'TomTom rejected TOMTOM_API_KEY';
      case 'no_key':
        return 'TomTom key unavailable';
      case 'budget':
        return 'TomTom daily budget reached';
      case 'rate_limited':
        return providerError || 'TomTom rate limited';
      case 'upstream':
        return providerError || 'TomTom upstream unreachable';
      default:
        break;
    }
    if (status === 503) return providerError || 'TomTom key unavailable';
    if (status === 429) return 'TomTom daily budget reached';
    if (status === 502 || status === 504) return 'TomTom upstream unreachable';
    if (Number.isFinite(status)) return `TomTom flow error (HTTP ${status})`;
    return 'TomTom flow unavailable';
  }

  /** Camera position as a {lat, lon} scene point (degrees), or null when unknown. */
  function scenePoint() {
    const carto = layerState._viewer?.camera?.positionCartographic;
    if (!carto) return null;
    const lat = (carto.latitude * 180) / Math.PI;
    const lon = (carto.longitude * 180) / Math.PI;
    return Number.isFinite(lat) &&
      Number.isFinite(lon) &&
      Math.abs(lat) <= 90 &&
      Math.abs(lon) <= 180
      ? { lat, lon }
      : null;
  }

  /** Record one status answer: mode, provider status, probe sample, budgets. */
  function adoptStatus(status) {
    const wasLive = layerState._liveMode;
    layerState._liveMode = Boolean(status?.hasKey);
    layerState._flowStatusUnavailable = false;
    layerState._flowStatusResolved = true;
    layerState._flowStatusAt = Date.now();
    layerState._flowProvider = status?.providerStatus || null;
    layerState._flowSegment =
      status?.flowSegment && typeof status.flowSegment === 'object'
        ? status.flowSegment
        : null;
    layerState._flowBudget = {
      date: typeof status?.date === 'string' ? status.date : null,
      tiles: {
        count: Number(status?.dailyCount) || 0,
        budget: Number(status?.budget) || 0,
      },
      requests: {
        count: Number(status?.requestCount) || 0,
        budget: Number(status?.requestBudget) || 0,
      },
    };
    // A keyed proxy that already knows the feed is unhealthy (rejected key,
    // rate limit, unreachable upstream) says so before any tile is fetched;
    // the first successful tile fetch clears this.
    layerState._flowProbeError =
      layerState._liveMode && layerState._flowProvider?.status === 'degraded'
        ? layerState._flowProvider.error ||
          layerState._flowSegment?.error ||
          'TomTom flow probe failed'
        : null;
    if (layerState._liveMode && !wasLive) {
      console.log('[Data:Traffic] TomTom key present — live flow mode');
      registerDynamicCredit(layerState._viewer, TOMTOM_CREDIT);
    }
  }

  /**
   * Check `/api/tomtom/status` once per session and cache the result.
   * Live mode iff the server holds a TomTom key; the TomTom attribution credit
   * registers the first time live mode activates. Keyless or unreachable →
   * simulation mode. The probe carries the scene point so a keyed proxy can
   * sample live speed there (`stats.flowSegment`).
   *
   * Pacing: a FAILED probe is retried on the next call once
   * FLOW_STATUS_RETRY_MS has passed (a transient outage must not pin the
   * session to "status unreachable"); a LIVE session refreshes the sample in
   * the background at most every FLOW_STATUS_REFRESH_MS, and only from calls
   * that already exist (enable + camera-driven loads), so an idle client never
   * spends TomTom's request budget. Keyless sessions never re-ask.
   *
   * @returns {Promise<void>} Resolves when `_liveMode` is settled.
   */

  function ensureFlowStatus() {
    const now = Date.now();
    if (
      layerState._flowStatusPromise &&
      layerState._flowStatusUnavailable &&
      now - layerState._flowStatusAt >= FLOW_STATUS_RETRY_MS
    ) {
      layerState._flowStatusPromise = null;
    }
    if (!layerState._flowStatusPromise) {
      layerState._flowStatusPromise = source
        .getStatus({ point: scenePoint() })
        .then(adoptStatus)
        .catch((e) => {
          // Simulating because we could not ask, which is NOT the same as
          // "server says no key" — getStats() distinguishes the two.
          layerState._liveMode = false;
          layerState._flowStatusUnavailable = true;
          layerState._flowStatusResolved = true;
          layerState._flowStatusAt = Date.now();
          layerState._flowProvider = null;
          layerState._flowSegment = null;
          layerState._flowProbeError = null;
          console.warn(
            '[Data:Traffic] TomTom status unreachable — simulated traffic:',
            e?.message || e,
          );
        });
    } else if (
      layerState._liveMode &&
      layerState._enabled &&
      !layerState._flowStatusRefreshing &&
      now - layerState._flowStatusAt >= FLOW_STATUS_REFRESH_MS
    ) {
      // Background refresh: the settled promise stays in place so loads never
      // wait on it; only the sample/budget/probe fields move.
      layerState._flowStatusRefreshing = true;
      source
        .getStatus({ point: scenePoint() })
        .then((status) => {
          if (layerState._liveMode) adoptStatus(status);
        })
        .catch(() => {
          // Keep the last good answer; pace the next attempt like a success.
          layerState._flowStatusAt = Date.now();
        })
        .finally(() => {
          layerState._flowStatusRefreshing = false;
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
        // Real tiles arrived: whatever the status probe feared is moot.
        layerState._flowProbeError = null;
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
