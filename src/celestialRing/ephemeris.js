import * as geo from '../geo/index.js';

/**
 * Earth-fixed unit directions to the Sun and the Moon at an epoch: Cesium's
 * planetary model (geo's bit-identical port), rotated to the Earth with
 * `icrfToFixed(epochMs, result)` where it answers (a Cesium globe once its
 * ICRF data has loaded) and with the TEME rotation otherwise, as Cesium's
 * own fallback does. Needs no Cesium SDK, so it runs on a Navara page.
 */
export function createCelestialEphemeris({ icrfToFixed = null } = {}) {
  const sunInertial = geo.cartesian3.create();
  const moonInertial = geo.cartesian3.create();
  const fixedMatrix = geo.matrix3.create();
  return (epochMs, sunFixed, moonFixed) => {
    const time = geo.julianDate.fromDate(new Date(epochMs));
    geo.simon1994.computeSunPositionInEarthInertialFrame(time, sunInertial);
    geo.simon1994.computeMoonPositionInEarthInertialFrame(time, moonInertial);
    const matrix =
      icrfToFixed?.(epochMs, fixedMatrix) ||
      geo.transforms.computeTemeToPseudoFixedMatrix(time, fixedMatrix);
    if (!matrix) return false;
    geo.matrix3.multiplyByVector(matrix, sunInertial, sunFixed);
    geo.matrix3.multiplyByVector(matrix, moonInertial, moonFixed);
    geo.cartesian3.normalize(sunFixed, sunFixed);
    geo.cartesian3.normalize(moonFixed, moonFixed);
    return true;
  };
}
