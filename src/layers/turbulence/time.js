/**
 * What the turbulence layer shows at a time on the world clock. Pure.
 *
 * - Forecasts: G-AIRMET snapshots are each valid at one moment, three hours
 *   apart; the one nearest the time is shown, within half that spacing.
 * - Warnings: SIGMETs in force at the time (from its start, until its end).
 * - Reports: pilot reports from the REPORT_WINDOW_MS before the time.
 *
 * Both windows are half-open, [start, end), so a membership changes at
 * exactly the boundaries `selectionKey` counts.
 *
 * The clock calls back every frame while it plays, so `selectionKey` is
 * cheap (binary searches over prepared boundaries) and the layer redraws
 * only when the key changes.
 */

import { REPORT_WINDOW_MS } from './records.js';

const HOUR_MS = 3_600_000;
/** Spacing assumed for a single forecast snapshot. */
const DEFAULT_SPACING_MS = 3 * HOUR_MS;
/** How far before/after the snapshots the timeline offers the layer. */
const COVERAGE_PAD_MS = 1.5 * HOUR_MS;

const prepared = new WeakMap();

/** Count of sorted `values` before `t` (or at it, with `inclusive`). */
function rank(values, t, inclusive = true) {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (inclusive ? values[mid] <= t : values[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const ascending = (a, b) => a - b;

/** Sorted, distinct forecast valid times and the time boundaries, once per snapshot. */
function prepare(snapshot) {
  let entry = prepared.get(snapshot);
  if (entry) return entry;
  const times = [
    ...new Set((snapshot?.forecasts ?? []).map((r) => r.validAt)),
  ].sort(ascending);
  let spacing = DEFAULT_SPACING_MS;
  for (let i = 1; i < times.length; i++)
    spacing = Math.min(spacing, times[i] - times[i - 1]);
  const warnings = snapshot?.warnings ?? [];
  const reports = snapshot?.reports ?? [];
  entry = {
    times,
    window: spacing / 2,
    warningBounds: warnings
      .flatMap((r) => [r.validFrom, r.validTo])
      .sort(ascending),
    reportBounds: reports
      .flatMap((r) => [r.observedAt, r.observedAt + REPORT_WINDOW_MS])
      .sort(ascending),
  };
  if (snapshot && typeof snapshot === 'object') prepared.set(snapshot, entry);
  return entry;
}

/** The distinct forecast valid times of a snapshot, ascending. */
export function forecastTimes(snapshot) {
  return prepare(snapshot).times;
}

/**
 * The forecast valid time nearest `t` within half the snapshot spacing, or
 * null. Exactly halfway between two snapshots reads as the later one.
 */
export function nearestForecastTime(snapshot, t) {
  const { times, window } = prepare(snapshot);
  if (!times.length || !Number.isFinite(t)) return null;
  // The first snapshot at or after `t`, and the one before it.
  const after = rank(times, t, false);
  const later = times[after];
  const earlier = times[after - 1];
  let best = null;
  if (later !== undefined && later - t <= window) best = later;
  if (
    earlier !== undefined &&
    t - earlier <= window &&
    (best === null || t - earlier < later - t)
  )
    best = earlier;
  return best;
}

/**
 * A fingerprint of what would be shown at `t`: it changes exactly when the
 * forecast snapshot, the set of warnings in force or the set of reports in
 * the window could change.
 */
export function selectionKey(snapshot, t) {
  const { warningBounds, reportBounds } = prepare(snapshot);
  const forecast = nearestForecastTime(snapshot, t);
  return `${forecast ?? '-'}|${rank(warningBounds, t)}|${rank(reportBounds, t)}`;
}

/**
 * What is shown at `t`.
 * @returns {{forecastValidAt: number|null, forecasts: object[], warnings: object[], reports: object[], key: string}}
 */
export function selectAt(snapshot, t) {
  const forecastValidAt = nearestForecastTime(snapshot, t);
  return {
    forecastValidAt,
    forecasts:
      forecastValidAt === null
        ? []
        : (snapshot?.forecasts ?? []).filter(
            (r) => r.validAt === forecastValidAt,
          ),
    warnings: (snapshot?.warnings ?? []).filter(
      (r) => r.validFrom <= t && t < r.validTo,
    ),
    reports: (snapshot?.reports ?? []).filter(
      (r) => r.observedAt <= t && t - r.observedAt < REPORT_WINDOW_MS,
    ),
    key: selectionKey(snapshot, t),
  };
}

/**
 * The span of time the layer can show, for the world clock's timeline: the
 * forecast snapshots padded by half their spacing, and back far enough for
 * the reporting window. Null with nothing loaded.
 */
export function coverageOf(snapshot, now) {
  const { times } = prepare(snapshot);
  const warnings = snapshot?.warnings ?? [];
  const reports = snapshot?.reports ?? [];
  if (!times.length && !warnings.length && !reports.length) return null;
  const starts = [now - REPORT_WINDOW_MS];
  const ends = [now];
  if (times.length) {
    starts.push(times[0] - COVERAGE_PAD_MS);
    ends.push(times.at(-1) + COVERAGE_PAD_MS);
  }
  for (const r of warnings) ends.push(r.validTo);
  return { start: Math.min(...starts), end: Math.max(...ends) };
}
