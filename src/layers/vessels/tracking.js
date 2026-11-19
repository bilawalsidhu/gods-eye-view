import { fromDegrees } from '../../geo/ellipsoid.js';
import { distance } from '../../geo/vector.js';
import { findFrame } from '../../render/rendererOf.js';
import {
  TRAIL_HEIGHT_M,
  TRAIL_COLOR,
  TRAIL_HEAD_MAX_M,
  TRAIL_MAX_POINTS,
  TRAIL_MIN_MOVE_M,
  followsClock,
} from './policy.js';

/** A vessel record's own fix time, epoch ms (NaN when it gives none). */
function recordFixMs(record) {
  const epoch = record?.lastPositionEpoch;
  if (Number.isFinite(epoch)) return epoch * 1000;
  return Number.isFinite(record?.receivedAtMs) ? record.receivedAtMs : NaN;
}

export function createTracking({
  vesselState,
  services,
  parts: components,
  layer,
  options,
}) {
  const { state } = vesselState;
  const { geoidHeight } = services.geoid;
  const { createTrail } = services.trails;
  const { governorRequestRender } = services.render;

  /**
   * Geoid undulation N at (lat, lon), or null until the grid has loaded.
   * @param {number} lat
   * @param {number} lon
   * @returns {number|null}
   */

  function currentGeoidN(lat, lon) {
    return vesselState._geoidReady ? geoidHeight(lat, lon) : null;
  }

  /**
   * Build a slightly lifted trail vertex for a vessel record — raised
   * TRAIL_HEIGHT_M above the sea surface (geoid, same datum as the anchor)
   * to avoid z-fighting.
   * @param {Object} record - Vessel record with lat/lon.
   * @returns {{x: number, y: number, z: number}|null} Lifted ECEF position, or null without a fix.
   */

  function vesselTrailPosition(record) {
    if (!Number.isFinite(record?.lat) || !Number.isFinite(record?.lon))
      return null;
    const heightM = components.queries.vesselDatumHeightM(
      currentGeoidN(record.lat, record.lon),
      TRAIL_HEIGHT_M,
    );
    return fromDegrees(record.lon, record.lat, heightM);
  }

  /**
   * One-shot datum re-lift when the geoid grid warms mid-session: the first
   * refresh can land before ensureGeoidReady() resolves (anchors at N = 0) and
   * the next refresh is up to REFRESH_MS out — re-derive every record's
   * position in place so chevrons/labels snap to the sea surface as soon as N
   * is known. (A selected-vessel trail cannot exist that early — selection
   * needs a rendered pick — so trail vertices are not revisited.)
   */

  function refloorVesselRecords() {
    if (!state.records.all.length) return;
    for (const record of state.records.all) {
      const visual = components.rendering.getVisual(record);
      if (!Number.isFinite(record.lat) || !Number.isFinite(record.lon))
        continue;
      visual.position = components.rendering.anchorPosition(record);
      components.rendering.syncRecordIcon(record);
      // A moving vessel is drawn again where it is on the next pass.
      visual.drawnLat = NaN;
      visual.drawnLon = NaN;
      visual.followedAtMs = undefined;
      visual.drawnAtMs = Number.NaN;
    }
    components.rendering.forgetClockStep();
    // The rows moved with no poll behind them: draw the frame that shows it.
    governorRequestRender('ais-vessels-refloor');
  }

  /**
   * Start (or restart) the selected vessel's trail: seed with the current
   * position, render, then fire-and-forget the server ring-buffer backfill.
   * @param {Object} record - Freshly selected vessel record.
   */

  function startSelectedVesselTrail(record) {
    state.trailAbort?.abort();
    state.trailAbort = new AbortController();
    state.trailBackfillToken += 1;
    state.trailId = record.id;
    state.trailPositions = [];
    state.trailTimes = [];
    const current = vesselTrailPosition(record);
    if (current) {
      state.trailPositions.push(current);
      state.trailTimes.push(recordFixMs(record));
    }
    if (!state.trail && state.viewer) {
      state.trail = createTrail(state.viewer, {
        color: TRAIL_COLOR,
        width: 2.5,
      });
    }
    if (!state.trailHeadOff && state.viewer)
      state.trailHeadOff =
        findFrame(state.viewer)?.on('preRender', drawSelectedVesselTrail) ??
        null;
    drawTrailBody();
    backfillVesselTrail(record.id, state.trailBackfillToken, record.reference);
  }

  /**
   * The world clock moved to another time: the trail keeps what it holds,
   * drawn up to the new time, until the vessel's track at that time
   * replaces it. Clearing it would blank the trail at every step of the clock.
   * @param {Object} record - The selected vessel at the new time.
   */
  function retimeSelectedVesselTrail(record) {
    if (state.trailId !== record.id || !state.trail) {
      startSelectedVesselTrail(record);
      return;
    }
    state.trailAbort?.abort();
    state.trailAbort = new AbortController();
    state.trailBackfillToken += 1;
    drawSelectedVesselTrail();
    backfillVesselTrail(record.id, state.trailBackfillToken, record.reference, {
      replace: true,
    });
  }

  /** The world time the selected vessel is drawn at; Infinity live, where
   *  every fix is behind it. */
  function drawnTimeMs() {
    return followsClock(vesselState) ? vesselState.worldNow() : Infinity;
  }

  /** How many trail vertices are at or before `atMs` (undated ones always). */
  function bodyCountAt(atMs) {
    let count = state.trailTimes.length;
    while (count > 0 && state.trailTimes[count - 1] > atMs) count -= 1;
    return count;
  }

  /** Draw the trail's body: its fixes up to the time the vessel is drawn at.
   *  A fix ahead of the vessel would draw the trail in front of it. */
  function drawTrailBody() {
    if (!state.trail) return;
    state.trailBodyCount = bodyCountAt(drawnTimeMs());
    state.trail.setPositions(
      state.trailPositions.slice(0, state.trailBodyCount),
    );
  }

  /** The head: the body's last vertex to where the vessel is drawn, or none
   *  (no vessel drawn, or one too far from the body to be on its path). */
  function trailHeadPositions() {
    const record = state.selectedRecord;
    if (!record || record.id !== state.trailId || state.trailBodyCount < 1)
      return null;
    // Where its icon is drawn now (the renderer's, while it moves the icons).
    const at = components.rendering.drawnPositionNow(record);
    const last = state.trailPositions[state.trailBodyCount - 1];
    if (!at || !last) return null;
    const metres = distance(last, at);
    if (metres < 1 || metres > TRAIL_HEAD_MAX_M) return null;
    return [last, { x: at.x, y: at.y, z: at.z }];
  }

  /**
   * Each frame before it draws: the body moved on when the drawn time has
   * passed a fix, then the head to where the vessel is drawn now.
   */
  function drawSelectedVesselTrail() {
    if (!state.trail || !state.trailId) return;
    if (bodyCountAt(drawnTimeMs()) !== state.trailBodyCount) drawTrailBody();
    state.trail.setHead?.(trailHeadPositions());
  }

  /**
   * Fire-and-forget backfill from the server-side per-vessel ring buffer
   * (PRD F3 — "recent path" since server boot, not voyage history). Older
   * samples are spliced AHEAD of the live accumulation, capped at
   * TRAIL_MAX_POINTS (newest kept). Any failure (404/timeout/malformed)
   * silently keeps the live-only trail.
   * @param {string} id - Key of the selected vessel.
   * @param {number} token - Backfill token captured at request time.
   * @returns {Promise<void>}
   */

  async function backfillVesselTrail(
    id,
    token,
    reference = id,
    { replace = false } = {},
  ) {
    const owner = state.trailAbort;
    // Following the world clock, the track ends at the world's time.
    const atMs = followsClock(vesselState) ? vesselState.worldNow() : undefined;
    const signal = owner
      ? AbortSignal.any([owner.signal, AbortSignal.timeout(8000)])
      : AbortSignal.timeout(8000);
    let samples = null;
    try {
      const track = await vesselState._source.getTrack?.(
        reference,
        atMs === undefined ? { signal } : { signal, atMs },
      );
      samples = track?.records ?? null;
    } catch {
      return; // silent — keep the live-accumulated trail
    }
    if (
      signal.aborted ||
      owner !== state.trailAbort ||
      !samples ||
      token !== state.trailBackfillToken
    )
      return;
    if (state.trailId !== id) return;

    const older = [];
    const olderTimes = [];
    for (const sample of samples) {
      const lat = Number(sample?.latitude);
      const lon = Number(sample?.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      // Following the clock, an undated sample may be later than the time.
      if (
        atMs !== undefined &&
        !(Number.isFinite(sample?.observedAtMs) && sample.observedAtMs <= atMs)
      )
        continue;
      // Per-sample N (≤ TRAIL_MAX_POINTS lookups) — same sea-surface datum as
      // the live vertices so the spliced trail is height-continuous.
      const heightM = components.queries.vesselDatumHeightM(
        currentGeoidN(lat, lon),
        TRAIL_HEIGHT_M,
      );
      older.push(fromDegrees(lon, lat, heightM));
      olderTimes.push(
        Number.isFinite(sample?.observedAtMs) ? sample.observedAtMs : NaN,
      );
    }
    if (replace) {
      // The track at the new time, then the vessel's own fix at it.
      const record = state.selectedRecord;
      const current = record?.id === id ? vesselTrailPosition(record) : null;
      state.trailPositions = current ? [...older, current] : older;
      state.trailTimes = current
        ? [...olderTimes, recordFixMs(record)]
        : olderTimes;
    } else {
      if (!older.length) return;
      state.trailPositions = older.concat(state.trailPositions);
      state.trailTimes = olderTimes.concat(state.trailTimes);
    }
    if (state.trailPositions.length > TRAIL_MAX_POINTS) {
      const drop = state.trailPositions.length - TRAIL_MAX_POINTS;
      state.trailPositions = state.trailPositions.slice(drop);
      state.trailTimes = state.trailTimes.slice(drop);
    }
    drawTrailBody();
  }

  /**
   * Append the selected vessel's refreshed position to its trail when it has
   * moved more than TRAIL_MIN_MOVE_M from the last trail vertex.
   * @param {Object} record - Selected vessel record after an in-place update.
   */

  function appendSelectedVesselTrailFix(record) {
    if (!state.trail) return;
    const next = vesselTrailPosition(record);
    if (!next) return;
    const last = state.trailPositions[state.trailPositions.length - 1];
    if (last && distance(last, next) <= TRAIL_MIN_MOVE_M) return;
    state.trailPositions.push(next);
    state.trailTimes.push(recordFixMs(record));
    if (state.trailPositions.length > TRAIL_MAX_POINTS) {
      state.trailPositions.shift();
      state.trailTimes.shift();
    }
    drawTrailBody();
  }

  /**
   * Clear the rendered trail and accumulation; invalidate pending backfills.
   */

  function clearSelectedVesselTrail() {
    state.trailAbort?.abort();
    state.trailAbort = null;
    state.trailBackfillToken += 1;
    state.trailId = null;
    state.trailPositions = [];
    state.trailTimes = [];
    state.trailBodyCount = -1;
    state.trailHeadOff?.();
    state.trailHeadOff = null;
    if (state.trail) state.trail.clear();
  }

  /**
   * Destroy the trail primitive entirely (layer disable/teardown).
   */

  function destroySelectedVesselTrail() {
    clearSelectedVesselTrail();
    if (state.trail) {
      state.trail.destroy();
      state.trail = null;
    }
  }
  return {
    currentGeoidN,
    vesselTrailPosition,
    refloorVesselRecords,
    startSelectedVesselTrail,
    retimeSelectedVesselTrail,
    drawSelectedVesselTrail,
    backfillVesselTrail,
    appendSelectedVesselTrailFix,
    clearSelectedVesselTrail,
    destroySelectedVesselTrail,
  };
}
