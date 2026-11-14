import * as Cesium from 'cesium';
import { eciToGeodetic, gstime, propagate } from 'satellite.js';
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
 * The ISS as a 3D model when the camera is close. Far out the dot stays: the
 * model and the dot (ambient and tracked) split the distance range, so exactly
 * one of them draws. The model loads on first need and only if the ISS is
 * shown, and positions itself every frame from its own SGP4 sample (the dot
 * moves once a second, which at model range would show as a jump).
 */
export function createIssModel({ state: layerState, parts, resolveAsset }) {
  let model = null;
  let loading = false;
  let failed = false;
  let generation = 0;
  /** Turns the solar arrays and radiators by where the Sun is. */
  const articulation = createIssArticulation();
  const nearCondition = new Cesium.DistanceDisplayCondition(
    0,
    ISS_MODEL_MAX_DISTANCE_M,
  );
  const farCondition = new Cesium.DistanceDisplayCondition(
    ISS_MODEL_MAX_DISTANCE_M,
    Number.MAX_VALUE,
  );
  /** @type {Set<number>} Docked objects whose dots the model stands in for. */
  const handedCompanions = new Set();
  let lastCompanionScanMs = Number.NEGATIVE_INFINITY;
  /** Whether the ISS's orbit ring is hidden for the close-up. */
  let orbitHidden = false;
  const scratchPosition = new Cesium.Cartesian3();
  /** The station centre the model last rendered at (for the tracked card). */
  const visualPosition = new Cesium.Cartesian3();
  let visualValid = false;
  const scratchRotation = new Cesium.Matrix3();
  const scratchColumn = new Cesium.Cartesian3();

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

  async function _load() {
    loading = true;
    const loadGeneration = generation;
    try {
      const loaded = await Cesium.Model.fromGltfAsync({
        url: resolveAsset(ISS_MODEL_URL),
        scale: ISS_MODEL_SCALE,
        minimumPixelSize: ISS_MODEL_MIN_PX,
        distanceDisplayCondition: nearCondition,
        // So a click on the model tracks the ISS, as a click on its dot does.
        id: ISS_NORAD,
        show: false,
      });
      const viewer = layerState._viewer;
      if (loadGeneration !== generation || !viewer) {
        loaded.destroy();
        return;
      }
      viewer.scene.primitives.add(loaded);
      model = loaded;
    } catch (error) {
      // The dot keeps drawing at every distance; nothing else depends on this.
      failed = true;
      console.warn('[Data:Satellites] ISS model failed to load:', error);
    } finally {
      if (loadGeneration === generation) loading = false;
    }
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
    const point = layerState._points.get(ISS_NORAD);
    if (point && point.distanceDisplayCondition !== farCondition)
      point.distanceDisplayCondition = farCondition;
    const dot =
      layerState._trackedNorad === ISS_NORAD
        ? layerState._trackedEntity?.point
        : null;
    if (dot && !dot.distanceDisplayCondition)
      dot.distanceDisplayCondition = farCondition;
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
    const issPosition = layerState._points.get(ISS_NORAD)?.position;
    // The dots are placed at different moments (far apart with the clock sped
    // up), so their spacing only rules out what is nowhere near. Whether an
    // object is docked is read from both orbits at one instant.
    const date = new Date(layerState.now());
    const issTeme = _temeKm(layerState._catalog.get(ISS_NORAD)?.satrec, date);
    if (!issPosition || !issTeme) return;
    for (const [noradId, point] of layerState._points) {
      if (noradId === ISS_NORAD || !point?.position) continue;
      const entry = layerState._catalog.get(noradId);
      if (entry?.group === 'dense') continue;
      let docked = false;
      if (
        Cesium.Cartesian3.distance(point.position, issPosition) <=
        ISS_COMPANION_COARSE_M
      ) {
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
        point.distanceDisplayCondition = farCondition; // no-op when equal
        handedCompanions.add(noradId);
      } else if (handedCompanions.has(noradId)) {
        point.distanceDisplayCondition = undefined;
        handedCompanions.delete(noradId);
      }
    }
  }

  /** Give docked objects their dots back at every distance. */
  function _releaseCompanions() {
    for (const noradId of handedCompanions) {
      const point = layerState._points.get(noradId);
      if (point) point.distanceDisplayCondition = undefined;
    }
    handedCompanions.clear();
    lastCompanionScanMs = Number.NEGATIVE_INFINITY;
  }

  /**
   * Up close the orbit ring (polyline chords, turned once a second) runs off
   * the model and jumps across it, so it is hidden there.
   * @param {boolean} near Camera within ISS_ORBIT_HIDE_M of the station.
   */
  function _syncOrbitCloseUp(near) {
    const path = layerState._orbitPaths.get(ISS_NORAD);
    if (near) {
      if (path) path.primitive.show = false;
      orbitHidden = true;
    } else if (orbitHidden) {
      orbitHidden = false;
      // Back to the ring's own rules, unless the Cockpit holds it hidden.
      if (layerState._cockpitHiddenPath !== ISS_NORAD)
        parts.controls._syncIssOrbit?.();
    }
  }

  /**
   * Per-frame update from the layer's preRender tick.
   * @returns {void}
   */
  function _updateIssModel() {
    visualValid = false;
    const show = _shouldShow();
    if (!show) {
      if (model) model.show = false;
      if (handedCompanions.size) _releaseCompanions();
      _syncOrbitCloseUp(false);
      return;
    }
    const point = layerState._points.get(ISS_NORAD);
    const camera = layerState._viewer?.camera;
    const cameraDistance =
      point?.position && camera
        ? Cesium.Cartesian3.distance(camera.positionWC, point.position)
        : Number.POSITIVE_INFINITY;
    if (!model) {
      // The file is fetched only once the camera nears the model's range, so
      // a globe-wide view of the layer never downloads it.
      if (
        !loading &&
        !failed &&
        resolveAsset &&
        cameraDistance <= ISS_MODEL_MAX_DISTANCE_M * 1.5
      )
        _load();
      return;
    }
    _handOverDots();
    _handOverCompanions(Date.now());
    _syncOrbitCloseUp(cameraDistance < ISS_ORBIT_HIDE_M);
    // Out of range the model would not draw anyway: skip the SGP4 sample.
    if (cameraDistance > ISS_MODEL_MAX_DISTANCE_M * 1.5) {
      model.show = false;
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
      model.show = false;
      return;
    }
    const gmst = gstime(date);
    if (trackedSample) {
      // The sample the follow camera and the tracked dot were placed from.
      Cesium.Cartesian3.clone(
        layerState._trackedFrameCartesian,
        scratchPosition,
      );
    } else {
      const geo = eciToGeodetic(posVel.position, gmst);
      Cesium.Cartesian3.fromRadians(
        geo.longitude,
        geo.latitude,
        geo.height * 1000,
        undefined,
        scratchPosition,
      );
    }
    Cesium.Cartesian3.clone(scratchPosition, visualPosition);
    const axes = issFlightAxes(
      scratchPosition,
      temeToEcefAxes(posVel.velocity, gmst),
    );
    if (!axes) {
      model.show = false;
      return;
    }
    ISS_MODEL_LOCAL_AXES.forEach((key, column) => {
      scratchColumn.x = axes[key][0];
      scratchColumn.y = axes[key][1];
      scratchColumn.z = axes[key][2];
      Cesium.Matrix3.setColumn(
        scratchRotation,
        column,
        scratchColumn,
        scratchRotation,
      );
    });
    Cesium.Matrix4.fromRotationTranslation(
      scratchRotation,
      scratchPosition,
      model.modelMatrix,
    );
    articulation.update(model, date, scratchPosition, axes);
    model.show = true;
    visualValid = true;
  }

  /**
   * Where the tracked card should anchor: the station centre the model is
   * rendering at this frame, or null while the model is not drawn (the card
   * then keeps the dot's position). Up close the dot's cache can be a frame
   * ahead of the rendered model, ~130 m of orbit, which shook the card.
   * @returns {Cesium.Cartesian3|null}
   */
  function _issVisualPosition() {
    if (!visualValid || !model?.show) return null;
    const camera = layerState._viewer?.camera;
    if (
      camera &&
      Cesium.Cartesian3.distance(camera.positionWC, visualPosition) >
        ISS_MODEL_MAX_DISTANCE_M
    )
      return null;
    return visualPosition;
  }

  /**
   * How far the tracked card must stay from its anchor to clear the model, in
   * pixels, or null while the dot shows.
   */
  function _issCardClearPx() {
    const position = _issVisualPosition();
    const viewer = layerState._viewer;
    const camera = viewer?.camera;
    const height = viewer?.scene?.canvas?.clientHeight;
    const fovy = camera?.frustum?.fovy;
    if (!position || !height || !fovy) return null;
    const distance = Cesium.Cartesian3.distance(camera.positionWC, position);
    if (!(distance > 0)) return null;
    const pixelsPerMeter = height / (2 * Math.tan(fovy / 2)) / distance;
    return Math.min(
      height * 0.45,
      Math.max(ISS_MODEL_MIN_PX * 0.35, ISS_CARD_CLEAR_M * pixelsPerMeter),
    );
  }

  function _destroyIssModel() {
    generation += 1;
    loading = false;
    failed = false;
    visualValid = false;
    articulation.reset();
    _releaseCompanions();
    _syncOrbitCloseUp(false);
    if (model) {
      const scene = layerState._viewer?.scene;
      if (scene && scene.primitives.contains(model))
        scene.primitives.remove(model); // remove() destroys
      else if (!model.isDestroyed()) model.destroy();
      model = null;
    }
  }

  /** Whether the model is standing in for this docked object's dot. */
  function _issStandsInFor(noradId) {
    return handedCompanions.has(noradId) && _issVisualPosition() !== null;
  }

  return {
    _updateIssModel,
    _destroyIssModel,
    _issVisualPosition,
    _issCardClearPx,
    _issStandsInFor,
    /** The joint driver, for the command panel. */
    _issArticulation: articulation,
  };
}
