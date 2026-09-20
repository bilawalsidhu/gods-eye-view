/**
 * @file Circling math — pure and Cesium-free so every rule is pinnable.
 *
 * The detector accumulates the SIGNED heading change along an aircraft's
 * recent track, using only displacements long enough to carry a real
 * bearing. An aircraft that keeps turning the same way racks up ±360° per
 * revolution; straight flight sums to ~0 because left and right wobbles
 * cancel. A flag additionally requires the whole track to fit in a small
 * circle (loitering, not an en-route arc) and to span real time.
 */

import {
  HISTORY_WINDOW_MS,
  SAMPLE_MIN_INTERVAL_MS,
  MAX_SAMPLES,
  MIN_SEGMENT_M,
  MIN_TOTAL_TURN_DEG,
  MAX_LOITER_RADIUS_M,
  MIN_SPAN_MS,
  MIN_SEGMENTS,
} from './policy.js';

const EARTH_RADIUS_M = 6_371_008.8;
const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

function wrappedRadians(degrees) {
  return (((((degrees + 180) % 360) + 360) % 360) - 180) * DEG_TO_RAD;
}

function distanceM(a, b) {
  const lat1 = a.lat * DEG_TO_RAD;
  const lat2 = b.lat * DEG_TO_RAD;
  const dLat = lat2 - lat1;
  const dLon = wrappedRadians(b.lon - a.lon);
  const h = Math.min(
    1,
    Math.max(
      0,
      Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2,
    ),
  );
  return 2 * EARTH_RADIUS_M * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function bearingDeg(a, b) {
  const lat1 = a.lat * DEG_TO_RAD;
  const lat2 = b.lat * DEG_TO_RAD;
  const dLon = wrappedRadians(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (Math.atan2(y, x) * RAD_TO_DEG + 360) % 360;
}

function centerOf(points) {
  let x = 0;
  let y = 0;
  let z = 0;
  for (const point of points) {
    const lat = point.lat * DEG_TO_RAD;
    const lon = point.lon * DEG_TO_RAD;
    x += Math.cos(lat) * Math.cos(lon);
    y += Math.cos(lat) * Math.sin(lon);
    z += Math.sin(lat);
  }
  if (Math.hypot(x, y, z) < Number.EPSILON) {
    return { lat: points[0].lat, lon: points[0].lon };
  }
  return {
    lat: Math.atan2(z, Math.hypot(x, y)) * RAD_TO_DEG,
    lon: Math.atan2(y, x) * RAD_TO_DEG,
  };
}

/**
 * Append one position sample to a track, enforcing the window, the minimum
 * sample spacing, and the memory cap. Mutates and returns the track.
 * @param {{samples: Array<{tMs:number, lat:number, lon:number}>}} track
 */
export function appendSample(track, sample, nowMs) {
  const samples = track.samples;
  const last = samples[samples.length - 1];
  if (
    !last ||
    (sample.tMs - last.tMs >= SAMPLE_MIN_INTERVAL_MS &&
      (sample.lat !== last.lat || sample.lon !== last.lon))
  ) {
    samples.push({ tMs: sample.tMs, lat: sample.lat, lon: sample.lon });
  }
  const cutoff = nowMs - HISTORY_WINDOW_MS;
  while (samples.length && samples[0].tMs < cutoff) samples.shift();
  while (samples.length > MAX_SAMPLES) samples.shift();
  return track;
}

/**
 * Signed total turn, loiter radius, and span for one track.
 * @returns {{totalTurnDeg:number, radiusM:number, spanMs:number,
 *   segments:number, center:{lat:number, lon:number}|null}}
 */
export function circlingAssessment(samples, minSegmentM = MIN_SEGMENT_M) {
  const empty = {
    totalTurnDeg: 0,
    radiusM: 0,
    spanMs: 0,
    segments: 0,
    center: null,
  };
  if (!Array.isArray(samples) || samples.length < 2) return empty;
  let anchor = samples[0];
  const used = [anchor];
  let totalTurnDeg = 0;
  let previousBearing = null;
  for (let i = 1; i < samples.length; i += 1) {
    const sample = samples[i];
    if (distanceM(anchor, sample) < minSegmentM) continue;
    const bearing = bearingDeg(anchor, sample);
    if (previousBearing !== null) {
      // Shortest signed difference, so 350°→10° reads as +20, not −340.
      const delta = ((bearing - previousBearing + 540) % 360) - 180;
      // A half-turn between observations has no recoverable direction; do not
      // let the modulo tie-breaker invent one for sparsely sampled tracks.
      if (Math.abs(Math.abs(delta) - 180) > 1e-6) totalTurnDeg += delta;
    }
    previousBearing = bearing;
    anchor = sample;
    used.push(sample);
  }
  if (used.length < 2) return empty;
  const center = centerOf(used);
  let radiusM = 0;
  for (const point of used) {
    const d = distanceM(center, point);
    if (d > radiusM) radiusM = d;
  }
  return {
    totalTurnDeg,
    radiusM,
    spanMs: used[used.length - 1].tMs - used[0].tMs,
    segments: used.length - 1,
    center,
  };
}

/** The flag rule, separated so the thresholds are pinnable one by one. */
export function isCircling(assessment) {
  return (
    Math.abs(assessment.totalTurnDeg) >= MIN_TOTAL_TURN_DEG &&
    assessment.radiusM <= MAX_LOITER_RADIUS_M &&
    assessment.spanMs >= MIN_SPAN_MS &&
    assessment.segments >= MIN_SEGMENTS
  );
}
