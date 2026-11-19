/**
 * @module replay/sampling
 * @description Where a recorded contact was at a time, worked out from its
 * samples alone, so replay draws through the renderer contract and needs no
 * engine clock or sampled property. A recording is cut into spans where the
 * contact went unrecorded for longer than `GAP_SECONDS`; inside a span the
 * position is a straight blend of its two neighbouring samples, and between
 * spans the contact is not drawn.
 */
import { positionToEcef } from '../geo/ellipsoid.js';
import { nearestDeltaMs, OBSERVED_WINDOW_MS, splitAtGaps } from './model.js';

/** A recorded row as a contract position (degrees, metres). */
export const lonLatOf = (p) => ({ lon: p.lon, lat: p.lat, height: p.alt || 0 });

/** A recorded row as ECEF metres. */
export const ecefOf = (p) => positionToEcef(lonLatOf(p));

/**
 * Prepare one grouped track (`groupTracks`) for sampling.
 * @param {{id: string, layer: string, points: object[]}} track
 */
export function prepareTrack(track) {
  return {
    id: track.id,
    layer: track.layer,
    points: track.points,
    times: track.points.map((p) => p.ts * 1000),
    spans: splitAtGaps(track.points).map((part) => ({
      from: part[0].ts * 1000,
      to: part[part.length - 1].ts * 1000,
    })),
  };
}

/**
 * How far outside a recorded span a moment still counts as inside it, ms. A
 * clock converted between time scales can land a hair before a sample, and a
 * contact must not vanish for that.
 */
const SLACK_MS = 1500;

/** The span of the recording that holds `ms` (within the slack), or undefined. */
const spanAt = (track, ms) =>
  track.spans.find((s) => ms >= s.from - SLACK_MS && ms <= s.to + SLACK_MS);

/** Index of the last time at or before `ms`, or -1. */
function lastAtOrBefore(times, ms) {
  let lo = 0;
  let hi = times.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= ms) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** Longitude `b` moved to within 180 degrees of `a`, for a blend across the date line. */
const near = (a, b) => (b - a > 180 ? b - 360 : b - a < -180 ? b + 360 : b);

/**
 * The contact's position at `ms`, or null when no span of the recording
 * covers that moment.
 * @returns {{lon: number, lat: number, alt: number}|null}
 */
export function positionAt(track, ms) {
  const within = spanAt(track, ms);
  if (!within) return null;
  ms = Math.max(within.from, Math.min(within.to, ms));
  const i = lastAtOrBefore(track.times, ms);
  if (i < 0) return null;
  const a = track.points[i];
  const b = track.points[i + 1];
  const span = b ? track.times[i + 1] - track.times[i] : 0;
  if (!b || span <= 0 || ms <= track.times[i])
    return { lon: a.lon, lat: a.lat, alt: a.alt || 0 };
  const k = (ms - track.times[i]) / span;
  let lon = a.lon + k * (near(a.lon, b.lon) - a.lon);
  if (lon > 180) lon -= 360;
  if (lon < -180) lon += 360;
  return {
    lon,
    lat: a.lat + k * (b.lat - a.lat),
    alt: (a.alt || 0) + k * ((b.alt || 0) - (a.alt || 0)),
  };
}

/** Whether a recorded sample lies close to `ms` (a solid dot), not an estimate (a ring). */
export const observedAt = (track, ms) =>
  nearestDeltaMs(track.times, ms) <= OBSERVED_WINDOW_MS;

/**
 * The path a contact has left behind it: the samples of the current span
 * from `trailMs` ago, ending at its position now. Empty when not drawn.
 */
export function trailAt(track, ms, trailMs) {
  const now = positionAt(track, ms);
  if (!now) return [];
  const span = spanAt(track, ms);
  const from = Math.max(ms - trailMs, span.from);
  const path = [];
  for (let i = 0; i < track.times.length; i++) {
    const t = track.times[i];
    if (t >= from && t <= ms) path.push(track.points[i]);
  }
  const start = positionAt(track, from);
  return [...(start ? [start] : []), ...path, now];
}

/** A sphere that holds every position (ECEF); null for none. */
export function boundingSphere(ecefs) {
  if (!ecefs.length) return null;
  const sum = ecefs.reduce(
    (c, p) => ({ x: c.x + p.x, y: c.y + p.y, z: c.z + p.z }),
    { x: 0, y: 0, z: 0 },
  );
  const n = ecefs.length;
  const center = { x: sum.x / n, y: sum.y / n, z: sum.z / n };
  const radius = ecefs.reduce(
    (r, p) =>
      Math.max(r, Math.hypot(p.x - center.x, p.y - center.y, p.z - center.z)),
    0,
  );
  return { center, radius };
}
