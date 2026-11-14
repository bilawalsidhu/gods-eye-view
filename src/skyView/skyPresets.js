/**
 * Sky time presets: Sunset, End of twilight, Midnight,
 * Moonrise (astronomy-engine searches) and Next ISS pass start.
 *
 * Every search runs FORWARD from the current Sky time, so pressing a preset
 * twice walks to the next day's event. Definitions (also in the button
 * titles):
 *   sunset    upper limb of the Sun touches the sea-level horizon with
 *             standard refraction (astronomy-engine SearchRiseSet); the
 *             apparent altitude of the Sun's centre is then about -0.2 deg
 *   dusk      end of astronomical twilight: Sun's centre descends through
 *             -18 deg (no refraction, by convention)
 *   midnight  solar midnight: the Sun's lower transit (hour angle 12 h);
 *             no time-zone service is used, so this is not 00:00 on a clock
 *   moonrise  upper limb of the Moon rises (SearchRiseSet, +1)
 *   iss       start of the next ISS pass above 10 deg (findNextSatellitePass
 *             on the ISS elements, or the passes engine when present)
 */
import {
  Body,
  MakeTime,
  Observer,
  SearchAltitude,
  SearchHourAngle,
  SearchRiseSet,
} from 'astronomy-engine';
import { twoline2satrec } from 'satellite.js';
import { msg } from '../i18n/marker.js';
import { findNextSatellitePass } from '../data/satellitePass.js';
import { noradIdFromSatnum, parseTleText } from '../sources/tle.js';

export const ISS_NORAD = 25544;
/** Search windows (days) before a preset reports "not found". */
export const SEARCH_DAYS = 2;
export const ISS_SEARCH_HOURS = 48;
export const ISS_MIN_ELEV_DEG = 10;
export const TWILIGHT_END_DEG = -18;

export const PRESETS = Object.freeze([
  {
    id: 'sunset',
    label: msg('Sunset'),
    title: msg('Next sunset (top of the Sun on the horizon, with refraction)'),
  },
  {
    id: 'dusk',
    label: msg('Twilight end'),
    title: msg('End of astronomical twilight (Sun 18° below the horizon)'),
  },
  {
    id: 'midnight',
    label: msg('Midnight'),
    title: msg('Solar midnight (the Sun at its lowest)'),
  },
  {
    id: 'moonrise',
    label: msg('Moonrise'),
    title: msg('Next moonrise'),
  },
  {
    id: 'iss',
    label: msg('ISS pass'),
    title: msg('Start of the next ISS pass above 10°'),
  },
]);

const NOT_FOUND = {
  sunset: 'The Sun does not set here in the next 2 days.',
  dusk: 'Astronomical twilight does not end here in the next 2 days (the Sun stays above -18°).',
  midnight: 'No solar midnight found.',
  moonrise: 'The Moon does not rise here in the next 2 days.',
};

const asAstroObserver = ({ latDeg, lonDeg, groundHeightM = 0 }) =>
  new Observer(
    latDeg,
    lonDeg,
    Number.isFinite(groundHeightM) ? groundHeightM : 0,
  );

/**
 * Astronomical preset time (pure, synchronous).
 * @returns {{ ok: true, timeMs: number } | { ok: false, reason: string }}
 */
export function astronomicalPreset(id, fromMs, observer) {
  if (
    !observer ||
    !Number.isFinite(observer.latDeg) ||
    !Number.isFinite(observer.lonDeg) ||
    !Number.isFinite(fromMs)
  )
    return { ok: false, reason: 'Choose where you stand first.' };
  const obs = asAstroObserver(observer);
  // one minute ahead, so pressing a preset at its own event walks on to the
  // next one instead of finding the same instant again
  const start = MakeTime(new Date(fromMs + 60_000));
  let found = null;
  try {
    if (id === 'sunset')
      found = SearchRiseSet(Body.Sun, obs, -1, start, SEARCH_DAYS, 0);
    else if (id === 'dusk')
      found = SearchAltitude(
        Body.Sun,
        obs,
        -1,
        start,
        SEARCH_DAYS,
        TWILIGHT_END_DEG,
      );
    else if (id === 'midnight')
      found = SearchHourAngle(Body.Sun, obs, 12, start, +1)?.time ?? null;
    else if (id === 'moonrise')
      found = SearchRiseSet(Body.Moon, obs, +1, start, SEARCH_DAYS, 0);
    else return { ok: false, reason: `Unknown preset ${id}.` };
  } catch {
    found = null;
  }
  const ms = found?.date?.getTime?.();
  if (!Number.isFinite(ms)) return { ok: false, reason: NOT_FOUND[id] };
  return { ok: true, timeMs: ms };
}

/**
 * Next ISS pass start from the ISS elements (stations group, the same
 * same-origin /api/celestrak endpoint the satellites use; the server cache
 * applies). Elements are parsed once per text.
 * @param {object} options
 *   fetchText(path) -> Promise<string>   TLE text for a group
 */
export function createIssPassFinder({
  fetchText,
  findPass = findNextSatellitePass,
} = {}) {
  let cached = null; // { text, satrec }
  async function satrec() {
    const text = await fetchText('stations');
    if (cached?.text === text) return cached.satrec;
    const row = parseTleText(text).find(
      (r) => noradIdFromSatnum(r.line1.slice(2, 7)) === ISS_NORAD,
    );
    const rec = row ? twoline2satrec(row.line1, row.line2) : null;
    cached = { text, satrec: rec && !rec.error ? rec : null };
    return cached.satrec;
  }
  /** @returns {Promise<{ok:true,timeMs,pass}|{ok:false,reason}>} */
  return async function nextIssPass(fromMs, observer) {
    if (!observer)
      return { ok: false, reason: 'Choose where you stand first.' };
    let rec;
    try {
      rec = await satrec();
    } catch {
      return {
        ok: false,
        reason:
          'ISS elements could not be loaded (satellite data unavailable).',
      };
    }
    if (!rec)
      return { ok: false, reason: 'No ISS elements in the satellite data.' };
    const search = (from) =>
      findPass({
        satrec: rec,
        latDeg: observer.latDeg,
        lonDeg: observer.lonDeg,
        fromMs: from,
        minElevDeg: ISS_MIN_ELEV_DEG,
        horizonHours: ISS_SEARCH_HOURS,
        coarseStepSec: 30,
        fineStepSec: 5,
      });
    let pass = search(fromMs);
    // already inside a pass (or at its start, after pressing the preset):
    // the NEXT pass is the one after this one sets
    if (pass && pass.riseMs <= fromMs + 5000 && Number.isFinite(pass.setMs))
      pass = search(pass.setMs + 1000);
    const riseMs = pass?.riseMs;
    if (!Number.isFinite(riseMs))
      return {
        ok: false,
        reason: `No ISS pass above ${ISS_MIN_ELEV_DEG}° here in the next ${ISS_SEARCH_HOURS} h.`,
      };
    return { ok: true, timeMs: riseMs, pass };
  };
}

/** Preset by id: astronomical ones synchronously, the ISS one async. */
export async function presetTime(id, fromMs, observer, { nextIssPass } = {}) {
  if (id !== 'iss') return astronomicalPreset(id, fromMs, observer);
  if (typeof nextIssPass !== 'function')
    return { ok: false, reason: 'ISS passes are not available here.' };
  try {
    return await nextIssPass(fromMs, observer);
  } catch {
    return { ok: false, reason: 'The ISS pass search failed.' };
  }
}
