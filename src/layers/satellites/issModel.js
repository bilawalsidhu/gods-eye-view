import { eciToGeodetic, gstime, propagate } from 'satellite.js';
import { fromRadians } from '../../geo/ellipsoid.js';
import { eastNorthUp } from '../../geo/frames.js';
import { distance, dot, vec } from '../../geo/vector.js';
import { canvasOf, drawOf, findCamera } from '../../render/rendererOf.js';
import { createIssArticulation } from './issArticulation.js';
import {
  ISS_COMPANION_COARSE_M,
  ISS_COMPANION_RADIUS_M,
  ISS_COMPANION_SCAN_MS,
  ISS_CARD_CLEAR_M,
  ISS_MODEL_LOCAL_AXES,
  ISS_MODEL_MAX_DISTANCE_M,
  ISS_MODEL_MIN_PX,
  ISS_MODEL_NATIVE_SPAN,
  ISS_MODEL_URL,
  ISS_NORAD,
  ISS_ORBIT_HIDE_M,
  ISS_SPAN_M,
} from './policy.js';

/** The model's scale for the real 109 m truss. */
export const ISS_MODEL_SCALE = ISS_SPAN_M / ISS_MODEL_NATIVE_SPAN;

/**
 * Whether the ISS model may be drawn: the dot's own rules (layer on, points
 * on, the ISS loaded and its class shown or the ISS tracked), and not while
 * the Cockpit rides the ISS or hides it as a docked companion.
 * @param {{enabled: boolean, showPoints: boolean, hasIss: boolean,
 *   classVisible: boolean, tracked: boolean, cockpitHidden: boolean}} input
 * @returns {boolean}
 */
export function issModelShouldShow({
  enabled,
  showPoints,
  hasIss,
  classVisible,
  tracked,
  cockpitHidden,
}) {
  return (
    Boolean(enabled) &&
    Boolean(showPoints) &&
    Boolean(hasIss) &&
    (Boolean(classVisible) || Boolean(tracked)) &&
    !cockpitHidden
  );
}

/**
 * The station's flight axes in the Earth-fixed frame, from one SGP4 state:
 * the ISS normally flies "+XVV", its modules along the velocity, the truss
 * across the orbit plane, the same side always to the Earth. Returned as the
 * model's local axes: x along-track, y the orbit normal (along the truss), z
 * zenith (away from the Earth's centre).
 * @param {{x:number,y:number,z:number}} positionEcef Earth-fixed position.
 * @param {{x:number,y:number,z:number}} velocityEcefAxes Inertial velocity,
 *   turned onto the Earth-fixed axes (direction only matters).
 * @returns {{x:number[], y:number[], z:number[]}|null} Unit vectors, or null
 *   for a degenerate state (zero position or velocity along it).
 */
export function issFlightAxes(positionEcef, velocityEcefAxes) {
  const r = [positionEcef.x, positionEcef.y, positionEcef.z];
  const v = [velocityEcefAxes.x, velocityEcefAxes.y, velocityEcefAxes.z];
  const z = unit(r);
  const y = unit(cross(r, v));
  if (!z || !y) return null;
  const x = cross(y, z);
  return { x, y, z };
}

/**
 * Turn an inertial (TEME) vector onto the Earth-fixed axes at `gmst`: the same
 * rotation `eciToGeodetic` applies to the position.
 * @param {{x:number,y:number,z:number}} v
 * @param {number} gmst Radians.
 * @returns {{x:number,y:number,z:number}}
 */
export function temeToEcefAxes(v, gmst) {
  const c = Math.cos(gmst);
  const s = Math.sin(gmst);
  return { x: c * v.x + s * v.y, y: -s * v.x + c * v.y, z: v.z };
}

/**
 * The heading, pitch and roll (the render contract's model orientation, in
 * the east-north-up frame at `origin`) that turn the model's local axes onto
 * `axes` (ECEF unit vectors, for local X, Y and Z): the inverse of
 * `geo/quaternion`'s `headingPitchRollFrame`, whose rotation is
 * Rz(−heading)·Ry(−pitch)·Rx(roll).
 * @param {{x:number,y:number,z:number}} origin ECEF metres.
 * @param {number[][]} axes The ECEF directions of local X, Y and Z.
 * @returns {{heading:number, pitch:number, roll:number}}
 */
export function issOrientation(origin, axes) {
  const enu = eastNorthUp(origin);
  const local = axes.map((a) => {
    const v = vec(a[0], a[1], a[2]);
    return [dot(enu.x, v), dot(enu.y, v), dot(enu.z, v)];
  });
  // local[column][row]: the rotation in the east-north-up frame.
  const m20 = Math.max(-1, Math.min(1, local[0][2]));
  return {
    heading: -Math.atan2(local[0][1], local[0][0]),
    pitch: Math.asin(m20),
    roll: Math.atan2(local[1][2], local[2][2]),
  };
}

function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function unit(a) {
  const n = Math.hypot(a[0], a[1], a[2]);
  if (!(n > 0)) return null;
  return [a[0] / n, a[1] / n, a[2] / n];
}

/**
 * The ISS as a 3D model when the camera is close, drawn as an item of a
 * `models` set of the renderer's draw port. Far out the dot stays: the
 * model and the dot (ambient and tracked) split the distance range, so exactly
 * one of them draws. The model loads on first need and only if the ISS is
 * shown, and positions itself every frame from its own SGP4 sample (the dot
 * moves once a second, which at model range would show as a jump). Its
 * joints are posed through the item's `nodes`.
 */
export function createIssModel({ state: layerState, parts, resolveAsset }) {
  /** The models set, made on first need; null until then or after a failure. */
  let set = null;
  /** Whether the model has loaded and draws. */
  let ready = false;
  let failed = false;
  let generation = 0;
  let instances = 0;
  /** Whether the item was last sent shown. */
  let shown = false;
  /** Turns the solar arrays and radiators by where the Sun is. */
  const articulation = createIssArticulation();
  const nearRange = Object.freeze([0, ISS_MODEL_MAX_DISTANCE_M]);
  const farRange = Object.freeze([
    ISS_MODEL_MAX_DISTANCE_M,
    Number.POSITIVE_INFINITY,
  ]);
  /** @type {Set<number>} Docked objects whose dots the model stands in for. */
  const handedCompanions = new Set();
  let lastCompanionScanMs = Number.NEGATIVE_INFINITY;
  /** Whether the ISS's orbit ring is hidden for the close-up. */
  let orbitHidden = false;
  /** The station centre the model last rendered at (for the tracked card). */
  const visualPosition = { x: 0, y: 0, z: 0 };
  let visualValid = false;
  /** The model's item, changed where it is and sent each frame it shows. */
  let item = null;

  function _shouldShow() {
    const tracked = layerState._trackedNorad === ISS_NORAD;
    return issModelShouldShow({
      enabled: layerState._enabled,
      showPoints: layerState._params.showPoints,
      hasIss: layerState._catalog.has(ISS_NORAD),
      classVisible: parts.controls._classVisible(ISS_NORAD),
      tracked,
      cockpitHidden:
        (tracked && parts.cockpit?._cockpitHeld()) ||
        layerState._cockpitHiddenPoints?.has(ISS_NORAD),
    });
  }

  /** The eye's ECEF position, or null. */
  function _eye() {
    return findCamera(layerState._viewer)?.pose?.()?.position ?? null;
  }

  /** Make the models set and add the model to it (fetched from now on). */
  function _load() {
    const draw = layerState._viewer ? drawOf(layerState._viewer) : null;
    if (!draw?.models) {
      // A renderer without models: the dot keeps drawing at every distance.
      failed = true;
      return;
    }
    const loadGeneration = generation;
    set = draw.models({ id: `satellites:iss-model:${++instances}` });
    set.on('ready', () => {
      if (loadGeneration === generation) ready = true;
    });
    set.on('loadFailed', (_id, message) => {
      if (loadGeneration !== generation) return;
      // The dot keeps drawing at every distance; nothing else depends on this.
      console.warn('[Data:Satellites] ISS model failed to load:', message);
      _disposeSet();
      failed = true;
    });
    item = {
      id: 'iss',
      url: resolveAsset(ISS_MODEL_URL),
      pos: { x: 0, y: 0, z: 0 },
      orientation: { heading: 0, pitch: 0, roll: 0 },
      scale: ISS_MODEL_SCALE,
      minPixelSize: ISS_MODEL_MIN_PX,
      displayRange: nearRange,
      nodes: articulation.poses(),
      show: false,
      meta: { noradId: ISS_NORAD },
    };
    shown = false;
    set.upsert([item]);
  }

  function _disposeSet() {
    set?.dispose();
    set = null;
    item = null;
    ready = false;
    shown = false;
  }

  /** Hide the model (sent only when it showed). */
  function _hide() {
    if (!set || !item || !shown) return;
    item.show = false;
    shown = false;
    set.upsert([item]);
  }

  /** An object's inertial position at `date`, km, or null. */
  function _temeKm(satrec, date) {
    if (!satrec) return null;
    try {
      const position = propagate(satrec, date)?.position;
      return position && typeof position !== 'boolean' ? position : null;
    } catch {
      return null;
    }
  }

  /** Leave the near range to the model: the dots draw only beyond it. */
  function _handOverDots() {
    parts.rendering._setPointRange(ISS_NORAD, farRange);
    if (layerState._trackedNorad === ISS_NORAD)
      parts.rendering._setTrackedDotRange(farRange);
  }

  /** Give the ISS's dots back their whole range. */
  function _releaseDots() {
    parts.rendering._setPointRange(ISS_NORAD, undefined);
    parts.rendering._setTrackedDotRange(undefined);
  }

  /**
   * Objects docked to the ISS (Nauka, a Soyuz, a Dragon…) have dots of their
   * own at the station's position. Near the model they are part of it, and
   * their dots, moved only a few times a second, jump across the model at
   * 7.6 km/s. While the model shows, their dots draw only beyond its range
   * too. Rescanned once a second: a vehicle that undocks gets its dot back,
   * and a catalog rebuild's new dots are picked up.
   * @param {number} nowMs
   */
  function _handOverCompanions(nowMs) {
    if (nowMs - lastCompanionScanMs < ISS_COMPANION_SCAN_MS) return;
    lastCompanionScanMs = nowMs;
    const issPosition = layerState._points.get(ISS_NORAD)?.pos;
    // The dots are placed at different moments (far apart with the clock sped
    // up), so their spacing only rules out what is nowhere near. Whether an
    // object is docked is read from both orbits at one instant.
    const date = new Date(layerState.now());
    const issTeme = _temeKm(layerState._catalog.get(ISS_NORAD)?.satrec, date);
    if (!issPosition || !issTeme) return;
    for (const [noradId, point] of layerState._points) {
      if (noradId === ISS_NORAD || !point?.pos) continue;
      const entry = layerState._catalog.get(noradId);
      if (entry?.group === 'dense') continue;
      let docked = false;
      if (distance(point.pos, issPosition) <= ISS_COMPANION_COARSE_M) {
        const teme = _temeKm(entry?.satrec, date);
        docked =
          Boolean(teme) &&
          Math.hypot(
            teme.x - issTeme.x,
            teme.y - issTeme.y,
            teme.z - issTeme.z,
          ) *
            1000 <=
            ISS_COMPANION_RADIUS_M;
      }
      if (docked) {
        parts.rendering._setPointRange(noradId, farRange); // no-op when equal
        handedCompanions.add(noradId);
      } else if (handedCompanions.has(noradId)) {
        parts.rendering._setPointRange(noradId, undefined);
        handedCompanions.delete(noradId);
      }
    }
  }

  /** Give docked objects their dots back at every distance. */
  function _releaseCompanions() {
    for (const noradId of handedCompanions)
      parts.rendering._setPointRange(noradId, undefined);
    handedCompanions.clear();
    lastCompanionScanMs = Number.NEGATIVE_INFINITY;
  }

  /**
   * Up close the orbit ring (polyline chords, turned once a second) runs off
   * the model and jumps across it, so it is hidden there.
   * @param {boolean} near Camera within ISS_ORBIT_HIDE_M of the station.
   */
  function _syncOrbitCloseUp(near) {
    if (near) {
      parts.rendering._setOrbitPathShown(ISS_NORAD, false);
      orbitHidden = true;
    } else if (orbitHidden) {
      orbitHidden = false;
      // Back to the ring's own rules, unless the Cockpit holds it hidden.
      if (layerState._cockpitHiddenPath !== ISS_NORAD)
        parts.controls._syncIssOrbit?.();
    }
  }

  /**
   * Per-frame update from the layer's tick.
   * @returns {void}
   */
  function _updateIssModel() {
    visualValid = false;
    const show = _shouldShow();
    if (!show) {
      _hide();
      if (ready) _releaseDots();
      if (handedCompanions.size) _releaseCompanions();
      _syncOrbitCloseUp(false);
      return;
    }
    const point = layerState._points.get(ISS_NORAD);
    const eye = _eye();
    const cameraDistance =
      point?.pos && eye ? distance(eye, point.pos) : Number.POSITIVE_INFINITY;
    if (!set) {
      // The file is fetched only once the camera nears the model's range, so
      // a globe-wide view of the layer never downloads it.
      if (
        !failed &&
        resolveAsset &&
        cameraDistance <= ISS_MODEL_MAX_DISTANCE_M * 1.5
      )
        _load();
      if (!set) return;
    }
    if (ready) {
      _handOverDots();
      _handOverCompanions(Date.now());
      _syncOrbitCloseUp(cameraDistance < ISS_ORBIT_HIDE_M);
    }
    // Out of range the model would not draw anyway: skip the SGP4 sample.
    if (cameraDistance > ISS_MODEL_MAX_DISTANCE_M * 1.5) {
      _hide();
      return;
    }

    const sat = layerState._catalog.get(ISS_NORAD);
    const trackedSample =
      layerState._trackedNorad === ISS_NORAD &&
      Number.isFinite(layerState._trackedFrameGeo?.atMs)
        ? layerState._trackedFrameGeo
        : null;
    const date = new Date(
      trackedSample ? trackedSample.atMs : layerState.now(),
    );
    let posVel;
    try {
      posVel = propagate(sat.satrec, date);
    } catch {
      posVel = null;
    }
    if (
      !posVel?.position ||
      typeof posVel.position === 'boolean' ||
      !posVel.velocity ||
      typeof posVel.velocity === 'boolean'
    ) {
      _hide();
      return;
    }
    const gmst = gstime(date);
    let position;
    if (trackedSample) {
      // The sample the follow camera and the tracked dot were placed from.
      const c = layerState._trackedFrameCartesian;
      position = { x: c.x, y: c.y, z: c.z };
    } else {
      const geo = eciToGeodetic(posVel.position, gmst);
      position = fromRadians(geo.longitude, geo.latitude, geo.height * 1000);
    }
    const axes = issFlightAxes(position, temeToEcefAxes(posVel.velocity, gmst));
    if (!axes) {
      _hide();
      return;
    }
    articulation.update(date, position, axes);
    item.pos.x = position.x;
    item.pos.y = position.y;
    item.pos.z = position.z;
    item.orientation = issOrientation(
      position,
      ISS_MODEL_LOCAL_AXES.map((key) => axes[key]),
    );
    item.nodes = articulation.poses();
    item.show = true;
    shown = true;
    set.upsert([item]);
    visualPosition.x = position.x;
    visualPosition.y = position.y;
    visualPosition.z = position.z;
    visualValid = ready;
  }

  /**
   * Where the tracked card should anchor: the station centre the model is
   * rendering at this frame, or null while the model is not drawn (the card
   * then keeps the dot's position). Up close the dot's cache can be a frame
   * ahead of the rendered model, ~130 m of orbit, which shook the card.
   * @returns {{x:number,y:number,z:number}|null}
   */
  function _issVisualPosition() {
    if (!visualValid || !shown) return null;
    const eye = _eye();
    if (eye && distance(eye, visualPosition) > ISS_MODEL_MAX_DISTANCE_M)
      return null;
    return visualPosition;
  }

  /**
   * How far the tracked card must stay from its anchor to clear the model, in
   * pixels, or null while the dot shows.
   */
  function _issCardClearPx() {
    const position = _issVisualPosition();
    const pose = findCamera(layerState._viewer)?.pose?.();
    const height = canvasOf(layerState._viewer)?.clientHeight;
    const fovy = pose?.fovy;
    if (!position || !pose?.position || !height || !fovy) return null;
    const range = distance(pose.position, position);
    if (!(range > 0)) return null;
    const pixelsPerMeter = height / (2 * Math.tan(fovy / 2)) / range;
    return Math.min(
      height * 0.45,
      Math.max(ISS_MODEL_MIN_PX * 0.35, ISS_CARD_CLEAR_M * pixelsPerMeter),
    );
  }

  function _destroyIssModel() {
    generation += 1;
    failed = false;
    visualValid = false;
    articulation.reset();
    if (ready) _releaseDots();
    _releaseCompanions();
    _syncOrbitCloseUp(false);
    _disposeSet();
  }

  /** Whether the model is standing in for this docked object's dot. */
  function _issStandsInFor(noradId) {
    return handedCompanions.has(noradId) && _issVisualPosition() !== null;
  }

  /** Whether a click's draw hit is on the model. */
  function _hitIsIss(hit) {
    return Boolean(set) && hit?.set === set.id;
  }

  /** Ask for a frame: the command panel's changes between ticks. */
  function _requestRender() {
    if (set && item) set.upsert([item]);
  }

  return {
    _updateIssModel,
    _destroyIssModel,
    _issVisualPosition,
    _issCardClearPx,
    _issStandsInFor,
    _hitIsIss,
    _requestRender,
    /** The joint driver, for the command panel. */
    _issArticulation: articulation,
  };
}
