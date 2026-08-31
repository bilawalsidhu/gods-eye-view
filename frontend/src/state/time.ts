/**
 * How far back the globe is being shown, and what is honestly available back there.
 *
 * **The slider carries an offset, not an instant, and that is the whole design.** Held at two
 * hours back, the globe keeps running: "now" advances, so the instant on screen advances with
 * it, satellites keep moving at their real speed along their real historic tracks, and the
 * terminator creeps west. An instant would freeze everything the moment it was set, which
 * looks broken and shows nothing about motion. So the state is one number, milliseconds behind
 * the present, and zero means live.
 *
 * **Four things were asked for and they have three different answers.** Alexander Fanthome's
 * request on 2026-08-24 was a slider where "all assets should move, the earth and sun and moon
 * should also move". The sun and the moon are computed by Cesium from a `JulianDate` and are
 * exact at any epoch. Satellites are propagated by SGP4 from orbital element sets and are
 * exact at any epoch inside the element sets' own trust window. Aircraft, ships, transport and
 * posts are live feeds held in memory with a time to live, and **this project records no
 * history of them at all**, so there is nothing to show and no honest way to invent one.
 *
 * AGENTS.md is unambiguous that a position is never extrapolated, that two fixes are never
 * averaged into a third, and the transit staleness work went to real trouble to stop a bus
 * being drawn on the wrong street. An interpolated past track would be exactly that lie with a
 * slider in front of it. So the movers come off the globe when the clock leaves the present,
 * and {@link historyNotices} says so on screen rather than letting a viewer assume the planes
 * are real history.
 *
 * No Cesium and no DOM here. `ui/time-control.ts` draws it and `main.ts` wires it to the clock.
 */

import { STALE_EPOCH_AGE_MS } from '../globe/satellites/orbit';

/**
 * The furthest back the slider goes: 3.5 days, which is CelesTrak's own staleness figure.
 *
 * **Taken from the propagator rather than chosen, because it is the same bound.** An element
 * set more than 3.5 days from the instant being drawn is held back by
 * `SatelliteEngine.positionsAt` and counted, and the rail says how many. Letting the slider go
 * further back would produce a view whose satellites had almost all silently dropped out, with
 * the layer reporting itself as broken. Going back exactly this far means the drop-off is the
 * genuine edge of what the elements support.
 *
 * The guard in `orbit.ts` is symmetric on the same figure, which it was not before this
 * feature existed: it compared a signed difference, so time travel into the past passed every
 * check however far back it went. See `STALE_EPOCH_AGE_MS`.
 */
export const MAX_REWIND_MS = STALE_EPOCH_AGE_MS;

/**
 * One step of the slider: a minute.
 *
 * 3.5 days is 5,040 of them, which is a sensible number of stops for a range input and finer
 * than the thing being read. The terminator moves a quarter of a degree per minute and the ISS
 * moves about 460 km, so a minute is a visible step on both halves of what this drives.
 */
export const REWIND_STEP_MS = 60_000;

/** Slider positions from the far past to the present, inclusive of both ends. */
export const REWIND_STEPS = Math.round(MAX_REWIND_MS / REWIND_STEP_MS);

/**
 * Layers that exist only in the present, so they leave the globe when the clock does.
 *
 * Every one of them is a live feed of things that move, held in memory with a time to live and
 * never written down. Posts are in the list even though a post does not move: a post is dated,
 * and the set of posts the provider returns for a viewport is the set that exists now, so
 * showing today's posts under a two-day-old sun would date them wrongly.
 *
 * Cities are not in it, because cities do not move. Clouds are not in it either, and that is
 * the one item worth stating out loud rather than assuming: the GIBS sheets are the current
 * ones, so a historic view keeps today's weather. {@link historyNotices} says so.
 */
export const LIVE_ONLY_LAYERS: readonly string[] = [
  'aircraft',
  'military',
  'vessels',
  'transit',
  'social',
];

/** Hold a slider value inside the range, and off a fractional millisecond. */
export function clampRewind(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) {
    return 0;
  }
  return Math.min(Math.round(ms), MAX_REWIND_MS);
}

/** Whether the globe is showing the present. The one question every caller actually asks. */
export function isLive(rewindMs: number): boolean {
  return clampRewind(rewindMs) === 0;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** `1 hour`, `2 hours`. A count against a singular noun reads as a bug in the copy. */
function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * How far back, in words. Coarse on purpose: the exact instant is printed beside it.
 *
 * Two units at most, largest first, and the smaller one is dropped when it is zero, so this
 * reads "2 days back" rather than "2 days 0 hours back".
 */
export function describeRewind(rewindMs: number): string {
  const ms = clampRewind(rewindMs);
  if (ms === 0) {
    return 'Live';
  }
  if (ms < HOUR_MS) {
    return `${plural(Math.round(ms / MINUTE_MS), 'minute')} back`;
  }
  if (ms < DAY_MS) {
    const hours = Math.floor(ms / HOUR_MS);
    const minutes = Math.round((ms - hours * HOUR_MS) / MINUTE_MS);
    return minutes === 0
      ? `${plural(hours, 'hour')} back`
      : `${plural(hours, 'hour')} ${plural(minutes, 'minute')} back`;
  }
  const days = Math.floor(ms / DAY_MS);
  const hours = Math.round((ms - days * DAY_MS) / HOUR_MS);
  return hours === 0
    ? `${plural(days, 'day')} back`
    : `${plural(days, 'day')} ${plural(hours, 'hour')} back`;
}

/**
 * The instant on screen, written out in UTC.
 *
 * UTC rather than the browser's own zone, and stated as such. Every time in this project's
 * contracts is timezone-aware UTC, the satellite element sets are dated in it, and a viewer
 * comparing this readout against a card's observation time has to be reading the same clock.
 * A local rendering would silently disagree with every other time on screen by an hour or ten.
 */
const INSTANT_FORMAT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC',
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export function describeInstant(atMs: number): string {
  if (!Number.isFinite(atMs)) {
    return 'unknown';
  }
  // Non-breaking space stripped: `Intl` emits U+202F between the date and the time in some ICU
  // versions, which reaches the DOM as a character no test can type and no reader expects.
  //
  // Written as escapes rather than as the characters themselves, which is how this was first
  // written. A literal U+202F in source is invisible to whoever reads it next and cannot be typed
  // to reproduce a bug, so the linter refuses it, and it is right to.
  return `${INSTANT_FORMAT.format(new Date(atMs)).replaceAll(/[\u{202F}\u{00A0}]/gu, ' ')} UTC`;
}

/**
 * What the product says it is and is not doing back here, or an empty list when live.
 *
 * Three sentences, because there are three different claims and collapsing them would blur the
 * one that matters. The first says what is true, the second says what is missing and why, and
 * the third names the one thing on screen that is neither.
 */
export function historyNotices(rewindMs: number): readonly string[] {
  if (isLive(rewindMs)) {
    return [];
  }
  return [
    'The sun, the moon and every satellite are computed for this instant, so they are where they really were.',
    'Aircraft, ships, transport and posts are live feeds. Nothing here recorded their past, so they are not drawn rather than guessed at.',
    'The cloud imagery stays current: NASA publishes it for today.',
  ];
}
