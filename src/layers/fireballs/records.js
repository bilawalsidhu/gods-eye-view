// Pure records for the JPL CNEOS fireball layer, shared by the local proxy
// (server/providers/fireballs.js) and the browser. A portable module: no
// i18n, no renderer.

/** Age bands the markers are coloured by, newest first. */
export const FIREBALL_AGE_BANDS = Object.freeze([
  Object.freeze({ id: 'month', maxDays: 30, color: '#ffb347' }),
  Object.freeze({ id: 'year', maxDays: 365, color: '#ff7a45' }),
  Object.freeze({ id: 'older', maxDays: Infinity, color: '#b0607a' }),
]);

const DAY_MS = 86_400_000;

const number = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/** Milliseconds of a CNEOS `YYYY-MM-DD hh:mm:ss` time (UTC), or null. */
export function parseFireballTime(text) {
  if (typeof text !== 'string') return null;
  const match = /^(\d{4}-\d\d-\d\d)[ T](\d\d:\d\d:\d\d)$/.exec(text.trim());
  if (!match) return null;
  const ms = Date.parse(`${match[1]}T${match[2]}Z`);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The CNEOS fireball API payload as located events, newest first. Rows without
 * a time or a position are skipped; null for a payload that is not the API's
 * `fields` + `data` table.
 * @returns {Array<{id: string, time: number, lat: number, lon: number,
 *   altKm: number|null, velocityKms: number|null,
 *   radiatedEnergy: number|null, impactEnergyKt: number|null}>|null}
 */
export function normalizeFireballs(payload) {
  const fields = payload?.fields;
  const data = payload?.data;
  // An empty answer is `{signature, count: "0"}`, with no table at all.
  if (fields === undefined && data === undefined)
    return payload && String(payload.count) === '0' ? [] : null;
  if (!Array.isArray(fields) || !Array.isArray(data)) return null;
  const at = Object.fromEntries(fields.map((name, index) => [name, index]));
  if (!['date', 'lat', 'lat-dir', 'lon', 'lon-dir'].every((name) => name in at))
    return null;
  const rows = [];
  const seen = new Set();
  for (const row of data) {
    if (!Array.isArray(row)) continue;
    const time = parseFireballTime(row[at.date]);
    const lat = number(row[at.lat]);
    const lon = number(row[at.lon]);
    const latDir = row[at['lat-dir']];
    const lonDir = row[at['lon-dir']];
    if (
      time === null ||
      lat === null ||
      lon === null ||
      !['N', 'S'].includes(latDir) ||
      !['E', 'W'].includes(lonDir) ||
      lat > 90 ||
      lon > 180
    )
      continue;
    const id = String(row[at.date])
      .trim()
      .replace(/[^0-9]/g, '');
    if (seen.has(id)) continue;
    seen.add(id);
    const altKm = 'alt' in at ? number(row[at.alt]) : null;
    const velocityKms = 'vel' in at ? number(row[at.vel]) : null;
    const radiatedEnergy = 'energy' in at ? number(row[at.energy]) : null;
    const impactEnergyKt =
      'impact-e' in at ? number(row[at['impact-e']]) : null;
    rows.push({
      id,
      time,
      lat: latDir === 'S' ? -lat : lat,
      lon: lonDir === 'W' ? -lon : lon,
      altKm: altKm !== null && altKm >= 0 && altKm < 200 ? altKm : null,
      velocityKms: velocityKms !== null && velocityKms > 0 ? velocityKms : null,
      radiatedEnergy:
        radiatedEnergy !== null && radiatedEnergy > 0 ? radiatedEnergy : null,
      impactEnergyKt:
        impactEnergyKt !== null && impactEnergyKt > 0 ? impactEnergyKt : null,
    });
  }
  return rows.sort((a, b) => b.time - a.time);
}

/** The age band an event falls in at `nowMs`. */
export function fireballAgeBand(event, nowMs) {
  const days = (nowMs - event.time) / DAY_MS;
  return (
    FIREBALL_AGE_BANDS.find((band) => days <= band.maxDays) ??
    FIREBALL_AGE_BANDS.at(-1)
  );
}

/**
 * Marker size in CSS pixels by estimated impact energy: 14 px for the
 * smallest (about 0.07 kt), growing by 5 px per tenfold, at most 40 px.
 */
export function fireballMarkerSize(event) {
  const kt = event?.impactEnergyKt;
  if (!(kt > 0)) return 14;
  return Math.round(Math.max(14, Math.min(40, 20 + 5 * Math.log10(kt))));
}

/** Where the layer's data comes from. */
export const FIREBALL_PROVENANCE = Object.freeze({
  provider: 'NASA/JPL Center for Near Earth Object Studies',
  dataset: 'Fireball and bolide reports (U.S. Government sensors)',
  url: 'https://cneos.jpl.nasa.gov/fireballs/',
  license: 'NASA/JPL data; NASA media usage guidelines',
});
