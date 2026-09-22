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

const M_PER_DEG_LAT = 111320;

function metersXY(refLatDeg) {
  return {
    kx: Math.cos((refLatDeg * Math.PI) / 180) * M_PER_DEG_LAT,
    ky: M_PER_DEG_LAT,
  };
}

function distanceM(a, b) {
  const { kx, ky } = metersXY((a.lat + b.lat) / 2);
  return Math.hypot((b.lon - a.lon) * kx, (b.lat - a.lat) * ky);
}

function bearingDeg(a, b) {
  const { kx, ky } = metersXY((a.lat + b.lat) / 2);
  const deg =
    (Math.atan2((b.lon - a.lon) * kx, (b.lat - a.lat) * ky) * 180) / Math.PI;
  return (deg + 360) % 360;
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
      totalTurnDeg += ((bearing - previousBearing + 540) % 360) - 180;
    }
    previousBearing = bearing;
    anchor = sample;
    used.push(sample);
  }
  if (used.length < 2) return empty;
  const center = {
    lat: used.reduce((sum, p) => sum + p.lat, 0) / used.length,
    lon: used.reduce((sum, p) => sum + p.lon, 0) / used.length,
  };
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
