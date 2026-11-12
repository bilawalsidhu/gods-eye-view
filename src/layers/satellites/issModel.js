import * as Cesium from 'cesium';
import { eciToGeodetic, gstime, propagate } from 'satellite.js';
import {
  ISS_MODEL_MAX_DISTANCE_M,
  ISS_MODEL_MIN_PX,
  ISS_MODEL_NATIVE_SPAN,
  ISS_MODEL_URL,
  ISS_NORAD,
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
  const nearCondition = new Cesium.DistanceDisplayCondition(
    0,
    ISS_MODEL_MAX_DISTANCE_M,
  );
  const farCondition = new Cesium.DistanceDisplayCondition(
    ISS_MODEL_MAX_DISTANCE_M,
    Number.MAX_VALUE,
  );
  const scratchPosition = new Cesium.Cartesian3();
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
   * Per-frame update from the layer's preRender tick.
   * @returns {void}
   */
  function _updateIssModel() {
    const show = _shouldShow();
    if (!show) {
      if (model) model.show = false;
      return;
    }
    if (!model) {
      if (!loading && !failed && resolveAsset) _load();
      return;
    }
    _handOverDots();

    const point = layerState._points.get(ISS_NORAD);
    const camera = layerState._viewer?.camera;
    // Out of range the model would not draw anyway: skip the SGP4 sample.
    if (
      point?.position &&
      camera &&
      Cesium.Cartesian3.distance(camera.positionWC, point.position) >
        ISS_MODEL_MAX_DISTANCE_M * 1.5
    ) {
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
    const axes = issFlightAxes(
      scratchPosition,
      temeToEcefAxes(posVel.velocity, gmst),
    );
    if (!axes) {
      model.show = false;
      return;
    }
    ['x', 'y', 'z'].forEach((key, column) => {
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
    model.show = true;
  }

  /** Drop the model (destroy or a fresh init); the next need reloads it. */
  function _destroyIssModel() {
    generation += 1;
    loading = false;
    failed = false;
    if (model) {
      const scene = layerState._viewer?.scene;
      if (scene && scene.primitives.contains(model))
        scene.primitives.remove(model); // remove() destroys
      else if (!model.isDestroyed()) model.destroy();
      model = null;
    }
  }

  return { _updateIssModel, _destroyIssModel };
}
