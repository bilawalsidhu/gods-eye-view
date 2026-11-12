/**
 * Solunar card owner: the next 7 local days at one map spot. It computes the
 * days with the sky math (solunarDay.js) and publishes a plain presentation
 * for the card view to render; the 12 h / 24 h choice and "Use map centre"
 * come back through the store's controls. Everything is computed in the
 * browser; no outside data feed and no key.
 */
import { getLocale } from '../i18n/index.js';
import { solunarWeek } from './solunarDay.js';
import {
  BAND_HALF_MS,
  CLOSE_SYZYGY_DAYS,
  MAX_STARS,
  NEAR_SYZYGY_DAYS,
} from './rating.js';
import { zoneAt } from './zone.js';

export const HOUR12_STORAGE_KEY = 'gev:solunar:hour12:v1';
export const WEEK_DAYS = 7;

/** The locale's own clock style until the user picks one. */
export function defaultHour12() {
  try {
    return (
      new Intl.DateTimeFormat(getLocale(), {
        hour: 'numeric',
      }).resolvedOptions().hour12 === true
    );
  } catch {
    return true;
  }
}

function readHour12(storage) {
  try {
    const v = storage?.getItem(HOUR12_STORAGE_KEY);
    if (v === '12') return true;
    if (v === '24') return false;
  } catch {
    /* private mode: use the default */
  }
  return defaultHour12();
}

/** The rating rule the card prints under the week. */
const RULE = Object.freeze({
  near: NEAR_SYZYGY_DAYS,
  close: CLOSE_SYZYGY_DAYS,
  hours: BAND_HALF_MS / 3_600_000,
  maxStars: MAX_STARS,
});

/**
 * The card owner. It holds the spot and the clock style, publishes what the
 * card shows and answers the card's controls.
 * @param {{store: object, now?: () => number, storage?: object,
 *   onUseCenter?: () => void}} options
 *   `store` is the card store (src/ui/stores/solunar.js); it takes the plain
 *   presentation and the controls the view calls.
 */
export function createSolunarPanel({
  store,
  now = () => Date.now(),
  storage = globalThis.localStorage,
  onUseCenter = () => {},
} = {}) {
  if (!store?.publish) throw new TypeError('createSolunarPanel needs a store');
  let spot = null;
  let hour12 = readHour12(storage);
  let destroyed = false;

  const presentation = () => {
    if (!spot) return { spot: null, hour12, days: [], rule: RULE };
    const zone = spot.zone || zoneAt(spot.latDeg, spot.lonDeg);
    const week = solunarWeek({ ...spot, zone }, now(), WEEK_DAYS);
    return {
      spot: { latDeg: spot.latDeg, lonDeg: spot.lonDeg, zone },
      hour12,
      rule: RULE,
      days: week.map((day) => ({
        date: day.date,
        startMs: day.startMs,
        endMs: day.endMs,
        phase: day.phase,
        illumination: day.illumination,
        huntingStars: day.huntingStars,
        fishingStars: day.fishingStars,
        sunrise: day.sunrise,
        sunset: day.sunset,
        moonrise: day.moonrise,
        moonset: day.moonset,
        moonUpper: day.moonUpper,
        moonLower: day.moonLower,
        windows: day.windows.map((window) => ({
          kind: window.kind,
          source: window.source,
          startMs: window.startMs,
          endMs: window.endMs,
        })),
      })),
    };
  };

  const publish = () => {
    if (destroyed) return;
    store.publish(presentation());
  };

  const setHour12 = (value) => {
    hour12 = Boolean(value);
    try {
      storage?.setItem(HOUR12_STORAGE_KEY, hour12 ? '12' : '24');
    } catch {
      /* not persisted */
    }
    publish();
  };

  store.connect({ setHour12, useCenter: () => onUseCenter() });
  publish();

  return {
    /** Show the week for a spot. */
    setSpot(latDeg, lonDeg, source = 'click') {
      if (!Number.isFinite(latDeg) || !Number.isFinite(lonDeg)) return false;
      spot = {
        latDeg,
        lonDeg,
        source,
        zone: zoneAt(latDeg, lonDeg),
      };
      publish();
      return true;
    },
    getSpot: () => (spot ? { ...spot } : null),
    getHour12: () => hour12,
    refresh: publish,
    destroy() {
      destroyed = true;
      store.connect(null);
      store.publish(null);
    },
  };
}
