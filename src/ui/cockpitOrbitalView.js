/** The orbital (satellite) view of the Cockpit controller: camera, zoom, look and HUD. */
import * as Cesium from 'cesium';
import { formatNumber, msg, t } from '../i18n/index.js';
import {
  ORBITAL_DEFAULT_ZOOM,
  ORBITAL_PREFETCH_INTERVAL_MS,
  centreLinesFirst,
  ORBITAL_PREFETCH_MAX_TILES,
  ORBITAL_PREFETCH_MIN_ZOOM,
  ORBITAL_SETTLE_BLUR_PX,
  ORBITAL_ZOOM_LADDER,
  ORBITAL_ZOOM_TRANSITION_MS,
  cesiumFrustumFovRad,
  footprintWidthKm,
  fovForZoom,
  groundTrackAhead,
  imageryLevelForView,
  interpolateZoomFov,
  nadirOrientation,
  nextOrbitalZoom,
  offNadirAngleDeg,
  offNadirOrientation,
  offNadirCentreMeetsEarth,
  offNadirSwathScale,
  orbitalBaseFovRad,
  orbitalMaxZoom,
  previousOrbitalZoom,
  sensorStripFraction,
  sensorSwathZoom,
  tilesForPoints,
  wheelZoomStep,
  zoomSettleHolding,
  zoomTransitionState,
} from '../cockpitOrbital.js';
import {
  clampOrbitalLook,
  lookIsOffset,
  orbitalLookReadoutParts,
  stepOrbitalLook,
} from '../cockpitLook.js';
import { cockpitUiUpdateDue } from '../cockpitMath.js';
import { createPlaceTracker, nearPlaceRadiusKm } from '../data/placeBelow.js';
import { isPointerFree } from '../data/inputOwnership.js';
import { zoomableSwathKm } from '../layers/satellites/sensors.js';
import {
  easeOrbitalLook,
  orbitalFocusReadout,
  releaseOrbitalFocus,
  updateOrbitalFocus,
} from './cockpitOrbitalFocus.js';
import { orbitalEyePosition } from './cockpitOrbitalSatellites.js';
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
    // Wheel scrolling summed toward the next zoom step (wheelZoomStep).
    wheel: null,
    // Imagery pre-loaded ahead of the ground track from 16x: when it last
    // looked ahead, and the tiles already asked for (oldest first).
    prefetchMs: -Infinity,
    prefetched: new Set(),
    // The provider those tiles came from, and the requests still in flight.
    prefetchProvider: null,
    prefetchRequests: new Set(),
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
  // Pre-loads still queued or in flight are for a view no longer shown.
  for (const request of state.prefetchRequests) request.cancel?.();
  state.prefetchRequests.clear();
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
  // On the satellite, or on the way to it after Previous/Next.
  const eye = orbitalEyePosition(state, position, nowMs);
  // Track-up: the ground track at the top, so the picture scrolls along it.
  // A geostationary satellite has no track and stays north-up.
  const nadir = nadirOrientation(eye, {
    previousUp: state.previousUp,
    headingDeg: Number.isFinite(info.groundTrackDeg)
      ? info.groundTrackDeg
      : null,
  });
  if (!nadir) return;
  state.previousUp = nadir.north;
  state.altitudeM = info.altitudeM;
  // The top step follows live altitude and the window's shape: when it
  // falls below the zoom shown, step back to it rather than show finer
  // ground than the sensor images.
  const maxZoom = orbitalMaxZoomFor.call(this, info);
  if (state.zoom > maxZoom) {
    this.lastSubjectInfo = info;
    goToZoom.call(this, maxZoom);
  }
  // A ground focus aims the look itself (src/ui/cockpitOrbitalFocus.js).
  if (!updateOrbitalFocus.call(this, state, nadir, eye, nowMs))
    state.lookView = easeOrbitalLook(
      state,
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
    destination: eye,
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
  prefetchImageryAhead.call(this, info, nowMs);
}

/** Tiles remembered as asked for in one orbital session. */
const PREFETCH_MEMORY = 512;

/** How far the shown time may be from now for the look-ahead to run, ms. */
const PREFETCH_LIVE_TOLERANCE_MS = 60_000;

/**
 * From 16x the view is 10 to 40 km wide while the ground track moves about
 * 7 km/s, so the imagery under it arrives late. Every
 * ORBITAL_PREFETCH_INTERVAL_MS ask the globe's base imagery for the tiles
 * the view will need 5 to 20 s ahead (`groundTrackAhead`), at the level
 * Cesium will draw there (`imageryLevelForView`), so the browser has them
 * cached when the view gets there. The requests are throttled at the
 * lowest priority: Cesium's request scheduler declines one while the
 * imagery server's slots are taken by the tiles on screen or the scheduler
 * is full, and a declined tile is asked again on a later look-ahead. At most
 * ORBITAL_PREFETCH_MAX_TILES a time; the last PREFETCH_MEMORY tiles asked
 * for are not asked again unless their request failed, and a new base map
 * starts the memory over. Exit cancels the requests still pending. Nothing
 * below 16x, while the view is tilted off nadir (it no longer looks at the
 * track), with the world clock away from now (paused, played back), after
 * the exit, or with the globe hidden (Google 3D tiles drawn instead).
 * @returns {number} The tiles asked for.
 */
export function prefetchImageryAhead(info, nowMs) {
  const state = this.orbital;
  if (!state || !(state.zoom >= ORBITAL_PREFETCH_MIN_ZOOM)) return 0;
  // Tilted, the view looks off the track the pre-load follows.
  if (lookIsOffset(state.lookTarget, 0) || lookIsOffset(state.lookView, 0))
    return 0;
  if (nowMs - state.prefetchMs < ORBITAL_PREFETCH_INTERVAL_MS) return 0;
  // The look-ahead runs at live speed: with the world clock paused, played
  // back or moved, the view will not pass where it points.
  if (
    Number.isFinite(info.atMs) &&
    Math.abs(info.atMs - Date.now()) > PREFETCH_LIVE_TOLERANCE_MS
  )
    return 0;
  state.prefetchMs = nowMs;
  try {
    const globe = this.viewer.scene?.globe;
    if (!globe || globe.show === false) return 0;
    const provider = baseImageryProvider(this.viewer);
    if (!provider) return 0;
    // Another base map: its tiles have not been asked for.
    // A fresh set, so a late failure from the old map's requests cannot
    // drop a tile the new one has fetched.
    if (provider !== state.prefetchProvider) {
      for (const request of state.prefetchRequests) request.cancel?.();
      state.prefetchRequests = new Set();
      state.prefetched = new Set();
      state.prefetchProvider = provider;
    }
    const fov = fovForZoom(orbitalBaseFovRad(info.altitudeM), state.zoom);
    const viewKm = footprintWidthKm(
      info.altitudeM,
      fov,
      viewAspect(this.viewer),
    );
    // The ground one CSS pixel covers at the nadir point, as Cesium's
    // screen-space error measures it: the vertical field of view over the
    // canvas height, at the satellite's altitude.
    const canvas = this.viewer.scene?.canvas;
    const heightPx = canvas?.clientHeight || canvas?.height;
    const terrain =
      this.viewer.terrainProvider ?? this.viewer.scene?.globe?.terrainProvider;
    const level = imageryLevelForView(provider.tilingScheme, {
      metresPerPixel: (info.altitudeM * 2 * Math.tan(fov / 2)) / heightPx,
      latitudeDeg: info.latitude,
      geographic:
        provider.tilingScheme.projection instanceof Cesium.GeographicProjection,
      tileWidthPx: provider.tileWidth,
      minimumLevel: provider.minimumLevel,
      maximumLevel: provider.maximumLevel,
      maximumScreenSpaceError: globe.maximumScreenSpaceError,
      terrainLevelErrorM:
        typeof terrain?.getLevelMaximumGeometricError === 'function'
          ? (terrainLevel) =>
              terrain.getLevelMaximumGeometricError(terrainLevel)
          : undefined,
    });
    if (level === null) return 0;
    const memory = state.prefetched;
    const tiles = tilesForPoints(
      provider.tilingScheme,
      centreLinesFirst(groundTrackAhead(info, viewKm)),
      level,
      {
        maxTiles: ORBITAL_PREFETCH_MAX_TILES,
        skip: (key) => memory.has(key),
      },
    );
    let asked = 0;
    for (const tile of tiles) {
      let pending;
      let request;
      try {
        // The tiles on screen keep their slots: Cesium's scheduler declines
        // this request while the imagery server's slots are taken (shared
        // with the globe's own tile requests, throttleByServer) or the
        // scheduler is full, and at the lowest priority it is the first
        // dropped from the priority heap, never one the screen asked for.
        pending = provider.requestImage(
          tile.x,
          tile.y,
          tile.level,
          (request = new Cesium.Request({
            throttle: true,
            throttleByServer: true,
            priority: Number.MAX_VALUE,
            type: Cesium.RequestType.IMAGERY,
          })),
        );
      } catch {
        continue;
      }
      // A provider that declines now (throttled) is asked again later.
      if (!pending) continue;
      const requests = state.prefetchRequests;
      requests.add(request);
      Promise.resolve(pending).then(
        () => requests.delete(request),
        (error) => {
          requests.delete(request);
          // Dropped by the scheduler (rejected with no error): asked again
          // later. A tile that failed to load stays remembered, so one
          // missing from the map is not asked for every look-ahead.
          if (error === undefined) memory.delete(tile.key);
        },
      );
      memory.add(tile.key);
      if (memory.size > PREFETCH_MEMORY)
        memory.delete(memory.values().next().value);
      asked += 1;
    }
    return asked;
  } catch {
    return 0;
  }
}

/**
 * The provider of the lowest shown imagery layer, the base map the globe
 * drapes, when it can be asked for a tile; else null.
 */
function baseImageryProvider(viewer) {
  const layers = viewer.imageryLayers ?? viewer.scene?.imageryLayers;
  const count = Number.isInteger(layers?.length) ? layers.length : 0;
  for (let i = 0; i < count; i += 1) {
    const layer = layers.get(i);
    if (!layer || layer.show === false || layer.alpha === 0) continue;
    const provider = layer.imageryProvider;
    if (
      typeof provider?.requestImage === 'function' &&
      typeof provider.tilingScheme?.positionToTileXY === 'function'
    )
      return provider;
    return null;
  }
  return null;
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
 * Word a ground focus's off-nadir angle, as image metadata gives it:
 * `OFF-NADIR 23.4°`.
 */
function wordFocusOffNadir(focus) {
  return t('OFF-NADIR {angle}°', {
    angle: formatNumber(focus.offNadirDeg, {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    }),
  });
}

/**
 * Publish the orbital HUD. The swath is the nadir footprint, so it is left
 * out while the view is tilted off nadir. A ground focus reads the single
 * off-nadir angle to its target and scales the swath by the tilt onto it.
 * @param {object} info Satellite subject (`readSatelliteInfo`).
 * @param {{active: boolean, blurPx: number, lockTick: boolean}} transition
 */
export function publishOrbitalView(info, transition = IDLE_TRANSITION) {
  const state = this.orbital;
  if (!state || !info) return;
  const focus = orbitalFocusReadout.call(this);
  const offset = Boolean(focus) || lookIsOffset(state.lookTarget, 0);
  const aspect = Number.isFinite(this.viewer.camera?.frustum?.aspectRatio)
    ? this.viewer.camera.frustum.aspectRatio
    : canvasAspect(this.viewer);
  const settledFov = fovForZoom(orbitalBaseFovRad(info.altitudeM), state.zoom);
  const footprintKm = footprintWidthKm(info.altitudeM, settledFov, aspect);
  // The strip is drawn over the picture, so it follows the view as a step
  // zooms (republished every frame then), not the step it is heading for.
  const shownKm = Number.isFinite(state.verticalFov)
    ? footprintWidthKm(info.altitudeM, state.verticalFov, aspect)
    : footprintKm;
  const maxZoom = orbitalMaxZoomFor.call(this, info);
  const swathKm = sensorSwathKm(info);
  const trackUp = Number.isFinite(info.groundTrackDeg);
  // A ground focus sets the tilt; otherwise the look target does.
  const tilt = focus
    ? { northDeg: focus.pitchDeg, eastDeg: focus.yawDeg }
    : offset
      ? lookTilt(orbitalLookReadoutParts(state.lookTarget))
      : null;
  const swathScale = tilt ? offNadirSwathScale(tilt) : 1;
  // Tilted past the limb, the view's centre looks into space: no swath. The
  // camera eases toward the target, so both must meet the Earth; the HUD
  // republishes on its cadence, so the swath appears once the view arrives.
  // Exact angles here, not the whole degrees the readout rounds to; a ground
  // focus aims the look itself, so its angles are the target.
  const target = focus
    ? { pitchDeg: focus.pitchDeg, yawDeg: focus.yawDeg }
    : clampOrbitalLook(state.lookTarget);
  // The eased view is tested even with the target at nadir: on the way back
  // from past the limb it still looks into space.
  const seesEarth =
    (!offset ||
      offNadirCentreMeetsEarth(info.altitudeM, {
        northDeg: target.pitchDeg,
        eastDeg: target.yawDeg,
      })) &&
    offNadirCentreMeetsEarth(info.altitudeM, {
      northDeg: state.lookView?.pitchDeg ?? 0,
      eastDeg: state.lookView?.yawDeg ?? 0,
    });
  this.publishOrbital({
    name: info.name,
    classLabel: info.classLabel || '',
    altitudeM: info.altitudeM,
    velocityMps: Number.isFinite(info.velocityMps) ? info.velocityMps : null,
    latitude: info.latitude,
    longitude: info.longitude,
    zoom: state.zoom,
    zoomSteps: ORBITAL_ZOOM_LADDER.filter((step) => step <= maxZoom),
    maxZoom,
    footprintKm: offset ? null : footprintKm,
    // The imaging sensor's swath, drawn to scale; null without one. The
    // SENSOR step's zoom is null when the swath lies outside 1x..maxZoom.
    // Looking past the limb there is no ground for it to cover: no sensor.
    sensor:
      swathKm === null || !seesEarth
        ? null
        : {
            label: info.sensor?.label ?? null,
            swathKm,
            // Off nadir the view and the swath widen alike: the strip
            // keeps its share of the frame. No strip where it would
            // mislead: a geostationary view has no ground track to run
            // along, and a SAR images to one side of nadir, not under it.
            stripFraction:
              trackUp && info.sensor?.type !== 'SAR'
                ? sensorStripFraction(swathKm, shownKm)
                : null,
            zoom: sensorSwathZoom(info.altitudeM, swathKm, aspect, maxZoom),
          },
    transition: { ...transition },
    look: {
      offset,
      readout: focus
        ? wordFocusOffNadir(focus)
        : offset
          ? wordOffNadir(state.lookTarget, { trackUp })
          : '',
      // The mapped point the view is held on, or null.
      focus: focus ? { key: focus.key, label: focus.label } : null,
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
    // Read on the HUD's cadence, so the age stays current without a timer.
    // The gap between the TLE's epoch and the time the satellite is shown
    // at (the world clock's), either side: SGP4 drifts both ways.
    tleAgeMs: Number.isFinite(info.tle?.epochMs)
      ? Math.abs(
          (Number.isFinite(info.atMs) ? info.atMs : Date.now()) -
            info.tle.epochMs,
        )
      : null,
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
      ? nextOrbitalZoom(
          state.zoom,
          orbitalMaxZoomFor.call(this, this.lastSubjectInfo),
        )
      : previousOrbitalZoom(state.zoom);
  return goToZoom.call(this, next);
}

/**
 * Jump to the zoom at which the view is exactly as wide as the imaging
 * sensor's swath (the SENSOR step), when that zoom is in range.
 * @returns {boolean} True when the zoom changed.
 */
export function jumpToSensorSwath() {
  if (!this.active || this.subjectKind !== 'satellite' || !this.orbital)
    return false;
  const info = this.lastSubjectInfo;
  const swathKm = sensorSwathKm(info);
  if (swathKm === null || !Number.isFinite(info?.altitudeM)) return false;
  const zoom = sensorSwathZoom(
    info.altitudeM,
    swathKm,
    viewAspect(this.viewer),
    orbitalMaxZoomFor.call(this, info),
  );
  return zoom === null ? false : goToZoom.call(this, zoom);
}

/**
 * Step the zoom with the mouse wheel over the picture: one step per notch,
 * trackpad scrolling summed to a step (`wheelZoomStep`). Only in orbit, and
 * never while a tool owns the pointer.
 * @param {WheelEvent} event
 * @returns {boolean} True when the zoom changed.
 */
export function onOrbitalWheel(event) {
  if (!this.active || this.subjectKind !== 'satellite' || !this.orbital)
    return false;
  if (!isPointerFree()) return false;
  const state = this.orbital;
  const { accumulator, step } = wheelZoomStep(
    state.wheel,
    event,
    performance.now(),
  );
  state.wheel = accumulator;
  if (!step) return false;
  const changed = stepOrbitalZoom.call(this, step);
  if (changed) event.preventDefault?.();
  return changed;
}

/** The sensor swath the view draws and the SENSOR step targets, km, or null. */
function sensorSwathKm(info) {
  const swathKm = info?.sensor?.narrowestSwathKm;
  return Number.isFinite(swathKm) && swathKm > 0 ? swathKm : null;
}

/**
 * The satellite's tightest zoom step at its live altitude. Only a swath
 * confirmed on a cited page opens steps past 8x.
 */
function orbitalMaxZoomFor(info) {
  return orbitalMaxZoom(
    info?.altitudeM,
    zoomableSwathKm(info?.sensor),
    viewAspect(this.viewer),
  );
}

function viewAspect(viewer) {
  return Number.isFinite(viewer.camera?.frustum?.aspectRatio)
    ? viewer.camera.frustum.aspectRatio
    : canvasAspect(viewer);
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
  // An arrow takes the view over from a ground focus where it is.
  releaseOrbitalFocus.call(this, { handOver: true });
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
  // Ends a ground focus too, easing back on its clock.
  releaseOrbitalFocus.call(this);
  state.lookTarget = { ...NADIR_LOOK };
  if (immediate || prefersReducedMotion()) state.lookView = { ...NADIR_LOOK };
  presentNow.call(this);
  return true;
}
