import {
  classifyRiverLevel,
  cleanReferences,
} from '../../../src/layers/riverLevels/model.js';
import { twd97ToWgs84 } from './twd97.js';

/**
 * Taiwan's Water Resources Agency (MOEA) open data, keyless, published under
 * the Open Government Data License, version 1.0:
 * - river gauge register (河川水位測站站況): position in TWD97 TM2 metres and
 *   the three alert levels (一級/二級/三級警戒水位), level 1 the most severe;
 * - real-time water level (即時水位資料): the newest 10-minute reading per
 *   gauge, raw and not quality controlled, in metres, local time (UTC+8).
 */
export const WRA_STATIONS_URL =
  'https://opendata.wra.gov.tw/api/v2/c4acc691-7416-40ca-9464-292c0c00da92?format=JSON';
export const WRA_REALTIME_URL =
  'https://opendata.wra.gov.tw/api/v2/73c4c3de-4045-4765-abeb-89f9f9cd5ff0?format=JSON';

const CODE = /^[0-9A-Z]{4,12}$/;
/** Taiwan main island and its near islets, with margin. */
const IN_TAIWAN = ({ lat, lon }) =>
  lat > 21.7 && lat < 25.5 && lon > 119.9 && lon < 122.2;

/**
 * Register rows still in service, keyed by gauge code, with position and
 * cleaned alert levels. Retired gauges (已廢) are dropped.
 * @param {Array<object>} rows
 * @returns {Map<string, object>}
 */
export function normalizeWraRegister(rows) {
  if (!Array.isArray(rows)) throw new Error('invalid_register');
  const out = new Map();
  for (const row of rows) {
    const code = String(row?.basinidentifier || '').toUpperCase();
    if (!CODE.test(code) || row.observationstatus === '已廢') continue;
    const [x, y] = String(row.locationbytwd97_xy || '')
      .trim()
      .split(/\s+/)
      .map(Number);
    const position = twd97ToWgs84(x, y);
    if (!position || !IN_TAIWAN(position)) continue;
    out.set(code, {
      code,
      name:
        String(row.englishname || '').trim() ||
        String(row.observatoryname || ''),
      nativeName: String(row.observatoryname || '').trim() || null,
      river:
        String(row.englishrivername || '').trim() ||
        String(row.rivername || '').trim(),
      lat: position.lat,
      lon: position.lon,
      refs: cleanReferences({
        watch: row.alertlevel3,
        warning: row.alertlevel2,
        flood: row.alertlevel1,
      }),
    });
  }
  return out;
}

/** "2026-11-05T04:40:00" in Taiwan time → epoch ms. */
function taiwanTime(text) {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?)$/.exec(
    String(text || ''),
  );
  return match ? Date.parse(`${match[1]}+08:00`) : NaN;
}

/**
 * Join the newest readings to the register.
 * @param {Map<string, object>} register From normalizeWraRegister.
 * @param {Array<object>} rows Real-time rows.
 * @returns {Array<object>} Shared station shape.
 */
export function normalizeWraReadings(register, rows) {
  if (!Array.isArray(rows)) throw new Error('invalid_snapshot');
  const newest = new Map();
  for (const row of rows) {
    if (String(row?.checkresult) !== 'true') continue;
    const code = String(row.stationid || '').toUpperCase();
    const meta = register.get(code);
    if (!meta) continue;
    const level =
      row.waterlevel === null || row.waterlevel === ''
        ? NaN
        : Number(row.waterlevel);
    const observedMs = taiwanTime(row.datetime);
    // -99 and lower are the network's "no value" sentinels.
    if (!Number.isFinite(level) || level <= -99 || !Number.isFinite(observedMs))
      continue;
    const previous = newest.get(code);
    if (previous && previous.observedMs >= observedMs) continue;
    newest.set(code, {
      id: `wra:${code}`,
      provider: 'wra',
      code,
      name: meta.name,
      nativeName: meta.nativeName,
      river: meta.river,
      lat: meta.lat,
      lon: meta.lon,
      level,
      observedMs,
      refs: meta.refs,
      band: classifyRiverLevel(level, meta.refs),
    });
  }
  return [...newest.values()];
}
