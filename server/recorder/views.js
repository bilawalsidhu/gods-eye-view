/**
 * @module recorder/views
 * @description Saved views: a name and the replay state to come back to (when
 * the window starts and how long it is, the drawn area, the layers and the
 * speed). Checked here so a stored view can always be applied.
 */
import { ALL_LAYERS } from './config.js';

const MAX_NAME = 60;
const MAX_VIEWS = 200;
const WINDOW_HOURS = [1, 6, 24]; // as in the replay controller
const SPEEDS = [0.5, 1, 2, 5, 10, 30, 60];

/** A number inside a range, or null. */
const within = (value, low, high) =>
  Number.isFinite(value) && value >= low && value <= high ? value : null;

/** The name as stored: trimmed, one line, not empty. */
export function viewName(input) {
  const name = String(input ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!name) throw new TypeError('Give the view a name');
  if (name.length > MAX_NAME)
    throw new TypeError(`A view name is at most ${MAX_NAME} characters`);
  return name;
}

/**
 * Cleans what the panel sends into the stored form; throws a message the
 * panel can show. Unknown fields are dropped.
 * @returns {{fromSec: number|null, windowHours: number, layers: string[],
 *   region: {west:number,south:number,east:number,north:number}|null, speed: number}}
 */
export function cleanView(input = {}) {
  const layers = []
    .concat(input.layers ?? [])
    .filter((l) => ALL_LAYERS.includes(l));
  if (!layers.length) throw new TypeError('A view needs at least one layer');
  const windowHours = WINDOW_HOURS.includes(Number(input.windowHours))
    ? Number(input.windowHours)
    : 6;
  const speed = SPEEDS.includes(Number(input.speed)) ? Number(input.speed) : 10;
  let region = null;
  if (input.region) {
    const r = input.region;
    const box = {
      west: within(Number(r.west), -180, 180),
      south: within(Number(r.south), -90, 90),
      east: within(Number(r.east), -180, 180),
      north: within(Number(r.north), -90, 90),
    };
    if (Object.values(box).some((v) => v === null) || box.south > box.north)
      throw new TypeError('The area in this view is not valid');
    region = box;
  }
  const fromSec =
    input.fromSec == null ? null : within(Number(input.fromSec), 0, 4e9);
  return { fromSec, windowHours, layers, region, speed };
}

/** Whether another view may be added. */
export const roomForView = (count, exists) => exists || count < MAX_VIEWS;

/** Rows from a store -> [{ name, savedTs, view }], skipping any that no longer parse. */
export function readViews(rows) {
  const out = [];
  for (const row of rows) {
    try {
      out.push({
        name: row.name,
        savedTs: Number(row.saved_ts),
        view: cleanView(JSON.parse(row.body)),
      });
    } catch {
      // A damaged row is left out rather than breaking the list.
    }
  }
  return out;
}
