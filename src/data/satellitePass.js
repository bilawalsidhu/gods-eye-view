// src/data/satellitePass.js
/**
 * Satellite pass prediction with naked-eye visibility.
 * Look angles come from SGP4; rise/set are bisected to sub-second precision,
 * the peak is refined with a parabola, and visibility uses the USNO
 * low-precision Sun position with a cylindrical Earth shadow. Scan pattern from
 * skylight (MIT) shared/src/celestial.ts nextISSPass.
 */
import { propagate, gstime, eciToEcf, ecfToLookAngles } from 'satellite.js';

const R2D = 180 / Math.PI;
const D2R = Math.PI / 180;
const EARTH_RADIUS_KM = 6371.0;
const AU_KM = 149597870.7;

/**
 * Observer look angles at an instant, or null when propagation fails.
 * @param {Object} satrec SGP4 satellite record
 * @param {number} dateMs UTC epoch timestamp in milliseconds
 * @param {number} latDeg Observer latitude in degrees [-90, 90]
 * @param {number} lonDeg Observer longitude in degrees [-180, 180]
 * @returns {{ elevDeg: number, azDeg: number, satECI: {x:number, y:number, z:number} } | null}
 */
export function lookAnglesAt(satrec, dateMs, latDeg, lonDeg) {
  const date = new Date(dateMs);
  let pv;
  try {
    pv = propagate(satrec, date);
  } catch {
    return null;
  }
  const pos = pv && pv.position;
  if (
    !pos ||
    typeof pos === 'boolean' ||
    ![pos.x, pos.y, pos.z].every(Number.isFinite)
  )
    return null;
  const ecf = eciToEcf(pos, gstime(date));
  const look = ecfToLookAngles(
    { latitude: latDeg * D2R, longitude: lonDeg * D2R, height: 0 },
    ecf,
  );
  return {
    elevDeg: look.elevation * R2D,
    azDeg: (((look.azimuth * R2D) % 360) + 360) % 360,
    satECI: pos,
  };
}

/**
 * Compute Sun position in geocentric ECI coordinates using USNO low-precision solar coordinates.
 * Accurate to within ~1 arcminute (~0.017°) within centuries of J2000.0.
 * @param {number} dateMs UTC epoch timestamp in milliseconds
 * @returns {{ x: number, y: number, z: number, raDeg: number, decDeg: number }}
 */
export function solarPositionECI(dateMs) {
  const JD = dateMs / 86400000 + 2440587.5;
  const D = JD - 2451545.0; // days since J2000.0
  const g = ((((357.529 + 0.98560028 * D) % 360) + 360) % 360) * D2R;
  const q = (((280.459 + 0.98564736 * D) % 360) + 360) % 360;
  const L =
    ((((q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) % 360) + 360) % 360) *
    D2R;
  const e = (23.439 - 0.00000036 * D) * D2R;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  return {
    x: AU_KM * Math.cos(dec) * Math.cos(ra),
    y: AU_KM * Math.cos(dec) * Math.sin(ra),
    z: AU_KM * Math.sin(dec),
    raDeg: (((ra * R2D) % 360) + 360) % 360,
    decDeg: dec * R2D,
  };
}

/**
 * Check whether a satellite in ECI is illuminated by the Sun (outside Earth shadow).
 * Uses a cylindrical Earth shadow model with mean radius 6,371 km.
 * @param {{ x: number, y: number, z: number }} satECI Satellite position in km
 * @param {number} dateMs UTC epoch timestamp in milliseconds
 * @returns {boolean} True if sunlit, false if in eclipse (Earth shadow)
 */
export function isSatelliteSunlit(satECI, dateMs) {
  if (!satECI || typeof satECI === 'boolean') return false;
  const sun = solarPositionECI(dateMs);
  const sunLen = Math.hypot(sun.x, sun.y, sun.z);
  const sx = sun.x / sunLen;
  const sy = sun.y / sunLen;
  const sz = sun.z / sunLen;
  const proj = satECI.x * sx + satECI.y * sy + satECI.z * sz;
  if (proj > 0) return true; // Sunward side of Earth
  const dx = satECI.x - proj * sx;
  const dy = satECI.y - proj * sy;
  const dz = satECI.z - proj * sz;
  return Math.hypot(dx, dy, dz) > EARTH_RADIUS_KM;
}

/**
 * Compute the observer local solar elevation angle in degrees.
 * @param {number} latDeg Observer latitude in degrees
 * @param {number} lonDeg Observer longitude in degrees
 * @param {number} dateMs UTC epoch timestamp in milliseconds
 * @returns {number} Solar elevation in degrees [-90, 90]
 */
export function observerSolarElevation(latDeg, lonDeg, dateMs) {
  const sun = solarPositionECI(dateMs);
  const gmst = gstime(new Date(dateMs));
  const gmstDeg = (((gmst * R2D) % 360) + 360) % 360;
  const localHourAngleDeg =
    (((gmstDeg + lonDeg - sun.raDeg) % 360) + 360) % 360;
  const H = localHourAngleDeg * D2R;
  const phi = latDeg * D2R;
  const dec = sun.decDeg * D2R;
  const sinElev =
    Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H);
  return Math.asin(Math.max(-1, Math.min(1, sinElev))) * R2D;
}

/**
 * Check whether the observer sky is dark (civil, nautical, or astronomical twilight / night).
 * Default threshold is -6° (civil twilight).
 * @param {number} latDeg Observer latitude
 * @param {number} lonDeg Observer longitude
 * @param {number} dateMs UTC timestamp
 * @param {number} [maxSunElevDeg=-6] Sun elevation ceiling (default -6° for civil twilight)
 * @returns {boolean} True if sun is at or below the threshold
 */
export function isObserverDark(latDeg, lonDeg, dateMs, maxSunElevDeg = -6) {
  return observerSolarElevation(latDeg, lonDeg, dateMs) <= maxSunElevDeg;
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
  steps = 10,
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
  return isRising ? Math.ceil(high) : Math.floor(low);
}

/**
 * Find the next pass of a satellite over an observer location.
 * Uses 20s coarse scanning, bisection for sub-second rise/set times,
 * parabolic interpolation for the peak, and optional naked-eye visibility filtering.
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
 * @param {boolean} [options.requireVisible=false] Skip passes that are not naked-eye visible
 * @param {number} [options.maxSunElevDeg=-6] Ceiling for observer darkness (default -6° for civil twilight)
 * @returns {{
 *   riseMs: number,
 *   setMs: number,
 *   maxElevDeg: number,
 *   maxElevMs: number,
 *   riseAzDeg: number,
 *   visible: boolean,
 *   sunlit: boolean,
 *   observerDark: boolean
 * } | null} `visible` is true when any sampled part of the pass is sunlit under a
 *   dark sky; `sunlit` and `observerDark` describe the peak only.
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
  requireVisible = false,
  maxSunElevDeg = -6,
}) {
  if (
    !satrec ||
    ![
      latDeg,
      lonDeg,
      fromMs,
      minElevDeg,
      horizonHours,
      coarseStepSec,
      fineStepSec,
      maxSunElevDeg,
    ].every(Number.isFinite) ||
    Math.abs(latDeg) > 90 ||
    Math.abs(lonDeg) > 180 ||
    Math.abs(fromMs) > 8.63e15 ||
    minElevDeg < 0 ||
    minElevDeg > 90 ||
    horizonHours <= 0 ||
    horizonHours > 72 ||
    coarseStepSec < 1 ||
    coarseStepSec > 120 ||
    fineStepSec < 0.1 ||
    fineStepSec > 60
  )
    return null;
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
    let hasVisibleSegment = false;
    let elevPrevSample = null;
    let peakLeftElev = null;
    let peakRightElev = null;
    let peakStepMs = fineMs;

    // Visibility at an instant inside [riseMs, setMs], so no elevation gate
    const checkVisibility = (tMs) => {
      if (hasVisibleSegment) return;
      const look = lookAnglesAt(satrec, tMs, latDeg, lonDeg);
      if (!look) return;
      const sunlit = isSatelliteSunlit(look.satECI, tMs);
      const dark = isObserverDark(latDeg, lonDeg, tMs, maxSunElevDeg);
      if (sunlit && dark) {
        hasVisibleSegment = true;
      }
    };

    // Check visibility at rise
    checkVisibility(riseMs);

    // Transit forward in fine steps
    while (tCurr <= horizonMs) {
      const look = lookAnglesAt(satrec, tCurr, latDeg, lonDeg);
      const elev = look ? look.elevDeg : -90;

      if (look) {
        const sunlit = isSatelliteSunlit(look.satECI, tCurr);
        const dark = isObserverDark(latDeg, lonDeg, tCurr, maxSunElevDeg);
        if (sunlit && dark && elev >= minElevDeg) {
          hasVisibleSegment = true;
        }
      }

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
        refinedPeakMs = Math.max(
          riseMs,
          Math.min(setMs, Math.round(maxElevMs + shift)),
        );
        refinedPeakElevDeg = Math.min(
          90,
          maxElevDeg -
            Math.pow(peakLeftElev - peakRightElev, 2) /
              (8 * (peakLeftElev - 2 * maxElevDeg + peakRightElev)),
        );
      }
    }

    // Sun and sky state at the peak
    const peakLook = lookAnglesAt(satrec, refinedPeakMs, latDeg, lonDeg);
    const peakSunlit = peakLook
      ? isSatelliteSunlit(peakLook.satECI, refinedPeakMs)
      : false;
    const peakDark = isObserverDark(
      latDeg,
      lonDeg,
      refinedPeakMs,
      maxSunElevDeg,
    );

    // Check visibility at the refined peak and at set
    checkVisibility(refinedPeakMs);
    checkVisibility(setMs);

    if (!hasVisibleSegment) {
      hasVisibleSegment = hasVisibleInterval(riseMs, setMs, (time) => {
        const look = lookAnglesAt(satrec, time, latDeg, lonDeg);
        return [
          Boolean(look && isSatelliteSunlit(look.satECI, time)),
          isObserverDark(latDeg, lonDeg, time, maxSunElevDeg),
        ];
      });
    }

    // Skip passes with no visible part when requireVisible is set
    if (requireVisible && !hasVisibleSegment) {
      searchCursor = Math.max(setMs + 1000, searchCursor + coarseMs);
      continue;
    }

    const riseLook = lookAnglesAt(satrec, riseMs, latDeg, lonDeg);
    return {
      riseMs,
      setMs,
      maxElevDeg: refinedPeakElevDeg,
      maxElevMs: refinedPeakMs,
      riseAzDeg: riseLook ? riseLook.azDeg : 0,
      visible: hasVisibleSegment,
      sunlit: peakSunlit,
      observerDark: peakDark,
    };
  }

  return null;
}

/** Resolve shadow/twilight crossings to 20ms so short overlap is not lost between samples. */
export function hasVisibleInterval(start, end, conditionsAt) {
  const visible = (states) => states[0] && states[1];
  for (let left = start; left < end; left += 5000) {
    const right = Math.min(end, left + 5000);
    const a = conditionsAt(left);
    const b = conditionsAt(right);
    if (visible(a) || visible(b)) return true;
    const cuts = [left, right];
    for (let condition = 0; condition < 2; condition++) {
      if (a[condition] === b[condition]) continue;
      let low = left;
      let high = right;
      while (high - low > 20) {
        const mid = (low + high) / 2;
        if (conditionsAt(mid)[condition] === a[condition]) low = mid;
        else high = mid;
      }
      cuts.push((low + high) / 2);
    }
    cuts.sort((a, b) => a - b);
    for (let i = 1; i < cuts.length; i++) {
      if (visible(conditionsAt((cuts[i - 1] + cuts[i]) / 2))) return true;
    }
  }
  return false;
}
