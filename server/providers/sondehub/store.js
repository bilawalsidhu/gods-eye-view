import {
  normalizeSondeFrame,
  mergeFrame,
  trackPoint,
  SONDE_RETAIN_MS,
  SONDE_MAX_SERIALS,
  SONDE_TRACK_MAX_POINTS,
} from '../../../src/layers/radiosondes/records.js';
/** Keep validated fixes and bounded rolling tracks in memory. */
export function createSondeStore({ now = Date.now } = {}) {
  const entries = new Map();
  function prune() {
    const cutoff = now() - SONDE_RETAIN_MS;
    for (const [serial, entry] of entries) {
      if (entry.lastSeenMs < cutoff || entry.latest.timeMs < cutoff)
        entries.delete(serial);
      else entry.track = entry.track.filter((p) => p.timeMs >= cutoff);
    }
  }
  return {
    /** Admit only newer fixes, projecting away receiver fields. */
    ingest(raw) {
      const frame = normalizeSondeFrame(raw, now());
      if (!frame) return null;
      prune();
      const previous = entries.get(frame.serial);
      if (mergeFrame(previous?.latest, frame) !== frame) return null;
      const track = previous?.track ?? [];
      const last = track.at(-1);
      if (
        !last ||
        frame.timeMs - last.timeMs >= 10_000 ||
        Math.abs(frame.altM - last.altM) >= 100
      )
        track.push(trackPoint(frame));
      if (track.length > SONDE_TRACK_MAX_POINTS)
        track.splice(0, track.length - SONDE_TRACK_MAX_POINTS);
      entries.delete(frame.serial);
      entries.set(frame.serial, { latest: frame, track, lastSeenMs: now() });
      if (entries.size > SONDE_MAX_SERIALS)
        entries.delete(entries.keys().next().value);
      return frame;
    },
    /** Return the latest retained fix for each serial. */
    snapshot() {
      prune();
      return [...entries.values()].map((e) => e.latest);
    },
    /** Return a copy of a serial's retained rolling path. */
    track(serial) {
      prune();
      return (entries.get(serial)?.track ?? []).map(trackPoint);
    },
  };
}
