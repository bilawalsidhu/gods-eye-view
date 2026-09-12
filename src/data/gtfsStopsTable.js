/**
 * GTFS `stops.txt` → `stop_id` → position.
 *
 * The Dutch train feed places nothing itself; the stop table is what turns a
 * predicted arrival at a stop id into a point on the globe.
 *
 * Pure parsing: the archive fetch lives in gtfsZipMember.js.
 */
import { splitCsvLine } from './gtfsRouteTypes.js';

/**
 * @param {string} text - Full stops.txt contents.
 * @returns {Map<string,{lat:number, lon:number, name:string}>}
 */
export function parseStopsTxt(text) {
  const table = new Map();
  const lines = String(text ?? '').split(/\r?\n/);
  if (lines.length < 2) return table;
  const header = splitCsvLine(lines[0]).map((h) => h.trim().replace(/^﻿/, ''));
  const idAt = header.indexOf('stop_id');
  const latAt = header.indexOf('stop_lat');
  const lonAt = header.indexOf('stop_lon');
  const nameAt = header.indexOf('stop_name');
  if (idAt === -1 || latAt === -1 || lonAt === -1) return table;

  for (let i = 1; i < lines.length; i += 1) {
    if (!lines[i]) continue;
    const cells = splitCsvLine(lines[i]);
    const id = (cells[idAt] ?? '').trim();
    if (!id) continue;
    // Number('') is 0, a perfectly finite coordinate off the coast of Ghana,
    // so a blank cell has to be rejected before the conversion rather than by
    // a range check after it.
    const latRaw = (cells[latAt] ?? '').trim();
    const lonRaw = (cells[lonAt] ?? '').trim();
    if (!latRaw || !lonRaw) continue;
    const lat = Number(latRaw);
    const lon = Number(lonRaw);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    // 0,0 is the null island every bad export lands on, and no stop is there.
    if (lat === 0 && lon === 0) continue;
    table.set(id, { lat, lon, name: nameAt === -1 ? '' : (cells[nameAt] ?? '').trim() });
  }
  return table;
}
