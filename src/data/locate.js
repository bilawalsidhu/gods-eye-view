import { fromDegreesInto } from '../geo/ellipsoid.js';

/**
 * Finding a selected vessel or aircraft again once it has left the screen or
 * its layer's feed: where its own track has it at a time, and whether a point
 * is on screen at all.
 */

/**
 * The newest point of a track at or before `atMs` (any time when `atMs` is
 * not given), from a live source's `getTrack` records
 * (`{observedAtMs, latitude, longitude, baroAltitudeM?}`).
 * @param {Array<object>} points
 * @param {number} [atMs]
 * @returns {{lat: number, lon: number, altitudeM: ?number, observedAtMs: number}|null}
 */
export function readingAt(points, atMs) {
  let best = null;
  for (const point of points ?? []) {
    const lat = Number(point?.latitude);
    const lon = Number(point?.longitude);
    const observedAtMs = point?.observedAtMs;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (!Number.isFinite(observedAtMs)) continue;
    if (Number.isFinite(atMs) && observedAtMs > atMs) continue;
    if (best && best.observedAtMs >= observedAtMs) continue;
    const altitude = Number(point.baroAltitudeM ?? point.altitudeM);
    best = {
      lat,
      lon,
      altitudeM: Number.isFinite(altitude) ? altitude : null,
      observedAtMs,
    };
  }
  return best;
}

/**
 * Where a source's track has a vessel or aircraft at `atMs` (now, when not
 * given): `{status: 'found', lat, lon, altitudeM, observedAtMs, atMs}`, or
 * `{status: 'none'}` when the track has no point at or before the time, the
 * source keeps no tracks or the lookup fails.
 * @param {{getTrack?: Function}|null} source
 * @param {string} reference The track reference the layer's records carry.
 * @param {{atMs?: number, signal?: AbortSignal}} [options]
 */
export async function locateOnTrack(source, reference, { atMs, signal } = {}) {
  if (typeof source?.getTrack !== 'function' || !reference)
    return { status: 'none' };
  try {
    const track = await source.getTrack(
      reference,
      Number.isFinite(atMs) ? { signal, atMs } : { signal },
    );
    const reading = readingAt(track?.records, atMs);
    // The time it was looked up for, so its reading's age can be told.
    const at = Number.isFinite(atMs) ? atMs : Date.now();
    return reading
      ? { status: 'found', ...reading, atMs: at }
      : { status: 'none' };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { status: 'none' };
  }
}

/** Mean Earth radius (m), for the horizon test. */
const EARTH_RADIUS_M = 6_371_000;

/**
 * Whether a point is in the camera's view: in front of it, inside its field
 * of view and on the near side of the globe.
 * @param {{position: {x, y, z}, direction: {x, y, z}, up: {x, y, z},
 *   right: {x, y, z}, fovy: number, aspectRatio: number}} pose
 * @param {number} lat
 * @param {number} lon
 * @param {number} [heightM]
 * @returns {boolean}
 */
export function onScreen(pose, lat, lon, heightM = 0) {
  if (!pose?.position || !Number.isFinite(lat) || !Number.isFinite(lon))
    return false;
  const p = fromDegreesInto(lon, lat, Math.max(0, heightM || 0), {
    x: 0,
    y: 0,
    z: 0,
  });
  const c = pose.position;
  const v = { x: p.x - c.x, y: p.y - c.y, z: p.z - c.z };
  const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
  const ahead = dot(v, pose.direction);
  if (!(ahead > 0)) return false;
  const tanY = Math.tan(pose.fovy / 2);
  const tanX = tanY * (pose.aspectRatio || 1);
  if (Math.abs(dot(v, pose.right) / ahead) > tanX) return false;
  if (Math.abs(dot(v, pose.up) / ahead) > tanY) return false;
  // Behind the globe: the camera is below the point's horizon plane. Judged
  // on a sphere through the point, which is close enough for a button.
  const length = Math.hypot(p.x, p.y, p.z) || EARTH_RADIUS_M;
  const normal = { x: p.x / length, y: p.y / length, z: p.z / length };
  return dot({ x: c.x - p.x, y: c.y - p.y, z: c.z - p.z }, normal) > 0;
}
