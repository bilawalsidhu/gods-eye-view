import { cameraOf, findCamera, findFrame } from '../../render/rendererOf.js';
import {
  entityFollowTarget,
  onFollowChanged,
  stopFollowing,
} from '../../data/followed.js';
import { formatNumber, t } from '../../i18n/index.js';
import { unitLabel } from '../../ui/unitLabels.js';
import { nextCockpitNearContacts } from '../../data/cockpitAirLod.js';
import {
  courseScreenRotation,
  stabilizeScreenRotation,
} from '../../data/screenRotation.js';
import {
  createTrackedAircraftIcon,
  isOtherTrackedIconSet,
  trackedContactHolder,
} from '../../data/trackedAircraftIcon.js';
import { fromDegrees, toLonLatH } from '../../geo/ellipsoid.js';
import { julianToEpochMs } from '../../geo/julian.js';
import { renderedFrames } from '../../data/renderedFrames.js';
import { clone, distanceSquared, vec } from '../../geo/vector.js';
import { trailHeadLine } from '../../data/modelVisualAnchor.js';
import { routePlausible } from '../../data/routePlausible.js';
import {
  isTrackingSelectionGesture,
  isTrackingClickGesture,
} from '../../data/trackingClickGesture.js';
import { inputFor } from '../../input/dispatcher.js';
import {
  TRAIL_MAX_POINTS,
  TRAIL_COLOR,
  CYAN_TRANSPARENT,
  TRACKED_CYAN,
  STALE_ALPHA,
  displayDelayMs,
  followsClock,
} from './policy.js';
import {
  drawTrailSegments,
  historyFixEpochMs,
  insertTrailFix,
  joinTrailBackfill,
  trailBackfillFixes,
  trailBodyCount,
  trailBodySegments,
  trailHeadCurvePoints,
  trailHeadStartFix,
} from '../../data/trailContinuity.js';
import { roundHeadingDegrees } from '../../data/headingDegrees.js';
import { entityRecord } from '../../data/entityRecords.js';

/**
 * The icao a click's hit carries (`event.hit`, the contract's `Hit`): a
 * draw-set item's id (the icon and model sets' rows), or the id of
 * something drawn outside the draw port (a hit with no set).
 */
function aircraftPickId(hit) {
  if (!hit || hit.surface) return undefined;
  if (!hit.set) return hit.id || undefined;
  return isOtherTrackedIconSet(hit.set, 'flights') ? undefined : hit.id;
}

const STALE_CYAN = Object.freeze([...TRACKED_CYAN.slice(0, 3), STALE_ALPHA]);

export function createTracking({
  flightState,
  services,
  parts,
  layer,
  resolveAsset,
}) {
  const {
    selectTrackedSubjectContext,
    clearTrackedSubjectContext,
    refreshTrackedSubjectContext,
  } = services.context;
  const { isTr3b, tr3bTypeLabel, tr3bConvertedIds } =
    services.aircraftPresentation;
  const { createTrail } = services.trails;
  const { ensureGeoidReady, geoidHeight } = services.geoid;
  const { resolveGroundFloorCellsBounded, floorAltitudeM, cachedGroundFloor } =
    services.groundFloor;
  const { clearFocusTarget } = services.focus;
  const { isMilitaryLayerActive, isMilitaryIcao } = services.militaryRegistry;
  const { trackedLabelModelFromText, refreshTrackedReadout } = services.readout;
  const { FOLLOW_MIN_RANGE_M, SELECTION_FOLLOW_TRANSITION_S, followViewFrom } =
    services.camera;
  const { resolvePickId, isOwnedByOtherLayer } = services.picking;
  const flightsLayer = layer;
  /** The tracked contact's billboard (an icon set on the draw port). */
  const trackedIcon = createTrackedAircraftIcon({
    viewer: () => flightState._viewer,
    setPrefix: 'flights',
  });

  /** The camera's pose, or null without a camera to ask. */
  function _pose() {
    const viewer = flightState._viewer;
    try {
      return (viewer && findCamera(viewer)?.pose()) ?? null;
    } catch {
      return null;
    }
  }

  function _emitAwarenessEvent(type, detail) {
    if (
      typeof window === 'undefined' ||
      !window.dispatchEvent ||
      typeof CustomEvent === 'undefined'
    )
      return;
    window.dispatchEvent(new CustomEvent(type, { detail }));
  }

  function _publishTrackedSelection(icao24, origin = 'programmatic') {
    const position = parts.icons._iconPosition(icao24, vec());
    const info = flightState.records.data.get(icao24);
    if (!position || !info) return false;
    if (flightState._trackedEntity)
      entityRecord(flightState._trackedEntity).selectionOrigin = origin;
    _emitAwarenessEvent('gev:awareness-subject-selected', {
      layerId: 'flights',
      id: icao24,
      // Canonical display chain (callsign → registration → hex). Publishing a
      // bare `callsign || icao24` here resurrected the pre-enrichment behavior:
      // a callsign-less contact reached Context as its raw hex even once adsbdb
      // had supplied a registration. Identity below stays `icao24`.
      label: parts.queries._contactLabel(icao24, info),
      position,
      origin,
    });
    selectTrackedSubjectContext(_contextSubjectMetadata(icao24));
    return true;
  }

  /**
   * Describe the selected contact for the shared context slot the voice tools
   * and Cockpit read. Values are the LIVE descriptor, not a selection-time
   * snapshot, so a long follow never narrates a position the plane has left.
   * @param {string} icao24 Contact identity.
   * @returns {object|null} Context metadata, or null when the contact is gone.
   */

  function _contextSubjectMetadata(icao24) {
    const described = parts.queries._describeFlight(icao24);
    if (!described) return null;
    const altFt = Number.isFinite(described.altitudeM)
      ? Math.round(described.altitudeM * 3.28084)
      : null;
    const route =
      described.route && _routeIsPlausible(icao24, described.route)
        ? `${described.route.origin.code} → ${described.route.destination.code}`
        : null;
    return {
      id: icao24,
      layerId: 'flights',
      layerName: 'Live Flights',
      source: flightState.feed._lastSource,
      label: parts.queries._contactLabel(
        icao24,
        flightState.records.data.get(icao24),
      ),
      latitude: described.latitude,
      longitude: described.longitude,
      // Flat text only: the voice payload compacts properties through a
      // string cleaner that drops nested objects.
      properties: {
        name: parts.queries._contactLabel(
          icao24,
          flightState.records.data.get(icao24),
        ),
        operator: described.airline || '',
        callsign: described.callsign || '',
        registration: described.registration || '',
        type: described.typeName || described.typeCode || '',
        altitude: described.onGround
          ? 'on ground'
          : altFt === null
            ? ''
            : `${altFt.toLocaleString('en-US')} ft`,
        speed: Number.isFinite(described.velocityMps)
          ? `${Math.round(described.velocityMps * 1.944)} kt`
          : '',
        heading: Number.isFinite(described.track)
          ? `${roundHeadingDegrees(described.track)}°`
          : '',
        route: route || '',
        icao24,
        // Honesty cue: the contact is coasting on dead reckoning, so the
        // narrated position/velocity are last-known rather than live.
        // i18n-ignore: voice-context data, English for the model
        status: described.stale ? 'stale (missed polls)' : 'live',
      },
    };
  }

  function _isExplicitTrackingOrigin(origin) {
    return origin === 'user' || origin === 'voice' || origin === 'tool';
  }

  /**
   * Refresh the Cockpit AIR near/far band without consulting model state.
   * Near contacts keep their 2D aircraft silhouette when 3D is off, loading, or
   * capped; only a ready admitted model may take that silhouette over later.
   */

  function _refreshCockpitNearContacts() {
    const eye = flightState._cockpitContactMode ? _pose()?.position : null;
    if (!eye) {
      if (flightState._cockpitNearContacts.size)
        flightState._cockpitNearContacts = new Set();
      return;
    }
    const previous = flightState._cockpitNearContacts;
    const distancesSquared = [];
    const icons = flightState._icons;
    const t = parts.icons._displayMs();
    for (const icao24 of icons?.ids() ?? []) {
      if (icao24 === flightState._trackedIcao) continue;
      const position = icons.position(
        icao24,
        t,
        flightState._scratchCockpitPos,
      );
      distancesSquared.push([icao24, distanceSquared(eye, position)]);
    }
    const next = nextCockpitNearContacts(
      previous,
      distancesSquared,
      parts.rendering._modelAddDistM(),
      parts.rendering._modelKeepDistM(),
    );
    flightState._cockpitNearContacts = next;
    for (const icao24 of previous)
      if (!next.has(icao24)) parts.icons._applyIconPresentation(icao24);
    for (const icao24 of next)
      if (!previous.has(icao24)) parts.icons._applyIconPresentation(icao24);
  }

  /** Switch all current and future ambient contacts between silhouettes and cockpit pips. */

  function _setCockpitContactMode(active) {
    const next = active === true;
    if (flightState._cockpitContactMode === next) return;
    flightState._cockpitContactMode = next;
    if (next) _refreshCockpitNearContacts();
    else flightState._cockpitNearContacts = new Set();
    // The collection stays visible in cockpit. Near AIR contacts retain their
    // aircraft silhouette until a ready model takes over; far contacts are pips.
    // Never destroy on entry: tearing down hundreds of live glTF instances
    // synchronously blocked Chrome's renderer into Page Unresponsive.
    parts.rendering._setModelsShown(true);
    flightState._trail?.setVisible(!next);
    for (const icao24 of flightState._icons?.ids() ?? [])
      parts.icons._applyIconPresentation(icao24);
    flightState._lastFleetTickMs = 0;
  }

  function _applyCockpitState(detail = {}) {
    const active = detail?.active === true;
    flightState._cockpitSubjectId = active
      ? String(detail?.subjectId || '')
          .trim()
          .toLowerCase() || null
      : null;
    _setCockpitContactMode(active);
  }

  /** Start a selection's tracked-model state afresh: the model it draws
   *  with (whatever the fleet drew it with, a model or its icon) and the
   *  load-failure budget. Called from each path that changes which contact
   *  is selected — deselect, re-track, cross-layer handoff, init, destroy. */

  function _resetTrackedSelectionState() {
    flightState._trackedModelEligible = Boolean(
      flightState._trackedIcao &&
      flightState._models?.has(flightState._trackedIcao),
    );
    flightState._trackedModelFailIcao = null;
    flightState._trackedModelFailCount = 0;
    flightState._trackedModelRetryAtMs = 0;
  }

  /**
   * Whether the TRACKED aircraft draws as its 3D model: exactly when the
   * fleet's own rule would draw it so (`_modelRegimeActive` — 3D on and the
   * camera below the ceiling — and a place in the nearest-first cap, which
   * the fleet pass keeps in `_trackedModelEligible`). Selecting a contact
   * therefore never turns its icon into a model or its model into an icon.
   * A converted TR-3B has no 3D asset, and in cockpit you sit in your own
   * airframe, so neither draws one.
   */

  function _trackedModelRegimeActive() {
    if (
      !flightState._trackedIcao ||
      flightState._cockpitContactMode ||
      isTr3b(flightState._trackedIcao)
    )
      return false;
    return (
      flightState._trackedModelEligible === true &&
      parts.rendering._modelRegimeActive()
    );
  }

  /** Seed the tracked billboard's 2D orientation before a 3D→2D handoff. */

  function _syncTracked2dRotation() {
    if (!flightState._trackedIcao || !flightState._viewer) return;
    const pos =
      parts.motion._trackedDisplayCached() ||
      parts.icons._iconPosition(flightState._trackedIcao, vec());
    if (!pos) return;
    const projected = courseScreenRotation(
      _pose(),
      pos,
      parts.motion._trackedDisplayCourse(),
      flightState._lastTrackedRotation,
    );
    const rotation = stabilizeScreenRotation(
      flightState._lastTrackedRotation,
      projected,
      0,
    );
    if (rotation !== null) flightState._lastTrackedRotation = rotation;
  }

  /**
   * Put one report into the tracked aircraft's trail, in time order, and
   * refresh the rendered trail. Caller passes an owned (cloned) position. A
   * report that breaks from its neighbour starts a new segment (see
   * trailContinuity).
   * @param {{x: number, y: number, z: number}} position - The report's ECEF position.
   * @param {number} [epochMs] - The report's time; defaults to the tracked
   *   aircraft's newest position-history fix, which every caller has just pushed.
   * @param {{nullAltitude?: boolean, track?: number}} [options] - `nullAltitude`:
   *   the report had no altitude, so its position is not kept and the line
   *   breaks there; `track`: its reported track, which the line leaves it along.
   */

  function _appendTrailFix(
    position,
    epochMs,
    { nullAltitude = false, track = undefined } = {},
  ) {
    const history = flightState._positionHistory.get(flightState._trackedIcao);
    const timeMs = Number.isFinite(epochMs)
      ? epochMs
      : historyFixEpochMs(history?.[history.length - 1]);
    insertTrailFix(
      flightState._trailFixes,
      position,
      timeMs,
      TRAIL_MAX_POINTS,
      { nullAltitude, track },
    );
    _refreshTrailDisplay();
  }

  /**
   * Per-frame trail work, run before each frame draws whether or not the
   * head is visible: move the body on as the display time passes reports.
   * The head only reads the result.
   */

  function _trailTick() {
    if (!flightState._trackedIcao || !flightState._trail) return;
    if (_trailBodyCountNow() !== flightState._trailBodyCount)
      _refreshTrailDisplay();
  }

  /**
   * Renders the trail with its head clamped to the render-behind display
   * position. The newest reports run ahead of the displayed aircraft (the
   * delayed clock) — drawing them verbatim makes the trail extend in FRONT of
   * the icon.
   */

  function _refreshTrailDisplay() {
    // The trail BODY is the reports at or before the delayed display time,
    // joined along the curve the aircraft is drawn along; newer reports are
    // AHEAD of the icon. The per-frame head runs on along the same curve from
    // the last body report to the icon, so the body rebuilds only on a real
    // report or when the display time passes one, never at motion cadence.
    // A break lifts the pen: each segment is its own line, nothing between them.
    if (!flightState._trail) return;
    flightState._trailBodyCount = _trailBodyCountNow();
    drawTrailSegments(
      flightState._trail,
      trailBodySegments(flightState._trailFixes, flightState._trailBodyCount),
    );
  }

  /** Reports at or before the time the aircraft is drawn (now − the display delay). */

  function _trailBodyCountNow() {
    return trailBodyCount(
      flightState._trailFixes,
      flightState.now() - displayDelayMs(flightState),
    );
  }

  /**
   * The live head: the last DISPLAYED body point to the delayed head, or no
   * positions while there is none.
   * @returns {Array<{x: number, y: number, z: number}>}
   */
  function _trailHeadPositions() {
    // The head starts at the last DISPLAYED body point, the newest fix at or
    // before the delayed display time; a fix ahead of the icon would draw the
    // segment IN FRONT of the plane. During warm-up the icon predates all real
    // history, so there is no valid body point behind it.
    if (
      !flightState._trackedIcao ||
      !flightState._trailFixes.length ||
      parts.motion._isTrackWarmingUp()
    )
      return [];
    const head =
      parts.motion._trackedTrailCached() ||
      parts.motion._trackedDisplayPosition(flightState._trackedIcao);
    if (!head) return [];
    // The last body report → the icon. No head across a break: a body point
    // more than 150 km away, or too long ago or too far to be one path, stays
    // detached; none while the aircraft holds at its last point.
    const last = trailHeadStartFix(
      flightState._trailFixes,
      head,
      flightState.now(),
      flightState._trailBodyCount,
    );
    if (!last) return [];
    return trailHeadLine(
      last.position,
      // Along the curve the icon is drawn along, to where it is now.
      trailHeadCurvePoints(
        flightState._trailFixes,
        flightState._trailBodyCount,
        flightState.now() - displayDelayMs(flightState),
      ),
      head,
      parts.motion._trackedModelCenterWorld(),
      parts.motion._trackedModelEnvelopeM(),
      flightState._scratchTrailHead,
    );
  }

  /** Each drawn frame, before it draws: the trail moved on, then the live
   *  head where the aircraft is now. */
  function _drawTrailHead() {
    _trailTick();
    flightState._trail?.setHead(_trailHeadPositions());
  }

  /**
   * Start the trail for a newly tracked aircraft: seed it with the short
   * dead-reckoning history (chronological), render immediately, then
   * fire-and-forget an OpenSky track backfill.
   * @param {string} icao24 - ICAO 24-bit transponder address being tracked.
   */

  function _startTrail(icao24) {
    flightState._trailBackfillToken += 1;
    flightState._trailFixes = [];
    const history = flightState._positionHistory.get(icao24) || [];
    // Seed every report. The body only draws those at or before the delayed
    // display time (now − displayDelayMs); newer ones join it as the display
    // passes them. A synthetic forward fix (it carries `reportEpochMs`) is a
    // motion aid, never a report. A report drawn at an invented height keeps
    // no position and breaks the line.
    for (const fix of history) {
      if (Number.isFinite(fix.reportEpochMs)) continue;
      insertTrailFix(
        flightState._trailFixes,
        clone(fix.position),
        historyFixEpochMs(fix),
        TRAIL_MAX_POINTS,
        {
          nullAltitude: fix.inventedHeight === true,
          onGround: fix.onGround,
          track: fix.track,
        },
      );
    }
    if (!flightState._trail && flightState._viewer) {
      flightState._trail = createTrail(flightState._viewer, {
        color: TRAIL_COLOR,
        width: 2.5,
      });
    }
    flightState._trail?.setVisible(!flightState._cockpitContactMode);
    // Live head segment: last displayed body point → current dead-reckoned icon, drawn
    // again each frame before it draws, so it stays glued to the 12 Hz icon instead of
    // lagging ~1 s behind it. Only the head line is rebuilt; the body rebuilds on a real
    // fix (poll cadence). Dimmed where occluded (round 4), geodesic as the body (round 8).
    if (!flightState._trailHeadOff && flightState._viewer) {
      flightState._trailHeadOff =
        findFrame(flightState._viewer)?.on('preRender', _drawTrailHead) ?? null;
    }
    _refreshTrailDisplay();

    const oldestFixEpochSec = history.length
      ? julianToEpochMs(history[0].time) / 1000
      : Infinity;
    _backfillTrail(icao24, flightState._trailBackfillToken, oldestFixEpochSec);
  }

  /**
   * Fire-and-forget OpenSky /tracks backfill (PRD F1). On success, splices
   * waypoints strictly older than the oldest seeded fix AHEAD of the locally
   * accumulated fine segment, capped at TRAIL_MAX_POINTS (newest kept). Any
   * failure (404/429/timeout/malformed) silently keeps the local-only trail.
   * @param {string} icao24 - ICAO 24-bit transponder address being tracked.
   * @param {number} token - Backfill token captured at request time.
   * @param {number} oldestFixEpochSec - Epoch seconds of the oldest seeded fix.
   * @returns {Promise<void>}
   */

  async function _backfillTrail(icao24, token, oldestFixEpochSec) {
    let path = null;
    // Following the world clock, the track ends at the world's time.
    const atMs = followsClock(flightState) ? flightState.now() : undefined;
    try {
      const signal = AbortSignal.any([
        flightState.lifetime.signal,
        AbortSignal.timeout(8000),
      ]);
      const track = await flightState.feed._source.getTrack?.(
        flightState.records.data.get(icao24)?.sourceReference ?? icao24,
        atMs === undefined ? { signal } : { signal, atMs },
      );
      path = track?.records ?? null;
    } catch {
      return; // silent fallback to the accumulated trail
    }
    if (
      !path ||
      token !== flightState._trailBackfillToken ||
      icao24 !== flightState._trackedIcao
    )
      return;

    // OpenSky track waypoints: [time, latitude, longitude, baro_altitude, true_track, on_ground]
    // Height-datum fix (Task 6): /tracks only ever reports barometric/MSL altitude
    // (no per-waypoint geo_altitude in this endpoint), so waypoint render height is
    // the documented visual FALLBACK baroM + geoidHeight(waypointLat, waypointLon)
    // — geometrically approximate, not exact, same honesty caveat as the live
    // baro-fallback branch of pickRenderAltitudeM.
    await ensureGeoidReady();
    const parsed = [];
    for (const waypoint of path) {
      const {
        observedAtMs,
        latitude: lat,
        longitude: lon,
        baroAltitudeM: baroAlt,
      } = waypoint;
      const time = observedAtMs / 1000;
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      if (atMs !== undefined && !(observedAtMs <= atMs)) continue;
      if (!Number.isFinite(time) || time >= oldestFixEpochSec) continue;
      parsed.push({
        lat,
        lon,
        baroAlt,
        onGround: waypoint.onGround === true,
        timeMs: observedAtMs,
      });
    }
    if (!parsed.length) return;

    // Field-test fix (WAKE01 trail-underground, 2026-07-06 — mirror of
    // militaryFlights.js): resolve the coarse ellipsoidal ground along the track
    // and floor every waypoint at it so low baro segments never dive below the
    // mesh; a no-baro waypoint (predominantly taxi/ground segments in /tracks)
    // sits ON the surface when the floor is known.
    // Round-2 fix (owner: "trails suddenly much shorter / not loading"): the
    // resolve is BOUNDED (≤1.2 s), not a blocking await — a cold Re:Earth
    // lookup across a long path could stall the paint for seconds-to-timeout.
    // Paint with whatever cells are warm; the resolve keeps filling the cache
    // in the background for the next paint/select.
    await resolveGroundFloorCellsBounded(parsed);
    // Re-check the backfill token after the await (same guard as post-fetch):
    // tracking may have moved on while the terrain race was in flight.
    if (
      token !== flightState._trailBackfillToken ||
      icao24 !== flightState._trackedIcao
    )
      return;

    // Every waypoint is kept, each leg its own segment. A ground waypoint is
    // at altitude 0, floored at the ground. A waypoint with no altitude is a
    // break on both sides: it sits on the ground where the floor is known and
    // is skipped otherwise; a skipped point still breaks the line.
    const backfill = trailBackfillFixes(
      parsed.map(({ lat, lon, baroAlt, onGround, timeMs }) => {
        const known = Number.isFinite(baroAlt) ? baroAlt : onGround ? 0 : null;
        const altM = floorAltitudeM(
          known == null ? null : known + geoidHeight(lat, lon),
          cachedGroundFloor(lat, lon),
        );
        return {
          position: altM == null ? null : fromDegrees(lon, lat, altM),
          timeMs,
          nullAltitude: known == null,
        };
      }),
    );
    // A history that ends in the air does not join an aircraft now on the
    // ground (or the reverse) across a landing or take-off nobody saw.
    flightState._trailFixes = joinTrailBackfill(
      backfill,
      flightState._trailFixes,
      TRAIL_MAX_POINTS,
      {
        backfillEndsOnGround: parsed[parsed.length - 1].onGround,
        onGroundNow: flightState.records.data.get(icao24)?.onGround,
        nowMs: flightState.now(),
      },
    );
    _refreshTrailDisplay();
  }

  /**
   * Clear the rendered trail and accumulation; invalidate pending backfills.
   */

  function _clearTrail() {
    flightState._trailBackfillToken += 1;
    flightState._trailFixes = [];
    if (flightState._trail) flightState._trail.clear();
    flightState._trailHeadOff?.();
    flightState._trailHeadOff = null;
  }

  /**
   * Destroy the trail primitive entirely (layer disable/teardown).
   */

  function _destroyTrail() {
    _clearTrail();
    if (flightState._trail) {
      flightState._trail.destroy();
      flightState._trail = null;
    }
  }

  /**
   * Stop tracking the currently followed aircraft.
   *
   * Restores the hidden billboard, removes the tracked Entity, resets lerp
   * state, and RELEASES the camera IN PLACE — no flyTo. Deselect used to fly
   * an ~80 km pulled-back overview; the owner field-ruled that wrong
   * (2026-07-02: "it randomly zooms way up and loses my context"). The camera
   * now simply stays at its current position/orientation, immediately free to
   * orbit/zoom. Applies to every deselect path: click-empty-space, Escape,
   * aged-out plane, layer disable, and voice stopTracking.
   *
   * @param {boolean} [skipViewerUntrack=false] - ANOTHER layer just grabbed the
   *   follow-camera: tear down our own state but leave the camera's follow
   *   alone (the new owner controls it).
   * @param {object} [options] - Clear origin.
   * @param {boolean} [options.evicted=false] - The contact aged out of the feed
   *   rather than being deselected. Consumers that keep a readout on screen
   *   (the Cockpit Contact panel) hold last-known values for an eviction and
   *   only tear down on a deliberate clear.
   */

  function _clearTracking(
    skipViewerUntrack = false,
    { evicted = false, origin = 'programmatic' } = {},
  ) {
    flightState._followTarget = null;
    if (!flightState._trackedIcao) {
      clearFocusTarget('flights');
      return;
    }
    const clearedIcao = flightState._trackedIcao;
    clearFocusTarget('flights', clearedIcao);

    // The nose the icon continues from (the shared _displayCourse entry), so
    // release never flips it.
    const trackedCourseDeg = flightState._displayCourse.get(clearedIcao);

    // Stop tracking and hide the tracked billboard. skipViewerUntrack: when ANOTHER layer just
    // grabbed the follow-camera, we tear down our own state but must NOT clear the camera's follow
    // (the new owner controls it now — clearing it would yank the camera off their plane).
    // Releasing the follow does NOT move the camera: the view stays where the follow left it and
    // the user can immediately orbit/zoom.
    if (flightState._viewer && !skipViewerUntrack) {
      stopFollowing(flightState._viewer);
    }
    trackedIcon.hide();
    flightState._trackedEntity = null;
    parts.rendering._releaseTrackedModel();
    _resetTrackedSelectionState(); // the zoom band + load-failure budget belong to the selection we just dropped
    flightState._trackedIcao = null;
    // Hand the contact back to its icon only now: settling floors a grounded
    // contact, and while it still read as tracked its tracked model owned the
    // visual, so the floor would have stepped aside.
    if (flightState._icons?.has(clearedIcao)) {
      flightState._icons.setShown(clearedIcao, true);
      parts.icons._settleIcon(clearedIcao, { fromCourseDeg: trackedCourseDeg });
    }
    parts.icons._applyIconPresentation(clearedIcao);
    clearTrackedSubjectContext('flights');
    _emitAwarenessEvent('gev:awareness-subject-cleared', {
      layerId: 'flights',
      id: clearedIcao,
      origin,
      reason: evicted ? 'evicted' : 'deliberate',
    });
    // Invalidate the per-frame DR cache + reconciliation state so a same-frame re-track
    // cannot read the previous aircraft's cached/smoothed position.
    parts.motion._resetTrackedDisplay();
    _clearTrail();
  }

  /**
   * Whether the Military layer suppresses this civil duplicate right now.
   *
   * The dedicated Military layer owns icon/track/click for known-military
   * contacts, so the OpenSky duplicate is dropped while that layer is on. Two
   * contacts are exempt, both for the same reason — this layer still owns them:
   *
   *   - the CURRENTLY tracked one, which hands off on untrack; and
   *   - a target this layer is holding on its deferred-restore latch.
   *
   * The second exemption is what makes a shared/local Follow of a mil-registry
   * hex restorable at all. The accepted-snapshot id set is built BEFORE this
   * suppression runs, so without it the target is provably present in a healthy
   * feed yet has no billboard, `trackById` fails, and the restore reports
   * "feed unavailable" about a feed that was perfectly fine.
   *
   * @param {string} icao24 - Normalized ICAO 24-bit address.
   * @returns {boolean} True when the civil duplicate must be dropped.
   */

  function _militaryLayerSuppresses(icao24) {
    if (!isMilitaryLayerActive()) return false;
    if (icao24 === flightState._trackedIcao) return false;
    if (icao24 === flightState._pendingTrackingRestore?.id) return false;
    return true;
  }

  function _applyPendingTrackingRestore() {
    const pending = flightState._pendingTrackingRestore;
    if (
      !pending ||
      pending.generation !== flightState._trackingIntentGeneration
    )
      return false;
    if (!flightState._icons?.show || !flightState._icons.has(pending.id))
      return false;
    flightState._pendingTrackingRestore = null;
    _trackFlight(pending.id, { origin: pending.origin });
    return true;
  }

  function _cancelPendingTrackingRestore() {
    flightState._trackingIntentGeneration += 1;
    flightState._pendingTrackingRestore = null;
  }

  /**
   * The tracked plane's stale cue and whether it is drawn with the stale fade.
   * - SIGNAL LOST · <time since its last report>, dimmed: its coast has ended
   *   (or it holds at its last report after a missed update) and no newer
   *   report has come.
   * - STALE, dimmed: it has missed an update and still coasts, or the whole
   *   feed is backing off.
   * @param {string} icao24
   * @returns {{text: string, dimmed: boolean}}
   */

  function _trackedStaleCue(icao24) {
    const records = flightState.records;
    const misses = records.missingPolls.get(icao24) || 0;
    const repeated = records.fixRepeated?.has(icao24) === true;
    const backoff = flightState.feed._backoff === true;
    // Computed once per frame for the label, the icon colour and the model
    // fade; a poll between frames changes the key.
    const frame = renderedFrames(flightState._viewer);
    const key =
      frame >= 0 ? `${frame}|${icao24}|${misses}|${repeated}|${backoff}` : null;
    const cached = flightState._trackedStaleCueCache;
    if (key !== null && cached?.key === key) return cached.cue;
    const cue = _computeTrackedStaleCue(
      icao24,
      misses > 0 || repeated,
      backoff,
    );
    flightState._trackedStaleCueCache = key === null ? null : { key, cue };
    return cue;
  }

  /** `_trackedStaleCue` without the per-frame cache. A repeated fix counts as missed. */

  function _computeTrackedStaleCue(icao24, missed, backoff) {
    const lost = parts.motion._signalLost(icao24);
    if (lost && (missed || !lost.holds)) {
      const sec = Math.max(
        0,
        Math.floor((flightState.now() - lost.reportEpochMs) / 1000),
      );
      const time =
        sec < 60
          ? `${formatNumber(sec, { useGrouping: false })} ${unitLabel('s')}`
          : `${formatNumber(Math.floor(sec / 60), { useGrouping: false })} ${unitLabel('min')}`;
      return { text: t('SIGNAL LOST · {time}', { time }), dimmed: true };
    }
    // A missed update or a stalled feed: no newer position is coming in.
    if (missed || backoff) return { text: t('STALE'), dimmed: true };
    return { text: '', dimmed: false };
  }

  /** The tracked billboard's colour: cyan, faded while stale, clear while the 3D model is the visual. */

  function _trackedIconColor() {
    if (parts.rendering._modelOwnsVisual(flightState._trackedIcao))
      return CYAN_TRANSPARENT;
    return _trackedStaleCue(flightState._trackedIcao).dimmed
      ? STALE_CYAN
      : TRACKED_CYAN;
  }

  /**
   * Re-word the tracked label when its stale cue changes (STALE, SIGNAL LOST,
   * each new second or minute of it). Run from the layer's per-frame pass.
   */

  function _staleCueTick() {
    const icao24 = flightState._trackedIcao;
    if (!icao24 || !flightState._trackedEntity) return;
    const text = _trackedStaleCue(icao24).text;
    if (text === flightState._trackedStaleCueText) return;
    flightState._trackedStaleCueText = text;
    _updateTrackedLabelModel(icao24);
  }

  /** Multi-line tracked presentation text: "CS · FL · kts" + "Airline · Type" +
   *  "ORIG → DEST". The route line is gated by
   *  routePlausible so a wrong-leg adsbdb route is hidden, not displayed.
   *  The first line carries the stale cue (`_trackedStaleCue`): STALE while
   *  the plane coasts on dead reckoning after a missed update, SIGNAL LOST
   *  once the coast has ended, so last-known velocity/altitude are never
   *  presented as live. */

  function _trackedLabelText(icao24) {
    const info = flightState.records.data.get(icao24);
    if (!info) return icao24;
    // A whitespace-only callsign ("   ") is truthy, so `(info.callsign || icao24)`
    // kept it, then .trim() emptied it → the callsign slot dropped out of the
    // readout. `_contactLabel` trims FIRST, then falls through registration to
    // the ICAO hex, so a callsign-less enriched contact heads its readout with
    // the tail number rather than raw hex.
    const cs = parts.queries._contactLabel(icao24, info);
    // Flight levels are an aviation code; feet and knots read in the active
    // language ("0 фт · 1 уз").
    const quantity = (value, unit) =>
      `${formatNumber(value, { useGrouping: false })} ${unitLabel(unit)}`;
    const altFt = Number.isFinite(info.altitude)
      ? Math.round(info.altitude * 3.28084)
      : null;
    const fl =
      altFt === null
        ? t('Alt unknown')
        : altFt >= 18000
          ? `FL${Math.round(altFt / 100)}`
          : quantity(altFt, 'ft');
    const spd = info.velocity
      ? quantity(Math.round(info.velocity * 1.944), 'kts')
      : '';
    const stale = _trackedStaleCue(icao24).text;
    const lines = [[cs, fl, spd, stale].filter(Boolean).join(' · ')];
    // Converted contacts report their class as TR-3B and nothing else — the
    // operator/type identity is exactly what the Easter egg is replacing.
    const ident = isTr3b(icao24)
      ? tr3bTypeLabel(icao24)
      : [info.airline, info.typeName || info.typeCode]
          .filter(Boolean)
          .join(' · ');
    if (ident) lines.push(ident);
    if (info.route && _routeIsPlausible(icao24, info.route)) {
      lines.push(`${info.route.origin.code} → ${info.route.destination.code}`);
    }
    return lines.join('\n');
  }

  /** Write the explicit tracked presentation model and refresh its host entry. */

  function _updateTrackedLabelModel(icao24) {
    if (!flightState._trackedEntity || icao24 !== flightState._trackedIcao)
      return;
    entityRecord(flightState._trackedEntity).labelModel =
      trackedLabelModelFromText(_trackedLabelText(icao24), '#39d0ff');
    refreshTrackedReadout(flightState._trackedEntity);
    // The readout and the context slot describe the same contact — refresh them
    // together so voice never narrates a fix the card has already replaced.
    refreshTrackedSubjectContext(_contextSubjectMetadata(icao24));
  }

  /** The tracked billboard's images, from the current class/conversion: the
   *  fleet icon's own (`_fleetLook`), so selecting it changes only its colour. */
  function _trackedBillboardLook() {
    return parts.icons._fleetLook(flightState._trackedIcao);
  }

  /**
   * What the tracked billboard is drawn at: the size, scale and scale by
   * distance its fleet icon has (the scale read live: a landing changes it).
   * Kept in its entity record too, so the camera guard and screen
   * annotations size it from the app's own state.
   * @param {string} icao24
   */
  function _trackedSprite(icao24) {
    const look = parts.icons._fleetLook(icao24);
    return {
      width: look.size[0],
      height: look.size[1],
      get scale() {
        return parts.rendering._fleetBillboardScale(
          icao24,
          flightState.records.data.get(icao24)?.klass,
        );
      },
      scaleByDistance: look.scaleByDistance,
    };
  }

  /** Re-image the tracked billboard from the current class/conversion. */

  function _syncTrackedBillboardImage() {
    if (!flightState._trackedIcao || !flightState._trackedEntity) return;
    const look = _trackedBillboardLook();
    trackedIcon.setImage(look.image, look.imageLod);
  }

  /**
   * Re-render one contact after its TR-3B conversion (or the active IR style)
   * changed. Converting drops any 3D model so the triangle owns the visual; the
   * billboard image, tracked entity, and tracked card are all re-derived here.
   * @param {string} icao24 - ICAO 24-bit address.
   * @returns {boolean} True when the layer owns this contact.
   */

  function _refreshTr3bContact(icao24) {
    const id = String(icao24 || '')
      .trim()
      .toLowerCase();
    if (!id) return false;
    if (isTr3b(id)) {
      // Drop the 3D handoff for this contact — the fleet tick now skips it, so
      // an already-loaded model would otherwise linger with the billboard hidden.
      if (flightState._models.has(id)) parts.rendering._releaseModel(id);
      if (flightState._icons?.has(id) && id !== flightState._trackedIcao)
        flightState._icons.setShown(id, true);
      if (id === flightState._trackedIcao) {
        parts.rendering._releaseTrackedModel();
        _syncTracked2dRotation();
      }
    }
    parts.icons._applyIconPresentation(id);
    if (id === flightState._trackedIcao) {
      _syncTrackedBillboardImage();
      _updateTrackedLabelModel(id);
    }
    if (flightState._viewer)
      findFrame(flightState._viewer)?.requestRender('flights: TR-3B restyle');
    return flightState._icons?.has(id) || id === flightState._trackedIcao;
  }

  /** Re-image every converted contact this layer owns (IR style flip). */

  function _refreshTr3bForStyle() {
    for (const id of tr3bConvertedIds()) {
      if (flightState._icons?.has(id) || id === flightState._trackedIcao)
        _refreshTr3bContact(id);
    }
  }

  /** Plausibility check anchored to the plane's icon position (coarse is
   *  fine here — this gates a LABEL, and it must not touch the tracked frame
   *  cache). Missing data → true (never hide what we can't judge). */

  function _routeIsPlausible(icao24, route) {
    const info = flightState.records.data.get(icao24);
    const position = parts.icons._iconPosition(icao24, vec());
    if (!info || !position) return true;
    const carto = toLonLatH(position);
    if (!carto) return true;
    return routePlausible({
      latDeg: carto.lat,
      lonDeg: carto.lon,
      altitudeM: info.altitude ?? null,
      verticalRateMps: info.verticalRate ?? null,
      origin: route.origin,
      destination: route.destination,
    });
  }

  /**
   * Begin tracking a specific aircraft by ICAO24 address.
   *
   * Clears any existing tracked flight, hides its fleet icon, and shows the
   * tracked billboard (`createTrackedAircraftIcon`), drawn each frame at the
   * dead-reckoned display position, screen-rotated along the displayed
   * course. The tracked record carries the host presentation model
   * (callsign, flight level, speed, identity, plausible route text), and the
   * camera follows a target that reads it.
   *
   * @param {string} icao24 - ICAO 24-bit transponder address to track.
   * @param {{origin?: string, keepView?: boolean}} [options] `keepView` (a
   *   click on the plane): follow from the camera's own distance and angle,
   *   the plane sliding to the centre, rather than the calibrated framing.
   */

  function _trackFlight(
    icao24,
    { origin = 'programmatic', keepView = false } = {},
  ) {
    _clearTracking(false, { origin }); // switching planes — the new follow-camera takes over

    const icons = flightState._icons;
    const info = flightState.records.data.get(icao24);
    if (!icons?.has(icao24) || !info) return;

    // The tracked limiter continues from the nose the icon was drawn with, and
    // the entity starts with the rotation the icon had on screen.
    const t = parts.icons._displayMs();
    const iconPosition = icons.position(icao24, t, vec());
    const iconCourse = icons.course(icao24, t);
    flightState._displayCourse.set(icao24, iconCourse);
    flightState._trackedIcao = icao24;
    _resetTrackedSelectionState(); // fresh selection: enter at the ENTER ceiling, full load-retry budget
    flightState._cachedDRFrame = -1;
    flightState._lastTrackedRotation =
      courseScreenRotation(_pose(), iconPosition, iconCourse, 0) ?? 0;
    // A fleet 3D model this aircraft had keeps drawing it until the tracked
    // model is ready (`_updateTrackedModel` lets it go then), so it never
    // turns into its icon for the frames the tracked model takes to load.

    // Hide the icon — the tracked entity replaces it visually
    icons.setShown(icao24, false);

    // Helper: smoothed, per-frame-cached tracked position (see _trackedDisplayPosition —
    // one computation shared by the position/alignedAxis/rotation/trail-head callbacks,
    // with discontinuity reconciliation). Falls back to the icon's position when
    // the aircraft has no fix.
    const getTrackedPosition = () =>
      parts.motion._trackedDisplayPosition(icao24) ||
      parts.icons._iconPosition(icao24, vec()) ||
      iconPosition;

    // The tracked billboard: a 2D icon when zoomed out, handing over to the 3D model when zoomed
    // in past the TRACKED altitude ceiling. That handoff is DEFAULT behaviour — it does NOT wait on
    // the DISPLAY-rail 3D toggle, which arms the FLEET. The plane the user zooms into always
    // resolves into an aircraft.
    //
    // The billboard stays SHOWN at all times and is hidden by going TRANSPARENT (alpha 0), not by
    // show=false: it drops its alpha only once the tracked model is drawing, so there's neither a
    // billboard+model double-image nor a gap. The camera follows its own target through the camera
    // port, so nothing here frames the camera. The 3D model for the tracked plane is a draw-set
    // item driven by _updateTrackedModel() (see _trackedModel).
    const sprite = _trackedSprite(icao24);
    // The tracked contact as its readers see it (the tracked card, Cockpit, share links): a
    // plain holder of its entity record, drawn while it is the one tracked.
    const holder = trackedContactHolder(
      `flights:${icao24}`,
      trackedIcon,
      parts.motion._trackedDisplayCached,
    );
    flightState._trackedEntity = holder;
    entityRecord(holder).drawn = () => flightState._trackedEntity === holder;
    // The draw sets a height sample under the contact sees through (its
    // icons and models), for Cockpit's ground probe.
    entityRecord(holder).groundSets = () => {
      const sets = [...parts.rendering._groundSampleExclusions().sets];
      if (trackedIcon.setId) sets.push(trackedIcon.setId);
      return sets;
    };
    trackedIcon.show({
      id: icao24,
      image: _trackedBillboardLook().image,
      imageLod: _trackedBillboardLook().imageLod,
      sprite,
      position: getTrackedPosition,
      // Solid cyan (faded while stale) when the billboard is the visual (zoomed out, 3D off,
      // or model still loading); transparent once the tracked model is actually up.
      color: _trackedIconColor,
      // Screen-projected rotation, evaluated per frame on the camera's own
      // axes, so it stays exact through a tracked orbit. The tracked target
      // must never vanish into tile geometry — tracking a taxiing plane at
      // street level would otherwise bury the cyan icon inside the runway
      // skin, so it draws over depth like the fleet icon set; its
      // shared-host tracked card is top-composited separately.
      rotation: () => {
        const tracked = flightState.records.data.get(flightState._trackedIcao);
        const pos = getTrackedPosition();
        if (!tracked || !pos || !flightState._viewer)
          return flightState._lastTrackedRotation;
        const projected = courseScreenRotation(
          _pose(),
          pos,
          parts.motion._trackedDisplayCourse(),
          flightState._lastTrackedRotation,
        );
        const rot = stabilizeScreenRotation(
          flightState._lastTrackedRotation,
          projected,
        );
        if (rot !== null) flightState._lastTrackedRotation = rot;
        return flightState._lastTrackedRotation;
      },
    });
    entityRecord(flightState._trackedEntity).selectionOrigin = origin;
    entityRecord(flightState._trackedEntity).trackedId = `flights:${icao24}`;
    entityRecord(flightState._trackedEntity).sprite = sprite;
    entityRecord(flightState._trackedEntity).labelModel =
      trackedLabelModelFromText(_trackedLabelText(icao24), '#39d0ff');

    // A click on the plane follows it from where the camera is (`keepView`,
    // below). A selection from elsewhere (a search, voice, a share link) has no
    // view of the plane to keep: a billboard has a ~zero bounding sphere, so the
    // renderer's default follow distance is far too tight. It gets a calibrated
    // viewFrom — behind + above, distance scaled to altitude — for a readable
    // initial frame with surrounding context. (ENU: east=+X, north=+Y, up=+Z.)
    // An unreported altitude frames by the height the plane is drawn at.
    const followRange = Math.min(
      Math.max(
        ((info.altitude ?? info.renderAltitudeM) || 1500) * 1.1 + 2500,
        3000,
      ),
      30000,
    );
    const viewFrom = vec(0, -followRange * 0.8, followRange * 0.55);

    // Cancel any in-progress camera flight first — otherwise the camera won't apply the
    // follow target's viewFrom on the first frame, so voice-initiated tracking (which
    // often fires mid-fly_to_location) would follow the plane WITHOUT centering/framing it
    // the way a click (idle camera) does.
    // Expose the camera's already-settled position to cross-module HUD consumers (the tracked-target
    // readout) so they draw at the SAME spot the camera framed, without recomputing the dead-reckon in
    // postRender (which would jitter the label against the now-stable plane).
    entityRecord(flightState._trackedEntity).displayPosition =
      parts.motion._trackedDisplayCached;
    // Separate accessor on purpose: the entity record's `displayPosition` carries the follow-camera
    // anti-jitter contract and must keep returning the cached DR position. Presentation
    // that should weld to the AIRCRAFT YOU SEE reads the entity record's `visualPosition` instead.
    entityRecord(flightState._trackedEntity).visualPosition =
      parts.motion._trackedVisualCached;
    refreshTrackedReadout(flightState._trackedEntity);
    // The camera follows through its port: a target framed from viewFrom in
    // ENU, never closer than the readable minimum, whose presentation (key,
    // label, sprite, display position) reads the tracked entity's record.
    const camera = cameraOf(flightState._viewer);
    camera.cancelFlight();
    const kept = keepView
      ? followViewFrom(camera.pose(), getTrackedPosition())
      : null;
    flightState._followTarget = entityFollowTarget(flightState._trackedEntity, {
      position: getTrackedPosition,
      frame: 'enu',
      viewFrom: kept ?? viewFrom,
      minRange: FOLLOW_MIN_RANGE_M,
      // A click keeps the camera's distance and angle: the plane slides to
      // the centre from where the camera is, and is followed from there.
      ...(kept ? { transitionS: SELECTION_FOLLOW_TRANSITION_S } : {}),
    });
    camera.follow(flightState._followTarget);

    // Track-history trail (PRD F1): seed from local history + async backfill.
    // Ground traffic draws NO trail (a taxi path is noise, not a track) — if the
    // plane takes off while tracked, the on_ground→false transition in update()
    // starts one.
    parts.enrichment._requestTypeEnrichment(icao24, true); // tracked plane — front of the enrichment queue
    parts.enrichment._requestRouteEnrichment(icao24);
    parts.enrichment._requestPhotoEnrichment(icao24);
    // Round 2 (owner): grounded contacts get trails too — a landed-but-taxiing
    // aircraft's history is retrievable on select. Grounded flights positions
    // are already surface-clamped (the surfaceM chain), so seeds/appends drape.
    _startTrail(icao24);

    _publishTrackedSelection(icao24, origin);

    console.log(
      `[Data:Flights] Tracking ${parts.queries._contactLabel(icao24, info)} (${icao24})`,
    );
  }

  /**
   * Immediate military-suppression handoff sweep (pre-ship audit M2).
   *
   * The poll-time suppression branch in update() only reconciles every 30 s, so
   * toggling the Military layer showed duplicate icons (military ON: both layers
   * render the same aircraft ~3-4 km apart) or holes (military OFF: suppressed
   * aircraft absent) for up to a full poll. Fired synchronously by the registry
   * on the active-state TRANSITION:
   *
   *  - activated  → suppress known-military billboards NOW (mirror of the
   *    poll-time branch, tracked aircraft excluded — it hands off on untrack);
   *  - deactivated → the suppressed aircraft's state was deleted, so bring the
   *    next OpenSky poll forward instead of waiting out the interval (update()
   *    itself still honors _retryAt backoff).
   *
   * @param {boolean} active - New military-layer active state.
   * @returns {void}
   */

  function _onMilitaryActiveChange(active) {
    const icons = flightState._icons;
    if (!flightState._viewer || !icons) return;
    if (active) {
      const suppressed = [];
      for (const icao24 of icons.ids()) {
        if (isMilitaryIcao(icao24) && icao24 !== flightState._trackedIcao)
          suppressed.push(icao24);
      }
      // Military-suppression: drop each duplicate with any 3D model too.
      for (const icao24 of suppressed) parts.icons._forgetContact(icao24);
      flightState.feed._count = icons.count;
    } else if (icons.show) {
      // Fire-and-forget refresh; only while the layer is actually enabled.
      void flightsLayer.update(flightState._viewer);
    }
  }

  /**
   * Global keydown handler — Escape deselects the tracked flight.
   * @param {KeyboardEvent} e
   */

  function _onKeyDown(e) {
    if (e.key === 'Escape' && flightState._trackedIcao) {
      _cancelPendingTrackingRestore();
      _clearTracking(false, { origin: 'user' });
    }
  }

  /**
   * Install a click handler for flight selection: a pick names a draw-set
   * item by the contact's icao (see `aircraftPickId`). Also registers a
   * global keydown listener for the Escape key.
   *
   * Idempotent — returns immediately if a handler is already installed.
   *
   * @param {object} viewer
   */

  function _installClickHandler(viewer) {
    if (flightState._clickSubscription) return; // already installed

    // Cross-layer untrack: if ANOTHER layer (military, vessels, …) grabs the follow-camera, drop our
    // tracking so its model/entity/update-loop don't orphan — without touching the camera's follow
    // (the new owner controls it). Guarded so the intermediate untrack→retrack of OUR OWN switch
    // (the follow briefly ended) doesn't self-clear.
    if (!flightState._trackedEntityChangedRemove) {
      flightState._trackedEntityChangedRemove = onFollowChanged(
        viewer,
        (followed) => {
          if (
            flightState._trackedIcao &&
            flightState._viewer &&
            followed &&
            followed !== flightState._followTarget
          ) {
            _clearTracking(true, {
              origin: followed.selectionOrigin || 'programmatic',
            });
          }
        },
      );
    }

    flightState._clickSubscription = inputFor(viewer).onClick((event) => {
      const gesture = event.gesture;
      // Camera drags never select or deselect, even if they finish over a plane.
      // Duration alone is allowed through so a stationary long press can still
      // select/switch contacts; the destructive empty-space branch below applies
      // the full travel + duration click classifier.
      if (!isTrackingSelectionGesture(gesture)) return;
      // Cockpit mode owns the camera and keeps the current aircraft as its
      // first-person reference. A globe click must not fall through to the
      // normal empty-space deselection path; cockpit has explicit exit controls.
      if (document.body.classList.contains('cockpit-mode')) return;
      const picked = event.hit;

      if (picked) {
        // Clicking the plane we're ALREADY tracking (its tracked billboard, its
        // 3D model, or any pick carrying its icao) — ignore, don't deselect.
        // H1: the model used to have no pick id, so this fell through to
        // "empty space" and deselected the very plane being tracked.
        // Its billboard and models are draw-set items keyed by icao, like its icons.
        const pickedIcao = aircraftPickId(picked);
        if (flightState._trackedIcao && pickedIcao === flightState._trackedIcao)
          return;

        if (pickedIcao && flightState._icons?.has(pickedIcao)) {
          _cancelPendingTrackingRestore();
          _trackFlight(pickedIcao, { origin: 'user', keepView: true });
          return;
        }
      }

      // A pick that belongs to a sibling layer (military aircraft, satellite,
      // vessel, station, CCTV camera…) is not "empty space" — leave tracking
      // alone and let that layer handle it. resolvePickId String()-coerces the
      // heterogeneous pick ids (numeric NORAD ids, AIS record objects) so the
      // registry predicates can recognize them (H2).
      if (picked) {
        const pickedId = resolvePickId(picked);
        if (pickedId && isOwnedByOtherLayer('flights', pickedId)) return;
      }

      // Clicked empty space — deselect only for a clean, short click. A slow
      // stationary press may select above, but cannot release existing tracking.
      if (!isTrackingClickGesture(gesture)) return;
      if (flightState._trackedIcao) {
        _cancelPendingTrackingRestore();
        _clearTracking(false, { origin: 'user' });
      }
    });

    document.addEventListener('keydown', _onKeyDown);
  }
  return {
    _emitAwarenessEvent,
    _publishTrackedSelection,
    _contextSubjectMetadata,
    _isExplicitTrackingOrigin,
    _refreshCockpitNearContacts,
    _setCockpitContactMode,
    _applyCockpitState,
    _resetTrackedSelectionState,
    _trackedModelRegimeActive,
    _trackedBillboardLook,
    _trackedSprite,
    _syncTracked2dRotation,
    _appendTrailFix,
    _trailTick,
    _drawTrailHead,
    _trailHeadPositions,
    _refreshTrailDisplay,
    _startTrail,
    _backfillTrail,
    _clearTrail,
    _destroyTrail,
    /** Let the tracked billboard's set go (layer teardown). */
    _disposeTrackedIcon: () => trackedIcon.dispose(),
    /** The tracked billboard's set id, or null before one is made. */
    _clearTracking,
    _militaryLayerSuppresses,
    _applyPendingTrackingRestore,
    _cancelPendingTrackingRestore,
    _trackedLabelText,
    _trackedStaleCue,
    _trackedIconColor,
    _staleCueTick,
    _updateTrackedLabelModel,
    _syncTrackedBillboardImage,
    _refreshTr3bContact,
    _refreshTr3bForStyle,
    _routeIsPlausible,
    _trackFlight,
    _onMilitaryActiveChange,
    _onKeyDown,
    _installClickHandler,
  };
}
