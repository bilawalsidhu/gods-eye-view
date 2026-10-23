import { dayStartMs } from './dates.js';
import {
  CROSSFADE_SHARE,
  DANGER_LEVELS,
  FADED_ALPHA,
  FADE_DAYS,
  RUNOUT_SHARE,
} from './policy.js';

const DAY_MS = 86_400_000;

/** @param {number} value Unit interval. @returns {number} Eased, flat at both ends. */
function smoothstep(value) {
  const t = Math.min(1, Math.max(0, value));
  return t * t * (3 - 2 * t);
}

/**
 * The two days a playhead sits between, and how far it has blended.
 *
 * The playhead counts days from the window's first midnight. Each day holds
 * its own rating first and blends into the next one at its end, so a day is
 * readable before it changes.
 * @param {number} dayCount Days in the window.
 * @param {number} position Playhead in days.
 * @returns {{from:number, to:number, mix:number}}
 */
export function dayBlend(dayCount, position) {
  const last = dayCount - 1;
  const clamped = Math.min(last, Math.max(0, position));
  const from = Math.min(last, Math.floor(clamped));
  const to = Math.min(last, from + 1);
  const hold = 1 - CROSSFADE_SHARE;
  const into = clamped - from;
  const mix =
    to === from || into <= hold
      ? 0
      : smoothstep((into - hold) / CROSSFADE_SHARE);
  return { from, to, mix };
}

/** @param {number} dayCount Days. @param {number} position Playhead. @returns {number} Day most on screen. */
export function currentDay(dayCount, position) {
  const { from, to, mix } = dayBlend(dayCount, position);
  return mix < 0.5 ? from : to;
}

/** @param {number} level 0–5. @returns {?{level:number,label:string,color:?string}} Scale entry. */
export function dangerLevel(level) {
  return DANGER_LEVELS[level] ?? null;
}

/**
 * Index a region's ratings by window day.
 * @param {{days:Array<{date:string, level:number}>}} region Forecast region.
 * @param {Array<{date:string}>} days Window days.
 * @returns {Array<number>} Rating per window day; 0 where none was issued.
 */
export function ratingsByDay(region, days) {
  const byDate = new Map((region?.days ?? []).map((day) => [day.date, day]));
  return days.map((day) => byDate.get(day.date)?.level ?? 0);
}

const hexRgb = (hex) => [
  parseInt(hex.slice(1, 3), 16) / 255,
  parseInt(hex.slice(3, 5), 16) / 255,
  parseInt(hex.slice(5, 7), 16) / 255,
];

/**
 * A region's fill at the playhead: its day's danger colour, blending into the
 * next day's. An unrated day fades the fill out rather than painting a colour
 * that could read as safe.
 * @param {Array<number>} ratings Rating per window day.
 * @param {number} position Playhead in days.
 * @param {number} alpha Fill opacity at full strength.
 * @returns {{red:number, green:number, blue:number, alpha:number}}
 */
export function regionFill(ratings, position, alpha) {
  const { from, to, mix } = dayBlend(ratings.length, position);
  const colorOf = (level) => dangerLevel(level)?.color ?? null;
  const a = colorOf(ratings[from]);
  const b = colorOf(ratings[to]);
  const rgbA = a ? hexRgb(a) : b ? hexRgb(b) : [1, 1, 1];
  const rgbB = b ? hexRgb(b) : rgbA;
  const weightA = (a ? 1 : 0) * (1 - mix);
  const weightB = (b ? 1 : 0) * mix;
  const lerp = (i) => rgbA[i] + (rgbB[i] - rgbA[i]) * mix;
  return {
    red: lerp(0),
    green: lerp(1),
    blue: lerp(2),
    alpha: alpha * (weightA + weightB),
  };
}

/**
 * Whether a region's danger is rising, falling or steady into the next day.
 * @param {Array<number>} ratings Rating per window day.
 * @param {number} day Window day index.
 * @returns {-1|0|1} Trend; 0 when either day is unrated.
 */
export function dangerTrend(ratings, day) {
  const now = ratings[day];
  const next = ratings[day + 1];
  if (!now || !next) return 0;
  return Math.sign(next - now);
}

/**
 * How an observed avalanche looks at the playhead.
 *
 * Nothing until it happened; then a front runs from release to runout over a
 * fraction of a day; then the path fades with age to a floor, so the week's
 * activity stays on the map but today's reads first.
 * @param {string} time Observation ISO time.
 * @param {string} firstDate Window's first date.
 * @param {number} position Playhead in days.
 * @returns {{visible:boolean, runout:number, alpha:number, fresh:boolean}}
 */
export function observationState(time, firstDate, position) {
  const at = (Date.parse(time) - dayStartMs(firstDate)) / DAY_MS;
  const age = position - at;
  if (!Number.isFinite(age) || age < 0)
    return { visible: false, runout: 0, alpha: 0, fresh: false };
  const runout = Math.min(1, age / RUNOUT_SHARE);
  const fade = Math.min(1, age / FADE_DAYS);
  return {
    visible: true,
    runout,
    alpha: 1 - (1 - FADED_ALPHA) * fade,
    fresh: age < 1,
  };
}

/**
 * Whether a window has nothing to show: no rated region and no avalanche.
 * That is the off-season case the replay is offered for.
 * @param {Array<object>} regions Forecast regions.
 * @param {Array<object>} observations Observations.
 * @returns {boolean}
 */
export function isQuietWindow(regions, observations) {
  if (observations.length) return false;
  return !regions.some((region) => region.days.some((day) => day.level > 0));
}

/**
 * The busiest week of a season, for the replay to open on.
 * @param {Array<{from:string, to:string, count:number}>} weeks Season weeks.
 * @returns {?{from:string, to:string, count:number}}
 */
export function busiestWeek(weeks) {
  let best = null;
  for (const week of weeks) if (!best || week.count > best.count) best = week;
  return best && best.count > 0 ? best : null;
}
