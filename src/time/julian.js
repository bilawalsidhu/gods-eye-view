import { julianDate } from '../geo/index.js';

const scratch = new Date();

/**
 * Epoch ms as a Julian date, like `JulianDate.now(result)` for any time.
 * @param {number} ms
 * @param {{dayNumber: number, secondsOfDay: number}} [result]
 */
export function julianAt(ms, result) {
  scratch.setTime(ms);
  return julianDate.fromDate(scratch, result);
}
