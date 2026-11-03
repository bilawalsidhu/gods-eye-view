import * as Cesium from 'cesium';
export function worldToWindowCoordinates(scene, position, result) {
  return Cesium.SceneTransforms.worldToWindowCoordinates(
    scene,
    position,
    result,
  );
}
let occluder;
export function horizonOccluder(camera) {
  occluder ??= new Cesium.EllipsoidalOccluder(
    Cesium.Ellipsoid.WGS84,
    new Cesium.Cartesian3(),
  );
  occluder.cameraPosition = camera.positionWC;
  return occluder;
}
