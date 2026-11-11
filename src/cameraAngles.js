// Camera heading and roll as Cesium's camera reports them, from an engine pose.
//
// The globe contract keeps pose angles in [0, 2π) (src/globe/contract.js).
// Cesium's own Camera.heading and .roll lie in (0, 2π]: a view facing exactly
// north reports heading 2π, a level view reports roll 2π, and roll is exactly
// 0 only in Cesium's vertical branch (looking within 1e-3 of straight up or
// down). Share links and captured scene shots have always carried Cesium's
// numbers (`heading=360`, `roll=360`), so they are written from these, and a
// link or shot made on any engine reads as one made on Cesium. The contract
// folds Cesium's values within 1e-12 of 0 and 2π onto 0; a reading that was a
// hair above 0 therefore comes back as 2π here, the only case that differs.

import * as geo from './geo/index.js';

const { TWO_PI } = geo.math;

/** Whether a pose looks (nearly, within 1e-3) straight up or down, as Cesium tests it. */
export function poseIsVertical({ position, direction }) {
  const up = geo.ellipsoid.WGS84.geodeticSurfaceNormal(
    position,
    geo.cartesian3.create(),
  );
  return Math.abs(1 - Math.abs(geo.cartesian3.dot(direction, up))) <= 1e-3;
}

/** The pose heading as Cesium reports it, in (0, 2π]. */
export const cesiumHeading = (pose) =>
  pose.heading === 0 ? TWO_PI : pose.heading;

/** The pose roll as Cesium reports it: (0, 2π], or exactly 0 for a vertical view. */
export const cesiumRoll = (pose) =>
  pose.roll === 0 && !poseIsVertical(pose) ? TWO_PI : pose.roll;
