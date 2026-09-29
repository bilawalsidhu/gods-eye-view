/**
 * GDACS (Global Disaster Alert and Coordination System) event records.
 *
 * GDACS publishes one GeoJSON map feed per hazard type. Each feed mixes the
 * event centroid with track, cone and footprint geometry; only the
 * `Point_Centroid` features are kept, trimmed to the fields the layer shows.
 */

/** Hazard types GDACS publishes, in the order the list and proxy use. */
export const GDACS_EVENT_TYPES = Object.freeze([
  'EQ',
  'TC',
  'FL',
  'VO',
  'DR',
  'WF',
]);

export const GDACS_TYPE_NAMES = Object.freeze({
  EQ: 'Earthquake',
  TC: 'Tropical cyclone',
  FL: 'Flood',
  VO: 'Volcano',
  DR: 'Drought',
  WF: 'Wildfire',
});

/** Alert levels from most to least severe. */
export const GDACS_LEVELS = Object.freeze(['red', 'orange', 'green']);

export const GDACS_LEVEL_COLORS = Object.freeze({
  red: '#ff4d4d',
  orange: '#ff9f1c',
  green: '#4cc764',
});

export const GDACS_LEVEL_NAMES = Object.freeze({
  red: 'Red',
  orange: 'Orange',
  green: 'Green',
});

const REPORT_ORIGIN = 'https://www.gdacs.org';
const MAX_TEXT = 160;

const text = (value) =>
  typeof value === 'string'
    ? value.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT)
    : '';

/** GDACS stamps are UTC without a zone designator. */
export function parseGdacsTime(value) {
  if (typeof value !== 'string' || !value) return null;
  const stamp = /(?:[zZ]|[+-]\d\d:?\d\d)$/.test(value) ? value : `${value}Z`;
  const ms = Date.parse(stamp);
  return Number.isFinite(ms) ? ms : null;
}

/** Keep only a report link on the GDACS origin. */
function reportUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.origin === REPORT_ORIGIN ? url.href : null;
  } catch {
    return null;
  }
}

/** Severity text, without the placeholder floods carry ("Magnitude 0"). */
function severityText(data) {
  const value = text(data?.severitytext);
  if (!value || /^Magnitude 0\b/i.test(value)) return '';
  return value;
}

/**
 * Normalize one GDACS feature to an event record, or null when it is not an
 * event centroid or lacks an identity, a position or a known alert level.
 */
export function normalizeGdacsFeature(feature) {
  const p = feature?.properties;
  if (!p || p.Class !== 'Point_Centroid') return null;
  const type = typeof p.eventtype === 'string' ? p.eventtype : '';
  if (!GDACS_EVENT_TYPES.includes(type)) return null;
  const eventId = Number(p.eventid);
  if (!Number.isSafeInteger(eventId) || eventId <= 0) return null;
  const episodeId = Number(p.episodeid);
  const [lon, lat] = Array.isArray(feature.geometry?.coordinates)
    ? feature.geometry.coordinates
    : [];
  if (
    feature.geometry?.type !== 'Point' ||
    !Number.isFinite(lon) ||
    !Number.isFinite(lat) ||
    Math.abs(lat) > 90 ||
    Math.abs(lon) > 180
  )
    return null;
  const level = String(p.alertlevel || '').toLowerCase();
  if (!GDACS_LEVELS.includes(level)) return null;
  const countries = Array.isArray(p.affectedcountries)
    ? p.affectedcountries
        .map((entry) => text(entry?.countryname))
        .filter(Boolean)
    : [];
  return {
    id: `${type}-${eventId}`,
    type,
    eventId,
    episodeId: Number.isSafeInteger(episodeId) ? episodeId : 0,
    level,
    name: text(p.name) || `${GDACS_TYPE_NAMES[type]} ${eventId}`,
    country: text(p.country) || countries.join(', ').slice(0, MAX_TEXT),
    lon,
    lat,
    fromMs: parseGdacsTime(p.fromdate),
    toMs: parseGdacsTime(p.todate),
    modifiedMs: parseGdacsTime(p.datemodified),
    severity: severityText(p.severitydata),
    current: p.iscurrent === true || p.iscurrent === 'true',
    reportUrl: reportUrl(p.url?.report),
  };
}

/**
 * Normalize a GDACS map feed to event records, one per event (the latest
 * episode wins). Returns null when the payload is not a FeatureCollection.
 */
export function normalizeGdacsCollection(payload) {
  if (!Array.isArray(payload?.features)) return null;
  const byId = new Map();
  for (const feature of payload.features) {
    const record = normalizeGdacsFeature(feature);
    if (!record) continue;
    const previous = byId.get(record.id);
    if (!previous || record.episodeId > previous.episodeId)
      byId.set(record.id, record);
  }
  return [...byId.values()];
}

/** Most severe first, then the most recently updated. */
export function compareGdacsEvents(a, b) {
  const level = GDACS_LEVELS.indexOf(a.level) - GDACS_LEVELS.indexOf(b.level);
  if (level) return level;
  const at = (event) => event.toMs ?? event.fromMs ?? 0;
  return at(b) - at(a) || a.id.localeCompare(b.id);
}

const finiteOrNull = (value) => (Number.isFinite(value) ? value : null);

/**
 * Validate records that crossed the proxy boundary. Only the fields
 * `normalizeGdacsFeature` produces survive, re-checked; a row without a
 * matching identity, a known type and level, or a position is dropped.
 */
export function sanitizeGdacsEvents(rows) {
  if (!Array.isArray(rows)) return null;
  const seen = new Set();
  const events = [];
  for (const row of rows) {
    if (
      !row ||
      !GDACS_EVENT_TYPES.includes(row.type) ||
      !Number.isSafeInteger(row.eventId) ||
      row.eventId <= 0 ||
      row.id !== `${row.type}-${row.eventId}` ||
      seen.has(row.id) ||
      !GDACS_LEVELS.includes(row.level) ||
      !Number.isFinite(row.lon) ||
      !Number.isFinite(row.lat) ||
      Math.abs(row.lat) > 90 ||
      Math.abs(row.lon) > 180
    )
      continue;
    seen.add(row.id);
    events.push({
      id: row.id,
      type: row.type,
      eventId: row.eventId,
      episodeId: Number.isSafeInteger(row.episodeId) ? row.episodeId : 0,
      level: row.level,
      name: text(row.name) || `${GDACS_TYPE_NAMES[row.type]} ${row.eventId}`,
      country: text(row.country),
      lon: row.lon,
      lat: row.lat,
      fromMs: finiteOrNull(row.fromMs),
      toMs: finiteOrNull(row.toMs),
      modifiedMs: finiteOrNull(row.modifiedMs),
      severity: text(row.severity),
      current: row.current === true,
      reportUrl: reportUrl(row.reportUrl),
    });
  }
  return events.sort(compareGdacsEvents);
}
