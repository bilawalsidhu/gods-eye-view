// src/data/satellitePass.js
/**
 * Satellite pass prediction.
 * Look angles come from SGP4; rise/set are bisected to sub-second precision
 * and the peak is refined with a parabola. Scan pattern from skylight (MIT)
 * shared/src/celestial.ts nextISSPass.
 */
import { propagate, gstime, eciToEcf, ecfToLookAngles } from 'satellite.js';

const R2D = 180 / Math.PI;
const D2R = Math.PI / 180;

/**
 * Observer look angles at an instant, or null when propagation fails.
 * @param {Object} satrec SGP4 satellite record
 * @param {number} dateMs UTC epoch timestamp in milliseconds
 * @param {number} latDeg Observer latitude in degrees [-90, 90]
 * @param {number} lonDeg Observer longitude in degrees [-180, 180]
 * @returns {{ elevDeg: number, azDeg: number } | null}
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
 * Bisect the elevation threshold boundary f(t) = elev(t) - minElevDeg = 0.
 * Assumes one threshold crossing inside the bracket. 7 iterations resolve 20s to ~0.16s.
 * @private
 */
function _bisectBoundary(
  satrec,
  latDeg,
  lonDeg,
  tLow,
  tHigh,
  minElevDeg,
  isRising,
  steps = 7,
) {
  let low = tLow;
  let high = tHigh;
  for (let i = 0; i < steps; i++) {
    const mid = (low + high) / 2;
    const look = lookAnglesAt(satrec, mid, latDeg, lonDeg);
    const elev = look ? look.elevDeg : -90;
    if (isRising) {
      if (elev >= minElevDeg) {
        high = mid;
      } else {
        low = mid;
      }
    } else {
      if (elev >= minElevDeg) {
        low = mid;
      } else {
        high = mid;
      }
    }
  }
  return Math.round(isRising ? high : low);
}

/**
 * Find the next pass of a satellite over an observer location.
 * Uses 20s coarse scanning, bisection for sub-second rise/set times,
 * and parabolic interpolation for the peak.
 *
 * @param {Object} options
 * @param {Object} options.satrec SGP4 satellite record
 * @param {number} options.latDeg Observer latitude [-90, 90]
 * @param {number} options.lonDeg Observer longitude [-180, 180]
 * @param {number} options.fromMs UTC start time in milliseconds
 * @param {number} [options.minElevDeg=10] Elevation that defines rise and set (default 10°)
 * @param {number} [options.horizonHours=24] Maximum search horizon in hours (default 24h)
 * @param {number} [options.coarseStepSec=20] Coarse scan step in seconds (default 20s)
 * @param {number} [options.fineStepSec=5] Fine transit step in seconds (default 5s)
 * @returns {{
 *   riseMs: number,
 *   setMs: number,
 *   maxElevDeg: number,
 *   maxElevMs: number,
 *   riseAzDeg: number
 * } | null}
 */
export function findNextSatellitePass({
  satrec,
  latDeg,
  lonDeg,
  fromMs,
  minElevDeg = 10,
  horizonHours = 24,
  coarseStepSec = 20,
  fineStepSec = 5,
}) {
  const horizonMs = fromMs + horizonHours * 3600_000;
  const coarseMs = coarseStepSec * 1000;
  const fineMs = Math.max(1000, (fineStepSec || 5) * 1000);

  let searchCursor = fromMs;

  while (searchCursor <= horizonMs) {
    let tPrev = searchCursor;
    let tHit = null;
    let elevPrev = lookAnglesAt(satrec, tPrev, latDeg, lonDeg)?.elevDeg ?? -90;

    // Check if we start already inside a pass
    if (elevPrev >= minElevDeg) {
      tHit = searchCursor;
    } else {
      // Coarse forward scan
      for (let t = searchCursor + coarseMs; t <= horizonMs; t += coarseMs) {
        const look = lookAnglesAt(satrec, t, latDeg, lonDeg);
        const elev = look ? look.elevDeg : -90;
        if (elev >= minElevDeg) {
          tHit = t;
          break;
        }
        tPrev = t;
        elevPrev = elev;
      }
    }

    if (tHit == null) return null; // No pass found in remaining horizon

    // Resolve rise
    let riseMs;
    if (tHit === searchCursor && elevPrev >= minElevDeg) {
      riseMs = searchCursor;
    } else {
      riseMs = _bisectBoundary(
        satrec,
        latDeg,
        lonDeg,
        tPrev,
        tHit,
        minElevDeg,
        true,
      );
    }

    // Transit the pass to track peak and bracket set between tStepPrev and tCurr
    let tCurr = riseMs;
    let maxElevDeg = -90;
    let maxElevMs = riseMs;
    let tStepPrev = riseMs;
    let setMs = null;
    let elevPrevSample = null;
    let peakLeftElev = null;
    let peakRightElev = null;
    let peakStepMs = fineMs;

    // Transit forward in fine steps
    while (tCurr <= horizonMs) {
      const look = lookAnglesAt(satrec, tCurr, latDeg, lonDeg);
      const elev = look ? look.elevDeg : -90;

      if (elev < minElevDeg && tCurr > riseMs) {
        if (peakRightElev == null && tCurr > maxElevMs) {
          peakRightElev = elev;
          peakStepMs = tCurr - maxElevMs;
        }
        // Below threshold: bisect set between tStepPrev and tCurr
        setMs = _bisectBoundary(
          satrec,
          latDeg,
          lonDeg,
          tStepPrev,
          tCurr,
          minElevDeg,
          false,
        );
        break;
      }

      if (elev > maxElevDeg) {
        maxElevDeg = elev;
        maxElevMs = tCurr;
        peakLeftElev = elevPrevSample;
        peakRightElev = null;
      } else if (peakRightElev == null && tCurr > maxElevMs) {
        peakRightElev = elev;
        peakStepMs = tCurr - maxElevMs;
      }

      elevPrevSample = elev;
      tStepPrev = tCurr;
      tCurr += fineMs;
    }

    if (setMs == null) {
      setMs = Math.min(horizonMs, tCurr);
    }

    // Refine peak culmination via 3-point parabolic interpolation around maxElevMs
    // using adjacent transit samples (zero additional SGP4 calls)
    let refinedPeakMs = maxElevMs;
    let refinedPeakElevDeg = maxElevDeg;
    if (
      Number.isFinite(peakLeftElev) &&
      Number.isFinite(peakRightElev) &&
      peakLeftElev - 2 * maxElevDeg + peakRightElev < 0 // concave down
    ) {
      const denom = 2 * (peakLeftElev - 2 * maxElevDeg + peakRightElev);
      const shift = ((peakLeftElev - peakRightElev) / denom) * peakStepMs;
      if (Math.abs(shift) < peakStepMs) {
        refinedPeakMs = Math.round(maxElevMs + shift);
        refinedPeakElevDeg =
          maxElevDeg -
          Math.pow(peakLeftElev - peakRightElev, 2) /
            (8 * (peakLeftElev - 2 * maxElevDeg + peakRightElev));
      }
    }

    const riseLook = lookAnglesAt(satrec, riseMs, latDeg, lonDeg);
    return {
      riseMs,
      setMs,
      maxElevDeg: refinedPeakElevDeg,
      maxElevMs: refinedPeakMs,
      riseAzDeg: riseLook ? riseLook.azDeg : 0,
    };
  }

  return null;
}
