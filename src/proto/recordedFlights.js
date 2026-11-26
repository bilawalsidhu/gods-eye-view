// PROTOTYPE ONLY. Gives the flights source a timeline backed by a local
// recording of the live feed (a stand-in for Hosted's archive readers), so the
// timeline design can be tried on real aircraft. Not for merging.
import { openSkySnapshot, normalizeAircraftTrack } from '../sources/live/aircraft.js';

const BASE = '/proto-rec';
const STEP_MS = 5 * 60_000;
const SPAN_MS = 20 * 60_000;

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

/** Where a recorded aircraft was first and last seen, for the journey strip. */
export async function recordedJourney(reference) {
  try {
    const payload = await (
      await fetch(`${BASE}/track?hex=${encodeURIComponent(reference)}`)
    ).json();
    return Number.isFinite(payload.first)
      ? { start: payload.first, end: payload.last, callsign: payload.flight }
      : null;
  } catch {
    return null;
  }
}
