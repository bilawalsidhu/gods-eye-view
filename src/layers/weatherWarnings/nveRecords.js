/**
 * Normalize NVE/Varsom flood, landslide and avalanche warnings into the same
 * row shape as MET warnings (see records.js). Pure: the caller supplies the
 * clock and resolves municipality geometry, which NVE does not publish.
 */

const NVE_LEVELS = Object.freeze({ 2: 'yellow', 3: 'orange', 4: 'red' });
const AVALANCHE_LEVELS = Object.freeze({
  2: 'yellow',
  3: 'orange',
  4: 'red',
  5: 'red',
});
const AVALANCHE_NAMES = Object.freeze({
  2: 'moderate',
  3: 'considerable',
  4: 'high',
  5: 'very high',
});
const NVE_EVENTS = Object.freeze({ flood: 'Flood', landslide: 'Landslide' });
export const VARSOM_LINKS = Object.freeze({
  flood: 'https://www.varsom.no/en/flood-and-landslide-warning-service/',
  landslide: 'https://www.varsom.no/en/flood-and-landslide-warning-service/',
  avalanche: 'https://www.varsom.no/en/avalanche-bulletins/',
});
const MAX_AREA_NAMES = 3;

const text = (value) =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

const osloOffsetFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Europe/Oslo',
  timeZoneName: 'shortOffset',
});

/** Minutes Oslo is ahead of UTC at an instant ("GMT+2" → 120). */
function osloOffsetMinutes(ms) {
  const name = osloOffsetFormat
    .formatToParts(new Date(ms))
    .find((part) => part.type === 'timeZoneName')?.value;
  const match = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(name ?? '');
  if (!match) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3] ?? 0);
  return match[1] === '-' ? -minutes : minutes;
}

/**
 * Epoch milliseconds of an NVE timestamp. NVE writes Norwegian wall-clock
 * time without an offset ("2025-10-04T07:00:00"); explicit offsets win.
 * @param {string} value
 * @returns {number | null}
 */
export function osloLocalMs(value) {
  if (typeof value !== 'string') return null;
  if (/(Z|[+-]\d{2}:\d{2})$/.test(value)) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/.exec(
      value,
    );
  if (!match) return null;
  const [, y, mo, d, h, mi, s = '0'] = match;
  const wall = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  // Refine once so instants next to a DST switch use their own offset.
  let ms = wall - osloOffsetMinutes(wall) * 60_000;
  ms = wall - osloOffsetMinutes(ms) * 60_000;
  return Number.isFinite(ms) ? ms : null;
}

/** "Gran, Lunner, Jevnaker +2" from municipality names. */
function areaLabel(names) {
  const unique = [...new Set(names.filter(Boolean))];
  if (unique.length <= MAX_AREA_NAMES) return unique.join(', ') || null;
  return `${unique.slice(0, MAX_AREA_NAMES).join(', ')} +${unique.length - MAX_AREA_NAMES}`;
}

/**
 * Group NVE's one-record-per-municipality feed into one row per warning,
 * keeping only yellow-or-higher warnings in effect at `nowMs`.
 * @param {Array<object>} records `Warning/All` response.
 * @param {'flood' | 'landslide'} kind
 * @param {number} nowMs
 * @returns {Array<object>} Rows with `municipalities` (ids) and no polygons yet.
 */
export function groupNveWarnings(records, kind, nowMs) {
  if (!Array.isArray(records)) return null;
  const byId = new Map();
  for (const record of records) {
    const level = NVE_LEVELS[Number(record?.ActivityLevel)];
    if (!level) continue;
    const onset = osloLocalMs(record.ValidFrom);
    const expires = osloLocalMs(record.ValidTo);
    if (onset === null || expires === null) continue;
    if (onset > nowMs || expires <= nowMs) continue;
    const id = text(String(record.Id ?? ''));
    if (!id) continue;
    const key = `nve-${kind}:${id}`;
    let row = byId.get(key);
    if (!row) {
      row = {
        stableId: key,
        source: kind,
        level,
        event: kind,
        eventName: NVE_EVENTS[kind],
        area: null,
        domain: 'land',
        severity: null,
        certainty: null,
        description: text(record.ConsequenceText) ?? text(record.MainText),
        instruction: text(record.AdviceText),
        consequences: null,
        web: VARSOM_LINKS[kind],
        onset,
        expires,
        municipalities: [],
        municipalityNames: [],
      };
      byId.set(key, row);
    }
    for (const municipality of record.MunicipalityList ?? []) {
      const number = String(municipality?.Id ?? '');
      if (!/^\d{4}$/.test(number) || row.municipalities.includes(number))
        continue;
      row.municipalities.push(number);
      row.municipalityNames.push(text(municipality.Name));
    }
  }
  const rows = [];
  for (const { municipalityNames, ...row } of byId.values()) {
    if (!row.municipalities.length) continue;
    rows.push({ ...row, area: areaLabel(municipalityNames) });
  }
  return rows;
}

/**
 * Parse a Varsom region polygon: space-separated "lat,lon" pairs.
 * @param {string} value
 * @returns {Array<[number, number]> | null} Closed [lon, lat] ring.
 */
export function parseVarsomRing(value) {
  if (typeof value !== 'string') return null;
  const ring = [];
  for (const pair of value.trim().split(/\s+/)) {
    const [lat, lon] = pair.split(',').map(Number);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    ring.push([lon, lat]);
  }
  if (ring.length < 3) return null;
  const [first, last] = [ring[0], ring[ring.length - 1]];
  if (first[0] !== last[0] || first[1] !== last[1]) ring.push([...first]);
  return ring;
}

/**
 * Avalanche region polygons by region id from the Varsom `Region` endpoint.
 * @param {Array<object>} regions
 * @returns {Map<number, Array<Array<Array<[number, number]>>>>}
 */
export function avalancheRegionPolygons(regions) {
  const result = new Map();
  for (const region of Array.isArray(regions) ? regions : []) {
    const polygons = (Array.isArray(region?.Polygon) ? region.Polygon : [])
      .map(parseVarsomRing)
      .filter(Boolean)
      .map((ring) => [ring]);
    if (Number.isFinite(region?.Id) && polygons.length)
      result.set(region.Id, polygons);
  }
  return result;
}

/**
 * Avalanche danger level 2+ in effect at `nowMs`, one row per region.
 * @param {Array<object>} summary `RegionSummary/Simple` response.
 * @param {Map<number, Array>} polygonsByRegion From `avalancheRegionPolygons`.
 * @param {number} nowMs
 * @returns {Array<object> | null}
 */
export function normalizeAvalancheWarnings(summary, polygonsByRegion, nowMs) {
  if (!Array.isArray(summary)) return null;
  const rows = [];
  for (const region of summary) {
    const polygons = polygonsByRegion.get(region?.Id);
    if (!polygons) continue;
    for (const warning of region.AvalancheWarningList ?? []) {
      const danger = Number(warning?.DangerLevel);
      const level = AVALANCHE_LEVELS[danger];
      if (!level) continue;
      const onset = osloLocalMs(warning.ValidFrom);
      const expires = osloLocalMs(warning.ValidTo);
      if (onset === null || expires === null) continue;
      if (onset > nowMs || expires <= nowMs) continue;
      rows.push({
        stableId: `varsom-avalanche:${region.Id}:${warning.ValidFrom}`,
        source: 'avalanche',
        level,
        event: 'avalanche',
        eventName: `Avalanche danger ${danger} (${AVALANCHE_NAMES[danger]})`,
        area: text(warning.RegionName) ?? text(region.Name),
        domain: 'land',
        severity: null,
        certainty: null,
        description: text(warning.MainText),
        instruction: null,
        consequences: null,
        web: VARSOM_LINKS.avalanche,
        onset,
        expires,
        polygons,
      });
      break;
    }
  }
  return rows;
}
