/**
 * Predictive Trajectory & Orbital Footprint Predictor.
 *
 * Computes forward-propagated flight paths, nautical tracks, and satellite
 * groundtracks with spherical Earth geodesics and satellite.js SGP4.
 */

import * as satellite from 'satellite.js';

const EARTH_RADIUS_M = 6371008.8;
const KTS_TO_MPS = 0.514444;
const FPM_TO_MPS = 0.00508;

/**
 * Extrapolates great-circle waypoint coordinates given start position, bearing, and distance.
 * @param {number} latDeg - Initial latitude in degrees
 * @param {number} lonDeg - Initial longitude in degrees
 * @param {number} bearingDeg - Heading clockwise from true north
 * @param {number} distanceM - Great-circle distance along surface in meters
 * @returns {{ latDeg: number, lonDeg: number }}
 */
export function extrapolateGreatCircle(latDeg, lonDeg, bearingDeg, distanceM) {
  const phi1 = (latDeg * Math.PI) / 180;
  const lambda1 = (lonDeg * Math.PI) / 180;
  const theta = (bearingDeg * Math.PI) / 180;
  const delta = distanceM / EARTH_RADIUS_M;

  const sinPhi1 = Math.sin(phi1);
  const cosPhi1 = Math.cos(phi1);
  const sinDelta = Math.sin(delta);
  const cosDelta = Math.cos(delta);

  const sinPhi2 = sinPhi1 * cosDelta + cosPhi1 * sinDelta * Math.cos(theta);
  const phi2 = Math.asin(Math.max(-1, Math.min(1, sinPhi2)));

  const y = Math.sin(theta) * sinDelta * cosPhi1;
  const x = cosDelta - sinPhi1 * sinPhi2;
  const lambda2 = lambda1 + Math.atan2(y, x);

  const finalLon = ((lambda2 * 180) / Math.PI + 540) % 360 - 180;
  return {
    latDeg: (phi2 * 180) / Math.PI,
    lonDeg: finalLon,
  };
}

/**
 * Predicts aircraft or vessel trajectory up to 30 minutes in the future.
 *
 * @param {object} state
 * @param {number} state.latDeg
 * @param {number} state.lonDeg
 * @param {number} [state.altitudeM=0]
 * @param {number} [state.headingDeg=0]
 * @param {number} [state.speedKts=0]
 * @param {number} [state.verticalRateFpm=0]
 * @param {object} [options]
 * @param {number[]} [options.horizonsSec=[300, 900, 1800]] - 5m, 15m, 30m
 * @param {number} [options.stepSec=30] - sampling interval
 * @returns {Array<{
 *   horizonSec: number,
 *   color: string,
 *   waypoints: Array<{ latDeg: number, lonDeg: number, altitudeM: number, timeSec: number }>
 * }>}
 */
export function predictVehicleTrajectory(state, {
  horizonsSec = [300, 900, 1800],
  stepSec = 30,
} = {}) {
  const {
    latDeg = 0,
    lonDeg = 0,
    altitudeM = 0,
    headingDeg = 0,
    speedKts = 0,
    verticalRateFpm = 0,
  } = state;

  const speedMps = Math.max(0, speedKts * KTS_TO_MPS);
  const climbMps = verticalRateFpm * FPM_TO_MPS;

  const horizonColors = ['#00f0ff', '#ffd700', '#ff3366'];
  const segments = [];

  let currentLat = latDeg;
  let currentLon = lonDeg;
  let currentAlt = Math.max(0, altitudeM);

  const maxHorizon = Math.max(...horizonsSec);
  const totalSteps = Math.ceil(maxHorizon / stepSec);

  const allWaypoints = [{
    latDeg: currentLat,
    lonDeg: currentLon,
    altitudeM: currentAlt,
    timeSec: 0,
  }];

  for (let step = 1; step <= totalSteps; step++) {
    const elapsedSec = step * stepSec;
    const distanceM = speedMps * stepSec;
    const nextCoord = extrapolateGreatCircle(currentLat, currentLon, headingDeg, distanceM);

    currentLat = nextCoord.latDeg;
    currentLon = nextCoord.lonDeg;
    currentAlt = Math.max(0, currentAlt + climbMps * stepSec);

    allWaypoints.push({
      latDeg: currentLat,
      lonDeg: currentLon,
      altitudeM: currentAlt,
      timeSec: elapsedSec,
    });
  }

  // Segment waypoints into horizon tiers (e.g. 0-5m, 5-15m, 15-30m)
  let prevHorizonSec = 0;
  horizonsSec.forEach((hSec, idx) => {
    const waypoints = allWaypoints.filter(
      (wp) => wp.timeSec >= prevHorizonSec && wp.timeSec <= hSec,
    );
    segments.push({
      horizonSec: hSec,
      color: horizonColors[idx % horizonColors.length],
      waypoints,
    });
    prevHorizonSec = hSec;
  });

  return segments;
}

/**
 * Predicts satellite groundtrack and coverage footprint for the next orbital period.
 *
 * @param {string} tleLine1
 * @param {string} tleLine2
 * @param {Date} [startTime=new Date()]
 * @param {number} [durationSec=5400] - Default 90 minutes (1 orbit)
 * @param {number} [stepSec=60]
 * @returns {{
 *   groundtrack: Array<{ latDeg: number, lonDeg: number, altitudeM: number, timeSec: number }>,
 *   footprintRadiusM: number,
 *   currentPosition: { latDeg: number, lonDeg: number, altitudeM: number } | null
 * }}
 */
export function predictSatelliteOrbit(
  tleLine1,
  tleLine2,
  startTime = new Date(),
  durationSec = 5400,
  stepSec = 60,
) {
  if (!tleLine1 || !tleLine2) {
    return { groundtrack: [], footprintRadiusM: 0, currentPosition: null };
  }

  try {
    const satrec = satellite.twoline2satrec(tleLine1.trim(), tleLine2.trim());
    const groundtrack = [];
    let currentPosition = null;
    let latestAltM = 400000;

    const startMs = startTime.getTime();
    const steps = Math.ceil(durationSec / stepSec);

    for (let i = 0; i <= steps; i++) {
      const timeMs = startMs + i * stepSec * 1000;
      const date = new Date(timeMs);
      const positionAndVelocity = satellite.propagate(satrec, date);

      if (positionAndVelocity && positionAndVelocity.position) {
        const gmst = satellite.gstime(date);
        const geodetic = satellite.eciToGeodetic(positionAndVelocity.position, gmst);

        const latDeg = (geodetic.latitude * 180) / Math.PI;
        const lonDeg = (geodetic.longitude * 180) / Math.PI;
        const altitudeM = geodetic.height * 1000;

        const wp = {
          latDeg,
          lonDeg,
          altitudeM,
          timeSec: i * stepSec,
        };

        groundtrack.push(wp);
        if (i === 0) {
          currentPosition = wp;
          latestAltM = altitudeM;
        }
      }
    }

    // Swath / footprint cone calculation on spherical Earth
    // cos(theta) = R / (R + h)
    const angleRad = Math.acos(
      Math.max(0, Math.min(1, EARTH_RADIUS_M / (EARTH_RADIUS_M + latestAltM))),
    );
    const footprintRadiusM = EARTH_RADIUS_M * angleRad;

    return {
      groundtrack,
      footprintRadiusM,
      currentPosition,
    };
  } catch {
    return { groundtrack: [], footprintRadiusM: 0, currentPosition: null };
  }
}
