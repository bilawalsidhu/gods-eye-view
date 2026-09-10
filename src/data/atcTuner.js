/**
 * @module atcTuner
 * @description Proximity detection and automatic frequency tuning logic for
 * Air Traffic Control (ATC) communications.
 */

import { findNearestAirport, getAirportByIcao } from './atcAirports.js';

/**
 * Standard maximum line-of-sight VHF reception range in meters (~50 Nautical Miles).
 */
export const DEFAULT_ATC_RANGE_M = 92600;

/**
 * Convert feet to meters.
 * @param {number} feet
 * @returns {number}
 */
export function feetToMeters(feet) {
  return feet * 0.3048;
}

/**
 * Convert meters to feet.
 * @param {number} meters
 * @returns {number}
 */
export function metersToFeet(meters) {
  return meters / 0.3048;
}

/**
 * Classify aircraft flight phase relative to a target airport.
 * @param {object} params
 * @param {number|null} [params.altitudeM=null] Altitude above sea level in meters
 * @param {number} [params.verticalRateMps=0] Climb/descent rate in m/s (+ climb, - descent)
 * @param {number} [params.groundSpeedKts=0] Ground speed in knots
 * @param {number|null} [params.velocityMps=null] Ground speed in m/s
 * @param {number} [params.distanceM=Infinity] Distance to airport in meters
 * @param {boolean} [params.onGround=false] Transponder on_ground flag
 * @returns {{ phase: 'surface'|'approach'|'departure'|'enroute', recommendedFreq: 'tower'|'approach'|'ground' }}
 */
export function evaluateFlightPhase({
  altitudeM = null,
  verticalRateMps = 0,
  groundSpeedKts = 0,
  velocityMps = null,
  distanceM = Number.POSITIVE_INFINITY,
  onGround = false,
} = {}) {
  const effectiveSpeedKts = groundSpeedKts > 0
    ? groundSpeedKts
    : (Number.isFinite(velocityMps) ? velocityMps * 1.943844 : 0);

  const hasAlt = Number.isFinite(altitudeM);
  const alt = hasAlt ? altitudeM : 0;

  // Surface phase: on ground or confirmed low altitude within immediate airport radius (< 8 km / ~4.3 NM)
  if (onGround || (hasAlt && alt <= 150 && distanceM <= 8000)) {
    return {
      phase: 'surface',
      recommendedFreq: effectiveSpeedKts > 20 ? 'tower' : 'ground',
    };
  }

  // Departure phase: within 20 NM (~37 km), climbing actively (> 1.0 m/s) and below 10,000 ft (~3,048 m)
  if (distanceM <= 37040 && hasAlt && alt <= 3048 && verticalRateMps > 1.0) {
    return {
      phase: 'departure',
      recommendedFreq: distanceM <= 9260 ? 'tower' : 'approach',
    };
  }

  // Approach phase: within 30 NM (~55.5 km), below 12,000 ft (~3,657 m), descending or level
  if (distanceM <= 55560 && hasAlt && alt <= 3657 && verticalRateMps <= 1.0) {
    // Within 10 NM (18.5 km), switch from approach control to local tower
    return {
      phase: 'approach',
      recommendedFreq: distanceM <= 18520 ? 'tower' : 'approach',
    };
  }

  // En-route / Cruise
  return {
    phase: 'enroute',
    recommendedFreq: 'tower',
  };
}

/**
 * Resolve the complete ATC tuning state for an aircraft.
 * @param {object} params
 * @param {object|null} [params.aircraft=null] Aircraft telemetry { lat, lon, altitudeM, verticalRateMps, groundSpeedKts, velocityMps, onGround, callsign }
 * @param {boolean} [params.autoTune=true] Whether auto-tuning is active
 * @param {string|null} [params.manualAirportIcao=null] Manual airport ICAO override
 * @param {string|null} [params.manualFreqType=null] Manual frequency type override ('tower', 'approach', 'atis', 'ground')
 * @param {number} [params.maxRangeM=DEFAULT_ATC_RANGE_M] Max reception distance
 * @returns {object} Tuning result state
 */
export function resolveAtcTune({
  aircraft = null,
  autoTune = true,
  manualAirportIcao = null,
  manualFreqType = null,
  maxRangeM = DEFAULT_ATC_RANGE_M,
} = {}) {
  // Manual tuning without tracked aircraft
  if (!aircraft || !Number.isFinite(aircraft.lat) || !Number.isFinite(aircraft.lon)) {
    if (manualAirportIcao) {
      const manualAirport = getAirportByIcao(manualAirportIcao);
      if (manualAirport) {
        const freqType = manualFreqType || 'tower';
        const frequencyMHz = manualAirport.frequencies?.[freqType] || manualAirport.frequencies?.tower || null;
        return {
          tuned: true,
          status: 'monitoring',
          airport: manualAirport,
          distanceM: null,
          distanceNm: null,
          phase: 'enroute',
          freqType,
          frequencyMHz,
          streamUrl: manualAirport.streamUrl,
          inRange: true,
          callsign: null,
        };
      }
    }
    return {
      tuned: false,
      status: 'idle',
      airport: null,
      distanceM: null,
      distanceNm: null,
      phase: 'enroute',
      freqType: null,
      frequencyMHz: null,
      streamUrl: null,
      inRange: false,
      callsign: null,
    };
  }

  // Manual airport selection or nearest airport discovery
  let targetAirport = null;
  let distanceM = Number.POSITIVE_INFINITY;
  let distanceNm = Number.POSITIVE_INFINITY;

  if (manualAirportIcao) {
    targetAirport = getAirportByIcao(manualAirportIcao);
    if (targetAirport) {
      const match = findNearestAirport(aircraft.lat, aircraft.lon, Number.POSITIVE_INFINITY, [targetAirport]);
      if (match) {
        distanceM = match.distanceM;
        distanceNm = match.distanceNm;
      }
    }
  } else if (autoTune) {
    const nearest = findNearestAirport(aircraft.lat, aircraft.lon, maxRangeM);
    if (nearest) {
      targetAirport = nearest.airport;
      distanceM = nearest.distanceM;
      distanceNm = nearest.distanceNm;
    }
  }

  if (!targetAirport) {
    return {
      tuned: false,
      status: 'no-station',
      airport: null,
      distanceM: null,
      distanceNm: null,
      phase: 'enroute',
      freqType: null,
      frequencyMHz: null,
      streamUrl: null,
      inRange: false,
      callsign: aircraft.callsign || null,
    };
  }

  const inRange = distanceM <= maxRangeM;
  const { phase, recommendedFreq } = evaluateFlightPhase({
    altitudeM: Number.isFinite(aircraft.altitudeM) ? aircraft.altitudeM : null,
    verticalRateMps: aircraft.verticalRateMps ?? 0,
    groundSpeedKts: aircraft.groundSpeedKts ?? 0,
    velocityMps: aircraft.velocityMps ?? null,
    distanceM,
    onGround: Boolean(aircraft.onGround),
  });

  const selectedFreqType = manualFreqType || recommendedFreq;
  const frequencyMHz = targetAirport.frequencies?.[selectedFreqType] || targetAirport.frequencies?.tower || null;

  return {
    tuned: inRange || Boolean(manualAirportIcao),
    status: inRange ? (phase === 'approach' || phase === 'surface' ? 'active' : 'monitoring') : 'squelch',
    airport: targetAirport,
    distanceM,
    distanceNm,
    phase,
    freqType: selectedFreqType,
    frequencyMHz,
    streamUrl: (inRange || Boolean(manualAirportIcao)) ? targetAirport.streamUrl : null,
    inRange,
    callsign: aircraft.callsign || null,
  };
}
