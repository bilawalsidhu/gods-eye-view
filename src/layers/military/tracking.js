import * as geo from '../../geo/index.js';
import { nearFarScale } from '../shared/color.js';
import { appClock } from '../../time/clock.js';
import { t } from '../../i18n/index.js';
import { nextCockpitNearContacts } from '../../data/cockpitAirLod.js';
import { aircraftIcon, TRACKED_ICON_PX } from '../../data/aircraftIcons.js';
import { trackedModelZoomActive } from '../../data/trackedModelRegime.js';
import {
  screenProjectedRotation,
  stabilizeScreenRotation,
} from '../../data/iconOrientation.js';
import { trailHeadStart } from '../../data/modelVisualAnchor.js';
import { CLASS_SCALE_2D } from '../../data/aircraftClass.js';
import {
  TRACKED_MODEL_MAX_LOAD_FAILS,
  TRACKED_MODEL_RETRY_BACKOFF_MS,
  TRAIL_MAX_POINTS,
  RENDER_DELAY_SEC,
  TRAIL_COLOR,
  BILLBOARD_SCALE,
  GROUND_SCALE,
  AMBER_TRANSPARENT,
  TRACKED_ICON_COLOR,
} from './policy.js';
import { roundHeadingDegrees } from '../../data/headingDegrees.js';

export function createTracking({
  flightState,
  services,
  parts,
  layer,
  resolveAsset,
}) {
  const {
    selectTrackedSubjectContext,
    refreshTrackedSubjectContext,
    clearTrackedSubjectContext,
  } = services.context;
  const { tr3bTypeLabel, isTr3b, tr3bConvertedIds } =
    services.aircraftPresentation;
  const { trackedLabelModelFromText, refreshTrackedReadout } = services.readout;
  const { floorAltitudeM, cachedGroundFloor, resolveGroundFloorCellsBounded } =
    services.groundFloor;
  const { ensureGeoidReady, geoidHeight } = services.geoid;
  const { clearFocusTarget } = services.focus;
  const { selectionDispatcherFor } = services.selection;

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
    const info = flightState.records.data.get(icao24);
    if (!bb?.position || !info) return false;
    if (flightState._trackedEntity)
      flightState._trackedEntity.gevSelectionOrigin = origin;
    _emitAwarenessEvent('gev:awareness-subject-selected', {
      layerId: 'military',
      id: icao24,
      label:
        parts.queries._toCleanText(info.callsign) ||
        parts.queries._toCleanText(info.registration) ||
        icao24,
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
    const info = flightState.records.data.get(icao24);
    const label = described.callsign || described.registration || icao24;
    return {
      id: icao24,
      layerId: 'military',
      layerName: 'Military Flights',
      source: flightState.feed._lastSource,
      label,
      latitude: described.latitude,
      longitude: described.longitude,
      // Flat text only: the voice payload compacts properties through a
      // string cleaner that drops nested objects.
      properties: {
        name: label,
        operator: parts.queries._toCleanText(info?.operator) || '',
        callsign: described.callsign || '',
        registration: described.registration || '',
        // Converted contacts report their class as TR-3B — the same override
        // the readout and Contacts card show.
        type: tr3bTypeLabel(
          icao24,
          parts.queries._toCleanText(info?.type) || '',
        ),
        altitude: described.onGround
          ? 'on ground'
          : parts.queries._formatAltitude(info?.altitudeFt),
        speed: Number.isFinite(described.velocityMps)
          ? `${Math.round(described.velocityMps * 1.944)} kt`
          : '',
        heading: Number.isFinite(described.track)
          ? `${roundHeadingDegrees(described.track)}°`
          : '',
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

  /** Refresh the AIR-only Cockpit near band independently from model admission. */

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
    // Never bulk-destroy here: that stalls the renderer exactly as cockpit begins.
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

  /**
   * Build the multi-line presentation text for the protected tracked host card.
   * Lines: callsign, type/registration, operator/altitude.
   * While the plane is in its missed-poll grace (coasting on dead reckoning
   * with sticky metadata) the first line carries a "· STALE" cue — the fleet's
   * 45%-alpha billboard fade doesn't apply to the tracked plane (its entity
   * owns the visual), so without this the readout would present last-known
   * altitude/speed as live.
   * @param {Object|null} info - Flight metadata from _flightData
   * @param {string} icao24 - ICAO hex identifier (fallback display name)
   * @returns {string} Newline-separated label text
   */

  function _buildTrackedLabel(info, icao24) {
    const stale =
      flightState.records.missingPolls.get(icao24) || flightState.feed._backoff
        ? ` · ${t('STALE')}`
        : '';
    const callsign =
      (parts.queries._toCleanText(info?.callsign) ||
        parts.queries._toCleanText(info?.registration) ||
        icao24) + stale;
    // Converted contacts report their class as TR-3B — that override is exactly
    // what the Easter egg replaces the real type with.
    const type = tr3bTypeLabel(
      icao24,
      parts.queries._toCleanText(info?.type) || t('Type unknown'),
    );
    const registration =
      parts.queries._toCleanText(info?.registration) || t('Reg unknown');
    const operator =
      parts.queries._toCleanText(info?.operator) || t('Operator unknown');
    const altitude = parts.queries._formatAltitude(info?.altitudeFt);
    const speedKt = info?.speedMps ? Math.round(info.speedMps * 1.944) : null;
    const tail = speedKt ? `${altitude} · ${speedKt} kt` : altitude;
    return [
      callsign,
      `${type} · ${registration}`,
      `${operator} · ${tail}`,
    ].join('\n');
  }

  /** Write the explicit tracked presentation model and refresh its host entry. */

  function _updateTrackedLabelModel(icao24) {
    if (!flightState._trackedEntity || icao24 !== flightState._trackedIcao)
      return;
    flightState._trackedEntity.gevLabelModel = trackedLabelModelFromText(
      _buildTrackedLabel(flightState.records.data.get(icao24), icao24),
      '#ffd166',
    );
    refreshTrackedReadout(flightState._trackedEntity);
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
   * changed. Mirror of flights.js: converting drops any 3D model so the triangle
   * owns the visual, then the billboard, tracked entity, and card re-derive.
   * @param {string} icao24 - ICAO 24-bit address.
   * @returns {boolean} True when the layer owns this contact.
   */

  function _refreshTr3bContact(icao24) {
    const id = String(icao24 || '')
      .trim()
      .toLowerCase();
    if (!id) return false;
    if (isTr3b(id)) {
      if (flightState._models.has(id) || flightState._modelPending.has(id))
        parts.rendering._releaseModel(id);
      const modelled = flightState._billboards.get(id);
      if (modelled && id !== flightState._trackedIcao) modelled.show = true; // horizon cull re-asserts next tick
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
   *  icao (Contacts re-entry, a cross-layer round trip back to this layer) never
   *  makes `_trackedIcao` *observably* change, so the guard never fires. Without
   *  the reset, a contact dropped inside the hysteresis band comes back as a
   *  MODEL above the ENTER ceiling, and a contact whose GLB had already failed
   *  out would never get its retries back. Mirror of flights.js. */

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
        `[Data:Military] tracked 3D model gave up after ${flightState._trackedModelFailCount} failed loads of ${url} — ` +
          'this contact stays 2D until another is selected',
        err,
      );
    }
  }

  /**
   * The TRACKED aircraft's own model regime — DEFAULT-ON, camera-distance driven
   * (owner directive 2026-08-19). Mirror of flights.js: this does NOT consult the
   * DISPLAY-rail `models3d` toggle, which keeps owning the FLEET
   * (`_modelRegimeActive`) and its draw-call budget. Thresholds + hysteresis live
   * in trackedModelRegime.js — enter at TRACKED_MODEL_ENTER_ALT_M (150_000 m, the
   * owner's playtested swap distance, deliberately NEARER than the fleet's 800 km
   * ceiling this used to inherit), hand back only above
   * TRACKED_MODEL_EXIT_ALT_M so a boundary orbit cannot flap billboard↔model.
   * First-person means your own airframe is not drawn in cockpit — the eye sits
   * metres from its origin.
   */

  function _trackedModelRegimeActive() {
    if (flightState._trackedZoomLatchIcao !== flightState._trackedIcao) {
      flightState._trackedZoomLatchIcao = flightState._trackedIcao;
      flightState._trackedZoomLatched = false;
    }
    // A converted TR-3B has no 3D asset — suppressing the regime keeps its
    // tracked billboard fully opaque (the colour callback reads this too), so
    // the triangle stays the visual all the way in. Mirror of flights.js.
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
   * invariant), so every position entering the TRAIL subsystem (seed, append,
   * per-frame head) goes through this instead — the visible taxi history sits
   * on the surface without touching the billboard/model machinery.
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
   * Append one fix to the tracked aircraft's trail accumulation and refresh
   * the rendered trail. Caller passes an owned (cloned) Cartesian3.
   * @param {object} position - New fix position (Cartesian3), appended at the head.
   */

  function _appendTrailFix(position) {
    flightState._trailPositions.push(_trailFloorPosition(position));
    if (flightState._trailPositions.length > TRAIL_MAX_POINTS)
      flightState._trailPositions.shift();
    _refreshTrailDisplay();
  }

  /**
   * Renders the trail BODY — the accumulated fixes EXCLUDING the newest raw one. That
   * newest fix is at ~now, ~one poll interval AHEAD of the delayed icon (rendered at
   * now − RENDER_DELAY_SEC), so drawing it would push the trail in FRONT of the plane.
   * The cheap per-frame _trailHeadEntity segment bridges the last body point to the
   * delayed dead-reckoned head, so this primitive only rebuilds on a real fix (poll
   * cadence), never at motion cadence.
   */

  function _refreshTrailDisplay() {
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
   * fire-and-forget an adsb.lol trace backfill (~24 h of real history).
   * @param {string} icao24 - ICAO hex identifier being tracked.
   */

  function _startTrail(icao24) {
    flightState._trailBackfillToken += 1;
    flightState._trailPositions = [];
    const history = flightState._positionHistory.get(icao24) || [];
    // Seed only fixes at/behind the DELAYED display time (now − RENDER_DELAY_SEC). The
    // newest ~RENDER_DELAY_SEC of fixes are AHEAD of the displayed icon; including them
    // would draw the trail in front of the plane. They join via _appendTrailFix as they age.
    const seedRenderTimeMs = appClock.now() - RENDER_DELAY_SEC * 1000;
    for (const fix of history) {
      if (fix.timeMs <= seedRenderTimeMs) {
        // Floor grounded-history seeds (round 2): a grounded contact's stored
        // fixes carry the pre-datum default height — the trail copy sits on
        // the surface instead (pure lift; airborne fixes pass through).
        flightState._trailPositions.push(
          _trailFloorPosition(geo.cartesian3.clone(fix.position)),
        );
      }
    }
    _attachTrail();
    const oldestFixEpochSec = history.length
      ? history[0].timeMs / 1000
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
    // every frame via a CallbackProperty (Cesium updates entity-polyline positions cheaply,
    // unlike the trail primitive which fully rebuilds on setPositions). Keeps the head glued
    // to the 12 Hz icon instead of lagging ~1 s behind it.
    if (!flightState._trailHeadEntity && flightState._renderer) {
      flightState._trailHeadEntity = flightState._renderer.trails.createHead({
        // 'gev-trail' namespace (round 6): claimed by trailRenderer's pick
        // owner so a click on the head segment never reads as empty space.
        id: `gev-trail:mil-head-${++flightState._trailHeadSeq}`,
        show: !flightState._cockpitContactMode,
        positions: () => {
          // Need ≥2 accumulated points: the body draws all-but-newest, so the head must
          // start at the last DISPLAYED body point (index n−2). With a single fix that
          // point would be the sole raw fix — ~now, AHEAD of the delayed icon — so the
          // segment would draw IN FRONT of the plane. Likewise during warm-up the icon
          // predates all real history, so there is no valid body point behind it.
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
            flightState._trailPositions[flightState._trailPositions.length - 2];
          // Floor the head too (round 2): a grounded tracked contact's DR
          // display height is the pre-datum default — without this the last
          // segment dives underground while taxiing.
          const end = _trailFloorPosition(geo.cartesian3.clone(head));
          // On a contact that has not moved this segment runs from inside the
          // model out to its own anchor — a line through the fuselage. The END
          // never gives, so a moving trail still terminates on the tail; the
          // START is what slides, from nothing on a parked contact out to the
          // whole segment once it has cleared its own envelope. Measured against
          // the FLOORED endpoint, which is the one actually drawn.
          // See trailHeadStart.
          const from = trailHeadStart(
            start,
            end,
            parts.motion._trackedModelCenterWorld(),
            parts.motion._trackedModelEnvelopeM(),
            flightState._scratchTrailHead,
          );
          if (!from) return [];
          return [from, end];
        },
        width: 2.5,
        // Round 4: the head must never vanish into the mesh either (dimmed
        // when occluded so depth still reads); round 8: geodesic, consistent
        // with the trail body (no chords).
        color: TRAIL_COLOR,
      });
    }
    _refreshTrailDisplay();
  }

  /**
   * Fire-and-forget optional source history backfill (PRD F2). Trace points are
   * stride-thinned to the remaining vertex budget, then spliced strictly older
   * than the oldest seeded fix AHEAD of the locally accumulated fine segment,
   * capped at TRAIL_MAX_POINTS (newest kept). Any failure (404/timeout/
   * malformed) silently keeps the local-only trail.
   * @param {string} icao24 - ICAO hex identifier being tracked.
   * @param {number} token - Backfill token captured at request time.
   * @param {number} oldestFixEpochSec - Epoch seconds of the oldest seeded fix.
   * @returns {Promise<void>}
   */

  async function _backfillTrail(icao24, token, oldestFixEpochSec) {
    let trace = null;
    try {
      const track = await flightState.feed._source.getTrack?.(
        flightState.records.data.get(icao24)?.sourceReference ?? icao24,
        {
          signal: AbortSignal.any([
            flightState.lifetime.signal,
            AbortSignal.timeout(8000),
          ]),
        },
      );
      trace = track?.records ?? null;
    } catch {
      return; // silent fallback to the accumulated trail
    }
    if (!trace) return;
    if (
      token !== flightState._trailBackfillToken ||
      icao24 !== flightState._trackedIcao
    )
      return;

    // Height-datum fix (Task 7, mirror of flights.js Task 6 _backfillTrail): a
    // readsb trace point's altitude is barometric feet (same datum as the live
    // alt_baro, NOT geometric), so a trail waypoint's render height is the same
    // documented visual FALLBACK the live path uses — baroM + geoidHeight(lat,lon)
    // — geometrically approximate, not exact.
    await ensureGeoidReady();

    // readsb trace points: [secondsAfterTimestamp, lat, lon, alt_ft|'ground'|null, gs_kt, track, flags, ...]
    const parsed = [];
    for (const point of trace) {
      const t = point.observedAtMs / 1000;
      const lat = point.latitude,
        lon = point.longitude;
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      if (!Number.isFinite(t) || t >= oldestFixEpochSec) continue;
      parsed.push({ lat, lon, baroAltitudeM: point.baroAltitudeM });
    }
    if (!parsed.length) return;

    // Field-test fix (WAKE01 trail-underground, 2026-07-06): resolve the coarse
    // ellipsoidal ground along the trace and clamp every waypoint at it. A
    // 'ground'/null point sits ON the local surface — the old fixed 50 m
    // sentinel rendered ~1.5 km underground at Kirtland AFB (field ~1590 m
    // ellipsoidal) and dragged the whole pattern-work loop with it.
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

    let older = [];
    let lastAltM = null; // carry-forward for ground points whose cell isn't warm yet
    for (const { lat, lon, baroAltitudeM } of parsed) {
      const baroM =
        baroAltitudeM == null ? null : baroAltitudeM + geoidHeight(lat, lon);
      let altM = floorAltitudeM(baroM, cachedGroundFloor(lat, lon));
      // Ground/no-alt point with an unresolved floor: hold the previous
      // waypoint's altitude (continuity — never a dive to a made-up depth).
      // Leading points with nothing to carry keep the old low breadcrumb
      // sentinel (an arbitrary placeholder, never a reported altitude).
      if (altM == null) altM = lastAltM != null ? lastAltM : 50;
      lastAltM = altM;
      older.push(geo.cartesian3.fromDegrees(lon, lat, altM));
    }

    // Stride-thin the backfill so it plus the live fine segment fit the cap.
    const budget = Math.max(
      1,
      TRAIL_MAX_POINTS - flightState._trailPositions.length,
    );
    if (older.length > budget) {
      const stride = Math.ceil(older.length / budget);
      const thinned = [];
      for (let i = 0; i < older.length; i += stride) thinned.push(older[i]);
      older = thinned;
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
   * Stop tracking the current aircraft and clean up all tracking state.
   * Restores the original billboard, removes the tracked Entity, invalidates
   * the per-frame DR cache, and RELEASES the camera IN PLACE — no flyTo
   * (mirror of flights.js). Deselect used to fly an ~80 km pulled-back
   * overview; the owner field-ruled that wrong (2026-07-02: "it randomly zooms
   * way up and loses my context"). The camera stays at its current
   * position/orientation, immediately free to orbit/zoom. Applies to every
   * deselect path: click-empty-space, Escape, aged-out plane, layer disable,
   * and voice stopTracking.
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
      clearFocusTarget('militaryFlights');
      return;
    }
    const clearedIcao = flightState._trackedIcao;
    clearFocusTarget('militaryFlights', clearedIcao);

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
      // ground scale; the fleet tint is amber, or red while broadcasting an
      // emergency, on the ground and in the air).
      bb.scale =
        BILLBOARD_SCALE *
        (CLASS_SCALE_2D[meta?.klass] || 1) *
        (meta?.onGround ? GROUND_SCALE : 1);
      bb.color = parts.rendering._fleetBillboardColor(
        flightState._trackedIcao,
        meta,
      );
      bb.rotation = flightState._lastTrackedRotation;
    }
    flightState._lastCamPoseSig = ''; // force a fleet rotation pass on the next tick

    // Stop tracking and remove the entity. skipViewerUntrack: another layer just grabbed the
    // follow-camera, so tear down our state but DON'T clear viewer.trackedEntity (they own it now).
    // Releasing trackedEntity does NOT move the camera: Cesium resets the lookAt transform in
    // place, so the view stays where the follow left it and the user can immediately orbit/zoom.
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
    clearTrackedSubjectContext('military');
    _emitAwarenessEvent('gev:awareness-subject-cleared', {
      layerId: 'military',
      id: clearedIcao,
      origin,
      reason: evicted ? 'evicted' : 'deliberate',
    });
    // Invalidate the per-frame DR cache so a same-frame re-track cannot read
    // the previous aircraft's cached position.
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
   * Begin tracking a specific aircraft. Clears any previous tracking, hides the
   * billboard, creates a new Entity with dead-reckoning CallbackProperties for
   * smooth continuous motion, and sets the viewer's trackedEntity so the camera
   * follows.
   * @param {string} icao24 - ICAO hex identifier of the aircraft to track
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

    // Hide the billboard -- the tracked entity replaces it visually
    bb.show = false;

    // Helper: smoothed, per-frame-cached tracked position (see _trackedDisplayPosition —
    // one computation shared by the position/rotation/trail-head callbacks, with
    // discontinuity reconciliation). Falls back to the last billboard position when the
    // aircraft has no fix.
    const getTrackedPosition = () =>
      parts.motion._trackedDisplayPosition(icao24) || bb.position;

    // World-space orientation for the 3D model: nose along the course heading (ENU, pitch/roll 0).
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
    // The tracked entity is a PURE BILLBOARD — no label or model graphic. The tracked plane's 3D
    // model is the standalone primitive driven by _updateTrackedModel(); keeping it off the entity is
    // what makes the follow-camera's bounding sphere always ready (see _trackedModel).
    // The renderer keeps Cesium's EntityView in the same ENU frame as the
    // close-range camera guard (AUTO may otherwise alternate with a velocity frame).
    flightState._trackedEntity = flightState._renderer.tracked.create({
      // Dead-reckoning position, evaluated every render frame.
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
        BILLBOARD_SCALE *
        (CLASS_SCALE_2D[
          flightState.records.data.get(flightState._trackedIcao)?.klass
        ] || 1),
      // Solid amber when the billboard is the visual (zoomed out, 3D off, or model still loading);
      // transparent once the STANDALONE tracked model is actually up (ready + shown).
      color: () =>
        parts.rendering._modelOwnsVisual(flightState._trackedIcao)
          ? AMBER_TRANSPARENT
          : TRACKED_ICON_COLOR,
      scaleByDistance: nearFarScale(1000, 3.0, 8000000, 0.5),
      // The tracked target must never vanish into tile geometry — tracking a
      // taxiing plane at street level would otherwise bury the amber icon inside
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
    flightState._trackedEntity.gevTrackedId = `military:${icao24}`;
    flightState._trackedEntity.gevLabelModel = trackedLabelModelFromText(
      _buildTrackedLabel(info, icao24),
      '#ffd166',
    );

    // A billboard has a ~zero bounding sphere, so Cesium's default follow distance is
    // far too tight (the user had to scroll out to read the plane). Give the entity a
    // calibrated viewFrom — behind + above, distance scaled to altitude — for a readable
    // initial frame with surrounding context. (ENU: east=+X, north=+Y, up=+Z.)
    const altM = info?.altitudeFt ? info.altitudeFt * 0.3048 : 1500;
    const followRange = Math.min(Math.max(altM * 1.1 + 2500, 3000), 30000);
    flightState._renderer.tracked.setViewFrom(flightState._trackedEntity, {
      x: 0,
      y: -followRange * 0.8,
      z: followRange * 0.55,
    });

    // Cancel any in-progress camera flight first — otherwise Cesium won't apply the tracked
    // entity's viewFrom on the first frame, so voice-initiated tracking (which often fires
    // mid-fly_to_location) would follow the plane WITHOUT centering it like a click does.
    // Cross-module HUD consumers (tracked-target readout) read the camera's settled position, not a
    // postRender recompute, so the label doesn't jitter against the now-stable plane (mirror of flights).
    flightState._trackedEntity.gevDisplayPosition =
      parts.motion._trackedDisplayCached;
    // Separate accessor on purpose (mirror of flights.js): `gevDisplayPosition` keeps the
    // follow-camera anti-jitter contract; presentation that must weld to the aircraft you
    // can see reads `gevVisualPosition`.
    flightState._trackedEntity.gevVisualPosition =
      parts.motion._trackedVisualCached;
    refreshTrackedReadout(flightState._trackedEntity);
    // Camera follows the tracked entity (the renderer cancels any flight
    // first and applies the one exact tracked frame).
    if (follow) {
      flightState._trackedCameraFrameStop = flightState._renderer.follow.start(
        flightState._trackedEntity,
      );
    }
    if (resume) {
      _attachTrail();
      return;
    }

    // Track-history trail (PRD F2): seed from local history + async backfill.
    // Ground traffic draws NO trail — if the plane takes off while tracked, the
    // ground→air transition in update() starts one.
    // Round 2 (owner): grounded contacts get trails too — a landed-but-taxiing
    // aircraft's history is retrievable on select. Trail positions are floored
    // at the surface (_trailFloorPosition), so ground legs drape, never dive.
    _startTrail(icao24);

    const callsign =
      parts.queries._toCleanText(info.callsign) ||
      parts.queries._toCleanText(info.registration) ||
      icao24;
    _publishTrackedSelection(icao24, origin);
    console.log(`[Data:Military] Tracking ${callsign} (${icao24})`);
  }

  /**
   * Escape (through the selection dispatcher) clears the active aircraft tracking.
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
   * layer owns (commercial flight, satellite, vessel, station, CCTV
   * camera…) never reaches here.
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
   * Idempotent -- no-ops if already joined.
   */

  function _installClickHandler() {
    const renderer = flightState._renderer;
    if (!renderer) return;

    // Cross-layer untrack (mirror of flights): if another layer grabs the follow-camera, drop our
    // tracking without touching the follow target (the new owner controls it).
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
    flightState._selectionRemove = dispatcher.register('military', {
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
    _buildTrackedLabel,
    _updateTrackedLabelModel,
    _syncTrackedBillboardImage,
    _refreshTr3bContact,
    _refreshTr3bForStyle,
    _resetTrackedSelectionState,
    _trackedModelLoadAllowed,
    _noteTrackedModelLoadFailure,
    _trackedModelRegimeActive,
    _syncTracked2dRotation,
    _trailFloorPosition,
    _appendTrailFix,
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
