import { cameraOf, findCamera, findFrame } from '../../render/rendererOf.js';
import {
  entityFollowTarget,
  followedOf,
  onFollowChanged,
  stopFollowing,
} from '../../data/followed.js';
import {
  centerOnClick,
  claimSelection,
  followOnSecondClick,
  releaseSelection,
  yieldSelectionToOthers,
} from '../../data/clickSelect.js';
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
  trackedIconColor,
} from '../../data/trackedAircraftIcon.js';
import { fromDegrees, toLonLatH } from '../../geo/ellipsoid.js';
import { julianToEpochMs } from '../../geo/julian.js';
import { renderedFrames } from '../../data/renderedFrames.js';
import { clone, distanceSquared, vec } from '../../geo/vector.js';
import { trailHeadLine } from '../../data/modelVisualAnchor.js';
import {
  isTrackingSelectionGesture,
  isTrackingClickGesture,
} from '../../data/trackingClickGesture.js';
import { inputFor } from '../../input/dispatcher.js';
import {
  COCKPIT_AIR_ALL_ADD_M,
  COCKPIT_AIR_ALL_KEEP_M,
  COCKPIT_AIR_PROX_ADD_M,
  COCKPIT_AIR_PROX_KEEP_M,
  TRAIL_MAX_POINTS,
  displayDelayMs,
  followsClock,
  STALE_ALPHA,
  TRAIL_COLOR,
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
  trailTimeAt,
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
  return isOtherTrackedIconSet(hit.set, 'military') ? undefined : hit.id;
}

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
  const { createTrail } = services.trails;
  const { ensureGeoidReady, geoidHeight } = services.geoid;
  const { clearFocusTarget } = services.focus;
  const { FOLLOW_MIN_RANGE_M } = services.camera;
  const { resolvePickId, isOwnedByOtherLayer, isUnderOtherCard } =
    services.picking;
  /** The tracked contact's billboard (an icon set on the draw port). */
  const trackedIcon = createTrackedAircraftIcon({
    viewer: () => flightState._viewer,
    setPrefix: 'military',
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
      layerId: 'military',
      id: icao24,
      label:
        parts.queries._toCleanText(info.callsign) ||
        parts.queries._toCleanText(info.registration) ||
        icao24,
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
    // The AIR band follows the 3D mode, not the 3D model radius.
    const all = flightState._models3dMode === 'all';
    const next = nextCockpitNearContacts(
      previous,
      distancesSquared,
      all ? COCKPIT_AIR_ALL_ADD_M : COCKPIT_AIR_PROX_ADD_M,
      all ? COCKPIT_AIR_ALL_KEEP_M : COCKPIT_AIR_PROX_KEEP_M,
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
    // Never bulk-destroy here: that stalls the renderer exactly as cockpit begins.
    parts.rendering._setModelsShown(true);
    flightState._trail?.setVisible(!next);
    const icons = flightState._icons;
    for (const icao24 of icons?.ids() ?? [])
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

  /** The tracked billboard's colour: the contact's own fleet colour (tracking
   *  never recolours it), faded while stale, clear while the 3D model is the
   *  visual. */

  function _trackedIconColor() {
    const icao24 = flightState._trackedIcao;
    const color = parts.rendering._fleetBillboardColor(icao24);
    if (parts.rendering._modelOwnsVisual(icao24))
      return trackedIconColor(color, 0);
    return _trackedStaleCue(icao24).dimmed
      ? trackedIconColor(color, STALE_ALPHA)
      : color;
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

  /**
   * Build the multi-line presentation text for the protected tracked host card.
   * Lines: callsign, type/registration, operator/altitude.
   * The first line carries the stale cue (`_trackedStaleCue`): STALE while
   * the plane coasts on dead reckoning after a missed update, SIGNAL LOST
   * once the coast has ended, so last-known altitude/speed are never
   * presented as live.
   * @param {Object|null} info - Flight metadata from _flightData
   * @param {string} icao24 - ICAO hex identifier (fallback display name)
   * @returns {string} Newline-separated label text
   */

  function _buildTrackedLabel(info, icao24) {
    const cue = _trackedStaleCue(icao24).text;
    const stale = cue ? ` · ${cue}` : '';
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
    const altitude = info?.onGround
      ? t('On the ground')
      : parts.queries._formatAltitude(info?.altitudeFt);
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
    entityRecord(flightState._trackedEntity).labelModel =
      trackedLabelModelFromText(
        _buildTrackedLabel(flightState.records.data.get(icao24), icao24),
        '#ffd166',
      );
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
        return parts.rendering._fleetBillboardScale(icao24);
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
      findFrame(flightState._viewer)?.requestRender('military: TR-3B restyle');
    return flightState._icons?.has(id) || id === flightState._trackedIcao;
  }

  /** Re-image every converted contact this layer owns (IR style flip). */

  function _refreshTr3bForStyle() {
    for (const id of tr3bConvertedIds()) {
      if (flightState._icons?.has(id) || id === flightState._trackedIcao)
        _refreshTr3bContact(id);
    }
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
   * Field-test round 2 (2026-07-06): floors a trail-bound position at the warm
   * coarse ground cell — a pure LIFT (above-floor positions pass through
   * untouched, unknown floors change nothing). Grounded military billboards
   * deliberately render at the pre-datum default height (T7 groundSnap
   * invariant), so every position entering the TRAIL subsystem (seed, append,
   * per-frame head) goes through this instead — the visible taxi history sits
   * on the surface without touching the billboard/model machinery.
   * @param {{x: number, y: number, z: number}} position - Owned ECEF position (mutated/replaced freely).
   * @returns {{x: number, y: number, z: number}} The same or a lifted position.
   */

  function _trailFloorPosition(position) {
    const carto = toLonLatH(position);
    if (!carto) return position;
    const latDeg = carto.lat;
    const lonDeg = carto.lon;
    const floored = floorAltitudeM(
      carto.height,
      cachedGroundFloor(latDeg, lonDeg),
    );
    if (floored == null || floored === carto.height) return position;
    return fromDegrees(lonDeg, latDeg, floored);
  }

  /**
   * Put one report into the tracked aircraft's trail, in time order, and
   * refresh the rendered trail. Caller passes an owned (cloned) position. A
   * report that breaks from its neighbour starts a new segment (see
   * trailContinuity).
   * @param {{x: number, y: number, z: number}} position - The report's ECEF position.
   * @param {number} [epochMs] - The report's time; defaults to the tracked
   *   aircraft's newest position-history fix, which every caller has just pushed.
   * @param {{nullAltitude?: boolean}} [options] - `nullAltitude`: the report
   *   had no altitude, so its position is not kept and the line breaks there.
   *   A report for a time the display has already passed replaces what was
   *   drawn after it (see `insertTrailFix`).
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
      _trailFloorPosition(position),
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
   * Renders the trail BODY — the reports at or before the delayed display time,
   * joined along the curve the aircraft is drawn along. Newer reports are AHEAD of
   * the icon, so drawing them would push the trail in FRONT of the plane. The
   * per-frame head runs on along the same curve from the last body report to the
   * icon, so the body rebuilds only on a real report or when the display time
   * passes one, never at motion cadence. A break lifts the pen: each segment is
   * its own line, nothing between them.
   */

  function _refreshTrailDisplay() {
    if (!flightState._trail) return;
    flightState._trailBodyCount = _trailBodyCountNow();
    drawTrailSegments(
      flightState._trail,
      trailBodySegments(flightState._trailFixes, flightState._trailBodyCount),
    );
  }

  /** Reports at or before the time the aircraft is drawn (`_trailDisplayMs`). */

  function _trailBodyCountNow() {
    return trailBodyCount(flightState._trailFixes, _trailDisplayMs());
  }

  /**
   * The time on its trail at which a host-supplied placement draws the
   * aircraft, read off the trail where it is drawn (`trailTimeAt`): such a
   * placement draws at a delay of its own, not this layer's. NaN when this
   * layer's own motion draws it, or the trail has no pair to read.
   * @returns {number} Epoch ms or NaN.
   */
  function _placedTrailMs() {
    if (!parts.motion._trackedPlaced?.()) return NaN;
    return trailTimeAt(
      flightState._trailFixes,
      parts.motion._trackedDisplayCached(),
    );
  }

  /**
   * The time the trail runs up to: the time the aircraft is drawn at, now −
   * the display delay, or where a placement draws it. Otherwise the trail
   * ends short of a placed aircraft, or runs on ahead of it.
   * @returns {number} Epoch ms.
   */
  function _trailDisplayMs() {
    const placedMs = _placedTrailMs();
    return Number.isFinite(placedMs)
      ? placedMs
      : flightState.now() - displayDelayMs(flightState);
  }

  /** Whether the trail holds no report behind the aircraft yet: this
   *  layer's own motion draws it before its oldest fix. Never for an
   *  aircraft a placement draws: its trail is read where it is drawn. */
  function _trailWarmingUp() {
    return (
      !Number.isFinite(_placedTrailMs()) && parts.motion._isTrackWarmingUp()
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
      _trailWarmingUp()
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
    // Floor the head too (round 2): a grounded tracked contact's DR
    // display height is the pre-datum default — without this the last
    // segment dives underground while taxiing. The model envelope is
    // measured against the FLOORED endpoint, which is the one actually drawn.
    const end = _trailFloorPosition(clone(head));
    return trailHeadLine(
      last.position,
      // Along the curve the icon is drawn along, to where it is now.
      trailHeadCurvePoints(
        flightState._trailFixes,
        flightState._trailBodyCount,
        _trailDisplayMs(),
      ),
      end,
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
   * fire-and-forget an adsb.lol trace backfill (~24 h of real history).
   * @param {string} icao24 - ICAO hex identifier being tracked.
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
      // Floor grounded-history seeds (round 2): a grounded contact's stored
      // fixes carry the pre-datum default height — the trail copy sits on
      // the surface instead (pure lift; airborne fixes pass through).
      insertTrailFix(
        flightState._trailFixes,
        _trailFloorPosition(clone(fix.position)),
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
   * Fire-and-forget optional source history backfill (PRD F2). Every trace
   * point strictly older than the oldest seeded fix is spliced AHEAD of the
   * locally accumulated fine segment, each leg its own segment, capped at
   * TRAIL_MAX_POINTS (newest kept). Any failure (404/timeout/
   * malformed) silently keeps the local-only trail.
   * @param {string} icao24 - ICAO hex identifier being tracked.
   * @param {number} token - Backfill token captured at request time.
   * @param {number} oldestFixEpochSec - Epoch seconds of the oldest seeded fix.
   * @returns {Promise<void>}
   */

  async function _backfillTrail(icao24, token, oldestFixEpochSec) {
    let trace = null;
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
      if (atMs !== undefined && !(point.observedAtMs <= atMs)) continue;
      parsed.push({
        lat,
        lon,
        baroAltitudeM: point.baroAltitudeM,
        onGround: point.onGround === true,
        timeMs: point.observedAtMs,
      });
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

    // Every trace point is kept, each leg its own segment. A 'ground' point
    // is at altitude 0, floored at the ground. A point with no altitude is a
    // break on both sides: it sits on the ground where the floor is known and
    // is skipped otherwise; a skipped point still breaks the line.
    const backfill = trailBackfillFixes(
      parsed.map(({ lat, lon, baroAltitudeM, onGround, timeMs }) => {
        const known = Number.isFinite(baroAltitudeM)
          ? baroAltitudeM
          : onGround
            ? 0
            : null;
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
   * Stop tracking the current aircraft and clean up all tracking state.
   * Hands the contact back to its icon, removes the tracked Entity, invalidates
   * the per-frame DR cache, and RELEASES the camera IN PLACE — no flyTo
   * (mirror of flights.js). Deselect used to fly an ~80 km pulled-back
   * overview; the owner field-ruled that wrong (2026-07-02: "it randomly zooms
   * way up and loses my context"). The camera stays at its current
   * position/orientation, immediately free to orbit/zoom. Applies to every
   * deselect path: click-empty-space, Escape, aged-out plane, layer disable,
   * and voice stopTracking.
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
      clearFocusTarget('militaryFlights');
      return;
    }
    const clearedIcao = flightState._trackedIcao;
    clearFocusTarget('militaryFlights', clearedIcao);

    // The nose the icon continues from (the shared _displayCourse entry), so
    // release never flips it.
    const trackedCourseDeg = flightState._displayCourse.get(clearedIcao);

    // Stop tracking and hide the tracked billboard. skipViewerUntrack: another layer just grabbed
    // the follow-camera, so tear down our state but DON'T clear the camera's follow (they own it
    // now). Releasing the follow does NOT move the camera: the view stays where the follow left it
    // and the user can immediately orbit/zoom.
    if (flightState._viewer && !skipViewerUntrack) {
      stopFollowing(flightState._viewer);
    }
    trackedIcon.hide();
    flightState._trackedEntity = null;
    parts.rendering._releaseTrackedModel();
    _resetTrackedSelectionState(); // the zoom band + load-failure budget belong to the selection we just dropped
    flightState._trackedIcao = null;
    // Hand the contact back to its icon only now, once it no longer reads as
    // tracked (the settle plans it as a fleet contact).
    // Its fleet model, kept loaded while it was selected, takes it back in
    // this frame; the icon shows only when there is no loaded one.
    parts.rendering._handBackDeselected(clearedIcao);
    if (flightState._icons?.has(clearedIcao))
      parts.icons._settleIcon(clearedIcao, { fromCourseDeg: trackedCourseDeg });
    parts.icons._applyIconPresentation(clearedIcao);
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
    releaseSelection('military', clearedIcao);
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

  /** Have the camera follow the tracked aircraft (an explicit follow). */
  function _followTracked() {
    if (!flightState._followTarget || !flightState._viewer) return false;
    const camera = cameraOf(flightState._viewer);
    // Cancel any in-progress camera flight first — otherwise the camera won't
    // apply the follow target's viewFrom on the first frame, so
    // voice-initiated tracking (which often fires mid-fly_to_location) would
    // follow the plane without framing it.
    camera.cancelFlight();
    camera.follow(flightState._followTarget);
    return true;
  }

  /** Whether the camera follows the tracked aircraft now. */
  function _trackedIsFollowed() {
    return (
      Boolean(flightState._followTarget) &&
      followedOf(flightState._viewer) === flightState._followTarget
    );
  }

  /**
   * Centre the tracked aircraft once, as a click does: the camera keeps its
   * distance and angle and meets the plane where it will be on arrival.
   */
  function _centerTracked() {
    const icao24 = flightState._trackedIcao;
    const icons = flightState._icons;
    if (!icao24 || !icons?.has(icao24)) return false;
    return centerOnClick(
      flightState._viewer,
      (aheadMs) =>
        icons.position(icao24, parts.icons._displayMs() + aheadMs, vec()),
      { clockId: 'military' },
    );
  }

  /**
   * Begin tracking a specific aircraft. Clears any previous tracking, hides the
   * icon and draws the tracked billboard with dead-reckoned motion, read by
   * the selected-aircraft card and, when followed, the camera.
   * @param {string} icao24 - ICAO hex identifier of the aircraft to track
   * @param {{origin?: string, follow?: boolean, center?: boolean}} [options] `follow: false`
   *   (a click on the plane) selects it and centres it once, keeping the
   *   camera's distance and angle, and follows nothing
   *   (src/data/clickSelect.js); anything else (Follow, voice, a share link)
   *   follows it from a calibrated framing.
   *   `center: false` (a pick from a list, which the caller frames)
   *   selects it without moving the camera.
   */

  function _trackFlight(
    icao24,
    { origin = 'programmatic', follow = true, center = true } = {},
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

    // Hide the icon -- the tracked entity replaces it visually
    icons.setShown(icao24, false);

    // Helper: smoothed, per-frame-cached tracked position (see _trackedDisplayPosition —
    // one computation shared by the position/rotation/trail-head callbacks, with
    // discontinuity reconciliation). Falls back to the icon's position when the
    // aircraft has no fix.
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
    // port, so nothing here frames the camera. The tracked plane's 3D model is a draw-set item
    // driven by _updateTrackedModel() (see _trackedModel).
    const sprite = _trackedSprite(icao24);
    // The tracked contact as its readers see it (the tracked card, Cockpit, share links): a
    // plain holder of its entity record, drawn while it is the one tracked.
    const holder = trackedContactHolder(
      `military:${icao24}`,
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
      // Its own colour (faded while stale) when the billboard is the visual (zoomed out, 3D off,
      // or model still loading); transparent once the tracked model is actually up (ready + shown).
      color: _trackedIconColor,
      // The course a view-sheet image is drawn along (the same display
      // course the screen rotation below is projected from).
      course: () => parts.motion._trackedDisplayCourse(),
      // Screen-projected rotation, evaluated per frame on the camera's own
      // axes, so it stays exact through a tracked orbit. The tracked target
      // must never vanish into tile geometry — tracking a taxiing plane at
      // street level would otherwise bury the icon inside the runway
      // skin, so it draws over depth like the fleet icon set; its
      // shared-host tracked card is top-composited separately.
      rotation: () => {
        const tracked = flightState.records.data.get(flightState._trackedIcao);
        const pos = getTrackedPosition();
        if (!tracked || !pos || !flightState._viewer)
          return flightState._lastTrackedRotation;
        // A ground station's mast stands upright.
        if (tracked.klass === 'station') return 0;
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
    entityRecord(flightState._trackedEntity).trackedId = `military:${icao24}`;
    entityRecord(flightState._trackedEntity).sprite = sprite;
    entityRecord(flightState._trackedEntity).labelModel =
      trackedLabelModelFromText(_buildTrackedLabel(info, icao24), '#ffd166');

    // A follow (Follow, voice, a share link) has no view of the plane to
    // keep: a billboard has a ~zero bounding sphere, so the renderer's default
    // follow distance is far too tight. It gets a calibrated viewFrom — behind
    // + above, distance scaled to altitude — for a readable initial frame with
    // surrounding context. (ENU: east=+X, north=+Y, up=+Z.)
    const altM = info?.onGround
      ? 0
      : info?.altitudeFt
        ? info.altitudeFt * 0.3048
        : 1500;
    const followRange = Math.min(Math.max(altM * 1.1 + 2500, 3000), 30000);
    const viewFrom = vec(0, -followRange * 0.8, followRange * 0.55);

    // Cross-module HUD consumers (tracked-target readout) read the camera's settled position, not a
    // postRender recompute, so the label doesn't jitter against the now-stable plane (mirror of flights).
    entityRecord(flightState._trackedEntity).displayPosition =
      parts.motion._trackedDisplayCached;
    // Separate accessor on purpose (mirror of flights.js): the entity record's `displayPosition` keeps the
    // follow-camera anti-jitter contract; presentation that must weld to the aircraft you
    // can see reads the entity record's `visualPosition`.
    entityRecord(flightState._trackedEntity).visualPosition =
      parts.motion._trackedVisualCached;
    // What the camera follows when it is asked to: a target framed from
    // viewFrom in ENU, never closer than the readable minimum, whose
    // presentation (key, label, sprite, display position) reads the tracked
    // entity's record. It is also the selected-aircraft card's subject.
    flightState._followTarget = entityFollowTarget(flightState._trackedEntity, {
      position: getTrackedPosition,
      frame: 'enu',
      viewFrom,
      minRange: FOLLOW_MIN_RANGE_M,
    });
    // The one selection: any other layer's selected thing lets go.
    claimSelection('military', icao24, {
      subject: flightState._followTarget,
      origin,
    });
    refreshTrackedReadout(flightState._trackedEntity);
    if (follow) _followTracked();
    else if (center) _centerTracked();

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
   * Global keydown handler: pressing Escape clears the active aircraft tracking.
   * @param {KeyboardEvent} e - The keyboard event
   */

  function _onKeyDown(e) {
    if (e.key === 'Escape' && flightState._trackedIcao) {
      _cancelPendingTrackingRestore();
      _clearTracking(false, { origin: 'user' });
    }
  }

  /**
   * Install a left-click handler on the scene canvas for aircraft selection.
   * Clicking a military billboard starts tracking that aircraft; clicking empty
   * space or a non-military object deselects. Also attaches the Escape key
   * listener via {@link _onKeyDown}. Idempotent -- no-ops if already installed.
   * @param {object} viewer - The viewer
   */

  function _installClickHandler(viewer) {
    if (flightState._clickSubscription) return; // already installed

    // Cross-layer untrack (mirror of flights): if another layer grabs the follow-camera, drop our
    // tracking without touching the camera's follow (the new owner controls it).
    if (!flightState._trackedEntityChangedRemove) {
      const offFollow = onFollowChanged(viewer, (followed) => {
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
      });
      // Another layer selected something (a click selects without
      // following): let our plane go, and the camera with it only if it
      // follows our plane.
      const offSelection = yieldSelectionToOthers(
        'military',
        () => Boolean(flightState._trackedIcao),
        (selection) =>
          _clearTracking(!_trackedIsFollowed(), {
            origin: selection.origin,
          }),
      );
      flightState._trackedEntityChangedRemove = () => {
        offFollow();
        offSelection();
      };
    }

    flightState._clickSubscription = inputFor(viewer).onClick((event) => {
      const gesture = event.gesture;
      // Camera drags never select or deselect, even if they finish over a plane.
      // Duration alone is allowed through so a stationary long press can still
      // select/switch contacts; the destructive empty-space branch below applies
      // the full travel + duration click classifier.
      if (!isTrackingSelectionGesture(gesture)) return;
      // Cockpit mode owns the camera and keeps the current aircraft as its
      // first-person reference. Empty globe clicks are inert until the user
      // exits with C, Escape, or the dedicated button.
      if (document.body.classList.contains('cockpit-mode')) return;
      // Another layer's card or label painted on top takes the click: the item
      // under it does not act, and the click is not empty space either.
      if (isUnderOtherCard?.(event)) return;
      const picked = event.hit;

      if (picked) {
        // Clicking the plane we're ALREADY tracking (its tracked billboard, its
        // 3D model, or any pick carrying its icao) — ignore, don't deselect.
        // H1: the model used to have no pick id, so this fell through to
        // "empty space" and deselected the very plane being tracked.
        // Its billboard and models are draw-set items keyed by icao, like its icons.
        // A second click on the selected plane follows it, as the card's
        // Follow does; a click on the followed plane keeps the follow
        // (src/data/clickSelect.js).
        const pickedIcao = aircraftPickId(picked);
        if (
          flightState._trackedIcao &&
          pickedIcao === flightState._trackedIcao
        ) {
          followOnSecondClick('military', pickedIcao, {
            isFollowed: _trackedIsFollowed,
            follow: () => {
              _cancelPendingTrackingRestore();
              if (!_followTracked()) return false;
              _publishTrackedSelection(pickedIcao, 'user');
              return true;
            },
          });
          return;
        }

        // A click selects and centres the plane once; it does not follow it
        // (src/data/clickSelect.js).
        if (pickedIcao && flightState._icons?.has(pickedIcao)) {
          _cancelPendingTrackingRestore();
          _trackFlight(pickedIcao, { origin: 'user', follow: false });
          return;
        }
      }

      // A pick that belongs to a sibling layer (commercial flight, satellite,
      // vessel, station, CCTV camera…) is not "empty space" — leave tracking
      // alone and let that layer handle it. resolvePickId String()-coerces the
      // heterogeneous pick ids (numeric NORAD ids, AIS record objects) so the
      // registry predicates can recognize them (H2).
      if (picked) {
        const pickedId = resolvePickId(picked);
        if (pickedId && isOwnedByOtherLayer('military', pickedId)) return;
      }

      // Clicked empty space -- deselect only for a clean, short click. A slow
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
    _buildTrackedLabel,
    _trackedStaleCue,
    _trackedIconColor,
    _staleCueTick,
    _updateTrackedLabelModel,
    _syncTrackedBillboardImage,
    _refreshTr3bContact,
    _refreshTr3bForStyle,
    _resetTrackedSelectionState,
    _trackedModelRegimeActive,
    _trackedBillboardLook,
    _trackedSprite,
    _syncTracked2dRotation,
    _trailFloorPosition,
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
    _applyPendingTrackingRestore,
    _cancelPendingTrackingRestore,
    _trackFlight,
    _followTracked,
    _trackedIsFollowed,
    _centerTracked,
    _onKeyDown,
    _installClickHandler,
  };
}
