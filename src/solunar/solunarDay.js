/**
 * Solunar facts for ONE local calendar day at a spot: sun and moon rise, set
 * and transit, moon phase, the major/minor feeding windows and the day
 * rating. Pure functions of (spot, date); astronomy-engine does the sky math
 * (MIT, pinned exact in package.json); no DOM, no network, no key.
 *
 * Day rule (the fix for the "borrowed next day's moonrise" bug): an event
 * belongs to a day only when its instant lies inside [local midnight, next
 * local midnight) in the spot's zone. A day without a moonrise or moonset has
 * an EMPTY list for it, and the UI shows "none"; the next day's event is
 * never copied in. A day can have two events of one kind only on a 25-hour
 * (clock-back) day; both are returned.
 */
import {
  Body,
  Illumination,
  MakeTime,
  MoonPhase,
  Observer,
  SearchHourAngle,
  SearchMoonPhase,
  SearchRiseSet,
} from 'astronomy-engine';
import {
  DAY_MS,
  addDays,
  dateKey,
  localDateOf,
  localDayStartMs,
  zoneAt,
} from './zone.js';
import { rateDay } from './rating.js';

const MIN_MS = 60_000;
export const MAJOR_HALF_MS = 60 * MIN_MS; // major window = transit +/- 1 h (2 h)
export const MINOR_HALF_MS = 30 * MIN_MS; // minor window = rise/set +/- 30 min (1 h)

/** Rises (dir +1) or sets (dir -1) whose instant is in [startMs, endMs). */
function riseSetsIn(body, observer, dir, startMs, endMs) {
  const out = [];
  let from = startMs;
  for (let guard = 0; guard < 4 && from < endMs; guard++) {
    const found = SearchRiseSet(
      body,
      observer,
      dir,
      MakeTime(new Date(from)),
      (endMs - from) / DAY_MS,
    );
    if (!found) break;
    const ms = found.date.getTime();
    if (ms >= endMs) break;
    if (ms >= startMs) out.push(ms);
    from = Math.max(from, ms) + MIN_MS;
  }
  return out;
}

/** Meridian crossings (hourAngle 0 = upper, 12 = lower) in [startMs, endMs). */
function transitsIn(body, observer, hourAngle, startMs, endMs) {
  const out = [];
  let from = startMs;
  for (let guard = 0; guard < 4 && from < endMs; guard++) {
    let ms;
    try {
      ms = SearchHourAngle(
        body,
        observer,
        hourAngle,
        MakeTime(new Date(from)),
        +1,
      ).time.date.getTime();
    } catch {
      break; // no crossing found: the row says "none" instead of blanking the card
    }
    if (ms >= endMs) break;
    if (ms >= startMs) out.push(ms);
    from = Math.max(from, ms) + MIN_MS;
  }
  return out;
}

/** An elongation this close to 0/90/180/270 deg (about 12 h) names the principal phase. */
const PRINCIPAL_DEG = 6;

/**
 * The eight common phase names from the Moon's elongation (0 = new): crescent
 * below half lit, gibbous above half, and New / Quarter / Full only within
 * about half a day of the exact moment (the way USNO labels a day).
 */
export function phaseName(elongationDeg) {
  const e = ((elongationDeg % 360) + 360) % 360;
  const near = (target) => Math.abs(e - target) <= PRINCIPAL_DEG;
  if (e <= PRINCIPAL_DEG || e >= 360 - PRINCIPAL_DEG) return 'New Moon';
  if (near(90)) return 'First Quarter';
  if (near(180)) return 'Full Moon';
  if (near(270)) return 'Last Quarter';
  if (e < 90) return 'Waxing Crescent';
  if (e < 180) return 'Waxing Gibbous';
  if (e < 270) return 'Waning Gibbous';
  return 'Waning Crescent';
}

/** Days from `atMs` to the nearest exact new or full moon (searched, not averaged). */
export function daysFromSyzygy(atMs) {
  const from = MakeTime(new Date(atMs - 8 * DAY_MS));
  let best = Infinity;
  for (const lon of [0, 180]) {
    const hit = SearchMoonPhase(lon, from, 16);
    if (hit) best = Math.min(best, Math.abs(hit.date.getTime() - atMs));
  }
  return best / DAY_MS;
}

const windowAround = (kind, source, ms, half) => ({
  kind,
  source,
  centerMs: ms,
  startMs: ms - half,
  endMs: ms + half,
});

/**
 * @param {{latDeg:number, lonDeg:number, zone?:string}} spot
 * @param {{year:number, month:number, day:number}} date local calendar date
 */
export function solunarDay(spot, date) {
  const { latDeg, lonDeg } = spot;
  const zone = spot.zone || zoneAt(latDeg, lonDeg);
  const observer = new Observer(latDeg, lonDeg, 0);
  const startMs = localDayStartMs(zone, date.year, date.month, date.day);
  const next = addDays(date, 1);
  const endMs = localDayStartMs(zone, next.year, next.month, next.day);

  const sunrise = riseSetsIn(Body.Sun, observer, +1, startMs, endMs);
  const sunset = riseSetsIn(Body.Sun, observer, -1, startMs, endMs);
  const sunTransit = transitsIn(Body.Sun, observer, 0, startMs, endMs);
  const moonrise = riseSetsIn(Body.Moon, observer, +1, startMs, endMs);
  const moonset = riseSetsIn(Body.Moon, observer, -1, startMs, endMs);
  const moonUpper = transitsIn(Body.Moon, observer, 0, startMs, endMs);
  const moonLower = transitsIn(Body.Moon, observer, 12, startMs, endMs);

  const noon = MakeTime(new Date(startMs + (endMs - startMs) / 2));
  const elongationDeg = MoonPhase(noon);
  const windows = [
    ...moonUpper.map((ms) => windowAround('major', 'upper', ms, MAJOR_HALF_MS)),
    ...moonLower.map((ms) => windowAround('major', 'lower', ms, MAJOR_HALF_MS)),
    ...moonrise.map((ms) => windowAround('minor', 'rise', ms, MINOR_HALF_MS)),
    ...moonset.map((ms) => windowAround('minor', 'set', ms, MINOR_HALF_MS)),
  ].sort((a, b) => a.startMs - b.startMs);

  const base = {
    date: dateKey(date),
    zone,
    latDeg,
    lonDeg,
    startMs,
    endMs,
    sunrise,
    sunset,
    sunTransit,
    moonrise,
    moonset,
    moonUpper,
    moonLower,
    elongationDeg,
    phase: phaseName(elongationDeg),
    illumination: Illumination(Body.Moon, noon).phase_fraction,
    daysFromSyzygy: daysFromSyzygy(noon.date.getTime()),
    windows,
  };
  return { ...base, ...rateDay(base) };
}

/** The next `count` local days (today first) at a spot. */
export function solunarWeek(spot, nowMs, count = 7) {
  const zone = spot.zone || zoneAt(spot.latDeg, spot.lonDeg);
  const today = localDateOf(zone, nowMs);
  return Array.from({ length: count }, (_, i) =>
    solunarDay({ ...spot, zone }, addDays(today, i)),
  );
}
