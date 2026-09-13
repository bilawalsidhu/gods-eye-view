import * as Cesium from 'cesium';
import { t } from '../../i18n/index.js';
import { nextCockpitNearContacts } from '../../data/cockpitAirLod.js';
import { trackedModelZoomActive } from '../../data/trackedModelRegime.js';
import {
  screenProjectedRotation,
  stabilizeScreenRotation,
} from '../../data/iconOrientation.js';
import { trailHeadStart } from '../../data/modelVisualAnchor.js';
import { aircraftIcon, TRACKED_ICON_PX } from '../../data/aircraftIcons.js';
import { routePlausible } from '../../data/routePlausible.js';
import { CLASS_SCALE_2D } from '../../data/aircraftClass.js';
import {
  bindTrackingClickGesture,
  isTrackingSelectionGesture,
  isTrackingClickGesture,
} from '../../data/trackingClickGesture.js';
import {
  TRACKED_MODEL_MAX_LOAD_FAILS,
  TRACKED_MODEL_RETRY_BACKOFF_MS,
  TRAIL_MAX_POINTS,
  RENDER_DELAY_SEC,
  TRAIL_COLOR,
  CYAN_TRANSPARENT,
} from './policy.js';

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
  const { applyTrackedCameraFrame } = services.camera;
  const { resolvePickId, isOwnedByOtherLayer } = services.picking;
  const flightsLayer = layer;

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
    const bb = flightState._billboards.get(icao24);
    const info = flightState._flightData.get(icao24);
    if (!bb?.position || !info) return false;
    if (flightState._trackedEntity)
      flightState._trackedEntity.gevSelectionOrigin = origin;
    _emitAwarenessEvent('gev:awareness-subject-selected', {
      layerId: 'flights',
      id: icao24,
      // Canonical display chain (callsign → registration → hex). Publishing a
      // bare `callsign || icao24` here resurrected the pre-enrichment behavior:
      // a callsign-less contact reached Context as its raw hex even once adsbdb
      // had supplied a registration. Identity below stays `icao24`.
      label: parts.queries._contactLabel(icao24, info),
      position: Cesium.Cartesian3.clone(bb.position),
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
    const altFt = Math.round((described.altitudeM || 0) * 3.28084);
    const route =
      described.route && _routeIsPlausible(icao24, described.route)
        ? `${described.route.origin.code} → ${described.route.destination.code}`
        : null;
    return {
      id: icao24,
      layerId: 'flights',
      layerName: 'Live Flights',
      source: flightState._lastSource,
      label: parts.queries._contactLabel(
        icao24,
        flightState._flightData.get(icao24),
      ),
      latitude: described.latitude,
      longitude: described.longitude,
      // Flat text only: the voice payload compacts properties through a
      // string cleaner that drops nested objects.
      properties: {
        name: parts.queries._contactLabel(
          icao24,
          flightState._flightData.get(icao24),
        ),
        operator: described.airline || '',
        callsign: described.callsign || '',
        registration: described.registration || '',
        type: described.typeName || described.typeCode || '',
        altitude: described.onGround
          ? 'on ground'
          : `${altFt.toLocaleString('en-US')} ft`,
        speed: Number.isFinite(described.velocityMps)
          ? `${Math.round(described.velocityMps * 1.944)} kt`
          : '',
        heading: Number.isFinite(described.track)
          ? `${Math.round(described.track)}°`
          : '',
        route: route || '',
        icao24,
        // Honesty cue: the contact is coasting on dead reckoning, so the
        // narrated position/velocity are last-known rather than live.
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
    if (
      !flightState._cockpitContactMode ||
      !flightState._viewer?.camera?.positionWC
    ) {
      if (flightState._cockpitNearContacts.size)
        flightState._cockpitNearContacts = new Set();
      return;
    }
    const previous = flightState._cockpitNearContacts;
    const distancesSquared = [];
    for (const [icao24, bb] of flightState._billboards) {
      if (icao24 === flightState._trackedIcao || !bb?.position) continue;
      distancesSquared.push([
        icao24,
        Cesium.Cartesian3.distanceSquared(
          flightState._viewer.camera.positionWC,
          bb.position,
        ),
      ]);
    }
    const next = nextCockpitNearContacts(
      previous,
      distancesSquared,
      parts.rendering._modelAddDistM(),
      parts.rendering._modelKeepDistM(),
    );
    flightState._cockpitNearContacts = next;
    let presentationChanged = false;
    for (const [icao24, bb] of flightState._billboards) {
      if (previous.has(icao24) === next.has(icao24)) continue;
      parts.rendering._applyFleetBillboardPresentation(icao24, bb);
      presentationChanged = true;
    }
    if (presentationChanged) flightState._lastCamPoseSig = '';
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
    if (flightState._modelCollection) flightState._modelCollection.show = true;
    flightState._trail?.setVisible(!next);
    if (flightState._trailHeadEntity) flightState._trailHeadEntity.show = !next;
    for (const [icao24, bb] of flightState._billboards)
      parts.rendering._applyFleetBillboardPresentation(icao24, bb);
    flightState._lastCamPoseSig = '';
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

  /** Clear every per-SELECTION tracked-model latch: the zoom hysteresis band and
   *  the load-failure bound. Called from each path that changes which contact is
   *  selected — deselect, re-track, cross-layer handoff, init, destroy.
   *
   *  This must live in the production lifecycle, not only in the predicate's
   *  icao-change guard: a deselect followed by a same-turn re-track of the SAME
   *  icao (Contacts re-entry, a cross-layer round trip back to the original
   *  layer) never makes `_trackedIcao` *observably* change, so the guard never
   *  fires. Without the reset, a contact dropped inside the hysteresis band comes
   *  back as a MODEL above the ENTER ceiling, and a contact whose GLB had already
   *  failed out would never get its retries back. */

  function _resetTrackedSelectionState() {
    flightState._trackedZoomLatched = false;
    flightState._trackedZoomLatchIcao = null;
    flightState._trackedModelFailIcao = null;
    flightState._trackedModelFailCount = 0;
    flightState._trackedModelRetryAtMs = 0;
  }

  /** Whether the driver may start another tracked-model load this frame. */

  function _trackedModelLoadAllowed(nowMs = Date.now()) {
    if (flightState._trackedModelFailIcao !== flightState._trackedIcao)
      return true; // untried selection
    if (flightState._trackedModelFailCount >= TRACKED_MODEL_MAX_LOAD_FAILS)
      return false;
    return nowMs >= flightState._trackedModelRetryAtMs;
  }

  /** Record a rejected tracked-model load and arm the backoff / give-up latch. */

  function _noteTrackedModelLoadFailure(url, err) {
    if (flightState._trackedModelFailIcao !== flightState._trackedIcao) {
      flightState._trackedModelFailIcao = flightState._trackedIcao;
      flightState._trackedModelFailCount = 0;
    }
    flightState._trackedModelFailCount += 1;
    flightState._trackedModelRetryAtMs =
      Date.now() + TRACKED_MODEL_RETRY_BACKOFF_MS;
    if (flightState._trackedModelFailCount >= TRACKED_MODEL_MAX_LOAD_FAILS) {
      console.warn(
        `[Data:Flights] tracked 3D model gave up after ${flightState._trackedModelFailCount} failed loads of ${url} — ` +
          'this contact stays 2D until another is selected',
        err,
      );
    }
  }

  /**
   * The TRACKED aircraft's own model regime — DEFAULT-ON, camera-distance driven
   * (owner directive 2026-08-19). Unlike the fleet, this does NOT consult the
   * DISPLAY-rail `models3d` toggle: the selected contact is a single model, it is
   * what the camera is pointed at, and zooming in on a target should resolve it
   * into an aircraft without the operator arming anything. The toggle keeps
   * owning the FLEET (`_modelRegimeActive`), which is the draw-call budget.
   *
   * Thresholds + hysteresis live in trackedModelRegime.js: enter at
   * TRACKED_MODEL_ENTER_ALT_M (150_000 m — the owner's playtested swap distance,
   * deliberately NEARER than the fleet's 800 km ceiling this used to inherit),
   * hand back only above TRACKED_MODEL_EXIT_ALT_M, so orbiting AT the boundary
   * cannot flap billboard↔model. See that module's header for why the tracked
   * contact now goes 3D closer in than the fleet does.
   *
   * In cockpit you are sitting 7 m behind and 2.6 m above your own aircraft's
   * origin, so its ~26 m airframe would fill the visor. First-person means your
   * own airframe is not drawn.
   */

  function _trackedModelRegimeActive() {
    if (flightState._trackedZoomLatchIcao !== flightState._trackedIcao) {
      flightState._trackedZoomLatchIcao = flightState._trackedIcao;
      flightState._trackedZoomLatched = false;
    }
    // A converted TR-3B has no 3D asset — suppressing the regime keeps its
    // tracked billboard fully opaque (the colour callback reads this too), so
    // the triangle stays the visual all the way in.
    if (
      !flightState._trackedIcao ||
      flightState._cockpitContactMode ||
      isTr3b(flightState._trackedIcao)
    ) {
      flightState._trackedZoomLatched = false;
      return false;
    }
    flightState._trackedZoomLatched = trackedModelZoomActive(
      flightState._viewer?.camera?.positionCartographic?.height,
      flightState._trackedZoomLatched,
    );
    return flightState._trackedZoomLatched;
  }

  /** Seed the tracked billboard's 2D orientation before a 3D→2D handoff. */

  function _syncTracked2dRotation() {
    if (!flightState._trackedIcao || !flightState._viewer) return;
    const pos =
      parts.motion._trackedDisplayCached() ||
      flightState._billboards.get(flightState._trackedIcao)?.position;
    if (!pos) return;
    const projected = screenProjectedRotation(
      flightState._viewer.scene,
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
   * Append one fix to the tracked aircraft's trail accumulation and refresh
   * the rendered trail. Caller passes an owned (cloned) Cartesian3.
   * @param {Cesium.Cartesian3} position - New fix position, appended at the head.
   */

  function _appendTrailFix(position) {
    flightState._trailPositions.push(position);
    if (flightState._trailPositions.length > TRAIL_MAX_POINTS)
      flightState._trailPositions.shift();
    _refreshTrailDisplay();
  }

  /**
   * Renders the trail with its head clamped to the render-behind display
   * position. Raw newest fixes run up to RENDER_DELAY_SEC ahead of the
   * displayed aircraft (PRD C2 delayed clock) — drawing them verbatim makes
   * the trail extend in FRONT of the icon. The head is refreshed ~1Hz from
   * the fleet tick so it stays glued to the moving aircraft.
   */

  function _refreshTrailDisplay() {
    // The trail BODY is the accumulated fixes EXCLUDING the newest raw one — that newest
    // fix is at ~now, ~one poll interval AHEAD of the delayed icon (rendered at
    // now − RENDER_DELAY_SEC), so drawing it would push the trail in front of the plane.
    // The cheap per-frame _trailHeadEntity segment bridges the last body point to the
    // delayed dead-reckoned head, so the body primitive only rebuilds on a real fix
    // (poll cadence), never at motion cadence.
    if (!flightState._trail) return;
    flightState._trail.setPositions(
      flightState._trailPositions.length > 1
        ? flightState._trailPositions.slice(0, -1)
        : flightState._trailPositions,
    );
  }

  /**
   * Start the trail for a newly tracked aircraft: seed it with the short
   * dead-reckoning history (chronological), render immediately, then
   * fire-and-forget an OpenSky track backfill.
   * @param {string} icao24 - ICAO 24-bit transponder address being tracked.
   */

  function _startTrail(icao24) {
    flightState._trailBackfillToken += 1;
    flightState._trailPositions = [];
    const history = flightState._positionHistory.get(icao24) || [];
    // Seed only fixes at/behind the DELAYED display time (now − RENDER_DELAY_SEC). The
    // newest ~RENDER_DELAY_SEC of fixes are AHEAD of the displayed icon; including them
    // would draw the trail in front of the plane. They join the trail via _appendTrailFix
    // as they age past the delay.
    const seedRenderTime = Cesium.JulianDate.addSeconds(
      Cesium.JulianDate.now(),
      -RENDER_DELAY_SEC,
      flightState._scratchWarmupTime,
    );
    for (const fix of history) {
      if (Cesium.JulianDate.lessThanOrEquals(fix.time, seedRenderTime)) {
        flightState._trailPositions.push(Cesium.Cartesian3.clone(fix.position));
      }
    }
    if (!flightState._trail && flightState._viewer) {
      flightState._trail = createTrail(flightState._viewer, {
        color: TRAIL_COLOR,
        width: 2.5,
      });
    }
    flightState._trail?.setVisible(!flightState._cockpitContactMode);
    // Live head segment: last fix → current dead-reckoned icon, updated every frame via
    // a CallbackProperty (Cesium updates entity-polyline positions cheaply, unlike the
    // trail primitive which fully rebuilds on setPositions). Keeps the head glued to the
    // 12 Hz icon instead of lagging ~1 s behind it.
    if (!flightState._trailHeadEntity && flightState._viewer) {
      flightState._trailHeadEntity = flightState._viewer.entities.add({
        // 'gev-trail' namespace (round 6): claimed by trailRenderer's pick
        // owner so a click on the head segment never reads as empty space.
        id: `gev-trail:fl-head-${++flightState._trailHeadSeq}`,
        show: !flightState._cockpitContactMode,
        polyline: {
          positions: new Cesium.CallbackProperty(() => {
            // Need ≥2 accumulated points: the body draws all-but-newest, so the head must
            // start at the last DISPLAYED body point (index n−2). With a single fix that
            // point would be the sole raw fix — which is ~now, AHEAD of the delayed icon —
            // so the segment would draw IN FRONT of the plane. Likewise during warm-up the
            // icon predates all real history, so there is no valid body point behind it.
            if (
              !flightState._trackedIcao ||
              flightState._trailPositions.length < 2 ||
              parts.motion._isTrackWarmingUp()
            )
              return [];
            const head =
              parts.motion._trackedTrailCached() ||
              parts.motion._trackedDisplayPosition(flightState._trackedIcao);
            if (!head) return [];
            // body[n−2] (last displayed body point) → delayed head: runs FORWARD, never a
            // backward/reversing segment.
            const start =
              flightState._trailPositions[
                flightState._trailPositions.length - 2
              ];
            // On a contact that has not moved this segment runs from inside the
            // model out to its own anchor — a line through the fuselage. The END
            // never gives, so a moving trail still terminates on the tail; the
            // START is what slides, from nothing on a parked contact out to the
            // whole segment once it has cleared its own envelope.
            // See trailHeadStart. Read `head` in place and clone only on the draw
            // path — a suppressed parked contact runs this every frame.
            const from = trailHeadStart(
              start,
              head,
              parts.motion._trackedModelCenterWorld(),
              parts.motion._trackedModelEnvelopeM(),
              flightState._scratchTrailHead,
            );
            if (!from) return [];
            return [from, Cesium.Cartesian3.clone(head)];
          }, false),
          width: 2.5,
          material: Cesium.Color.fromCssColorString(TRAIL_COLOR).withAlpha(0.9),
          // Round 4: the head must never vanish into the mesh either (dimmed
          // when occluded so depth still reads).
          depthFailMaterial:
            Cesium.Color.fromCssColorString(TRAIL_COLOR).withAlpha(0.45),
          arcType: Cesium.ArcType.GEODESIC, // round 8: consistent with the trail body (no chords)
        },
      });
    }
    _refreshTrailDisplay();

    const oldestFixEpochSec = history.length
      ? Cesium.JulianDate.toDate(history[0].time).getTime() / 1000
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
    try {
      const track = await flightState._source.getTrack?.(
        flightState._flightData.get(icao24)?.sourceReference ?? icao24,
        {
          signal: AbortSignal.any([
            flightState.lifetime.signal,
            AbortSignal.timeout(8000),
          ]),
        },
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
      if (!Number.isFinite(time) || time >= oldestFixEpochSec) continue;
      parsed.push({ lat, lon, baroAlt });
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

    const older = [];
    let lastAltM = null; // carry-forward for no-baro points whose cell isn't warm yet
    for (const { lat, lon, baroAlt } of parsed) {
      const baroM = Number.isFinite(baroAlt)
        ? baroAlt + geoidHeight(lat, lon)
        : null;
      let altM = floorAltitudeM(baroM, cachedGroundFloor(lat, lon));
      // No baro + unresolved floor: hold the previous waypoint's altitude
      // (continuity — never a dive/spike to a made-up height). Leading points
      // with nothing to carry keep the old 10 km airborne default.
      if (altM == null) altM = lastAltM != null ? lastAltM : 10000;
      lastAltM = altM;
      older.push(Cesium.Cartesian3.fromDegrees(lon, lat, altM));
    }

    flightState._trailPositions = older.concat(flightState._trailPositions);
    if (flightState._trailPositions.length > TRAIL_MAX_POINTS) {
      flightState._trailPositions = flightState._trailPositions.slice(
        flightState._trailPositions.length - TRAIL_MAX_POINTS,
      );
    }
    _refreshTrailDisplay();
  }

  /**
   * Clear the rendered trail and accumulation; invalidate pending backfills.
   */

  function _clearTrail() {
    flightState._trailBackfillToken += 1;
    flightState._trailPositions = [];
    if (flightState._trail) flightState._trail.clear();
    if (
      flightState._trailHeadEntity &&
      flightState._viewer &&
      !flightState._viewer.isDestroyed()
    ) {
      try {
        flightState._viewer.entities.remove(flightState._trailHeadEntity);
      } catch {
        /* already gone */
      }
    }
    flightState._trailHeadEntity = null;
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
   *   follow-camera: tear down our own state but leave viewer.trackedEntity
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
    flightState._trackedCameraFrameStop?.();
    flightState._trackedCameraFrameStop = null;
    if (!flightState._trackedIcao) {
      clearFocusTarget('flights');
      return;
    }
    const clearedIcao = flightState._trackedIcao;
    clearFocusTarget('flights', clearedIcao);

    // Restore the original billboard appearance. The rotation is re-seeded from
    // the tracked entity's last rendered rotation and a rotation pass is forced
    // (_lastCamPoseSig below): the fleet billboard otherwise reappears with the
    // STALE screen rotation it had when tracking began — up to a full
    // ROTATION_REFRESH_MS of a wrong (possibly reversed) nose on release.
    if (flightState._billboards.has(flightState._trackedIcao)) {
      const bb = flightState._billboards.get(flightState._trackedIcao);
      bb.show = true;
      bb.width = 20;
      bb.height = 20;
      // Ground/military-aware restore (a plane untracked while taxiing must come
      // back muted-gray at ground scale, not white at full scale).
      bb.color = parts.rendering._fleetBillboardColor(flightState._trackedIcao);
      bb.scale = parts.rendering._fleetBillboardScale(
        flightState._trackedIcao,
        flightState._flightData.get(flightState._trackedIcao)?.klass,
      );
      bb.rotation = flightState._lastTrackedRotation;
    }
    flightState._lastCamPoseSig = ''; // force a fleet rotation pass on the next tick

    // Stop tracking and remove the entity. skipViewerUntrack: when ANOTHER layer just grabbed the
    // follow-camera, we tear down our own state but must NOT clear viewer.trackedEntity (the new owner
    // controls it now — clearing it would yank the camera off their plane). Releasing trackedEntity
    // does NOT move the camera: Cesium resets the lookAt transform in place, so the view stays where
    // the follow left it and the user can immediately orbit/zoom.
    if (flightState._viewer && !skipViewerUntrack) {
      flightState._viewer.trackedEntity = undefined;
    }
    if (flightState._trackedEntity) {
      flightState._viewer.entities.remove(flightState._trackedEntity);
      flightState._trackedEntity = null;
    }
    parts.rendering._releaseTrackedModel();
    _resetTrackedSelectionState(); // the zoom band + load-failure budget belong to the selection we just dropped
    flightState._trackedIcao = null;
    parts.rendering._applyFleetBillboardPresentation(
      clearedIcao,
      flightState._billboards.get(clearedIcao),
    );
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
    if (
      !flightState._billboardCollection?.show ||
      !flightState._billboards.has(pending.id)
    )
      return false;
    flightState._pendingTrackingRestore = null;
    _trackFlight(pending.id, { origin: pending.origin });
    return true;
  }

  function _cancelPendingTrackingRestore() {
    flightState._trackingIntentGeneration += 1;
    flightState._pendingTrackingRestore = null;
  }

  /** Multi-line tracked presentation text: "CS · FL · kts" + "Airline · Type" +
   *  "ORIG → DEST". The route line is gated by
   *  routePlausible so a wrong-leg adsbdb route is hidden, not displayed.
   *  While the plane is in its missed-poll grace (coasting on dead reckoning
   *  with sticky metadata), the first line carries a "· STALE" cue — the fleet's
   *  45%-alpha billboard fade doesn't apply to the tracked plane (its entity
   *  owns the visual), so without this the readout would present last-known
   *  velocity/altitude as live. */

  function _trackedLabelText(icao24) {
    const info = flightState._flightData.get(icao24);
    if (!info) return icao24;
    // A whitespace-only callsign ("   ") is truthy, so `(info.callsign || icao24)`
    // kept it, then .trim() emptied it → the callsign slot dropped out of the
    // readout. `_contactLabel` trims FIRST, then falls through registration to
    // the ICAO hex, so a callsign-less enriched contact heads its readout with
    // the tail number rather than raw hex.
    const cs = parts.queries._contactLabel(icao24, info);
    const altFt = Math.round((info.altitude || 0) * 3.28084);
    const fl = altFt >= 18000 ? `FL${Math.round(altFt / 100)}` : `${altFt} ft`;
    const spd = info.velocity ? `${Math.round(info.velocity * 1.944)} kts` : '';
    const stale =
      flightState._missingPolls.get(icao24) || flightState._backoff
        ? t('layers.status.stale')
        : '';
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
    flightState._trackedEntity.gevLabelModel = trackedLabelModelFromText(
      _trackedLabelText(icao24),
      '#39d0ff',
    );
    refreshTrackedReadout(flightState._trackedEntity);
    // The readout and the context slot describe the same contact — refresh them
    // together so voice never narrates a fix the card has already replaced.
    refreshTrackedSubjectContext(_contextSubjectMetadata(icao24));
  }

  /** Re-image the tracked entity's billboard from the current class/conversion. */

  function _syncTrackedBillboardImage() {
    if (!flightState._trackedIcao || !flightState._trackedEntity?.billboard)
      return;
    flightState._trackedEntity.billboard.image = aircraftIcon(
      parts.rendering._iconKind(
        flightState._trackedIcao,
        flightState._flightData.get(flightState._trackedIcao)?.klass,
      ),
      TRACKED_ICON_PX,
    );
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
      if (flightState._models.has(id) || flightState._modelPending.has(id))
        parts.rendering._releaseModel(id);
      const bb = flightState._billboards.get(id);
      if (bb && id !== flightState._trackedIcao) bb.show = true; // horizon cull re-asserts next tick
      if (id === flightState._trackedIcao) {
        parts.rendering._releaseTrackedModel();
        _syncTracked2dRotation();
      }
    }
    const bb = flightState._billboards.get(id);
    if (bb) parts.rendering._applyFleetBillboardPresentation(id, bb);
    if (id === flightState._trackedIcao) {
      _syncTrackedBillboardImage();
      _updateTrackedLabelModel(id);
    }
    flightState._viewer?.scene?.requestRender?.();
    return flightState._billboards.has(id) || id === flightState._trackedIcao;
  }

  /** Re-image every converted contact this layer owns (IR style flip). */

  function _refreshTr3bForStyle() {
    for (const id of tr3bConvertedIds()) {
      if (flightState._billboards.has(id) || id === flightState._trackedIcao)
        _refreshTr3bContact(id);
    }
  }

  /** Plausibility check anchored to the plane's billboard position (coarse is
   *  fine here — this gates a LABEL, and it must not touch the tracked frame
   *  cache). Missing data → true (never hide what we can't judge). */

  function _routeIsPlausible(icao24, route) {
    const info = flightState._flightData.get(icao24);
    const bb = flightState._billboards.get(icao24);
    if (!info || !bb || !bb.position) return true;
    const carto = Cesium.Cartographic.fromCartesian(
      bb.position,
      Cesium.Ellipsoid.WGS84,
      flightState._scratchCarto,
    );
    if (!carto) return true;
    return routePlausible({
      latDeg: Cesium.Math.toDegrees(carto.latitude),
      lonDeg: Cesium.Math.toDegrees(carto.longitude),
      altitudeM: info.altitude ?? null,
      verticalRateMps: info.verticalRate ?? null,
      origin: route.origin,
      destination: route.destination,
    });
  }

  /**
   * Begin tracking a specific aircraft by ICAO24 address.
   *
   * Clears any existing tracked flight, hides its billboard, and creates a
   * new Entity with:
   *  - A CallbackProperty position driven by dead-reckoning (_deadReckon).
   *  - A CallbackProperty alignedAxis set to the surface normal at the
   *    dead-reckoned position (keeps the icon tangent to the earth).
   *  - A CallbackProperty rotation from the aircraft's true_track heading.
   *  - An explicit host presentation model with callsign, flight level, speed,
   *    identity, and plausible route text.
   *
   * The viewer's trackedEntity is set to this entity so the camera follows it.
   *
   * @param {string} icao24 - ICAO 24-bit transponder address to track.
   */

  function _trackFlight(icao24, { origin = 'programmatic' } = {}) {
    _clearTracking(false, { origin }); // switching planes — the new follow-camera takes over

    const bb = flightState._billboards.get(icao24);
    const info = flightState._flightData.get(icao24);
    if (!bb || !info) return;

    flightState._trackedIcao = icao24;
    _resetTrackedSelectionState(); // fresh selection: enter at the ENTER ceiling, full load-retry budget
    flightState._cachedDRFrame = -1;
    flightState._lastTrackedRotation = bb.rotation || 0;
    // Drop any fleet 3D model for this aircraft — the tracked entity now owns its visual (its
    // own billboard + model graphic), and the fleet tick skips the tracked icao, so a leftover
    // fleet model would be orphaned + double-rendered.
    parts.rendering._releaseModel(icao24);

    // Hide the billboard — the tracked entity replaces it visually
    bb.show = false;

    // Helper: smoothed, per-frame-cached tracked position (see _trackedDisplayPosition —
    // one computation shared by the position/alignedAxis/rotation/trail-head callbacks,
    // with discontinuity reconciliation). Falls back to the last billboard position when
    // the aircraft has no fix.
    const getTrackedPosition = () =>
      parts.motion._trackedDisplayPosition(icao24) || bb.position;

    // Dead-reckoning position property — smooth continuous motion between API updates.
    const positionProperty = new Cesium.CallbackProperty(() => {
      return getTrackedPosition();
    }, false);

    // Create tracked entity: a 2D billboard when zoomed out, a 3D model when zoomed in past the
    // TRACKED altitude ceiling. That handoff is DEFAULT behaviour — it does NOT wait on the
    // DISPLAY-rail 3D toggle, which arms the FLEET. The plane the user zooms into always
    // resolves into an aircraft.
    //
    // The billboard stays SHOWN at all times and is hidden by going TRANSPARENT (alpha 0), not by
    // show=false. This is deliberate: viewer.trackedEntity derives the follow-camera framing from
    // the entity's bounding sphere, and a 3D model graphic reports a PENDING sphere until its glTF
    // finishes loading. If we hid the billboard outright, tracking a plane while already zoomed in
    // would stall the centering until the model loaded. A shown-but-transparent billboard always
    // supplies a ready sphere, so framing is instant; we only drop its alpha once the model GLB is
    // preloaded (_planeModelLoaded), so there's neither a billboard+model double-image nor a gap.
    // The tracked entity is a PURE BILLBOARD — no label or model graphic. The 3D model for the
    // tracked plane is a standalone primitive driven by _updateTrackedModel(); keeping it off the
    // entity is what makes the follow-camera's bounding sphere always ready (see _trackedModel).
    // Keep Cesium's generated entity ID: re-init without destroy can temporarily
    // overlap collections, and an explicit ICAO ID would throw on that duplicate.
    flightState._trackedEntity = flightState._viewer.entities.add({
      position: positionProperty,
      // Force Cesium's built-in EntityView and our close-range camera guard to
      // use the same local frame. AUTO can select a velocity frame while the
      // model matrix uses aircraft orientation; alternating between those
      // frames makes the target oscillate forward/back on screen.
      trackingReferenceFrame: Cesium.TrackingReferenceFrame.ENU,
      billboard: {
        image: aircraftIcon(
          parts.rendering._iconKind(
            flightState._trackedIcao,
            flightState._flightData.get(flightState._trackedIcao)?.klass,
          ),
          TRACKED_ICON_PX,
        ),
        width: 28,
        height: 28,
        scale:
          CLASS_SCALE_2D[
            flightState._flightData.get(flightState._trackedIcao)?.klass
          ] || 1,
        // Solid cyan when the billboard is the visual (zoomed out, 3D off, or model still loading);
        // transparent once the STANDALONE tracked model is actually up (ready + shown).
        color: new Cesium.CallbackProperty(
          () =>
            parts.rendering._modelOwnsVisual(flightState._trackedIcao)
              ? CYAN_TRANSPARENT
              : Cesium.Color.CYAN,
          false,
        ),
        sizeInMeters: false,
        scaleByDistance: new Cesium.NearFarScalar(1000, 3.0, 8000000, 0.5),
        alignedAxis: Cesium.Cartesian3.ZERO,
        // The tracked target must never vanish into tile geometry — tracking a
        // taxiing plane at street level would otherwise bury the cyan icon inside
        // the runway skin exactly like the fleet ground icons (_groundDepthDistance);
        // its shared-host tracked card is top-composited separately.
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        // Screen-projected rotation, evaluated per frame: exact in tracked-orbit
        // mode where camera.heading lives in the entity's reference frame.
        rotation: new Cesium.CallbackProperty(() => {
          const tracked = flightState._flightData.get(flightState._trackedIcao);
          const pos = getTrackedPosition();
          if (!tracked || !pos || !flightState._viewer)
            return flightState._lastTrackedRotation;
          const projected = screenProjectedRotation(
            flightState._viewer.scene,
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
        }, false),
      },
    });
    flightState._trackedEntity.gevSelectionOrigin = origin;
    flightState._trackedEntity.gevTrackedId = `flights:${icao24}`;
    flightState._trackedEntity.gevLabelModel = trackedLabelModelFromText(
      _trackedLabelText(icao24),
      '#39d0ff',
    );

    // A billboard has a ~zero bounding sphere, so Cesium's default follow distance is
    // far too tight (the user had to scroll out to read the plane). Give the entity a
    // calibrated viewFrom — behind + above, distance scaled to altitude — for a readable
    // initial frame with surrounding context. (ENU: east=+X, north=+Y, up=+Z.)
    const followRange = Math.min(
      Math.max((info.altitude || 1500) * 1.1 + 2500, 3000),
      30000,
    );
    flightState._trackedEntity.viewFrom = new Cesium.Cartesian3(
      0,
      -followRange * 0.8,
      followRange * 0.55,
    );

    // Cancel any in-progress camera flight first — otherwise Cesium won't apply the
    // tracked entity's viewFrom on the first frame, so voice-initiated tracking (which
    // often fires mid-fly_to_location) would follow the plane WITHOUT centering/framing it
    // the way a click (idle camera) does.
    // Expose the camera's already-settled position to cross-module HUD consumers (the tracked-target
    // readout) so they draw at the SAME spot the camera framed, without recomputing the dead-reckon in
    // postRender (which would jitter the label against the now-stable plane).
    flightState._trackedEntity.gevDisplayPosition =
      parts.motion._trackedDisplayCached;
    // Separate accessor on purpose: `gevDisplayPosition` carries the follow-camera
    // anti-jitter contract and must keep returning the cached DR position. Presentation
    // that should weld to the AIRCRAFT YOU SEE reads `gevVisualPosition` instead.
    flightState._trackedEntity.gevVisualPosition =
      parts.motion._trackedVisualCached;
    refreshTrackedReadout(flightState._trackedEntity);
    flightState._viewer.camera.cancelFlight();
    // Camera follows the tracked entity
    flightState._viewer.trackedEntity = flightState._trackedEntity;
    flightState._trackedCameraFrameStop =
      applyTrackedCameraFrame(
        flightState._viewer,
        flightState._trackedEntity,
        flightState._trackedEntity.viewFrom,
      ) || null;

    // Track-history trail (PRD F1): seed from local history + async backfill.
    // Ground traffic draws NO trail (a taxi path is noise, not a track) — if the
    // plane takes off while tracked, the on_ground→false transition in update()
    // starts one.
    parts.enrichment._requestTypeEnrichment(icao24, true); // tracked plane — front of the enrichment queue
    parts.enrichment._requestRouteEnrichment(icao24);
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
    if (!flightState._viewer || !flightState._billboardCollection) return;
    if (active) {
      for (const [icao24, bb] of flightState._billboards) {
        if (!isMilitaryIcao(icao24) || icao24 === flightState._trackedIcao)
          continue;
        flightState._billboardCollection.remove(bb);
        flightState._billboards.delete(icao24);
        parts.rendering._releaseModel(icao24); // military-suppression: drop any 3D model too
        flightState._flightData.delete(icao24);
        flightState._positionHistory.delete(icao24);
        flightState._displayCourse.delete(icao24);
        flightState._groundSnap.forget(icao24);
        flightState._missingPolls.delete(icao24);
      }
      flightState._count = flightState._billboards.size;
    } else if (flightState._billboardCollection.show) {
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
   * Install a LEFT_CLICK handler on the scene canvas for flight selection.
   *
   * Picking logic checks both `picked.primitive` and `picked.id` because
   * different CesiumJS versions surface BillboardCollection hits differently.
   * Also registers a global keydown listener for the Escape key.
   *
   * Idempotent — returns immediately if a handler is already installed.
   *
   * @param {Cesium.Viewer} viewer
   */

  function _installClickHandler(viewer) {
    if (flightState._clickHandler) return; // already installed

    // Cross-layer untrack: if ANOTHER layer (military, vessels, …) grabs the follow-camera, drop our
    // tracking so its model/entity/update-loop don't orphan — without touching viewer.trackedEntity
    // (the new owner controls it). Guarded so the intermediate untrack→retrack of OUR OWN switch
    // (viewer.trackedEntity briefly undefined) doesn't self-clear.
    if (!flightState._trackedEntityChangedRemove) {
      flightState._trackedEntityChangedRemove =
        viewer.trackedEntityChanged.addEventListener(() => {
          if (
            flightState._trackedIcao &&
            flightState._viewer &&
            flightState._viewer.trackedEntity &&
            flightState._viewer.trackedEntity !== flightState._trackedEntity
          ) {
            _clearTracking(true, {
              origin:
                flightState._viewer.trackedEntity?.gevSelectionOrigin ||
                'programmatic',
            });
          }
        });
    }

    flightState._clickHandler = new Cesium.ScreenSpaceEventHandler(
      viewer.scene.canvas,
    );
    bindTrackingClickGesture(flightState._clickHandler, (click, gesture) => {
      // Camera drags never select or deselect, even if they finish over a plane.
      // Duration alone is allowed through so a stationary long press can still
      // select/switch contacts; the destructive empty-space branch below applies
      // the full travel + duration click classifier.
      if (!isTrackingSelectionGesture(gesture)) return;
      // Cockpit mode owns the camera and keeps the current aircraft as its
      // first-person reference. A globe click must not fall through to the
      // normal empty-space deselection path; cockpit has explicit exit controls.
      if (document.body.classList.contains('cockpit-mode')) return;
      const picked = viewer.scene.pick(click.position);

      if (picked) {
        // Clicking the tracked entity itself — ignore (don't deselect)
        if (picked.id === flightState._trackedEntity) return;

        // Clicking the plane we're ALREADY tracking (its standalone 3D model or
        // any pick carrying its icao) — same no-op as the 2D tracked-entity click
        // above. H1: the model used to have no pick id, so this fell through to
        // "empty space" and deselected the very plane being tracked.
        if (flightState._trackedIcao) {
          const rawPick =
            typeof picked.id === 'string' ? picked.id : picked.primitive?.id;
          if (
            picked.primitive === flightState._trackedModel ||
            rawPick === flightState._trackedIcao
          )
            return;
        }

        // For BillboardCollection picks, the billboard may be at picked.primitive or picked.id
        const billboard = picked.primitive;
        if (
          billboard &&
          billboard.id &&
          flightState._billboards.has(billboard.id)
        ) {
          _cancelPendingTrackingRestore();
          _trackFlight(billboard.id, { origin: 'user' });
          return;
        }
        // Some CesiumJS versions surface the id as a string on picked.id instead
        if (
          picked.id &&
          typeof picked.id === 'string' &&
          flightState._billboards.has(picked.id)
        ) {
          _cancelPendingTrackingRestore();
          _trackFlight(picked.id, { origin: 'user' });
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
    _trackedModelLoadAllowed,
    _noteTrackedModelLoadFailure,
    _trackedModelRegimeActive,
    _syncTracked2dRotation,
    _appendTrailFix,
    _refreshTrailDisplay,
    _startTrail,
    _backfillTrail,
    _clearTrail,
    _destroyTrail,
    _clearTracking,
    _militaryLayerSuppresses,
    _applyPendingTrackingRestore,
    _cancelPendingTrackingRestore,
    _trackedLabelText,
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
