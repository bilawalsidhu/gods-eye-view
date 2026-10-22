// Exact legacy planetary model and bare-viewer fallback for CelestialRing.
import * as Cesium from 'cesium';
export function createCelestialEphemeris() {
  const sunInertial = new Cesium.Cartesian3();
  const moonInertial = new Cesium.Cartesian3();
  const fixedMatrix = new Cesium.Matrix3();
  return (epochMs, sunFixed, moonFixed) => {
    const time = Cesium.JulianDate.fromDate(new Date(epochMs));
    Cesium.Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(
      time,
      sunInertial,
    );
    Cesium.Simon1994PlanetaryPositions.computeMoonPositionInEarthInertialFrame(
      time,
      moonInertial,
    );
    const matrix =
      Cesium.Transforms.computeIcrfToFixedMatrix(time, fixedMatrix) ||
      Cesium.Transforms.computeTemeToPseudoFixedMatrix(time, fixedMatrix);
    if (!matrix) return false;
    Cesium.Matrix3.multiplyByVector(matrix, sunInertial, sunFixed);
    Cesium.Matrix3.multiplyByVector(matrix, moonInertial, moonFixed);
    Cesium.Cartesian3.normalize(sunFixed, sunFixed);
    Cesium.Cartesian3.normalize(moonFixed, moonFixed);
    return true;
  };
}
export const projectCelestialPoint = (scene, position, result) =>
  Cesium.SceneTransforms.worldToWindowCoordinates(scene, position, result);
export const flyCelestialViewer = (viewer, options) =>
  viewer.camera.flyTo({
    ...options,
    easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
  });
