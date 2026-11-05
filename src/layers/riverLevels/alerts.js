/**
 * @module layers/riverLevels/alerts
 *
 * Level alerts for single gauges, kept in this browser. The viewer picks one
 * of a gauge's own reference levels; the layer says so once when a reading
 * reaches it, and again only after the water has gone back the other way.
 * The check runs on each refresh while the app is open with the layer on:
 * nothing is sent anywhere, and a closed tab hears nothing.
 *
 * Pure apart from the injected storage and the browser Notification helpers.
 */

import { readingIsLate, STATION_ID_PATTERN } from './model.js';

export const RIVER_ALERT_STORAGE_KEY = 'gev:river-level-alerts:v1';
export const RIVER_ALERT_LIMIT = 25;

// A level is reached when the gauge's band sits at it or further along the
// same ladder: high water rises through watch → warning → flood → above the
// record, low water falls through below normal → the lowest on record.
const HIGH_WATER = ['watch', 'warning', 'flood', 'major'];
const LOW_WATER = ['low', 'record-low'];

// The references a gauge must publish for each level to be reachable. A
// gauge without alert stages reaches "watch" over its mean yearly high, as
// the band classifier says.
const NEEDS = Object.freeze({
  watch: ['watch', 'high'],
  warning: ['warning'],
  flood: ['flood'],
  major: ['recordHigh'],
  low: ['low'],
  'record-low': ['recordLow'],
});

/** Every alert level, high water first. */
export const RIVER_ALERT_LEVELS = Object.freeze(Object.keys(NEEDS));

/** The alert levels a gauge can reach, given the references it publishes. */
export function alertLevelsFor(station) {
  const refs = station?.refs || {};
  return RIVER_ALERT_LEVELS.filter((level) =>
    NEEDS[level].some((key) => Number.isFinite(refs[key])),
  );
}

/** Whether a band is at or past an alert level on that level's ladder. */
export function alertReached(band, level) {
  const ladder = HIGH_WATER.includes(level)
    ? HIGH_WATER
    : LOW_WATER.includes(level)
      ? LOW_WATER
      : null;
  if (!ladder) return false;
  const at = ladder.indexOf(band);
  return at >= 0 && at >= ladder.indexOf(level);
}

/**
 * The viewer's gauge alerts.
 * @param {object} [options]
 * @param {Storage|null} [options.storage] Where the alerts persist; without
 *   one (private mode, blocked storage) they last until the page closes.
 * @param {number} [options.limit]
 */
export function createRiverAlerts({
  storage = null,
  limit = RIVER_ALERT_LIMIT,
} = {}) {
  /** @type {Map<string, {level: string, name: string, reached: boolean}>} */
  const watches = new Map();

  function load() {
    let parsed = null;
    try {
      parsed = JSON.parse(storage?.getItem(RIVER_ALERT_STORAGE_KEY) || 'null');
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    for (const [id, watch] of Object.entries(parsed)) {
      if (watches.size >= limit) break;
      if (!STATION_ID_PATTERN.test(id)) continue;
      if (!RIVER_ALERT_LEVELS.includes(watch?.level)) continue;
      watches.set(id, {
        level: watch.level,
        name: String(watch.name || id).slice(0, 80),
        reached: watch.reached === true,
      });
    }
  }

  function save() {
    try {
      if (watches.size)
        storage?.setItem(
          RIVER_ALERT_STORAGE_KEY,
          JSON.stringify(Object.fromEntries(watches)),
        );
      else storage?.removeItem(RIVER_ALERT_STORAGE_KEY);
    } catch {
      // Full or blocked storage: the alerts still work until the page closes.
    }
  }

  load();

  return {
    /** @returns {{level: string, name: string, reached: boolean}|null} */
    get(stationId) {
      return watches.get(stationId) || null;
    },

    /** @returns {Array<{id: string, level: string, name: string, reached: boolean}>} */
    list() {
      return [...watches].map(([id, watch]) => ({ id, ...watch }));
    },

    /**
     * Watch a gauge for a level, or stop with a null level. A level the
     * gauge cannot reach, or a new gauge over the limit, is refused.
     * @returns {{reached: boolean}|null} Whether the level is already reached
     *   (said now, and not again until the water turns), or null if refused.
     */
    set(station, level) {
      if (!station?.id || !STATION_ID_PATTERN.test(station.id)) return null;
      if (!level) {
        watches.delete(station.id);
        save();
        return { reached: false };
      }
      if (!alertLevelsFor(station).includes(level)) return null;
      if (!watches.has(station.id) && watches.size >= limit) return null;
      const reached = alertReached(station.band, level);
      watches.set(station.id, {
        level,
        name: String(station.name || station.id).slice(0, 80),
        reached,
      });
      save();
      return { reached };
    },

    clear() {
      watches.clear();
      save();
    },

    /**
     * Compare fresh readings with the alerts. A gauge alerts once when it
     * reaches its level and re-arms when it leaves it; a late reading or a
     * gauge gone grey changes nothing.
     * @returns {Array<{station: object, level: string}>} The alerts to give.
     */
    check(stations, now = Date.now()) {
      if (!watches.size) return [];
      const due = [];
      let changed = false;
      for (const station of stations || []) {
        const watch = station ? watches.get(station.id) : null;
        if (!watch || station.band === 'unknown') continue;
        if (readingIsLate(station, now)) continue;
        const reached = alertReached(station.band, watch.level);
        if (reached && !watch.reached)
          due.push({ station, level: watch.level });
        if (reached !== watch.reached) {
          watch.reached = reached;
          changed = true;
        }
      }
      if (changed) save();
      return due;
    },
  };
}

/** `window.localStorage` when the browser lets the page use it, else null. */
export function browserAlertStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

/**
 * Ask once whether the browser may show alerts. Call it from the viewer's own
 * click: browsers refuse the question otherwise.
 * @returns {Promise<string>} The permission, or 'unsupported'.
 */
export async function requestAlertPermission(api = globalThis.Notification) {
  try {
    if (!api) return 'unsupported';
    if (api.permission !== 'default') return api.permission;
    return await api.requestPermission();
  } catch {
    return 'denied';
  }
}

/**
 * A system notification when the viewer allowed them. Browsers that only
 * notify through a service worker (Chrome on Android) throw here; the in-app
 * toast still carries the alert.
 * @returns {boolean} Whether one was shown.
 */
export function showBrowserAlert(
  { title, body, tag },
  api = globalThis.Notification,
) {
  try {
    if (api?.permission !== 'granted') return false;
    new api(title, { body, tag });
    return true;
  } catch {
    return false;
  }
}
