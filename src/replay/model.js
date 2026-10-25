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

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/** 1536 -> "1.5 KB"; one decimal below 10, none above. */
export function formatBytes(bytes) {
  let value = Math.max(0, Number(bytes) || 0);
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const text = unit === 0 || value >= 10 ? Math.round(value) : value.toFixed(1);
  return `${text} ${UNITS[unit]}`;
}

/** Seconds as "40min", "6.5h" or "12d". */
export function formatSpan(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}min`;
  const trim = (v) => (v >= 10 ? Math.round(v) : Number(v.toFixed(1)));
  if (s < 86400) return `${trim(s / 3600)}h`;
  return `${trim(s / 86400)}d`;
}

export const STORAGE_ORANGE = 0.6;
export const STORAGE_RED = 0.85;

/**
 * What the storage bar shows, from the recorder's status. The bar is measured
 * against the size cap when one is set, otherwise against the disk (what is
 * stored plus what is free). With neither, only the size is known.
 */
export function storageUse(status) {
  const used = Number(status?.bytes) || 0;
  const cap = Number(status?.max_bytes) || 0;
  const free = Number.isFinite(status?.disk_free_bytes)
    ? status.disk_free_bytes
    : null;
  const total = cap > 0 ? cap : free === null ? 0 : used + free;
  const fraction = total ? Math.min(1, used / total) : 0;
  const level =
    fraction >= STORAGE_RED
      ? 'red'
      : fraction >= STORAGE_ORANGE
        ? 'orange'
        : 'green';
  // Growth: what is stored so far over the time it covers.
  const span = Number(status?.to_ts) - Number(status?.from_ts);
  const perHour = span >= 600 ? used / (span / 3600) : null;
  const retention = Number(status?.retention_sec) || 0;
  const settles =
    perHour && retention > 0 ? (perHour * retention) / 3600 : null;
  let fullInSec = null;
  let settlesAt = null;
  if (perHour && total) {
    if (settles !== null && settles <= total * 0.98) settlesAt = settles;
    else if (used < total) fullInSec = ((total - used) / perHour) * 3600;
  }
  return {
    basis: cap > 0 ? 'cap' : total ? 'disk' : 'none',
    used,
    total,
    free: total ? Math.max(0, total - used) : null,
    fraction,
    level,
    perHour,
    settlesAt,
    fullInSec,
  };
}
