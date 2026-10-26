import * as Cesium from 'cesium';
export function worldToWindowCoordinates(scene, position, result) {
  return Cesium.SceneTransforms.worldToWindowCoordinates(
    scene,
    position,
    result,
  );
}
const occluder = new Cesium.EllipsoidalOccluder(
  Cesium.Ellipsoid.WGS84,
  new Cesium.Cartesian3(),
);
export function horizonOccluder(camera) {
  occluder.cameraPosition = camera.positionWC;
  return occluder;
}
