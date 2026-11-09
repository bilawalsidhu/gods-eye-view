import * as Cesium from 'cesium';

const scratch = new Date();

/**
 * Epoch ms as a Cesium JulianDate, like `JulianDate.now(result)` for any time.
 * @param {number} ms
 * @param {Cesium.JulianDate} [result]
 */
export function julianAt(ms, result) {
  scratch.setTime(ms);
  return Cesium.JulianDate.fromDate(scratch, result);
}
