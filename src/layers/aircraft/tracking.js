import { bindOverlayHost } from '../../overlays/bindOverlayHost.js';
import * as geo from '../../geo/index.js';
import { nearFarScale } from '../shared/color.js';
import { nextCockpitNearContacts } from '../../data/cockpitAirLod.js';
import { trackedModelZoomActive } from '../../data/trackedModelRegime.js';
import {
  screenProjectedRotation,
  stabilizeScreenRotation,
} from '../../data/iconOrientation.js';
import { trailHeadStart } from '../../data/modelVisualAnchor.js';
import { aircraftIcon, TRACKED_ICON_PX } from '../../data/aircraftIcons.js';
import { CLASS_SCALE_2D } from '../../data/aircraftClass.js';
import {
  drawTrailSegments,
  historyFixEpochMs,
  insertTrailFix,
  joinTrailBackfill,
  recordTrailPoint,
  trailBackfillFixes,
  trailBodyCount,
  trailBodyCountOutsideModel,
  trailBodySegments,
  trailHeadStartFix,
  trailRecordingBlocked,
  TRAIL_RECORD_STEP_M,
  TRAIL_RECORD_STEP_MS,
} from '../../data/trailContinuity.js';
import { roundHeadingDegrees } from '../../data/headingDegrees.js';

/**
 * Selection, follow camera and track history shared by the observed aircraft
 * layers (civil flights and military). Everything a layer does differently
 * arrives as an explicit parameter; the layer's own tracking module adds its
 * extra rules (the civil layer's military suppression and route gate, the
 * military layer's tracked card) around the returned parts.
 *
 * @param {object} options
 * @param {string} options.layerId Layer id in awareness events, the context
 *   slot, the tracked entity id and the selection dispatcher.
 * @param {string} options.layerName Layer name in the context slot.
 * @param {string} options.focusId Focus-target owner id.
 * @param {string} options.logTag Console prefix.
 * @param {string} options.trailHeadIdPrefix Trail-head entity id prefix.
 * @param {object} options.policy The layer's RENDER_DELAY_SEC, TRAIL_COLOR,
 *   TRAIL_MAX_POINTS, TRACKED_MODEL_MAX_LOAD_FAILS and
 *   TRACKED_MODEL_RETRY_BACKOFF_MS.
 * @param {{ color: object, transparentColor: object, labelColor: string,
 *   baseScale: number }} options.trackedStyle Tracked billboard and card style.
 * @param {(icao24: string, info: object) => string} options.contactLabel
 *   Display name of a contact (selection event, console).
 * @param {(icao24: string) => string} options.trackedLabelText Tracked card
 *   text.
 * @param {(icao24: string, described: object) => { label: string,
 *   operator: string, type: string, altitude: string, extra: object }}
 *   options.contextFields The context slot's layer-specific fields.
 * @param {(icao24: string, meta: object|undefined) => number}
 *   options.fleetBillboardScale Fleet billboard scale restored on untrack.
 * @param {(info: object) => number|null} options.followAltitudeM Altitude (m)
 *   the initial follow range scales with; falsy means the 1500 m default.
 * @param {(icao24: string) => void} [options.onTrackStart] Runs when a new
 *   selection (not a resume) starts, before its trail.
 * @param {boolean} options.floorTrail Lift every trail position onto the warm
 *   ground floor (for a layer whose grounded fixes keep the pre-datum height).
 */
export function createAircraftTracking({
  flightState,
  services,
  parts,
  layerId,
  layerName,
  focusId,
  logTag,
  trailHeadIdPrefix,
  policy,
  trackedStyle,
  contactLabel,
  trackedLabelText,
  contextFields,
  fleetBillboardScale,
  followAltitudeM,
  onTrackStart,
  floorTrail,
}) {
  const {
    displayDelayMs,
    followsClock,
    DR_CORRECTION_MS,
    TRAIL_COLOR,
    TRAIL_MAX_POINTS,
    TRACKED_MODEL_MAX_LOAD_FAILS,
    TRACKED_MODEL_RETRY_BACKOFF_MS,
  } = policy;
  const {
    selectTrackedSubjectContext,
    clearTrackedSubjectContext,
    refreshTrackedSubjectContext,
  } = bindOverlayHost(services.context, () => flightState._renderer?.engine);
  const { isTr3b, tr3bConvertedIds } = services.aircraftPresentation;
  const { ensureGeoidReady, geoidHeight } = services.geoid;
  const { resolveGroundFloorCellsBounded, floorAltitudeM, cachedGroundFloor } =
    services.groundFloor;
  const { clearFocusTarget } = services.focus;
  const { trackedLabelModelFromText, refreshTrackedReadout } = services.readout;
  const { selectionDispatcherFor } = services.selection;

  function _emitAwarenessEvent(type, detail) {
    if (services.context.forEngine && flightState._renderer?.engine) {
      services.context
        .forEngine(flightState._renderer?.engine)
        ?.publishAwareness(type, detail);
      return;
    }
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
    const info = flightState.records.data.get(icao24);
    if (!bb?.position || !info) return false;
    if (flightState._trackedEntity)
      flightState._trackedEntity.gevSelectionOrigin = origin;
    _emitAwarenessEvent('gev:awareness-subject-selected', {
      layerId,
      id: icao24,
      // Canonical display chain (callsign → registration → hex). Publishing a
      // bare `callsign || icao24` here resurrected the pre-enrichment behavior:
      // a callsign-less contact reached Context as its raw hex even once adsbdb
      // had supplied a registration. Identity below stays `icao24`.
      label: contactLabel(icao24, info),
      position: geo.cartesian3.clone(bb.position),
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
    const { label, operator, type, altitude, extra } = contextFields(
      icao24,
      described,
    );
    return {
      id: icao24,
      layerId,
      layerName,
      source: flightState.feed._lastSource,
      label,
      latitude: described.latitude,
      longitude: described.longitude,
      // Flat text only: the voice payload compacts properties through a
      // string cleaner that drops nested objects.
      properties: {
        name: label,
        operator,
        callsign: described.callsign || '',
        registration: described.registration || '',
        type,
        altitude,
        speed: Number.isFinite(described.velocityMps)
          ? `${Math.round(described.velocityMps * 1.944)} kt`
          : '',
        heading: Number.isFinite(described.track)
          ? `${roundHeadingDegrees(described.track)}°`
          : '',
        ...extra,
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
    const camera = flightState._renderer?.view.camera;
    if (!flightState._cockpitContactMode || !camera?.positionWC) {
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
        geo.cartesian3.distanceSquared(camera.positionWC, bb.position),
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
    flightState._renderer?.models.setVisible(true);
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

  /** Write the explicit tracked presentation model and refresh its host entry. */

  function _updateTrackedLabelModel(icao24) {
    if (!flightState._trackedEntity || icao24 !== flightState._trackedIcao)
      return;
    flightState._trackedEntity.gevLabelModel = trackedLabelModelFromText(
      trackedLabelText(icao24),
      trackedStyle.labelColor,
    );
    refreshTrackedReadout(
      flightState._trackedEntity,
      flightState._renderer?.engine,
    );
    // The readout and the context slot describe the same contact — refresh them
    // together so voice never narrates a fix the card has already replaced.
    refreshTrackedSubjectContext(_contextSubjectMetadata(icao24));
  }

  /** Re-image the tracked entity's billboard from the current class/conversion. */

  function _syncTrackedBillboardImage() {
    if (!flightState._trackedIcao || !flightState._trackedEntity) return;
    flightState._renderer.tracked.setImage(
      flightState._trackedEntity,
      aircraftIcon(
        parts.rendering._iconKind(
          flightState._trackedIcao,
          flightState.records.data.get(flightState._trackedIcao)?.klass,
        ),
        TRACKED_ICON_PX,
      ),
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
    flightState._renderer?.view.requestRender();
    return flightState._billboards.has(id) || id === flightState._trackedIcao;
  }

  /** Re-image every converted contact this layer owns (IR style flip). */

  function _refreshTr3bForStyle() {
    for (const id of tr3bConvertedIds()) {
      if (flightState._billboards.has(id) || id === flightState._trackedIcao)
        _refreshTr3bContact(id);
    }
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
        `${logTag} tracked 3D model gave up after ${flightState._trackedModelFailCount} failed loads of ${url} — ` +
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
      flightState._renderer?.view.camera?.positionCartographic?.height,
      flightState._trackedZoomLatched,
    );
    return flightState._trackedZoomLatched;
  }

  /** Seed the tracked billboard's 2D orientation before a 3D→2D handoff. */

  function _syncTracked2dRotation() {
    if (!flightState._trackedIcao || !flightState._renderer) return;
    const pos =
      parts.motion._trackedDisplayCached() ||
      flightState._billboards.get(flightState._trackedIcao)?.position;
    if (!pos) return;
    const projected = screenProjectedRotation(
      flightState._renderer.view.scene,
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
   * Field-test round 2 (2026-07-06): floors a trail-bound position at the warm
   * coarse ground cell — a pure LIFT (above-floor positions pass through
   * untouched, unknown floors change nothing). Grounded military billboards
   * deliberately render at the pre-datum default height (T7 groundSnap
   * invariant), so with `floorTrail` every position entering the TRAIL
   * subsystem (seed, append, per-frame head) goes through this instead — the
   * visible taxi history sits on the surface without touching the
   * billboard/model machinery. Grounded civil positions are already
   * surface-clamped (the surfaceM chain), so that layer skips it.
   * @param {object} position - Owned position (Cartesian3; mutated/replaced freely).
   * @returns {object} The same or a lifted position.
   */

  function _trailFloorPosition(position) {
    const carto = geo.cartographic.fromCartesian(
      position,
      geo.ellipsoid.WGS84,
      flightState._scratchTrailCarto,
    );
    if (!carto) return position;
    const latDeg = geo.math.toDegrees(carto.latitude);
    const lonDeg = geo.math.toDegrees(carto.longitude);
    const floored = floorAltitudeM(
      carto.height,
      cachedGroundFloor(latDeg, lonDeg),
    );
    if (floored == null || floored === carto.height) return position;
    return geo.cartesian3.fromDegrees(lonDeg, latDeg, floored);
  }

  /**
   * Put one report into the tracked aircraft's trail, in time order, and
   * refresh the rendered trail. Caller passes an owned (cloned) Cartesian3. A
   * report that breaks from its neighbour starts a new segment (see
   * trailContinuity).
   * @param {object} position - The report's position.
   * @param {number} [epochMs] - The report's time; defaults to the tracked
   *   aircraft's newest position-history fix, which every caller has just pushed.
   * @param {{nullAltitude?: boolean}} [options] - `nullAltitude`: the report
   *   had no altitude, so its position is not kept and the line breaks there.
   *   A report for a time the display has already passed replaces what was
   *   drawn after it (see `insertTrailFix`).
   */

  function _appendTrailFix(position, epochMs, { nullAltitude = false } = {}) {
    const history = flightState._positionHistory.get(flightState._trackedIcao);
    const timeMs = Number.isFinite(epochMs)
      ? epochMs
      : historyFixEpochMs(history?.[history.length - 1]);
    insertTrailFix(
      flightState._trailFixes,
      floorTrail ? _trailFloorPosition(position) : position,
      timeMs,
      TRAIL_MAX_POINTS,
      {
        nullAltitude,
        displayMs: flightState.now() - displayDelayMs(flightState),
        settleMs: DR_CORRECTION_MS,
      },
    );
    _refreshTrailDisplay();
  }

  /**
   * Per-frame trail work, run from the layer's preRender pass whether or not
   * the head is visible: record where the tracked icon is drawn (at most once
   * a second or every 150 m) and move the body on as the display time passes
   * reports. The head callback only reads the result.
   */

  function _trailTick() {
    if (!flightState._trackedIcao || !flightState._trail) return;
    const displayMs = flightState.now() - displayDelayMs(flightState);
    let changed = false;
    if (
      flightState._trailFixes.length &&
      !parts.motion._isTrackWarmingUp() &&
      !trailRecordingBlocked(flightState._trailFixes, displayMs)
    ) {
      const drawn = parts.motion._trackedDisplayPosition(
        flightState._trackedIcao,
      );
      const last = flightState._trailRecordPosition;
      if (
        drawn &&
        (!last ||
          displayMs - flightState._trailRecordMs >= TRAIL_RECORD_STEP_MS ||
          geo.cartesian3.distance(last, drawn) >= TRAIL_RECORD_STEP_M)
      ) {
        flightState._trailRecordMs = displayMs;
        flightState._trailRecordPosition = geo.cartesian3.clone(
          drawn,
          flightState._trailRecordPosition ?? undefined,
        );
        changed = recordTrailPoint(
          flightState._trailFixes,
          floorTrail
            ? _trailFloorPosition(geo.cartesian3.clone(drawn))
            : geo.cartesian3.clone(drawn),
          displayMs,
          TRAIL_MAX_POINTS,
        );
      }
    }
    if (changed || _trailBodyCountNow() !== flightState._trailBodyCount)
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
    // The trail BODY is the accumulated fixes at or before the delayed display time
    // (now − RENDER_DELAY_SEC); newer fixes are AHEAD of the icon, so drawing them
    // would push the trail in front of the plane. The cheap per-frame
    // _trailHeadEntity segment bridges the last body point to the delayed
    // dead-reckoned head, so the body rebuilds only on a real fix or when the
    // display time passes one, never at motion cadence.
    // A break lifts the pen: each segment is its own line, nothing between them.
    if (!flightState._trail) return;
    flightState._trailBodyCount = _trailBodyCountNow();
    drawTrailSegments(
      flightState._trail,
      trailBodySegments(flightState._trailFixes, flightState._trailBodyCount),
    );
  }

  /** Fixes at or before the time the aircraft is drawn (now − RENDER_DELAY_SEC),
   *  less the newest recorded points inside its 3D model. */

  function _trailBodyCountNow() {
    return trailBodyCountOutsideModel(
      flightState._trailFixes,
      trailBodyCount(
        flightState._trailFixes,
        flightState.now() - displayDelayMs(flightState),
      ),
      parts.motion._trackedModelCenterWorld(),
      parts.motion._trackedModelEnvelopeM(),
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
    flightState._trailFixes = [];
    flightState._trailRecordPosition = null;
    flightState._trailRecordMs = -Infinity;
    const history = flightState._positionHistory.get(icao24) || [];
    // Seed every report. The body only draws those at or before the delayed
    // display time (now − RENDER_DELAY_SEC); newer ones join it as the display
    // passes them. A synthetic forward fix (it carries `reportEpochMs`) is a
    // motion aid, never a report. A report drawn at an invented height keeps
    // no position and breaks the line.
    for (const fix of history) {
      if (Number.isFinite(fix.reportEpochMs)) continue;
      insertTrailFix(
        flightState._trailFixes,
        floorTrail
          ? _trailFloorPosition(geo.cartesian3.clone(fix.position))
          : geo.cartesian3.clone(fix.position),
        historyFixEpochMs(fix),
        TRAIL_MAX_POINTS,
        { nullAltitude: fix.inventedHeight === true },
      );
    }
    _attachTrail();
    const oldestFixEpochSec = history.length
      ? historyFixEpochMs(history[0]) / 1000
      : Infinity;
    _backfillTrail(icao24, flightState._trailBackfillToken, oldestFixEpochSec);
  }

  function _attachTrail() {
    if (!flightState._trail && flightState._renderer) {
      flightState._trail = flightState._renderer.trails.create({
        color: TRAIL_COLOR,
        width: 2.5,
      });
    }
    flightState._trail?.setVisible(!flightState._cockpitContactMode);
    // Live head segment: last DISPLAYED body point → current dead-reckoned icon, updated
    // every frame through the display callback. Keeps the head glued
    // to the 12 Hz icon while the trail body updates less often.
    if (!flightState._trailHeadEntity && flightState._renderer) {
      flightState._trailHeadEntity = flightState._renderer.trails.createHead({
        // 'gev-trail' namespace: claimed by the display's pick
        // owner so a click on the head segment never reads as empty space.
        id: `gev-trail:${trailHeadIdPrefix}-head-${++flightState._trailHeadSeq}`,
        show: !flightState._cockpitContactMode,
        positions: () => {
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
          const last = trailHeadStartFix(
            flightState._trailFixes,
            head,
            flightState.now(),
            flightState._trailBodyCount,
          );
          if (!last) return [];
          const start = last.position;
          // With `floorTrail` the head is floored too: a grounded tracked
          // contact's DR display height is the pre-datum default — without this
          // the last segment dives underground while taxiing.
          const end = floorTrail
            ? _trailFloorPosition(geo.cartesian3.clone(head))
            : head;
          // On a contact that has not moved this segment runs from inside the
          // model out to its own anchor — a line through the fuselage. The END
          // never gives, so a moving trail still terminates on the tail; the
          // START is what slides, from nothing on a parked contact out to the
          // whole segment once it has cleared its own envelope. Measured against
          // the endpoint actually drawn. See trailHeadStart. An unfloored `head`
          // is read in place and cloned only on the draw path — a suppressed
          // parked contact runs this every frame.
          const from = trailHeadStart(
            start,
            end,
            parts.motion._trackedModelCenterWorld(),
            parts.motion._trackedModelEnvelopeM(),
            flightState._scratchTrailHead,
          );
          if (!from) return [];
          return [from, end === head ? geo.cartesian3.clone(head) : end];
        },
        width: 2.5,
        // The head must never vanish into the mesh either (dimmed when
        // occluded so depth still reads); geodesic, consistent with the
        // trail body (no chords).
        color: TRAIL_COLOR,
      });
    }
    _refreshTrailDisplay();
  }

  /**
   * Fire-and-forget OpenSky /tracks backfill. On success, splices
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

    // Tracks report barometric altitude only; the geoid offset approximates
    // ellipsoid height consistently with live barometric fixes.
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

    // Floor low segments at the ground without waiting indefinitely for cold
    // terrain cells. The lookup keeps warming the cache after the bound.
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
          position:
            altM == null ? null : geo.cartesian3.fromDegrees(lon, lat, altM),
          timeMs,
          nullAltitude: known == null,
        };
      }),
    );
    flightState._trailFixes = joinTrailBackfill(
      backfill,
      flightState._trailFixes,
      TRAIL_MAX_POINTS,
    );
    _refreshTrailDisplay();
  }

  /**
   * Clear the rendered trail and accumulation; invalidate pending backfills.
   */

  function _clearTrail() {
    flightState._trailBackfillToken += 1;
    flightState._trailFixes = [];
    flightState._trailRecordPosition = null;
    flightState._trailRecordMs = -Infinity;
    if (flightState._trail) flightState._trail.clear();
    if (flightState._trailHeadEntity)
      flightState._renderer?.trails.removeHead(flightState._trailHeadEntity);
    flightState._trailHeadEntity = null;
  }

  /**
   * Destroy the trail primitive entirely (layer disable/teardown).
   */

  function _destroyTrail() {
    _clearTrail();
    _detachTrail();
  }

  function _detachTrail() {
    if (flightState._trailHeadEntity)
      flightState._renderer?.trails.removeHead(flightState._trailHeadEntity);
    flightState._trailHeadEntity = null;
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
    if (!flightState._trackedIcao) {
      clearFocusTarget(focusId);
      return;
    }
    const clearedIcao = flightState._trackedIcao;
    clearFocusTarget(focusId, clearedIcao);

    // Restore the original billboard appearance. The rotation is re-seeded from
    // the tracked entity's last rendered rotation and a rotation pass is forced
    // (_lastCamPoseSig below): the fleet billboard otherwise reappears with the
    // STALE screen rotation it had when tracking began — up to a full
    // ROTATION_REFRESH_MS of a wrong (possibly reversed) nose on release.
    if (flightState._billboards.has(flightState._trackedIcao)) {
      const bb = flightState._billboards.get(flightState._trackedIcao);
      const meta = flightState.records.data.get(flightState._trackedIcao);
      bb.show = true;
      bb.width = 20;
      bb.height = 20;
      // Ground-aware restore (a plane untracked while taxiing comes back at
      // ground scale, in the layer's fleet tint).
      bb.color = parts.rendering._fleetBillboardColor(
        flightState._trackedIcao,
        meta,
      );
      bb.scale = fleetBillboardScale(flightState._trackedIcao, meta);
      bb.rotation = flightState._lastTrackedRotation;
    }
    flightState._lastCamPoseSig = ''; // force a fleet rotation pass on the next tick

    // Stop tracking and remove the entity. skipViewerUntrack: when ANOTHER layer just grabbed the
    // follow camera, tear down only our own state and keep the new owner.
    // Releasing our follow keeps the camera pose so the user can orbit or zoom.
    if (flightState._renderer && !skipViewerUntrack) {
      flightState._renderer.follow.release();
    }
    if (flightState._trackedEntity) {
      flightState._renderer.tracked.remove(flightState._trackedEntity);
      flightState._trackedEntity = null;
    }
    parts.rendering._releaseTrackedModel();
    _resetTrackedSelectionState(); // the zoom band + load-failure budget belong to the selection we just dropped
    flightState._trackedIcao = null;
    parts.rendering._applyFleetBillboardPresentation(
      clearedIcao,
      flightState._billboards.get(clearedIcao),
    );
    clearTrackedSubjectContext(layerId);
    _emitAwarenessEvent('gev:awareness-subject-cleared', {
      layerId,
      id: clearedIcao,
      origin,
      reason: evicted ? 'evicted' : 'deliberate',
    });
    // Invalidate the per-frame DR cache + reconciliation state so a same-frame re-track
    // cannot read the previous aircraft's cached/smoothed position.
    parts.motion._resetTrackedDisplay();
    _clearTrail();
  }

  function _applyPendingTrackingRestore() {
    const pending = flightState._pendingTrackingRestore;
    if (
      !pending ||
      pending.generation !== flightState._trackingIntentGeneration
    )
      return false;
    if (
      !flightState._renderer?.fleet.visible() ||
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

  /**
   * Begin tracking a specific aircraft by ICAO24 address.
   *
   * Clears any existing tracked flight, hides its billboard, and creates a
   * tracked display handle with:
   *  - A position callback driven by dead-reckoning (_deadReckon).
   *  - A rotation callback from the aircraft's course.
   *  - An explicit host presentation model (the layer's tracked card).
   *
   * The display starts the engine follow for this handle.
   *
   * @param {string} icao24 - ICAO 24-bit transponder address to track.
   */

  function _trackFlight(
    icao24,
    { origin = 'programmatic', resume = false, follow = true } = {},
  ) {
    if (!resume) _clearTracking(false, { origin }); // switching planes — the new follow-camera takes over

    const bb = flightState._billboards.get(icao24);
    const info = flightState.records.data.get(icao24);
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
    // one computation shared by the position/rotation/trail-head callbacks, with
    // discontinuity reconciliation). Falls back to the last billboard position when the
    // aircraft has no fix.
    const getTrackedPosition = () =>
      parts.motion._trackedDisplayPosition(icao24) || bb.position;

    // Create tracked entity: a 2D billboard when zoomed out, a 3D model when zoomed in past the
    // TRACKED altitude ceiling. That handoff is DEFAULT behaviour — it does NOT wait on the
    // DISPLAY-rail 3D toggle, which arms the FLEET. The plane the user zooms into always
    // resolves into an aircraft.
    //
    // The tracked sprite becomes transparent only while the standalone model is ready and shown.
    flightState._trackedEntity = flightState._renderer.tracked.create({
      // Dead-reckoning position — smooth continuous motion between API updates.
      position: getTrackedPosition,
      image: aircraftIcon(
        parts.rendering._iconKind(
          flightState._trackedIcao,
          flightState.records.data.get(flightState._trackedIcao)?.klass,
        ),
        TRACKED_ICON_PX,
      ),
      width: 28,
      height: 28,
      scale:
        trackedStyle.baseScale *
        (CLASS_SCALE_2D[
          flightState.records.data.get(flightState._trackedIcao)?.klass
        ] || 1),
      // Solid tracked tint when the billboard is the visual (zoomed out, 3D off, or model still
      // loading); transparent once the STANDALONE tracked model is actually up (ready + shown).
      color: () =>
        parts.rendering._modelOwnsVisual(flightState._trackedIcao)
          ? trackedStyle.transparentColor
          : trackedStyle.color,
      scaleByDistance: nearFarScale(1000, 3.0, 8000000, 0.5),
      // The tracked target must never vanish into tile geometry — tracking a
      // taxiing plane at street level would otherwise bury the tracked icon inside
      // the runway skin exactly like the fleet ground icons (_groundDepthDistance);
      // its shared-host tracked card is top-composited separately.
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      // Screen-projected rotation, evaluated per frame: exact in tracked-orbit
      // mode where camera.heading lives in the entity's reference frame.
      rotation: () => {
        const tracked = flightState.records.data.get(flightState._trackedIcao);
        const pos = getTrackedPosition();
        if (!tracked || !pos || !flightState._renderer)
          return flightState._lastTrackedRotation;
        const projected = screenProjectedRotation(
          flightState._renderer.view.scene,
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
    flightState._trackedEntity.gevSelectionOrigin = origin;
    flightState._trackedEntity.gevTrackedId = `${layerId}:${icao24}`;
    flightState._trackedEntity.gevLabelModel = trackedLabelModelFromText(
      trackedLabelText(icao24),
      trackedStyle.labelColor,
    );

    // Frame the aircraft behind and above, with distance scaled to altitude.
    // The offset uses ENU: east=+X, north=+Y, up=+Z.
    const followRange = Math.min(
      Math.max((followAltitudeM(info) || 1500) * 1.1 + 2500, 3000),
      30000,
    );
    flightState._renderer.tracked.setViewFrom(flightState._trackedEntity, {
      x: 0,
      y: -followRange * 0.8,
      z: followRange * 0.55,
    });

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
    refreshTrackedReadout(
      flightState._trackedEntity,
      flightState._renderer?.engine,
    );
    // Camera follows the tracked entity (the renderer cancels any flight
    // first and applies the one exact tracked frame).
    // A resumed binding or a share restore re-follows the session's own
    // subject: marked only while the follow starts, so the shell does not
    // read it as new navigation (LayerBindings.observeCamera) yet any later
    // follow of the same aircraft still is.
    if (follow) {
      const entity = flightState._trackedEntity;
      const restoring = resume || origin === 'share-restore';
      if (restoring) entity.gevRestoring = true;
      try {
        flightState._renderer.follow.start(entity);
      } finally {
        if (restoring) delete entity.gevRestoring;
      }
    }

    if (resume) {
      _attachTrail();
      return;
    }
    onTrackStart?.(icao24);
    // Track-history trail: seed from local history + async backfill.
    // Round 2 (owner): grounded contacts get trails too — a landed-but-taxiing
    // aircraft's history is retrievable on select; ground legs drape (see
    // _trailFloorPosition), never dive.
    _startTrail(icao24);

    _publishTrackedSelection(icao24, origin);

    console.log(`${logTag} Tracking ${contactLabel(icao24, info)} (${icao24})`);
  }

  /**
   * Escape (through the selection dispatcher) deselects the tracked flight.
   */

  function _onEscape() {
    if (flightState._trackedIcao) {
      _cancelPendingTrackingRestore();
      _clearTracking(false, { origin: 'user' });
    }
  }

  /**
   * A click the selection dispatcher hands this layer: one of its aircraft
   * (a fleet sprite or model, or the tracked plane's own visual). The
   * dispatcher has already applied the gesture rules (a drag selects
   * nothing; isTrackingSelectionGesture) and the pointer claim.
   * @param {string} id - The picked id this layer owns.
   */

  function _onSelect(id) {
    // Cockpit mode owns the camera and keeps the current aircraft as its
    // first-person reference: a globe click selects nothing here.
    if (document.body.classList.contains('cockpit-mode')) return;
    // Clicking the tracked plane itself — its tracked visual or its
    // standalone 3D model (pick id = its icao, H1) — is a no-op, not a
    // deselect and not a re-track.
    if (
      id === flightState._trackedEntity?.id ||
      (flightState._trackedIcao && id === flightState._trackedIcao)
    )
      return;
    if (flightState._billboards.has(id)) {
      _cancelPendingTrackingRestore();
      _trackFlight(id, { origin: 'user' });
    }
  }

  /**
   * Empty space (or a pick no layer owns). The dispatcher calls this only
   * for a clean, short click (isTrackingClickGesture): a slow stationary
   * press may select, but cannot release existing tracking. A pick another
   * layer owns never reaches here.
   */

  function _onEmptyClick() {
    if (document.body.classList.contains('cockpit-mode')) return;
    if (flightState._trackedIcao) {
      _cancelPendingTrackingRestore();
      _clearTracking(false, { origin: 'user' });
    }
  }

  /**
   * Join the engine's selection dispatcher (clicks with picks, Escape) and
   * watch the follow camera for another layer taking it.
   *
   * Idempotent — returns immediately if already joined.
   */

  function _installClickHandler() {
    const renderer = flightState._renderer;
    if (!renderer) return;

    // Cross-layer untrack: if ANOTHER layer (military, vessels, …) grabs the follow-camera, drop our
    // tracking so its model/entity/update-loop don't orphan — without touching the follow target
    // (the new owner controls it). Guarded so the intermediate untrack→retrack of OUR OWN switch
    // (the follow target briefly empty) doesn't self-clear.
    if (!flightState._trackedEntityChangedRemove) {
      flightState._trackedEntityChangedRemove = renderer.follow.onChanged(
        () => {
          const current = flightState._renderer?.follow.current();
          if (
            flightState._trackedIcao &&
            current &&
            current !== flightState._trackedEntity
          ) {
            _clearTracking(true, {
              origin: current?.gevSelectionOrigin || 'programmatic',
            });
          }
        },
      );
    }

    if (flightState._selectionRemove) return; // already joined
    const dispatcher = selectionDispatcherFor(renderer.engine);
    if (!dispatcher) return;
    flightState._selectionRemove = dispatcher.register(layerId, {
      // The fleet's icaos, and the tracked visual's own id: clicking it is
      // this layer's no-op, never empty space.
      owns: (id) =>
        flightState._billboards.has(id) ||
        (!!flightState._trackedEntity &&
          id === String(flightState._trackedEntity.id)),
      onSelect: _onSelect,
      onEmptyClick: _onEmptyClick,
      onEscape: _onEscape,
    });
  }

  /** Leave the selection dispatcher and stop watching the follow camera. */

  function _removeClickHandler() {
    flightState._selectionRemove?.();
    flightState._selectionRemove = null;
    if (flightState._trackedEntityChangedRemove) {
      flightState._trackedEntityChangedRemove();
      flightState._trackedEntityChangedRemove = null;
    }
  }
  return {
    _emitAwarenessEvent,
    _publishTrackedSelection,
    _contextSubjectMetadata,
    _isExplicitTrackingOrigin,
    _refreshCockpitNearContacts,
    _setCockpitContactMode,
    _applyCockpitState,
    _updateTrackedLabelModel,
    _syncTrackedBillboardImage,
    _refreshTr3bContact,
    _refreshTr3bForStyle,
    _resetTrackedSelectionState,
    _trackedModelLoadAllowed,
    _noteTrackedModelLoadFailure,
    _trackedModelRegimeActive,
    _syncTracked2dRotation,
    ...(floorTrail ? { _trailFloorPosition } : {}),
    _appendTrailFix,
    _trailTick,
    _refreshTrailDisplay,
    _startTrail,
    _attachTrail,
    _detachTrail,
    _backfillTrail,
    _clearTrail,
    _destroyTrail,
    _clearTracking,
    _applyPendingTrackingRestore,
    _cancelPendingTrackingRestore,
    _trackFlight,
    _onEscape,
    _onSelect,
    _onEmptyClick,
    _installClickHandler,
    _removeClickHandler,
  };
}
