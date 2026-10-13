/**
 * Registered historic fire events — pure validation and FIRMS archive
 * request planning. No network, no Cesium, no filesystem.
 *
 * Original design/implementation: @lleon-at-navteca in PR #609.
 */

export const FIRMS_MAX_WINDOW_DAYS = 5;
export const FIRE_HISTORY_SOURCES = Object.freeze([
  'VIIRS_SNPP_SP',
  'VIIRS_NOAA20_SP',
  'VIIRS_NOAA21_SP',
  'MODIS_SP',
]);

const DAY_MS = 86_400_000;
const ID_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const PERIMETER_TEXT = /^[A-Za-z0-9][A-Za-z0-9 .'-]{0,49}$/;
const PERIMETER_YEAR = /^\d{4}$/;
const PERIMETER_UNIT = /^[A-Z0-9]{2,8}$/;
const PERIMETER_STATE = /^US-[A-Z]{2}$/;

export function parseUtcDay(value) {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return NaN;
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(ms)) return NaN;
  return new Date(ms).toISOString().slice(0, 10) === value ? ms : NaN;
}

export function formatUtcDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Validate historical-perimeter match metadata only. This module does not
 * build ArcGIS queries; perimeter acquisition belongs to the shared
 * fire-perimeters provider.
 */
export function normalizeFirePerimeter(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const service = raw.service;
  if (!['nifc-history', 'wfigs'].includes(service)) return null;
  const incident = typeof raw.incident === 'string' ? raw.incident.trim() : '';
  if (!PERIMETER_TEXT.test(incident)) return null;
  const out = { service, incident };
  if (service === 'nifc-history') {
    if (!PERIMETER_YEAR.test(String(raw.fireYear || ''))) return null;
    out.fireYear = String(raw.fireYear);
    if (raw.unitId != null) {
      if (!PERIMETER_UNIT.test(String(raw.unitId))) return null;
      out.unitId = String(raw.unitId);
    }
  } else {
    if (!PERIMETER_STATE.test(String(raw.state || ''))) return null;
    out.state = String(raw.state);
    const after = parseUtcDay(raw.discoveredAfter);
    if (!Number.isFinite(after)) return null;
    out.discoveredAfter = formatUtcDay(after);
  }
  return Object.freeze(out);
}

export function normalizeFireEvent(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!ID_PATTERN.test(id)) return null;
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) return null;
  const startMs = parseUtcDay(raw.startDate);
  const endMs = parseUtcDay(raw.endDate);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs)
    return null;
  if (!Array.isArray(raw.bbox) || raw.bbox.length !== 4) return null;
  const [west, south, east, north] = raw.bbox.map(Number);
  if (
    ![west, south, east, north].every(Number.isFinite) ||
    west < -180 ||
    east > 180 ||
    south < -90 ||
    north > 90 ||
    west >= east ||
    south >= north
  )
    return null;
  const sources = Array.isArray(raw.sources)
    ? raw.sources.filter((source) => FIRE_HISTORY_SOURCES.includes(source))
    : [];
  if (!sources.length) return null;
  const perimeter = raw.perimeter == null ? null : normalizeFirePerimeter(raw.perimeter);
  if (raw.perimeter != null && !perimeter) return null;
  const burnedHa = Number(raw.burnedHa);
  const references = Array.isArray(raw.references)
    ? raw.references
        .filter(
          (reference) =>
            reference &&
            typeof reference.label === 'string' &&
            typeof reference.url === 'string' &&
            /^https:\/\//.test(reference.url),
        )
        .map((reference) =>
          Object.freeze({ label: reference.label, url: reference.url }),
        )
    : [];
  return Object.freeze({
    id,
    name,
    region: typeof raw.region === 'string' ? raw.region.trim() : '',
    startDate: formatUtcDay(startMs),
    endDate: formatUtcDay(endMs),
    startMs,
    endMs: endMs + DAY_MS,
    bbox: Object.freeze([west, south, east, north]),
    sources: Object.freeze([...new Set(sources)]),
    summary: typeof raw.summary === 'string' ? raw.summary.trim() : '',
    burnedHa: Number.isFinite(burnedHa) && burnedHa > 0 ? burnedHa : null,
    references: Object.freeze(references),
    perimeter,
  });
}

export function normalizeFireEventCatalog(payload) {
  const list = Array.isArray(payload?.events) ? payload.events : [];
  const events = [];
  const rejected = [];
  const ids = new Set();
  for (const [index, raw] of list.entries()) {
    const event = normalizeFireEvent(raw);
    const label = String(raw?.id ?? `#${index + 1}`);
    if (!event || ids.has(event.id)) {
      rejected.push(label);
      continue;
    }
    ids.add(event.id);
    events.push(event);
  }
  return { events, rejected };
}

export function splitDateWindows(
  startDate,
  endDate,
  maxDays = FIRMS_MAX_WINDOW_DAYS,
) {
  const startMs = parseUtcDay(startDate);
  const endMs = parseUtcDay(endDate);
  const cap = Math.min(
    FIRMS_MAX_WINDOW_DAYS,
    Math.max(1, Math.floor(Number(maxDays) || 0)),
  );
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs)
    return [];
  const totalDays = Math.round((endMs - startMs) / DAY_MS) + 1;
  const windows = [];
  for (let offset = 0; offset < totalDays; offset += cap) {
    windows.push({
      date: formatUtcDay(startMs + offset * DAY_MS),
      days: Math.min(cap, totalDays - offset),
    });
  }
  return windows;
}

export function firmsAreaSegment(bbox) {
  return bbox.map((value) => Number(value).toFixed(4)).join(',');
}

export function filterRecordsToEvent(records, event) {
  if (!Array.isArray(records) || !event) return [];
  const [west, south, east, north] = event.bbox;
  return records.filter((record) => {
    const lat = Number(record?.lat);
    const lon = Number(record?.lon);
    if (lat < south || lat > north || lon < west || lon > east) return false;
    const dayMs = parseUtcDay(record?.acqDate);
    return (
      Number.isFinite(dayMs) && dayMs >= event.startMs && dayMs < event.endMs
    );
  });
}
