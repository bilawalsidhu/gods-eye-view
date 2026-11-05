/**
 * @module render/stub/orbits
 * @description Where an orbit item is at a time: its two-line elements
 * propagated with SGP4 and turned into Earth-fixed metres.
 */
import { eciToEcf, gstime, propagate, twoline2satrec } from 'satellite.js';

/**
 * @param {Map<string, object>} satrecs Parsed elements by line pair, the caller's cache.
 * @param {[string, string]} tle
 * @param {number} t Epoch ms.
 * @returns {{x: number, y: number, z: number}|null} ECEF metres, or null when the elements cannot be propagated to `t`.
 */
export function orbitPosition(satrecs, tle, t) {
  const key = `${tle[0]}\n${tle[1]}`;
  let satrec = satrecs.get(key);
  if (!satrec) {
    satrec = twoline2satrec(tle[0], tle[1]);
    satrecs.set(key, satrec);
  }
  const date = new Date(t);
  const state = propagate(satrec, date);
  const eci = state?.position;
  if (!eci || typeof eci !== 'object') return null;
  const ecf = eciToEcf(eci, gstime(date));
  return { x: ecf.x * 1000, y: ecf.y * 1000, z: ecf.z * 1000 };
}
