// src/data/issPass.js
/**
 * Next-ISS-pass prediction. Kept as a thin wrapper over satellitePass.js so the
 * original findNextIssPass signature and defaults still work.
 */
import { findNextSatellitePass, lookAnglesAt } from './satellitePass.js';

export { lookAnglesAt };

/**
 * Predict the next ISS pass over an observer location.
 * @param {Object} options
 * @param {Object} options.satrec SGP4 satellite record
 * @param {number} options.latDeg Observer latitude in degrees [-90, 90]
 * @param {number} options.lonDeg Observer longitude in degrees [-180, 180]
 * @param {number} options.fromMs UTC start time in milliseconds
 * @param {number} [options.minElevDeg=10] Elevation that defines rise and set, in degrees
 * @param {number} [options.horizonHours=24] Maximum search window in hours
 * @param {number} [options.coarseStepSec=30] Coarse search step in seconds
 * @param {number} [options.fineStepSec=5] Fine transit step in seconds for peak tracking
 * @returns {{ riseMs: number, setMs: number, maxElevDeg: number, maxElevMs: number, riseAzDeg: number } | null}
 */
export function findNextIssPass({
  satrec,
  latDeg,
  lonDeg,
  fromMs,
  minElevDeg = 10,
  horizonHours = 24,
  coarseStepSec = 30,
  fineStepSec = 5,
}) {
  return findNextSatellitePass({
    satrec,
    latDeg,
    lonDeg,
    fromMs,
    minElevDeg,
    horizonHours,
    coarseStepSec,
    fineStepSec,
  });
}
