/**
 * Historic fire event scaffolding — pure helpers behind
 * scripts/fire-event-scaffold.mjs. Given an incident name and year they
 * build the NIFC candidate query, rank what came back, derive the event
 * window and box, and assemble a config entry that passes the same
 * validation the proxy applies. No network, no filesystem.
 */
import {
  FIRE_PERIMETER_SERVICES,
  formatUtcDay,
  normalizeFireEvent,
  parseUtcDay,
} from './fireHistoryEvents.js';

const DAY_MS = 86_400_000;
/** Fallback window length when no containment/out date is published. */
export const DEFAULT_WINDOW_DAYS = 30;
/** Box padding: fraction of the larger side, with a floor in degrees. */
export const BBOX_PAD_FRACTION = 0.12;
export const BBOX_PAD_MIN_DEG = 0.02;

const sqlText = (value) => `'${String(value).replace(/'/g, "''")}'`;

/**
 * Which NIFC service to search for a given year: WFIGS carries incidents
 * from about 2020 on; the history view carries final perimeters back to
 * the 1900s (with sparse attributes).
 * @param {number} year
 * @returns {'wfigs'|'nifc-history'}
 */
export function defaultServiceForYear(year) {
  return Number(year) >= 2020 ? 'wfigs' : 'nifc-history';
}

/**
 * Archive sources that existed for a year (standard-processing products).
 * @param {number} year
 * @returns {string[]}
 */
export function sourcesForYear(year) {
  const y = Number(year);
  const sources = [];
  if (y >= 2012) sources.push('VIIRS_SNPP_SP');
  if (y >= 2020) sources.push('VIIRS_NOAA20_SP');
  if (y >= 2024) sources.push('VIIRS_NOAA21_SP');
  sources.push('MODIS_SP');
  return sources;
}

/**
 * Candidate query (attributes only) for an incident name and year.
 * @param {{name: string, year: number, state?: string, service?: string}} input
 * @returns {{service: string, url: string}}
 */
export function candidateQueryUrl({ name, year, state, service }) {
  const serviceId = service || defaultServiceForYear(year);
  const svc = FIRE_PERIMETER_SERVICES[serviceId];
  if (!svc) throw new Error(`Unknown perimeter service: ${serviceId}`);
  const y = Number(year);
  const where = [];
  let outFields;
  if (serviceId === 'wfigs') {
    where.push(
      `UPPER(attr_IncidentName)=${sqlText(String(name).toUpperCase())}`,
    );
    where.push(
      `attr_FireDiscoveryDateTime >= timestamp ${sqlText(`${y}-01-01`)}`,
      `attr_FireDiscoveryDateTime < timestamp ${sqlText(`${y + 1}-01-01`)}`,
    );
    if (state) where.push(`attr_POOState=${sqlText(state)}`);
    outFields = [
      'OBJECTID',
      'attr_IncidentName',
      'attr_POOState',
      'attr_POOCounty',
      'attr_UniqueFireIdentifier',
      'attr_FireDiscoveryDateTime',
      'attr_ContainmentDateTime',
      'attr_FireOutDateTime',
      'poly_GISAcres',
      'poly_DateCurrent',
    ];
  } else {
    where.push(`UPPER(INCIDENT)=${sqlText(String(name).toUpperCase())}`);
    where.push(`FIRE_YEAR=${sqlText(String(y))}`);
    outFields = [
      'OBJECTID',
      'INCIDENT',
      'FIRE_YEAR',
      'GIS_ACRES',
      'UNIT_ID',
      'AGENCY',
      'SOURCE',
      'DATE_CUR',
    ];
  }
  const params = new URLSearchParams({
    where: where.join(' AND '),
    outFields: outFields.join(','),
    returnGeometry: 'false',
    f: 'json',
  });
  return { service: serviceId, url: `${svc.url}?${params}` };
}

/**
 * Extent-only query for one candidate, in WGS84.
 * @param {string} serviceId
 * @param {number} objectId
 * @returns {string}
 */
export function extentQueryUrl(serviceId, objectId) {
  const svc = FIRE_PERIMETER_SERVICES[serviceId];
  if (!svc) throw new Error(`Unknown perimeter service: ${serviceId}`);
  const params = new URLSearchParams({
    where: `OBJECTID=${Math.trunc(Number(objectId))}`,
    returnExtentOnly: 'true',
    outSR: '4326',
    f: 'json',
  });
  return `${svc.url}?${params}`;
}

/** DATE_CUR arrives as YYYYMMDD (number or string); → epoch ms or null. */
export function parseCompactDay(value) {
  const text = String(value ?? '').trim();
  if (!/^\d{8}$/.test(text)) return null;
  const ms = parseUtcDay(
    `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`,
  );
  return Number.isFinite(ms) ? ms : null;
}

const msOrNull = (value) =>
  Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null;

/**
 * Normalize service features into comparable candidates, largest first.
 * @param {*} payload - ArcGIS JSON response.
 * @param {string} serviceId
 * @returns {Array<object>}
 */
export function rankCandidates(payload, serviceId) {
  const features = Array.isArray(payload?.features) ? payload.features : [];
  const candidates = features
    .map(({ attributes: a = {} }) =>
      serviceId === 'wfigs'
        ? {
            objectId: a.OBJECTID,
            name: a.attr_IncidentName || '',
            state: a.attr_POOState || null,
            county: a.attr_POOCounty || null,
            uniqueId: a.attr_UniqueFireIdentifier || null,
            unitId: null,
            acres: msOrNull(a.poly_GISAcres),
            discoveryMs: msOrNull(a.attr_FireDiscoveryDateTime),
            containmentMs: msOrNull(a.attr_ContainmentDateTime),
            outMs: msOrNull(a.attr_FireOutDateTime),
            currentMs: msOrNull(a.poly_DateCurrent),
          }
        : {
            objectId: a.OBJECTID,
            name: a.INCIDENT || '',
            state: null,
            county: null,
            uniqueId: null,
            unitId: a.UNIT_ID || null,
            agency: a.AGENCY || a.SOURCE || null,
            acres: msOrNull(a.GIS_ACRES),
            discoveryMs: null,
            containmentMs: null,
            outMs: null,
            currentMs: parseCompactDay(a.DATE_CUR),
          },
    )
    .filter((c) => Number.isInteger(c.objectId));
  return candidates.sort((a, b) => (b.acres || 0) - (a.acres || 0));
}

/**
 * Derive the inclusive UTC day window. Start prefers the discovery date;
 * end prefers containment, then fire-out, then the perimeter's currency
 * date, else discovery + DEFAULT_WINDOW_DAYS. Anything not taken from a
 * containment/out date is flagged so the operator checks it.
 * @param {object} candidate
 * @param {{start?: string, end?: string}} [overrides]
 * @returns {{startDate: string, endDate: string, startEstimated: boolean, endEstimated: boolean}}
 */
export function deriveWindow(candidate, overrides = {}) {
  let startMs = parseUtcDay(overrides.start);
  let startEstimated = false;
  if (!Number.isFinite(startMs)) {
    if (candidate.discoveryMs) startMs = candidate.discoveryMs;
    else if (candidate.currentMs) {
      startMs = candidate.currentMs - DEFAULT_WINDOW_DAYS * DAY_MS;
      startEstimated = true;
    } else throw new Error('No start date available — pass --start YYYY-MM-DD');
  }
  let endMs = parseUtcDay(overrides.end);
  let endEstimated = false;
  if (!Number.isFinite(endMs)) {
    const published = candidate.containmentMs || candidate.outMs;
    if (published) endMs = published;
    else {
      endMs = candidate.currentMs || startMs + DEFAULT_WINDOW_DAYS * DAY_MS;
      endEstimated = true;
    }
  }
  if (endMs < startMs) endMs = startMs;
  return {
    startDate: formatUtcDay(startMs),
    endDate: formatUtcDay(endMs),
    startEstimated,
    endEstimated,
  };
}

/**
 * Pad an ArcGIS extent into a config bbox, rounded to 3 decimals and
 * clamped to the globe.
 * @param {{xmin: number, ymin: number, xmax: number, ymax: number}} extent
 * @returns {number[]} [west, south, east, north]
 */
export function padBbox(extent) {
  const { xmin, ymin, xmax, ymax } = extent || {};
  if (
    ![xmin, ymin, xmax, ymax].every(Number.isFinite) ||
    xmin >= xmax ||
    ymin >= ymax
  )
    throw new Error('Perimeter extent unavailable — pass --bbox W,S,E,N');
  const pad = Math.max(
    BBOX_PAD_MIN_DEG,
    BBOX_PAD_FRACTION * Math.max(xmax - xmin, ymax - ymin),
  );
  const r = (v) => Math.round(v * 1000) / 1000;
  return [
    Math.max(-180, r(xmin - pad)),
    Math.max(-90, r(ymin - pad)),
    Math.min(180, r(xmax + pad)),
    Math.min(90, r(ymax + pad)),
  ];
}

/**
 * Kebab-case id: `<name>-fire-<year>` unless the name already says fire.
 * @param {string} name
 * @param {number} year
 * @returns {string}
 */
export function slugifyEventId(name, year) {
  const base = String(name)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const withFire = /(^|-)fire($|-)/.test(base) ? base : `${base}-fire`;
  return `${withFire}-${year}`.replace(/-+/g, '-');
}

/**
 * Title-case a NIFC incident name (history rows are upper-case).
 * @param {string} name
 * @returns {string}
 */
export function displayName(name) {
  const text = String(name || '').trim();
  if (!text) return '';
  const cased =
    text === text.toUpperCase()
      ? text.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase())
      : text;
  return /\bfire\b/i.test(cased) ? cased : `${cased} Fire`;
}

/**
 * Assemble and validate a config entry.
 * @param {object} input
 * @returns {{entry: object, warnings: string[]}}
 */
export function buildEventEntry({
  candidate,
  service,
  year,
  bbox,
  id,
  name,
  region,
  summary,
  references = [],
  window,
  sources,
}) {
  const warnings = [];
  const entryName = name || displayName(candidate.name);
  const entryId = id || slugifyEventId(candidate.name, year);
  const perimeter =
    service === 'wfigs'
      ? {
          service,
          incident: candidate.name,
          state: candidate.state,
          discoveredAfter: formatUtcDay(
            (candidate.discoveryMs || parseUtcDay(window.startDate)) -
              7 * DAY_MS,
          ),
        }
      : {
          service,
          incident: candidate.name,
          fireYear: String(year),
          ...(candidate.unitId ? { unitId: candidate.unitId } : {}),
        };
  const entry = {
    id: entryId,
    name: entryName,
    region:
      region ||
      [
        candidate.county && `${candidate.county} County`,
        candidate.state && candidate.state.replace(/^US-/, ''),
        candidate.state ? 'USA' : null,
      ]
        .filter(Boolean)
        .join(', '),
    startDate: window.startDate,
    endDate: window.endDate,
    bbox,
    sources: sources || sourcesForYear(year),
    summary: summary || '',
    burnedHa: candidate.acres
      ? Math.round(candidate.acres * 0.40468564)
      : undefined,
    references,
    perimeter,
  };
  if (entry.burnedHa === undefined) delete entry.burnedHa;
  if (window.startEstimated)
    warnings.push(
      `startDate ${entry.startDate} is an estimate — set it from the incident report`,
    );
  if (window.endEstimated)
    warnings.push(
      `endDate ${entry.endDate} is an estimate (no containment date published) — check it`,
    );
  if (!entry.region) warnings.push('region is empty — add one');
  if (!entry.summary) warnings.push('summary is empty — add one sentence');
  if (!references.length)
    warnings.push('references is empty — add at least one https source');
  if (!candidate.state && service === 'wfigs')
    warnings.push(
      'candidate has no state; perimeter filter may match several incidents',
    );
  if (!normalizeFireEvent(entry))
    throw new Error('Scaffolded entry failed validation');
  return { entry, warnings };
}

/**
 * One-line-per-candidate table for the terminal.
 * @param {Array<object>} candidates
 * @returns {string}
 */
export function formatCandidateTable(candidates) {
  const day = (ms) => (ms ? formatUtcDay(ms) : '—');
  return candidates
    .map((c, i) =>
      [
        `[${i}]`,
        c.name,
        c.state || c.unitId || '',
        c.county || c.agency || '',
        c.acres
          ? `${Math.round(c.acres).toLocaleString('en-US')} ac`
          : 'acres —',
        `disc ${day(c.discoveryMs)}`,
        `contained ${day(c.containmentMs || c.outMs)}`,
        `current ${day(c.currentMs)}`,
      ]
        .filter(Boolean)
        .join('  '),
    )
    .join('\n');
}
