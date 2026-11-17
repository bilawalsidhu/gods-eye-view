/**
 * The fixes a snapshot at a time may carry for each contact (a record's
 * `fixes`, see readSnapshotTimeline in src/sources/live/contract.js): where
 * it was in the minutes around the time, so a layer following the world
 * clock places it at nearby times, earlier ones too, without asking again.
 */

/** Most fixes a contact keeps across the snapshots that brought them. */
export const TIMELINE_FIXES_LIMIT = 240;
/** Kept fixes are at least this far apart, so the limit spans well over an
 * hour around the newest snapshot's time however dense the fixes come. */
export const TIMELINE_FIX_SPACING_MS = 20_000;
/**
 * The longest stretch of snapshot times a layer treats as loaded at once
 * (see src/time/snapshotTimeline.js). With each snapshot's fixes reaching a
 * span either side, it stays within what every contact keeps around the
 * newest snapshot's time.
 */
export const TIMELINE_HELD_MS = 20 * 60_000;
/**
 * A contact following the clock is not drawn at a time more than this
 * before its first fix: it was not there yet. Within it, it is drawn
 * reaching its first fix, as a contact first seen is.
 */
export const TIMELINE_UNSEEN_MS = 60_000;

/**
 * A record's fixes in time order, those with a time and a position only,
 * or null when it carries fewer than two.
 * @param {unknown} value
 * @returns {Array<{atMs: number, lat: number, lon: number,
 *   altitudeM: number|null}>|null}
 */
export function readTimelineFixes(value) {
  if (!Array.isArray(value)) return null;
  const fixes = [];
  for (const fix of value) {
    const atMs = Number(fix?.atMs);
    const lat = Number(fix?.lat);
    const lon = Number(fix?.lon);
    if (
      !Number.isFinite(atMs) ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      Math.abs(lat) > 90
    )
      continue;
    const altitudeM = Number(fix?.altitudeM);
    fixes.push({
      atMs,
      lat,
      lon,
      altitudeM:
        fix?.altitudeM != null && Number.isFinite(altitudeM) ? altitudeM : null,
    });
  }
  if (fixes.length < 2) return null;
  fixes.sort((a, b) => a.atMs - b.atMs);
  return fixes;
}

/** The share of records whose fixes reach no further than fixesReachMs. */
export const FIXES_REACH_SHARE = 0.9;

/**
 * How far the fixes a snapshot's records carry reach: the time by which
 * FIXES_REACH_SHARE of them have their newest fix, so a few reaching far
 * ahead do not stand for the rest (those whose fixes end sooner left), or
 * null when none carries fixes.
 * @param {Array<{fixes?: unknown}>|undefined} records
 * @returns {number|null}
 */
export function fixesReachMs(records) {
  const reaches = [];
  for (const record of records ?? []) {
    if (!Array.isArray(record?.fixes)) continue;
    let reach = -Infinity;
    for (const fix of record.fixes) {
      const atMs = Number(fix?.atMs);
      if (Number.isFinite(atMs) && atMs > reach) reach = atMs;
    }
    if (reach > -Infinity) reaches.push(reach);
  }
  if (!reaches.length) return null;
  reaches.sort((a, b) => a - b);
  return reaches[Math.ceil(FIXES_REACH_SHARE * reaches.length) - 1];
}

/**
 * Two runs of entries in time order (`timeOf` reads an entry's epoch ms) as
 * one: `newer` stands in for the entries of `older` within the time it
 * spans, the rest of `older` is kept, and an entry closer than
 * TIMELINE_FIX_SPACING_MS to the one kept before it is left out, but for
 * the newest of `newer`, which is always kept. Only the `limit` entries nearest
 * `centreMs` are kept, so the fixes kept span at least `limit` times that
 * spacing.
 * @template T
 * @param {T[]} older
 * @param {T[]} newer
 * @param {(entry: T) => number} timeOf
 * @param {number} centreMs
 * @param {number} [limit]
 * @returns {T[]}
 */
export function mergeTimelineRuns(
  older,
  newer,
  timeOf,
  centreMs,
  limit = TIMELINE_FIXES_LIMIT,
) {
  const first = newer.length ? timeOf(newer[0]) : Infinity;
  const last = newer.length ? timeOf(newer[newer.length - 1]) : -Infinity;
  const newest = newer[newer.length - 1];
  // Both runs in order, the older entries within the newer run's time left
  // out, thinned to the spacing.
  const merged = [];
  const take = (entry) => {
    const k = merged.length - 1;
    if (k < 0 || timeOf(entry) - timeOf(merged[k]) >= TIMELINE_FIX_SPACING_MS) {
      merged.push(entry);
    } else if (entry === newest) {
      merged[k] = entry;
    }
  };
  let i = 0;
  let j = 0;
  while (i < older.length || j < newer.length) {
    if (i < older.length) {
      const t = timeOf(older[i]);
      if (t >= first && t <= last) {
        i++;
        continue;
      }
      if (j >= newer.length || t < timeOf(newer[j])) {
        take(older[i++]);
        continue;
      }
    }
    take(newer[j++]);
  }
  if (merged.length <= limit) return merged;
  // The window of `limit` entries nearest the centre.
  let start = 0;
  while (
    start + limit < merged.length &&
    Math.abs(timeOf(merged[start + limit]) - centreMs) <
      Math.abs(timeOf(merged[start]) - centreMs)
  )
    start++;
  return merged.slice(start, start + limit);
}
