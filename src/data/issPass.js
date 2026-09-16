// src/data/issPass.js
/**
 * Next-ISS-pass prediction from a satrec: coarse 30 s scan to find a window
 * where elevation ≥ minElevDeg, refined to ~5 s at the edges, tracking peak
 * elevation. ~2880 SGP4 propagations for a 24 h horizon — tens of ms, fine for
 * an on-demand voice call. Pattern from skylight (MIT) shared/src/celestial.ts
 * nextISSPass, extended with set-time + peak tracking.
 */
import { propagate, gstime, eciToEcf, ecfToLookAngles } from 'satellite.js';

const R2D = 180 / Math.PI;
const D2R = Math.PI / 180;

/**
 * Observer look angles at an instant, or null when propagation fails.
 * @param {object} satrec Initialized satellite.js SATREC for the target.
 * @param {number} dateMs Instant to propagate to, epoch milliseconds.
 * @param {number} latDeg Observer latitude, degrees north.
 * @param {number} lonDeg Observer longitude, degrees east.
 * @returns {{elevDeg: number, azDeg: number}|null} Elevation in [-90, 90] and
 *   azimuth normalized to [0, 360), both degrees, or null when SGP4 fails.
 */
export function lookAnglesAt(satrec, dateMs, latDeg, lonDeg) {
  const date = new Date(dateMs);
  const pv = propagate(satrec, date);
  const pos = pv && pv.position;
  if (!pos || typeof pos === 'boolean') return null;
  const ecf = eciToEcf(pos, gstime(date));
  const look = ecfToLookAngles(
    { latitude: latDeg * D2R, longitude: lonDeg * D2R, height: 0 },
    ecf,
  );
  return {
    elevDeg: look.elevation * R2D,
    azDeg: (((look.azimuth * R2D) % 360) + 360) % 360,
  };
}

/**
 * Find the next visible pass of a satellite over an observer.
 *
 * Coarse-to-fine: a coarse scan locates the first sample above the threshold
 * (starting mid-pass counts — the answer a voice caller wants), the rise is
 * walked back at fine resolution, then the pass is tracked to its set while
 * recording peak elevation.
 *
 * @param {object} inputs Pass query.
 * @param {object} inputs.satrec Initialized satellite.js SATREC.
 * @param {number} inputs.latDeg Observer latitude, degrees north.
 * @param {number} inputs.lonDeg Observer longitude, degrees east.
 * @param {number} inputs.fromMs Search start, epoch milliseconds.
 * @param {number} [inputs.minElevDeg=10] Threshold elevation, degrees.
 * @param {number} [inputs.horizonHours=24] How far ahead to search, hours.
 * @param {number} [inputs.coarseStepSec=30] Coarse scan step, seconds.
 * @param {number} [inputs.fineStepSec=5] Refinement step, seconds.
 * @returns {{riseMs: number, setMs: number, maxElevDeg: number,
 *   maxElevMs: number, riseAzDeg: number}|null} Pass window in epoch ms, peak
 *   elevation in degrees with its instant, and rise azimuth in degrees — or
 *   null when no pass clears the threshold within the horizon.
 */
export function findNextIssPass({
  satrec, latDeg, lonDeg, fromMs,
  minElevDeg = 10, horizonHours = 24, coarseStepSec = 30, fineStepSec = 5,
}) {
  const elev = (t) => lookAnglesAt(satrec, t, latDeg, lonDeg)?.elevDeg ?? -90;
  const horizonMs = fromMs + horizonHours * 3600_000;
  const coarse = coarseStepSec * 1000;
  const fine = fineStepSec * 1000;

  // Coarse scan for the first sample above threshold. If we START inside a
  // pass, that's still "the next pass" for a voice answer — accept it.
  let hit = null;
  for (let t = fromMs; t <= horizonMs; t += coarse) {
    if (elev(t) >= minElevDeg) { hit = t; break; }
  }
  if (hit == null) return null;

  // Refine rise: walk back in fine steps to the first sample ≥ threshold.
  let riseMs = hit;
  while (riseMs - fine > fromMs && elev(riseMs - fine) >= minElevDeg) riseMs -= fine;

  // Walk forward through the pass tracking the peak until we drop below.
  let maxElevDeg = -90;
  let maxElevMs = riseMs;
  let t = riseMs;
  while (t <= horizonMs) {
    const e = elev(t);
    if (e < minElevDeg && t > riseMs) break;
    if (e > maxElevDeg) { maxElevDeg = e; maxElevMs = t; }
    t += fine;
  }
  const setMs = t;

  const rise = lookAnglesAt(satrec, riseMs, latDeg, lonDeg);
  return { riseMs, setMs, maxElevDeg, maxElevMs, riseAzDeg: rise ? rise.azDeg : 0 };
}
