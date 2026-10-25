/** Pure helpers for replaying recorded history: tick lists and per-contact tracks. */

/** Evenly spaced ISO ticks from `fromMs` to `toMs`, inclusive; fewer than 2 when there is no span. */
export function buildTicks(fromMs, toMs, count = 240) {
  if (!(Number.isFinite(fromMs) && Number.isFinite(toMs)) || toMs <= fromMs)
    return [];
  const steps = Math.max(1, count - 1);
  return Array.from({ length: steps + 1 }, (_, i) =>
    new Date(fromMs + ((toMs - fromMs) * i) / steps).toISOString(),
  );
}

/** Group recorded rows into per-contact tracks, oldest first. */
export function groupTracks(points) {
  const tracks = new Map();
  for (const p of points || []) {
    const key = `${p.layer}:${p.id}`;
    let track = tracks.get(key);
    if (!track)
      tracks.set(key, (track = { id: p.id, layer: p.layer, points: [] }));
    track.points.push(p);
  }
  for (const track of tracks.values()) track.points.sort((a, b) => a.ts - b.ts);
  return tracks;
}

/** The window the slider covers: the recorded range, no longer than `maxHours`. */
export function replayWindow(range, maxHours = 6) {
  const from = Number(range?.from_ts);
  const to = Number(range?.to_ts);
  if (!(Number.isFinite(from) && Number.isFinite(to)) || to <= from)
    return null;
  return {
    fromSec: Math.max(from, to - maxHours * 3600),
    toSec: to,
  };
}

/** Index of the last tick at or before `timeMs`, or 0. */
export function tickIndexAt(ticks, timeMs) {
  let found = 0;
  for (let i = 0; i < ticks.length; i += 1) {
    if (Date.parse(ticks[i]) <= timeMs) found = i;
    else break;
  }
  return found;
}

export const GAP_SECONDS = 300;
export const OBSERVED_WINDOW_MS = 15000;

/** Split one contact's points where there is more than `gapSec` between them. */
export function splitAtGaps(points, gapSec = GAP_SECONDS) {
  const segments = [];
  for (const p of points) {
    const last = segments[segments.length - 1];
    if (last && p.ts - last[last.length - 1].ts <= gapSec) last.push(p);
    else segments.push([p]);
  }
  return segments;
}

/** Distance in ms from `ms` to the closest recorded time in sorted `timesMs`. */
export function nearestDeltaMs(timesMs, ms) {
  let lo = 0;
  let hi = timesMs.length - 1;
  if (hi < 0) return Infinity;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (timesMs[mid] < ms) lo = mid + 1;
    else hi = mid;
  }
  const after = Math.abs(timesMs[lo] - ms);
  return lo > 0 ? Math.min(after, Math.abs(timesMs[lo - 1] - ms)) : after;
}
