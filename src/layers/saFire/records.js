/**
 * Pure normalizers for the South Australian CFS/MFS fire feeds. No Cesium or
 * DOM imports: the dev/preview proxy and the browser source both use them.
 *
 * Two upstreams are normalized independently:
 *  - the ESO "current incidents" JSON array (every record is a plain object
 *    whose coordinates arrive as STRINGS and whose reported time is a
 *    dd/mm/yyyy + hh:mm wall clock in the record's own IANA zone), and
 *  - the CFS public-warnings ArcGIS feature layers (points and polygons).
 *
 * Individually invalid records are skipped. Only a payload that is not the
 * expected container at all (an incidents payload that is not an array, a
 * warnings payload without a `features` array) rejects the whole snapshot,
 * so a single bad record can never blank the layer.
 */
import { msg } from '../../i18n/marker.js';

/** South Australia bounding box plus margin; points outside are rejected. */
export const SA_BOUNDS = Object.freeze({
  west: 128.5,
  east: 141.5,
  south: -38.6,
  north: -25.5,
});

export const MAX_INCIDENTS = 5000;
export const MAX_WARNINGS = 500;
const MAX_WARNING_VERTICES = 20000;

const insideSa = (lat, lon) =>
  lon >= SA_BOUNDS.west &&
  lon <= SA_BOUNDS.east &&
  lat >= SA_BOUNDS.south &&
  lat <= SA_BOUNDS.north;

/** Strip control characters and bound length; empty or non-string becomes null. */
function cleanText(value, max = 300) {
  if (typeof value !== 'string') return null;
  const text = value
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .trim()
    .slice(0, max)
    .trim();
  return text === '' ? null : text;
}

/** Strings must be non-blank: `Number('')` and `Number(null)` are 0, not "missing". */
function coordinate(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  if (typeof value === 'string' && value.trim() !== '')
    return Number(value.trim());
  return NaN;
}

const count = (value) =>
  Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;

// --- Time zones --------------------------------------------------------------

const ZONE_NAME = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){0,2}$/;
const zoneFormatters = new Map();

function zoneFormatter(timeZone) {
  if (
    typeof timeZone !== 'string' ||
    timeZone.length > 64 ||
    !ZONE_NAME.test(timeZone)
  )
    return null;
  let formatter = zoneFormatters.get(timeZone);
  if (formatter) return formatter;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
  } catch {
    return null; // unknown zone
  }
  if (zoneFormatters.size >= 16) zoneFormatters.clear();
  zoneFormatters.set(timeZone, formatter);
  return formatter;
}

/** Offset (zone wall clock minus UTC) in ms at a UTC instant, or null. */
export function zoneOffsetMs(utcMs, timeZone) {
  const formatter = zoneFormatter(timeZone);
  if (!formatter) return null;
  const parts = {};
  for (const { type, value } of formatter.formatToParts(utcMs))
    parts[type] = Number(value);
  const wall = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return wall - Math.floor(utcMs / 1000) * 1000;
}

/**
 * Convert a dd/mm/yyyy + hh:mm wall-clock time in an IANA zone to UTC epoch
 * ms. DST-correct via Intl, never the host's zone. A wall time repeated by
 * the autumn transition resolves to its standard-time reading; one skipped by
 * the spring transition resolves to a nearby valid instant. Returns null for
 * an unparseable date/time or an unknown zone.
 * @param {{date?: string, time?: string, tz?: string}} reported
 * @returns {number|null}
 */
export function parseReportedTime(reported) {
  if (!reported || typeof reported !== 'object') return null;
  const date = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(
    String(reported.date ?? '').trim(),
  );
  const time = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(
    String(reported.time ?? '').trim(),
  );
  if (!date || !time) return null;
  const [day, month, year] = [date[1], date[2], date[3]].map(Number);
  const [hour, minute, second] = [time[1], time[2], time[3] ?? 0].map(Number);
  if (year < 1990 || year > 2100 || hour > 23 || minute > 59 || second > 59)
    return null;
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  const check = new Date(wall);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  )
    return null; // e.g. 31/02
  const first = zoneOffsetMs(wall, reported.tz);
  if (first === null) return null;
  let utc = wall - first;
  // Re-evaluate at the candidate: near a transition the first guess used the
  // wrong side's offset.
  const again = zoneOffsetMs(utc, reported.tz);
  if (again !== first) utc = wall - again;
  return utc;
}

// --- Incidents ---------------------------------------------------------------

/**
 * Normalize the ESO current-incidents JSON array.
 * @param {unknown} payload - Parsed upstream JSON.
 * @returns {Array<Object>|null} Rows, or null when the payload is not an array.
 */
export function normalizeSaIncidents(payload) {
  if (!Array.isArray(payload)) return null;
  const rows = [];
  const ids = new Set();
  for (const record of payload) {
    if (!record || typeof record !== 'object' || Array.isArray(record))
      continue;
    const id = cleanText(
      typeof record.id === 'number' ? String(record.id) : record.id,
      64,
    );
    if (id === null || ids.has(id)) continue;
    const lat = coordinate(record.location?.coordinates?.lat);
    const lon = coordinate(record.location?.coordinates?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !insideSa(lat, lon))
      continue;
    ids.add(id);
    const messageCount = count(record.messages_count);
    rows.push({
      id,
      agency: cleanText(record.agency, 20),
      name: cleanText(record.location?.name, 120),
      lat,
      lon,
      region: cleanText(record.location?.region, 40),
      fireBanDistrict: cleanText(record.location?.fbd, 80),
      type: cleanText(record.incident?.type, 80),
      status: cleanText(record.incident?.status, 40),
      level: cleanText(record.incident?.level, 10),
      ground: count(record.resources?.ground),
      aircraft: count(record.resources?.aircraft),
      messageCount:
        messageCount ??
        (Array.isArray(record.messages) ? record.messages.length : null),
      reportedTime: parseReportedTime(record.reported),
    });
    if (rows.length >= MAX_INCIDENTS) break;
  }
  return rows;
}

// --- Warnings ----------------------------------------------------------------

/**
 * Only an https link on cfs.sa.gov.au (or a subdomain), without credentials
 * or a custom port, survives; anything else (http, other hosts, javascript:,
 * data:, userinfo tricks) becomes null.
 * @param {unknown} value
 * @returns {string|null}
 */
export function safeWarningLink(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.length > 500 || /[\u0000-\u0020\u007f\\]/.test(text))
    return null;
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    !(
      url.hostname === 'cfs.sa.gov.au' ||
      url.hostname.endsWith('.cfs.sa.gov.au')
    )
  )
    return null;
  return url.href;
}

/** The warnings layers store `public` as a free-text string ("True"). */
function isPublic(value) {
  if (value === true) return true;
  return typeof value === 'string' && value.trim().toLowerCase() === 'true';
}

/** ArcGIS GeoJSON dates are epoch ms; tolerate ISO strings. */
function dateMs(value) {
  if (Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

const integerOrNull = (value) => (Number.isSafeInteger(value) ? value : null);

function validRing(ring) {
  if (!Array.isArray(ring) || ring.length < 4) return false;
  for (const position of ring) {
    if (!Array.isArray(position) || position.length < 2) return false;
    const [lon, lat] = position;
    if (!Number.isFinite(lon) || Math.abs(lon) > 180) return false;
    if (!Number.isFinite(lat) || Math.abs(lat) > 90) return false;
  }
  return true;
}

/**
 * Normalize Polygon/MultiPolygon geometry to an array of polygons (arrays of
 * rings), or null when malformed, empty or over the vertex cap. A polygon is
 * kept only if its outer ring's bounding box touches South Australia: the
 * shared layer extent reaches well beyond the state.
 */
function normalizeWarningPolygons(geometry) {
  if (!geometry || typeof geometry !== 'object') return null;
  let polygons;
  if (geometry.type === 'Polygon') polygons = [geometry.coordinates];
  else if (geometry.type === 'MultiPolygon') polygons = geometry.coordinates;
  else return null;
  if (!Array.isArray(polygons)) return null;
  const result = [];
  let vertices = 0;
  for (const rings of polygons) {
    if (!Array.isArray(rings) || !rings.length || !rings.every(validRing))
      return null;
    vertices += rings.reduce((sum, ring) => sum + ring.length, 0);
    if (vertices > MAX_WARNING_VERTICES) return null;
    const lons = rings[0].map(([lon]) => lon);
    const lats = rings[0].map(([, lat]) => lat);
    if (
      Math.max(...lons) < SA_BOUNDS.west ||
      Math.min(...lons) > SA_BOUNDS.east ||
      Math.max(...lats) < SA_BOUNDS.south ||
      Math.min(...lats) > SA_BOUNDS.north
    )
      continue;
    result.push(rings);
  }
  return result.length ? result : null;
}

/** Vertex mean of the largest-bounding-box outer ring (degrees). */
function polygonAnchor(polygons) {
  let best = polygons[0][0];
  let bestSpan = -1;
  for (const [outer] of polygons) {
    const lons = outer.map(([lon]) => lon);
    const lats = outer.map(([, lat]) => lat);
    const span =
      (Math.max(...lons) - Math.min(...lons)) *
      (Math.max(...lats) - Math.min(...lats));
    if (span > bestSpan) {
      bestSpan = span;
      best = outer;
    }
  }
  const n = best.length - 1; // closed ring: last repeats first
  let lon = 0;
  let lat = 0;
  for (let i = 0; i < n; i++) {
    lon += best[i][0];
    lat += best[i][1];
  }
  return { lon: lon / n, lat: lat / n };
}

function warningRow(feature, kind, index, nowMs) {
  const props = feature?.properties;
  if (!props || typeof props !== 'object' || Array.isArray(props)) return null;
  // Fail closed: an unset or non-"true" `public` flag is not shown.
  if (!isPublic(props.public)) return null;
  const expiry =
    dateMs(props.expiry_with_offset) ?? dateMs(props.expiry) ?? null;
  if (expiry !== null && expiry < nowMs) return null;
  let lat;
  let lon;
  let polygons;
  if (kind === 'point') {
    const coords = feature.geometry?.coordinates;
    if (feature.geometry?.type !== 'Point' || !Array.isArray(coords))
      return null;
    lon = coordinate(coords[0]);
    lat = coordinate(coords[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !insideSa(lat, lon))
      return null;
  } else {
    polygons = normalizeWarningPolygons(feature.geometry);
    if (!polygons) return null;
    ({ lat, lon } = polygonAnchor(polygons));
  }
  const objectId = props.objectid ?? feature.id;
  const stable =
    typeof objectId === 'number' || typeof objectId === 'string'
      ? String(objectId).slice(0, 40)
      : `i${index}`;
  return {
    id: `${kind === 'point' ? 'p' : 'g'}:${stable}`,
    kind,
    category: cleanText(props.category, 100) ?? cleanText(props.icon, 100),
    headline: cleanText(props.headline, 300),
    name: cleanText(props.name, 300),
    description: cleanText(props.description, 2000),
    longDescription: cleanText(props.long_description, 2000),
    expiryTime: expiry,
    createdTime: dateMs(props.created_date),
    editedTime: dateMs(props.last_edited_date),
    incidentRef: integerOrNull(props.incident_id),
    mfsIncidentRef: integerOrNull(props.mfs_incident_id),
    link: safeWarningLink(props.message_link),
    lat,
    lon,
    ...(polygons ? { polygons } : {}),
  };
}

/**
 * Normalize the two CFS public-warning layers (0 = points, 1 = polygons).
 * Keeps only public, unexpired, in-state warnings.
 * @param {{points: unknown, polygons: unknown}} collections - Parsed GeoJSON.
 * @param {number} nowMs - Current epoch ms (injected for tests).
 * @returns {Array<Object>|null} Rows, or null when either layer is not a feature collection.
 */
export function normalizeSaWarnings({ points, polygons } = {}, nowMs) {
  if (!Array.isArray(points?.features) || !Array.isArray(polygons?.features))
    return null;
  const rows = [];
  const ids = new Set();
  for (const [kind, collection] of [
    ['polygon', polygons],
    ['point', points],
  ]) {
    collection.features.forEach((feature, index) => {
      if (rows.length >= MAX_WARNINGS) return;
      const row = warningRow(feature, kind, index, nowMs);
      if (!row || ids.has(row.id)) return;
      ids.add(row.id);
      rows.push(row);
    });
  }
  return rows;
}

/**
 * Link warnings to incidents only on an explicit numeric match: the warning
 * layers store an Integer `incident_id` (CFS) / `mfs_incident_id` (MFS) while
 * incident ids look like "F2610120119". A warning links to an incident when
 * the incident id's digits equal the matching field and the agency agrees.
 * Note 2026+ ids exceed a 32-bit Integer, so such links are rare in practice;
 * unmatched warnings simply display on their own.
 * @param {Array<Object>} incidents - Normalized incident rows.
 * @param {Array<Object>} warnings - Normalized warning rows.
 * @returns {Map<string, string>} warning id → incident id.
 */
export function linkWarningsToIncidents(incidents, warnings) {
  const byNumber = { CFS: new Map(), MFS: new Map() };
  for (const incident of incidents) {
    const agency = byNumber[String(incident.agency).toUpperCase()];
    const digits = /^[A-Za-z]?(\d{1,15})$/.exec(incident.id)?.[1];
    if (agency && digits) agency.set(Number(digits), incident.id);
  }
  const links = new Map();
  for (const warning of warnings) {
    const target =
      (warning.incidentRef != null && byNumber.CFS.get(warning.incidentRef)) ||
      (warning.mfsIncidentRef != null &&
        byNumber.MFS.get(warning.mfsIncidentRef));
    if (target) links.set(warning.id, target);
  }
  return links;
}

// --- Browser-side validation of the proxy envelope -----------------------------

const nullableText = (value) => value === null || typeof value === 'string';
const nullableNumber = (value) => value === null || Number.isFinite(value);

function validIncidentRow(row) {
  return (
    row &&
    typeof row === 'object' &&
    typeof row.id === 'string' &&
    row.id !== '' &&
    Number.isFinite(row.lat) &&
    Number.isFinite(row.lon) &&
    insideSa(row.lat, row.lon) &&
    [
      'agency',
      'name',
      'region',
      'fireBanDistrict',
      'type',
      'status',
      'level',
    ].every((key) => nullableText(row[key])) &&
    ['ground', 'aircraft', 'messageCount', 'reportedTime'].every((key) =>
      nullableNumber(row[key]),
    )
  );
}

function validWarningRow(row) {
  return (
    row &&
    typeof row === 'object' &&
    typeof row.id === 'string' &&
    row.id !== '' &&
    (row.kind === 'point' || row.kind === 'polygon') &&
    Number.isFinite(row.lat) &&
    Number.isFinite(row.lon) &&
    [
      'category',
      'headline',
      'name',
      'description',
      'longDescription',
      'link',
    ].every((key) => nullableText(row[key])) &&
    (row.link === null || safeWarningLink(row.link) === row.link) &&
    ['expiryTime', 'createdTime', 'editedTime'].every((key) =>
      nullableNumber(row[key]),
    ) &&
    (row.kind === 'point' ||
      (Array.isArray(row.polygons) &&
        row.polygons.length > 0 &&
        row.polygons.every(
          (rings) =>
            Array.isArray(rings) && rings.length > 0 && rings.every(validRing),
        )))
  );
}

/**
 * Validate the `/api/sa-fire` envelope in the browser before it replaces what
 * is displayed. Throws on a structurally wrong payload; individually invalid
 * rows are dropped.
 * @param {unknown} payload
 * @returns {{incidents: Array<Object>, warnings: Array<Object>, warningsAvailable: boolean,
 *   incidentsFetchedAt: number|null, warningsFetchedAt: number|null,
 *   upstreamModified: number|null, stale: boolean}}
 */
export function validateSaFireSnapshot(payload) {
  if (
    !payload ||
    typeof payload !== 'object' ||
    !Array.isArray(payload.incidents) ||
    !Array.isArray(payload.warnings) ||
    typeof payload.warningsAvailable !== 'boolean'
  )
    throw new Error(msg('Malformed SA fire snapshot'));
  const ids = new Set();
  const incidents = payload.incidents.filter((row) => {
    if (!validIncidentRow(row) || ids.has(row.id)) return false;
    ids.add(row.id);
    return true;
  });
  const warningIds = new Set();
  const warnings = payload.warnings.filter((row) => {
    if (!validWarningRow(row) || warningIds.has(row.id)) return false;
    warningIds.add(row.id);
    return true;
  });
  const time = (value) => (Number.isFinite(value) ? value : null);
  return {
    incidents,
    warnings: payload.warningsAvailable ? warnings : [],
    warningsAvailable: payload.warningsAvailable,
    incidentsFetchedAt: time(payload.incidentsFetchedAt),
    warningsFetchedAt: time(payload.warningsFetchedAt),
    upstreamModified: time(payload.upstreamModified),
    stale: payload.stale === true,
  };
}
