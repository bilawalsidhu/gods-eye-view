/** The orbital (satellite) view of the Cockpit controller: camera, zoom, look and HUD. */
import { formatNumber, msg, t } from '../i18n/index.js';
import {
  ORBITAL_BASE_MAX_ZOOM,
  ORBITAL_DEFAULT_ZOOM,
  ORBITAL_SETTLE_BLUR_PX,
  ORBITAL_ZOOM_LADDER,
  ORBITAL_ZOOM_TRANSITION_MS,
  cesiumFrustumFovRad,
  footprintWidthKm,
  fovForZoom,
  interpolateZoomFov,
  nadirOrientation,
  nextOrbitalZoom,
  offNadirAngleDeg,
  offNadirOrientation,
  offNadirCentreMeetsEarth,
  offNadirSwathScale,
  orbitalBaseFovRad,
  previousOrbitalZoom,
  zoomSettleHolding,
  zoomTransitionState,
} from '../cockpitOrbital.js';
import {
  clampOrbitalLook,
  easeLook,
  lookIsOffset,
  orbitalLookReadoutParts,
  stepOrbitalLook,
} from '../cockpitLook.js';
import { cockpitUiUpdateDue } from '../cockpitMath.js';
import { createPlaceTracker, nearPlaceRadiusKm } from '../data/placeBelow.js';
import {
  COCKPIT_CONTEXT_UPDATE_MS,
  COCKPIT_HUD_UPDATE_MS,
  compassPointLabel,
  formatCockpitCoordinate,
} from './cockpitPresentation.js';

/**
 * How often the orbital view asks for a regional brief. A low orbit crosses
 * the briefing's 25 km refresh distance every few seconds, so the sub-satellite
 * point is briefed on a clock instead.
 */
export const ORBITAL_BRIEF_REFRESH_MS = 60_000;

/** Whether the user asked for reduced motion: zoom steps and tilts cut. */
function prefersReducedMotion() {
  return Boolean(
    globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches,
  );
}

const IDLE_TRANSITION = Object.freeze({
  active: false,
  blurPx: 0,
  lockTick: false,
});

const NADIR_LOOK = Object.freeze({ yawDeg: 0, pitchDeg: 0 });

/**
 * Start an orbital session's state. Keeps the camera's own field of view so
 * the exit can put it back exactly.
 */
export function beginOrbital() {
  const frustum = this.viewer.camera?.frustum;
  const state = {
    imagery: acquireOrbitImagery(this.services),
    zoom: ORBITAL_DEFAULT_ZOOM,
    // A zoom step in flight: the magnification it started from and when.
    transition: null,
    previousUp: null,
    savedFov: Number.isFinite(frustum?.fov) ? frustum.fov : null,
    altitudeM: null,
    verticalFov: null,
    lastBriefMs: 0,
    lookTarget: { ...NADIR_LOOK },
    lookView: { ...NADIR_LOOK },
    lookLastMs: performance.now(),
    // What the sub-satellite point is over: undefined until the first
    // lookup lands, then a place or null (nothing named there).
    place: undefined,
    placeTracker: null,
  };
  state.placeTracker = createPlaceTracker({
    lookup: this.services.placeBelow,
    onPlace: (place) => {
      if (this.orbital !== state) return;
      state.place = place;
      if (this.lastSubjectInfo?.kind === 'satellite')
        publishOrbitalView.call(this, this.lastSubjectInfo);
    },
  });
  this.orbital = state;
}

/** End the orbital session: restore the field of view and clear the HUD. */
export function endOrbital() {
  const state = this.orbital;
  if (!state) return;
  this.orbital = null;
  state.placeTracker?.reset();
  const frustum = this.viewer.camera?.frustum;
  if (frustum && state.savedFov !== null) frustum.fov = state.savedFov;
  // Back to the map the operator had, unless they picked another meanwhile.
  state.imagery?.release?.()?.catch?.(() => {});
  this.publishOrbital(null);
}

/**
 * Offer the sub-satellite point to the place tracker, with the radius a
 * populated place may lie in to be named (half the settled view's smaller
 * ground dimension, from NEAR_PLACE_MIN_ZOOM on), so a zoom step refreshes
 * the place at once.
 */
function trackPlace(info, nowMs) {
  const state = this.orbital;
  if (!state?.placeTracker) return;
  let nearKm = null;
  if (Number.isFinite(info.altitudeM)) {
    const frustum = this.viewer.camera?.frustum;
    const aspect = Number.isFinite(frustum?.aspectRatio)
      ? frustum.aspectRatio
      : canvasAspect(this.viewer);
    const fov = fovForZoom(orbitalBaseFovRad(info.altitudeM), state.zoom);
    // The field of view is vertical: aspect 1 gives the ground height.
    nearKm = nearPlaceRadiusKm(
      state.zoom,
      footprintWidthKm(info.altitudeM, fov, aspect),
      footprintWidthKm(info.altitudeM, fov, 1),
    );
  }
  state.placeTracker.update(info.latitude, info.longitude, nowMs, nearKm);
}

/**
 * Lease the map for flat imagery while in orbit. Another owner already
 * holding it (an imagery comparison) keeps the map as it is.
 * @returns {{release: () => Promise<void>}|null}
 */
function acquireOrbitImagery(services) {
  try {
    const lease = services?.acquireOrbitImagery?.() ?? null;
    lease?.ready?.catch?.(() => {});
    return lease;
  } catch {
    return null;
  }
}

/** The magnification the view shows at `nowMs`, mid-step included. */
function currentMagnification(state, baseFov, nowMs) {
  const fov = verticalFovAt(state, baseFov, nowMs).fov;
  return Math.tan(baseFov / 2) / Math.tan(fov / 2);
}

/**
 * The vertical field of view at `nowMs` and the step's HUD state. Once the
 * field of view lands, the focus pull holds until the imagery has loaded
 * (see `zoomSettleHolding`), then the reticle locks. A step that has settled
 * (lock tick over) is retired.
 */
function verticalFovAt(state, baseFov, nowMs, tilesLoaded = true) {
  const target = fovForZoom(baseFov, state.zoom);
  const step = state.transition;
  if (!step) return { fov: target, transition: IDLE_TRANSITION, moving: false };
  const elapsedMs = nowMs - step.startMs;
  const landedMs = elapsedMs - ORBITAL_ZOOM_TRANSITION_MS;
  if (landedMs >= 0 && step.heldMs === undefined) {
    if (zoomSettleHolding(landedMs, tilesLoaded)) {
      return {
        fov: target,
        transition: {
          active: true,
          blurPx: ORBITAL_SETTLE_BLUR_PX,
          lockTick: false,
        },
        moving: true,
      };
    }
    step.heldMs = landedMs;
  }
  // The lock tick runs from the end of the hold, not the end of the move.
  const now = zoomTransitionState(elapsedMs - (step.heldMs ?? 0));
  const fov = interpolateZoomFov(
    fovForZoom(baseFov, step.fromZoom),
    target,
    now.progress,
  );
  return {
    fov,
    transition: {
      active: now.active,
      // Settled steps carry no residue of the blur curve (sin π ≠ 0).
      blurPx: now.active ? now.blurPx : 0,
      lockTick: now.lockTick,
    },
    moving: now.active || now.lockTick,
  };
}

/** Apply the field of view for the altitude and time; returns the HUD state. */
function applyFov(state, altitudeM, nowMs) {
  const baseFov = orbitalBaseFovRad(altitudeM);
  const reading = verticalFovAt(
    state,
    baseFov,
    nowMs,
    tilesLoaded(this.viewer),
  );
  // The step's last frame (its lock tick over) publishes the idle state.
  if (state.transition && !reading.moving) {
    state.transition = null;
    reading.transition = IDLE_TRANSITION;
  }
  state.verticalFov = reading.fov;
  const frustum = this.viewer.camera?.frustum;
  if (frustum && 'fov' in frustum) {
    const aspect = Number.isFinite(frustum.aspectRatio)
      ? frustum.aspectRatio
      : canvasAspect(this.viewer);
    frustum.fov = cesiumFrustumFovRad(reading.fov, aspect);
  }
  return reading;
}

/**
 * Whether the imagery under the view has loaded. Flat imagery drapes the
 * globe; with the globe hidden (Google 3D kept) there is nothing to wait for.
 */
function tilesLoaded(viewer) {
  const globe = viewer.scene?.globe;
  return !globe?.show || globe.tilesLoaded !== false;
}

function canvasAspect(viewer) {
  const canvas = viewer.scene?.canvas;
  const width = canvas?.clientWidth;
  const height = canvas?.clientHeight;
  return width > 0 && height > 0 ? width / height : 1;
}

/** Copy a plain vector into a Cesium scratch. */
function intoCartesian(vector, result) {
  result.x = vector.x;
  result.y = vector.y;
  result.z = vector.z;
  return result;
}

/**
 * Drive the orbital camera for one rendered frame: at the satellite's own
 * per-frame position, looking at the Earth's centre with the ground track at
 * the top (north at the top for a satellite with none), tilted by the
 * off-nadir look. A low orbit moves ~7.6 km/s, so there is no cadence
 * gate here; only the HUD and briefing keep theirs.
 * @param {number} nowMs Frame time.
 */
export function updateOrbital(nowMs) {
  // Tracking anything from orbit (an aircraft, another satellite) ends the
  // view and leaves Cesium tracking with that target.
  if (this.viewer.trackedEntity?.position) {
    this.exit({ restoreTracking: false });
    return;
  }
  const info = this.readSatelliteInfo();
  if (!info || info.noradId !== this.subjectId || !this.orbital) {
    this.exit({ restoreTracking: false });
    return;
  }
  const position = this.services.satellitesLayer?.getCockpitPosition?.(
    this.scratchTarget,
  );
  if (!position) return;
  const state = this.orbital;
  // Track-up: the ground track at the top, so the picture scrolls along it.
  // A geostationary satellite has no track and stays north-up.
  const nadir = nadirOrientation(position, {
    previousUp: state.previousUp,
    headingDeg: Number.isFinite(info.groundTrackDeg)
      ? info.groundTrackDeg
      : null,
  });
  if (!nadir) return;
  state.previousUp = nadir.north;
  state.altitudeM = info.altitudeM;
  state.lookView = easeLook(
    state.lookView,
    state.lookTarget,
    nowMs - (state.lookLastMs || nowMs),
    { immediate: prefersReducedMotion() },
  );
  state.lookLastMs = nowMs;
  const view = offNadirOrientation(nadir, {
    northDeg: state.lookView.pitchDeg,
    eastDeg: state.lookView.yawDeg,
  });
  const zoomStepping = Boolean(state.transition);
  const reading = applyFov.call(this, state, info.altitudeM, nowMs);
  this.viewer.camera.setView({
    destination: position,
    orientation: {
      direction: intoCartesian(view.direction, this.scratchForward),
      up: intoCartesian(view.up, this.scratchUp),
    },
  });
  this.lastSubjectInfo = info;
  if (
    zoomStepping ||
    cockpitUiUpdateDue(nowMs, this.lastHudUpdateMs, COCKPIT_HUD_UPDATE_MS)
  ) {
    this.lastHudUpdateMs = nowMs;
    trackPlace.call(this, info, nowMs);
    publishOrbitalView.call(this, info, reading.transition);
  }
  if (
    cockpitUiUpdateDue(
      nowMs,
      this.lastContextUpdateMs,
      COCKPIT_CONTEXT_UPDATE_MS,
    )
  ) {
    this.lastContextUpdateMs = nowMs;
    updateOrbitalContext.call(this, info, nowMs);
  }
}

/**
 * Brief the sub-satellite point: the local page every context beat, the
 * regional brief on its own slower clock.
 */
function updateOrbitalContext(info, nowMs, force = false) {
  this.updateLocalPosition(info);
  const state = this.orbital;
  if (
    state &&
    (force || nowMs - state.lastBriefMs >= ORBITAL_BRIEF_REFRESH_MS)
  ) {
    state.lastBriefMs = nowMs;
    this.maybeRefreshRegionalBrief(info);
  }
}

/**
 * A track-up view tilts along and across the ground track, not toward the
 * compass: the look's north/east axes are the frame's top and right.
 */
const TRACK_LOOK_LABELS = Object.freeze({
  N: msg('FWD'),
  S: msg('AFT'),
  E: msg('RIGHT'),
  W: msg('LEFT'),
});

function lookDirectionLabel(code, trackUp) {
  return trackUp ? t(TRACK_LOOK_LABELS[code]) : compassPointLabel(code);
}

/**
 * Word the off-nadir look with its total angle from nadir first, or '' at
 * nadir: `OFF-NADIR 18.0° · FWD 15° · RIGHT 10°`.
 */
function wordOffNadir(look, { trackUp = false } = {}) {
  const parts = orbitalLookReadoutParts(look);
  const words = [];
  if (parts.northSouth)
    words.push(
      t('{direction} {angle}°', {
        direction: lookDirectionLabel(parts.northSouth, trackUp),
        angle: formatNumber(parts.northSouthDeg),
      }),
    );
  if (parts.eastWest)
    words.push(
      t('{direction} {angle}°', {
        direction: lookDirectionLabel(parts.eastWest, trackUp),
        angle: formatNumber(parts.eastWestDeg),
      }),
    );
  if (!words.length) return '';
  return t('OFF-NADIR {angle}° · {offset}', {
    angle: formatNumber(offNadirAngleDeg(lookTilt(parts)), {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    }),
    offset: words.join(' · '),
  });
}

/** The look's tilt as worded: whole degrees, signed north and east. */
function lookTilt(parts) {
  return {
    northDeg: (parts.northSouth === 'S' ? -1 : 1) * parts.northSouthDeg,
    eastDeg: (parts.eastWest === 'W' ? -1 : 1) * parts.eastWestDeg,
  };
}

/**
 * Publish the orbital HUD. The swath is the nadir footprint, so it is left
 * out while the view is tilted off nadir.
 * @param {object} info Satellite subject (`readSatelliteInfo`).
 * @param {{active: boolean, blurPx: number, lockTick: boolean}} transition
 */
export function publishOrbitalView(info, transition = IDLE_TRANSITION) {
  const state = this.orbital;
  if (!state || !info) return;
  const offset = lookIsOffset(state.lookTarget, 0);
  const aspect = Number.isFinite(this.viewer.camera?.frustum?.aspectRatio)
    ? this.viewer.camera.frustum.aspectRatio
    : canvasAspect(this.viewer);
  const settledFov = fovForZoom(orbitalBaseFovRad(info.altitudeM), state.zoom);
  const footprintKm = footprintWidthKm(info.altitudeM, settledFov, aspect);
  const trackUp = Number.isFinite(info.groundTrackDeg);
  const tilt = offset
    ? lookTilt(orbitalLookReadoutParts(state.lookTarget))
    : null;
  const swathScale = offset ? offNadirSwathScale(tilt) : 1;
  // Tilted past the limb, the view's centre looks into space: no swath. The
  // camera eases toward the target, so both must meet the Earth; the HUD
  // republishes on its cadence, so the swath appears once the view arrives.
  // Exact angles here, not the whole degrees the readout rounds to.
  const target = clampOrbitalLook(state.lookTarget);
  const seesEarth =
    !offset ||
    (offNadirCentreMeetsEarth(info.altitudeM, {
      northDeg: target.pitchDeg,
      eastDeg: target.yawDeg,
    }) &&
      offNadirCentreMeetsEarth(info.altitudeM, {
        northDeg: state.lookView?.pitchDeg ?? 0,
        eastDeg: state.lookView?.yawDeg ?? 0,
      }));
  this.publishOrbital({
    name: info.name,
    classLabel: info.classLabel || '',
    altitudeM: info.altitudeM,
    velocityMps: Number.isFinite(info.velocityMps) ? info.velocityMps : null,
    latitude: info.latitude,
    longitude: info.longitude,
    zoom: state.zoom,
    zoomSteps: [...ORBITAL_ZOOM_LADDER],
    maxZoom: ORBITAL_BASE_MAX_ZOOM,
    footprintKm: offset ? null : footprintKm,
    transition: { ...transition },
    look: {
      offset,
      readout: offset ? wordOffNadir(state.lookTarget, { trackUp }) : '',
      // Off nadir, the ground width at the view's centre, approximated from
      // the nadir footprint (`offNadirSwathScale`); 1 and null at nadir.
      swathScale,
      swathKm:
        offset && seesEarth && Number.isFinite(footprintKm)
          ? footprintKm * swathScale
          : null,
    },
    // Track-up turns the frame to the ground track; north then sits at
    // `northDeg` clockwise from the top. A geostationary view stays north-up.
    trackUp,
    northDeg: trackUp ? (360 - info.groundTrackDeg) % 360 : 0,
    place: state.place,
    noradId: info.noradId ?? null,
    cosparId: info.cosparId ?? null,
    tle: info.tle ?? null,
    owner: info.owner ?? null,
    operator: info.operator ?? null,
  });
}

/**
 * Present the orbital view on entry and after a language switch: the HUD,
 * the local page and a regional brief for the sub-satellite point.
 * @param {object} info Satellite subject.
 */
export function updateOrbitalHud(info, nowMs = performance.now()) {
  this.lastSubjectInfo = info;
  // A satellite has no flight plan and no Contact card.
  this.routeView.visible = false;
  this.clearPredictiveRoute();
  this.showContextCard(false);
  trackPlace.call(this, info, nowMs);
  publishOrbitalView.call(this, info);
  updateOrbitalContext.call(this, info, nowMs, true);
}

/** Re-apply the field of view and publish after a zoom or look change. */
function presentNow() {
  const state = this.orbital;
  const info = this.lastSubjectInfo;
  if (!state || info?.kind !== 'satellite') return;
  const nowMs = performance.now();
  const reading = Number.isFinite(state.altitudeM ?? info.altitudeM)
    ? applyFov.call(this, state, state.altitudeM ?? info.altitudeM, nowMs)
    : null;
  publishOrbitalView.call(this, info, reading?.transition ?? IDLE_TRANSITION);
}

/**
 * Step the optical zoom one step in (`direction` > 0) or out. The step
 * animates over ORBITAL_ZOOM_TRANSITION_MS with a focus-pull blur and a
 * lock tick, or cuts at once under reduced motion. The ends stay put.
 * @param {number} direction Positive to zoom in, negative to zoom out.
 * @returns {boolean} True when the zoom changed.
 */
export function stepOrbitalZoom(direction) {
  if (!this.active || this.subjectKind !== 'satellite' || !this.orbital)
    return false;
  const state = this.orbital;
  const next =
    direction > 0
      ? nextOrbitalZoom(state.zoom)
      : previousOrbitalZoom(state.zoom);
  return goToZoom.call(this, next);
}

/**
 * Move the zoom to `next`, animated from the magnification shown now unless
 * reduced motion is on.
 * @returns {boolean} True when the zoom changed.
 */
function goToZoom(next) {
  const state = this.orbital;
  if (!Number.isFinite(next) || next === state.zoom) return false;
  const nowMs = performance.now();
  const altitudeM = state.altitudeM ?? this.lastSubjectInfo?.altitudeM;
  const fromZoom = Number.isFinite(altitudeM)
    ? currentMagnification(state, orbitalBaseFovRad(altitudeM), nowMs)
    : state.zoom;
  state.zoom = next;
  state.transition = prefersReducedMotion()
    ? null
    : { fromZoom, startMs: nowMs };
  presentNow.call(this);
  return true;
}

/**
 * Tilt the orbital view one arrow step off nadir (see `lookKeyStep`); each
 * axis stops at ±45°. The view eases there unless reduced motion is on.
 * @param {{axis: 'yaw'|'pitch', sign: number, stepDeg: number}} step
 * @returns {boolean} True in an orbital view.
 */
export function turnOrbitalLook(step) {
  if (!this.active || this.subjectKind !== 'satellite' || !this.orbital)
    return false;
  if (!step) return false;
  const state = this.orbital;
  state.lookTarget = stepOrbitalLook(state.lookTarget, step);
  if (prefersReducedMotion()) state.lookView = { ...state.lookTarget };
  presentNow.call(this);
  return true;
}

/**
 * Bring the orbital view back to pure nadir (Home, 0 or the NADIR button).
 * @param {{immediate?: boolean}} [options] Jump instead of easing.
 * @returns {boolean} True in an orbital view.
 */
export function resetOrbitalLook({ immediate = false } = {}) {
  if (!this.active || this.subjectKind !== 'satellite' || !this.orbital)
    return false;
  const state = this.orbital;
  state.lookTarget = { ...NADIR_LOOK };
  if (immediate || prefersReducedMotion()) state.lookView = { ...NADIR_LOOK };
  presentNow.call(this);
  return true;
}
