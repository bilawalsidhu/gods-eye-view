/**
 * @file Parsers for the OpenFlights airline source.
 *
 * Used by the offline builder, never at view time. Pure.
 */

import { parseCsv } from '../countries/source.js';

/** OpenFlights writes an absent value as `\N`, `-`, `N/A` or an empty string. */
const absent = (value) => {
  const text = String(value ?? '').trim();
  return text === '' || text === '\\N' || text === '-' || text === 'N/A'
    ? null
    : text;
};

/**
 * Rows of OpenFlights `airlines.dat` (id, name, alias, IATA, ICAO, callsign,
 * country, active) that carry an ICAO designator of exactly three upper-case
 * letters. Each field is trimmed and an absent value becomes null; an IATA code
 * that is not two letters or digits becomes null.
 * @param {string} csv
 * @returns {{id: number, name: string|null, iata: string|null, icao: string,
 *   callsign: string|null, country: string|null, active: boolean}[]}
 */
export function parseOpenFlightsAirlines(csv) {
  const rows = [];
  for (const row of parseCsv(csv)) {
    if (row.length < 8) continue;
    const [id, name, , iata, icao, callsign, country, active] = row;
    const code = absent(icao);
    if (!code || !/^[A-Z]{3}$/.test(code)) continue;
    const iataCode = absent(iata);
    rows.push({
      id: Number(id),
      name: absent(name),
      iata: iataCode && /^[A-Z0-9]{2}$/.test(iataCode) ? iataCode : null,
      icao: code,
      callsign: absent(callsign),
      country: absent(country),
      active: active.trim() === 'Y',
    });
  }
  return rows;
}

/**
 * Collapse rows that share an ICAO designator to one: an active row beats an
 * inactive one, and among equals the lowest id wins. Output is in ICAO order.
 * @param {{id: number, icao: string, active: boolean}[]} rows
 * @returns {{kept: object[], collapsed: number}}
 */
export function dedupeByIcao(rows) {
  const best = new Map();
  for (const row of rows) {
    const current = best.get(row.icao);
    if (
      !current ||
      (row.active && !current.active) ||
      (row.active === current.active && row.id < current.id)
    )
      best.set(row.icao, row);
  }
  const kept = [...best.values()].sort((a, b) =>
    a.icao < b.icao ? -1 : a.icao > b.icao ? 1 : 0,
  );
  return { kept, collapsed: rows.length - kept.length };
}
