// Cesium's ICRF rotation and the bare-viewer fallback for CelestialRing.
import * as Cesium from 'cesium';
/** Cesium's ICRF-to-fixed rotation, once its data has loaded; else undefined. */
export const cesiumIcrfToFixed = (epochMs, result) =>
  Cesium.Transforms.computeIcrfToFixedMatrix(
    Cesium.JulianDate.fromDate(new Date(epochMs)),
    result,
  );
export const projectCelestialPoint = (scene, position, result) =>
  Cesium.SceneTransforms.worldToWindowCoordinates(scene, position, result);
export const flyCelestialViewer = (viewer, options) =>
  viewer.camera.flyTo({
    ...options,
    easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
  });
