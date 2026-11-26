// PROTOTYPE ONLY. Gives the flights source a timeline backed by a local
// recording of the live feed (a stand-in for Hosted's archive readers), so the
// timeline design can be tried on real aircraft. Not for merging.
import { Cartesian3, HeadingPitchRange, Matrix4 } from 'cesium';
import { openSkySnapshot, normalizeAircraftTrack } from '../sources/live/aircraft.js';

const BASE = '/proto-rec';
const STEP_MS = 5 * 60_000;
const SPAN_MS = 20 * 60_000;

// The aircraft the timeline is about. A replay keeps it in every snapshot
// wherever the camera is, as an archive reader asked for one aircraft by id
// would, so the view can follow it back along its flight.
let subject = null;
export function setRecordedSubject(reference) {
  subject = reference ? String(reference).toLowerCase() : null;
}

export function withRecordedHistory(source) {
  let span = null;
  const listeners = new Set();
  const refresh = async () => {
    try {
      const answer = await (await fetch(`${BASE}/coverage`)).json();
      if (Number.isFinite(answer.start)) {
        const had = span !== null;
        span = { start: answer.start, end: answer.end };
        if (!had) for (const listener of listeners) listener();
      }
    } catch {
      // No recording: the layer stays live.
    }
  };
  refresh();
  setInterval(refresh, 30_000);
  return {
    ...source,
    timeline: {
      stepMs: STEP_MS,
      spanMs: SPAN_MS,
      coverage: () => (span ? { start: span.start, end: Date.now() } : null),
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    async getSnapshot(query = {}, options = {}) {
      if (query.atMs === undefined) return source.getSnapshot(query, options);
      const params = new URLSearchParams({ at: String(query.atMs) });
      if (Number.isFinite(query.latitude) && Number.isFinite(query.longitude)) {
        params.set('lat', query.latitude.toFixed(4));
        params.set('lon', query.longitude.toFixed(4));
      }
      if (subject) params.set('keep', subject);
      const response = await fetch(`${BASE}/snapshot?${params}`, {
        signal: options.signal,
      });
      const payload = await response.json();
      const snapshot = openSkySnapshot(payload, {
        source: 'Recorded ADS-B (adsb.lol)',
        coverage: 'recorded for this prototype',
        now: query.atMs,
      });
      for (const record of snapshot.records ?? [])
        record.fixes = payload.fixesByIcao?.[record.id];
      return { ...snapshot, atMs: query.atMs, status: 200 };
    },
    async getTrack(reference, options = {}) {
      if (options.atMs === undefined) return source.getTrack(reference, options);
      const response = await fetch(
        `${BASE}/track?hex=${encodeURIComponent(reference)}&at=${options.atMs}`,
        { signal: options.signal },
      );
      const payload = await response.json();
      return { records: normalizeAircraftTrack(payload.path), complete: false };
    },
  };
}

/**
 * Where a recorded aircraft was first and last seen, and the moments of its
 * flight worth a pin on the timeline, worked out from its recorded fixes.
 */
export async function recordedJourney(reference) {
  try {
    const payload = await (
      await fetch(`${BASE}/track?hex=${encodeURIComponent(reference)}`)
    ).json();
    if (!Number.isFinite(payload.first)) return null;
    return {
      start: payload.first,
      end: payload.last,
      callsign: (payload.flight || '').trim(),
      moments: journeyMoments(payload.path ?? [], payload.first, payload.last),
      path: payload.path ?? [],
    };
  } catch {
    return null;
  }
}

/** Fixes are [seconds, lat, lon, altitude m, heading]. */
export function journeyMoments(path, first, last) {
  const moments = [{ time: first, label: 'FIRST SEEN' }];
  const fixes = path.filter((fix) => Number.isFinite(fix[3]));
  if (fixes.length > 4) {
    const cruise = Math.max(...fixes.map((fix) => fix[3]));
    const level = (fix) => fix[3] >= cruise - 150;
    if (fixes[0][3] < cruise - 600) {
      const at = fixes.find(level);
      if (at) moments.push({ time: at[0] * 1000, label: 'LEVELLED OFF' });
    }
    if (fixes.at(-1)[3] < cruise - 600) {
      const at = fixes.findLast(level);
      if (at) moments.push({ time: at[0] * 1000, label: 'BEGAN DESCENT' });
    }
  }
  // The sharpest turns: where its heading swung most within two minutes.
  const turns = [];
  for (let index = 0; index < path.length; index += 1) {
    const from = path[index];
    const to = path.find((fix) => fix[0] >= from[0] + 120);
    if (!to || !Number.isFinite(from[4]) || !Number.isFinite(to[4])) continue;
    const swing = Math.abs(((to[4] - from[4] + 540) % 360) - 180);
    if (swing >= 25) turns.push({ time: (from[0] + 60) * 1000, swing });
  }
  turns.sort((a, b) => b.swing - a.swing);
  const kept = [];
  for (const turn of turns) {
    if (kept.length >= 2) break;
    if (kept.every((each) => Math.abs(each.time - turn.time) > 6 * 60_000))
      kept.push(turn);
  }
  for (const turn of kept)
    moments.push({ time: turn.time, label: `TURNED ${Math.round(turn.swing)}°` });
  if (Date.now() - last > 3 * 60_000) moments.push({ time: last, label: 'LAST SEEN' });
  return moments.sort((a, b) => a.time - b.time);
}

/**
 * Bring the view to where a recorded aircraft was at `ms`, keeping the
 * camera's bearing and tilt. The flights layer asks for what is around the
 * camera, so a replay that jumps far along a flight has to move the view there
 * before the aircraft can be drawn; from then on the usual tracking holds it.
 */
export function viewJourneyAt(path, ms) {
  const viewer = window.__godsEyeView?.viewer;
  if (!viewer || path.length < 2) return false;
  const t = ms / 1000;
  let index = path.findIndex((fix) => fix[0] > t);
  if (index === 0) return false;
  if (index < 0) index = path.length;
  const a = path[index - 1];
  const b = path[index] ?? a;
  const k = b[0] > a[0] ? Math.min(1, (t - a[0]) / (b[0] - a[0])) : 0;
  const lat = a[1] + (b[1] - a[1]) * k;
  const lon = a[2] + (b[2] - a[2]) * k;
  const altitude = Number.isFinite(a[3]) ? a[3] : 0;
  const camera = viewer.camera;
  const here = camera.positionCartographic;
  const km =
    111 *
    Math.hypot(
      (here.latitude * 180) / Math.PI - lat,
      ((here.longitude * 180) / Math.PI - lon) * Math.cos((lat * Math.PI) / 180),
    );
  // Near enough that the layer already has it: tracking does the rest.
  if (km < 60) return false;
  const target = Cartesian3.fromDegrees(lon, lat, altitude);
  const range = Math.min(400_000, Math.max(18_000, here.height - altitude));
  camera.lookAt(target, new HeadingPitchRange(camera.heading, Math.min(camera.pitch, -0.35), range));
  camera.lookAtTransform(Matrix4.IDENTITY);
  viewer.scene.requestRender?.();
  return true;
}
