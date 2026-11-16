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
  // Each entry's time is read once: a layer merges a run for every contact
  // in a snapshot, each holding up to `limit` entries.
  const olderTimes = new Array(older.length);
  for (let k = 0; k < older.length; k++) olderTimes[k] = timeOf(older[k]);
  const newerTimes = new Array(newer.length);
  for (let k = 0; k < newer.length; k++) newerTimes[k] = timeOf(newer[k]);
  const first = newer.length ? newerTimes[0] : Infinity;
  const last = newer.length ? newerTimes[newer.length - 1] : -Infinity;
  const newest = newer[newer.length - 1];
  // The older entries before the newer run that the loop below would keep
  // one by one, each far enough from the one before, are taken at once: a
  // contact's kept entries mostly stand before each snapshot's run.
  let lead = 0;
  while (
    lead < older.length &&
    !(olderTimes[lead] >= first && olderTimes[lead] <= last) &&
    (newer.length === 0 || olderTimes[lead] < first) &&
    (lead === 0 ||
      olderTimes[lead] - olderTimes[lead - 1] >= TIMELINE_FIX_SPACING_MS)
  )
    lead++;
  // Both runs in order, the older entries within the newer run's time left
  // out, thinned to the spacing.
  const merged = older.slice(0, lead);
  const times = olderTimes.slice(0, lead);
  const take = (entry, t) => {
    const k = merged.length - 1;
    if (k < 0 || t - times[k] >= TIMELINE_FIX_SPACING_MS) {
      merged.push(entry);
      times.push(t);
    } else if (entry === newest) {
      merged[k] = entry;
      times[k] = t;
    }
  };
  let i = lead;
  let j = 0;
  while (i < older.length || j < newer.length) {
    if (i < older.length) {
      const t = olderTimes[i];
      if (t >= first && t <= last) {
        i++;
        continue;
      }
      if (j >= newer.length || t < newerTimes[j]) {
        take(older[i], t);
        i++;
        continue;
      }
    }
    take(newer[j], newerTimes[j]);
    j++;
  }
  if (merged.length <= limit) return merged;
  // The window of `limit` entries nearest the centre.
  let start = 0;
  while (
    start + limit < merged.length &&
    Math.abs(times[start + limit] - centreMs) <
      Math.abs(times[start] - centreMs)
  )
    start++;
  return merged.slice(start, start + limit);
}
