import * as Cesium from 'cesium';
export function worldToWindowCoordinates(scene, position, result) {
  return Cesium.SceneTransforms.worldToWindowCoordinates(
    scene,
    position,
    result,
  );
}
