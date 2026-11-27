/**
 * What the Transit and Rail cockpit snapshots share: part reuse, the ground
 * lift, and the feed and motion fields both describe the same way.
 */

import { displayMotion } from './transitMovement.js';

/**
 * `previous` when it holds each of `next`'s values, else a frozen copy of
 * `next`: a part of a snapshot that did not change is the one read before.
 * `next` is a draft, filled again on every read.
 */
export function reuseSnapshot(previous, next) {
  if (!previous) return Object.freeze({ ...next });
  for (const name in next)
    if (!Object.is(previous[name], next[name]))
      return Object.freeze({ ...next });
  return previous;
}

/** `value` when it is a finite number, else null. */
export function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** The lift the ground provider adds over the floor (m), else 0. */
export function groundLiftM(services) {
  return Number.isFinite(services.ground?.GROUND_FLOOR_LIFT_M)
    ? services.ground.GROUND_FLOOR_LIFT_M
    : 0;
}

/** Fill the draft `next` with a feed's names and licence; returns `next`. */
export function fillFeedView(next, feed) {
  next.id = feed.id;
  next.name = feed.name ?? null;
  next.operator = feed.operator ?? null;
  next.region = feed.region ?? null;
  next.attribution = feed.attribution ?? null;
  next.license = feed.license ?? null;
  next.licenseUrl = feed.licenseUrl ?? null;
  return next;
}

/**
 * Fill the draft `motion` with how fast the vehicle moves and how that is
 * known, what the screen shows it doing, and how old its report is; returns
 * `motion`.
 */
export function fillMotionView(motion, entry, status) {
  const sample = entry.sample ?? null;
  const reported = finiteOrNull(entry.record.speedMps);
  const derived = finiteOrNull(sample?.segmentSpeedMps);
  motion.reportedSpeedMps = reported;
  motion.derivedSpeedMps = derived;
  motion.speedSource =
    reported !== null ? 'reported' : derived !== null ? 'derived' : null;
  motion.courseDeg = finiteOrNull(entry.courseDeg);
  motion.phase = sample?.phase ?? null;
  motion.word = displayMotion(entry, Date.now()).word;
  motion.reportAgeMs = finiteOrNull(sample?.latestReportAgeMs);
  motion.shownBehindMs = finiteOrNull(sample?.actualDelayMs);
  motion.feedStale = status?.stale === true;
  return motion;
}
