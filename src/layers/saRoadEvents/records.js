/**
 * Traffic SA roadworks, incidents and closures: normalization and validation.
 *
 * Pure (no Cesium, no I/O) and shared by the server proxy, the browser source
 * and the tests. Upstream rows are individually untrusted: a bad row is
 * skipped, never fatal. Only a payload that is not a feature collection at all
 * (or that has rows but not one usable row) rejects the whole snapshot, so a
 * schema change fails loudly into the proxy's last-good path instead of
 * blanking the layer.
 *
 * Two upstream services feed this module. The roadworks service
 * (maps.sa.gov.au, upper-case field names) carries the roadworks points; the
 * Traffic SA "TrafficSATime" service (geohub.sa.gov.au, lower-case field
 * names) carries incidents and closures/detours. Property names are matched
 * case-insensitively so one code path reads both.
 *
 * Every text field is plain text. HTML-looking markup in upstream descriptions
 * is stripped here and the overlay card draws text only.
 */

/**
 * Point kinds, from the upstream rec_type. `incident`, `collision`,
 * `flooding` and `waterworks` are incident-class (live events, shown by
 * default); `works24` and `works` are the two roadworks kinds.
 */
export const SA_ROAD_POINT_KINDS = Object.freeze([
  'incident',
  'collision',
  'flooding',
  'waterworks',
  'works24',
  'works',
  'unknown',
]);
/** Point kinds that are roadworks (the roadworks group carries only these). */
export const SA_ROAD_WORKS_KINDS = Object.freeze(['works24', 'works']);
/** The three independently fetched upstream groups. */
export const SA_ROAD_SOURCE_GROUPS = Object.freeze([
  'roadworks',
  'incidents',
  'closures',
]);
/** How the proxy is serving one group. */
export const SA_ROAD_SOURCE_STATUSES = Object.freeze([
  'live',
  'stale',
  'unavailable',
]);
/** Line kinds, from the upstream PLOT_TYPE. */
export const SA_ROAD_LINE_KINDS = Object.freeze([
  'closure',
  'detour',
  'unknown',
]);

/** South Australia with margin (covers the state and offshore waters). */
export const SA_BOUNDS = Object.freeze({
  west: 128.5,
  east: 141.5,
  south: -38.6,
  north: -25.5,
});

/** Hard bounds on what one snapshot can carry. */
export const SA_ROAD_EVENT_LIMITS = Object.freeze({
  maxPoints: 20_000,
  maxLines: 2_000,
  maxLineVertices: 1_000,
  maxTotalVertices: 60_000,
  maxLinesPerFeature: 50,
});

const ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;
const SHORT_TEXT = 160;
const LONG_TEXT = 1_500;
/** Direction and lanes-closed text can name several carriageways. */
const TRAFFIC_TEXT = 80;
const MAX_TRAFFIC_ENTRIES = 8;
const MAX_TRAFFIC_JSON = 2_000;

/**
 * Reduce an untrusted upstream string to bounded plain text.
 * @param {*} value - Candidate text.
 * @param {number} [max] - Maximum characters kept.
 * @returns {string|null} Clean text, or null when nothing readable remains.
 */
export function cleanText(value, max = SHORT_TEXT) {
  if (typeof value !== 'string') return null;
  const text = value
    .replace(/\r\n?/g, '\n')
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\/?[a-z!][^>]*>/gi, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(
      /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g,
      ' ',
    )
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

const ADELAIDE_FIELDS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Australia/Adelaide',
  hourCycle: 'h23',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
});

function adelaideOffsetMs(instant) {
  const p = Object.fromEntries(
    ADELAIDE_FIELDS.formatToParts(instant).map(({ type, value }) => [
      type,
      Number(value),
    ]),
  );
  return (
    Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) -
    Math.floor(instant / 1000) * 1000
  );
}

/**
 * Traffic SA stores Adelaide wall-clock times in its date fields as if they
 * were UTC (START_DATE_STRING "Mon 01 Sep 2025 08:00 PM" arrives as the epoch
 * of 2025-09-01T20:00Z). Convert such a value to the real instant.
 * @param {*} wallMs - Epoch ms whose UTC fields are Adelaide local time.
 * @returns {number|null} UTC epoch ms, or null when not a usable time.
 */
export function adelaideWallClockToInstant(wallMs) {
  if (!Number.isFinite(wallMs)) return null;
  try {
    const guess = wallMs - adelaideOffsetMs(wallMs);
    const instant = wallMs - adelaideOffsetMs(guess);
    return Number.isFinite(instant) ? instant : null;
  } catch {
    return null;
  }
}

const finiteOrNull = (value) => (Number.isFinite(value) ? value : null);

function recordId(feature, ...candidates) {
  for (const value of [...candidates, feature?.id]) {
    const text =
      typeof value === 'number' && Number.isFinite(value)
        ? String(value)
        : typeof value === 'string'
          ? value.trim().replace(/^\{(.*)\}$/, '$1')
          : '';
    if (ID_PATTERN.test(text)) return text;
  }
  return null;
}

/** True when a lon/lat pair is finite and inside the South Australia bounds. */
export function inSaBounds(lon, lat) {
  return (
    Number.isFinite(lon) &&
    Number.isFinite(lat) &&
    lon >= SA_BOUNDS.west &&
    lon <= SA_BOUNDS.east &&
    lat >= SA_BOUNDS.south &&
    lat <= SA_BOUNDS.north
  );
}

/** Round to ~1 cm; keeps the wire payload small and signatures stable. */
const round = (value) => Math.round(value * 1e7) / 1e7;

/**
 * Map the upstream rec_type to a point kind.
 * @param {*} recType - Upstream rec_type (e.g. "COLLISION").
 * @returns {'incident'|'collision'|'flooding'|'waterworks'|'works24'|'works'|'unknown'}
 */
export function pointKind(recType) {
  const text = typeof recType === 'string' ? recType.trim().toUpperCase() : '';
  if (text === 'INCIDENT') return 'incident';
  if (text === 'COLLISION') return 'collision';
  if (text === 'FLOODING') return 'flooding';
  if (text === 'EMERGENCY WATERWORKS') return 'waterworks';
  if (text === '24HR ROADWORKS') return 'works24';
  if (text === 'ROADWORKS') return 'works';
  return 'unknown';
}

/**
 * Map the upstream PLOT_TYPE to a line kind.
 * @param {*} plotType - Upstream PLOT_TYPE (e.g. "RD_CLOSURE").
 * @returns {'closure'|'detour'|'unknown'}
 */
export function lineKind(plotType) {
  const text = typeof plotType === 'string' ? plotType.trim() : '';
  if (/detour/i.test(text)) return 'detour';
  if (/clos/i.test(text)) return 'closure';
  return 'unknown';
}

/** Property bag with lower-cased names, so both services read the same way. */
function lowerKeys(properties) {
  if (
    !properties ||
    typeof properties !== 'object' ||
    Array.isArray(properties)
  )
    return null;
  const lower = Object.create(null);
  for (const [name, value] of Object.entries(properties))
    lower[name.toLowerCase()] = value;
  return lower;
}

/**
 * Direction and lanes closed from a point's `traffic_dir`. The incidents
 * service sends a JSON-encoded string such as
 * `[{"direction":"NORTHBOUND","lanes_closed":1}]` (or `"[]"`); the
 * roadworks service sends plain text such as "South Bound". Anything that is
 * not one of those, including malformed JSON, yields nulls and never throws.
 * @param {*} value - Upstream traffic_dir.
 * @returns {{direction: string|null, lanesClosed: string|null}}
 */
export function parseTrafficDirection(value) {
  const none = { direction: null, lanesClosed: null };
  if (typeof value !== 'string') return none;
  const text = value.trim();
  if (!text) return none;
  if (text[0] !== '[' && text[0] !== '{')
    return { direction: cleanText(text, TRAFFIC_TEXT), lanesClosed: null };
  if (text.length > MAX_TRAFFIC_JSON) return none;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return none;
  }
  if (!Array.isArray(parsed)) return none;
  const entries = [];
  for (const item of parsed.slice(0, MAX_TRAFFIC_ENTRIES)) {
    if (!item || typeof item !== 'object') continue;
    const direction = cleanText(item.direction, 40);
    if (!direction) continue;
    const closed = Number(item.lanes_closed);
    entries.push({
      direction,
      lanes:
        Number.isInteger(closed) && closed > 0 && closed < 100 ? closed : 0,
    });
  }
  if (!entries.length) return none;
  const directions = [...new Set(entries.map((entry) => entry.direction))];
  const closedLanes = entries.filter((entry) => entry.lanes > 0);
  let lanesClosed = null;
  if (closedLanes.length)
    lanesClosed =
      entries.length === 1
        ? String(closedLanes[0].lanes)
        : closedLanes
            .map((entry) => entry.lanes + ' ' + entry.direction)
            .join(', ');
  return {
    direction: cleanText(directions.join(' / '), TRAFFIC_TEXT),
    lanesClosed: cleanText(lanesClosed, TRAFFIC_TEXT),
  };
}

/** Incident ids are the numeric object id, prefixed so they never meet a roadworks id. */
function incidentId(feature, properties) {
  for (const value of [properties.incident_id, feature?.id])
    if (Number.isInteger(value) && value >= 0) return 'inc-' + value;
  return null;
}

function normalizePoint(feature, source) {
  const properties = lowerKeys(feature?.properties);
  if (!properties) return null;
  const geometry = feature.geometry;
  if (geometry?.type !== 'Point' || !Array.isArray(geometry.coordinates))
    return null;
  const [lon, lat] = geometry.coordinates;
  if (!inSaBounds(lon, lat)) return null;
  const id =
    source === 'incidents'
      ? incidentId(feature, properties)
      : recordId(feature, properties.roadworks_and_incidents_id);
  if (!id) return null;
  const traffic = parseTrafficDirection(properties.traffic_dir);
  return {
    id,
    kind: pointKind(properties.rec_type),
    description: cleanText(properties.description, LONG_TEXT),
    road: cleanText(properties.local_road),
    sideStreet: cleanText(properties.side_street),
    suburb: cleanText(properties.suburb),
    direction: traffic.direction,
    lanesClosed:
      traffic.lanesClosed ||
      cleanText(properties.no_lanes_closed, TRAFFIC_TEXT),
    speedLimit: cleanText(
      typeof properties.speed_limit === 'number'
        ? String(properties.speed_limit)
        : properties.speed_limit,
      40,
    ),
    startMs: adelaideWallClockToInstant(properties.start_date),
    endMs: adelaideWallClockToInstant(properties.end_date),
    lon: round(lon),
    lat: round(lat),
  };
}

/** Normalize one GeoJSON line geometry to arrays of [lon, lat] vertices. */
function normalizeLineGeometry(geometry, budget) {
  let parts;
  if (geometry?.type === 'LineString') parts = [geometry.coordinates];
  else if (geometry?.type === 'MultiLineString') parts = geometry.coordinates;
  else return null;
  if (
    !Array.isArray(parts) ||
    !parts.length ||
    parts.length > SA_ROAD_EVENT_LIMITS.maxLinesPerFeature
  )
    return null;
  const lines = [];
  let vertices = 0;
  for (const part of parts) {
    if (!Array.isArray(part) || part.length < 2) return null;
    const stride = Math.max(
      1,
      Math.ceil((part.length - 1) / (SA_ROAD_EVENT_LIMITS.maxLineVertices - 1)),
    );
    const line = [];
    for (let i = 0; i < part.length; i += stride) line.push(part[i]);
    // Thinning keeps the first and last vertex so the closure still joins up.
    if (line[line.length - 1] !== part[part.length - 1])
      line.push(part[part.length - 1]);
    // Thinning picks what is drawn, not what is trusted: every source vertex
    // must be a finite in-state position, including the ones the stride skips.
    for (const position of part) {
      if (!Array.isArray(position) || !inSaBounds(position[0], position[1]))
        return null;
    }
    vertices += line.length;
    lines.push(line.map(([lon, lat]) => [round(lon), round(lat)]));
  }
  if (vertices > budget) return null;
  return { lines, vertices };
}

const streets = (properties, prefix) =>
  [1, 2, 3]
    .map((n) => cleanText(properties[prefix + '_side_street_name' + n]))
    .filter(Boolean);

function normalizeLine(feature, budget) {
  const properties = lowerKeys(feature?.properties);
  if (!properties) return null;
  const id = recordId(feature, properties.location_id);
  if (!id) return null;
  const geometry = normalizeLineGeometry(feature.geometry, budget);
  if (!geometry) return null;
  const middle = geometry.lines[0][Math.floor(geometry.lines[0].length / 2)];
  return {
    record: {
      id,
      kind: lineKind(properties.plot_type),
      details: cleanText(
        properties.plot_details || properties.plot_alt_text,
        LONG_TEXT,
      ),
      road: cleanText(properties.local_road_name),
      startStreets: streets(properties, 'start'),
      startSuburb: cleanText(properties.start_suburb),
      endStreets: streets(properties, 'end'),
      endSuburb: cleanText(properties.end_suburb),
      startMs: adelaideWallClockToInstant(properties.start_date),
      endMs: adelaideWallClockToInstant(properties.end_date),
      anchor: middle,
      lines: geometry.lines,
    },
    vertices: geometry.vertices,
  };
}

const isFeatureCollection = (value) =>
  value?.type === 'FeatureCollection' && Array.isArray(value.features);

/**
 * Normalize a point collection.
 * @param {object} collection - GeoJSON FeatureCollection (pages already joined).
 * @param {{source?: 'roadworks'|'incidents'}} [options] - Which upstream group
 *   this is. `roadworks` keeps only the two roadworks kinds: the roadworks
 *   service still carries a few stale INCIDENT rows, which the incidents
 *   service supersedes, so they are counted in `ignored`, not `skipped`.
 *   `incidents` takes ids from the object id. Omitted, every kind is kept.
 * @returns {{records: object[], skipped: number, ignored: number}|null} null
 *   when the payload is not a feature collection or none of its rows is
 *   usable.
 */
export function normalizeSaRoadEventPoints(collection, { source } = {}) {
  if (!isFeatureCollection(collection)) return null;
  const records = [];
  const ids = new Set();
  let skipped = 0;
  let ignored = 0;
  for (const feature of collection.features) {
    const record =
      records.length < SA_ROAD_EVENT_LIMITS.maxPoints
        ? normalizePoint(feature, source)
        : null;
    if (
      record &&
      source === 'roadworks' &&
      !SA_ROAD_WORKS_KINDS.includes(record.kind)
    ) {
      ignored++;
      continue;
    }
    if (!record || ids.has(record.id)) {
      skipped++;
      continue;
    }
    ids.add(record.id);
    records.push(record);
  }
  if (collection.features.length && !records.length && !ignored) return null;
  return { records, skipped, ignored };
}

/**
 * Normalize the closures/detours line collection.
 * @param {object} collection - GeoJSON FeatureCollection.
 * @returns {{records: object[], skipped: number}|null} null when the payload
 *   is not a feature collection or none of its rows is usable.
 */
export function normalizeSaRoadEventLines(collection) {
  if (!isFeatureCollection(collection)) return null;
  const records = [];
  const ids = new Set();
  let skipped = 0;
  let vertices = 0;
  for (const feature of collection.features) {
    const result =
      records.length < SA_ROAD_EVENT_LIMITS.maxLines
        ? normalizeLine(
            feature,
            SA_ROAD_EVENT_LIMITS.maxTotalVertices - vertices,
          )
        : null;
    if (!result || ids.has(result.record.id)) {
      skipped++;
      continue;
    }
    ids.add(result.record.id);
    vertices += result.vertices;
    records.push(result.record);
  }
  if (collection.features.length && !records.length) return null;
  return { records, skipped };
}

/**
 * Normalize both Traffic SA collections into one snapshot body.
 * @param {{points: object, lines: object}} collections - Joined FeatureCollections.
 * @returns {{points: object[], lines: object[]}|null} null when either
 *   collection is unusable (the caller keeps its last good snapshot).
 */
export function normalizeSaRoadEventSnapshot(collections) {
  const points = normalizeSaRoadEventPoints(collections?.points);
  const lines = normalizeSaRoadEventLines(collections?.lines);
  if (!points || !lines) return null;
  return { points: points.records, lines: lines.records };
}

const textOrNull = (value, max) =>
  value === null || (typeof value === 'string' && value.length <= max);

/** Strict check of a record that already went through the normalizer. */
function validPointRecord(record) {
  return (
    Boolean(record) &&
    typeof record === 'object' &&
    ID_PATTERN.test(record.id) &&
    SA_ROAD_POINT_KINDS.includes(record.kind) &&
    inSaBounds(record.lon, record.lat) &&
    textOrNull(record.description, LONG_TEXT) &&
    textOrNull(record.road, SHORT_TEXT) &&
    textOrNull(record.sideStreet, SHORT_TEXT) &&
    textOrNull(record.suburb, SHORT_TEXT) &&
    textOrNull(record.direction, TRAFFIC_TEXT) &&
    textOrNull(record.lanesClosed, TRAFFIC_TEXT) &&
    textOrNull(record.speedLimit, 40) &&
    (record.startMs === null || Number.isFinite(record.startMs)) &&
    (record.endMs === null || Number.isFinite(record.endMs))
  );
}

function validLineRecord(record) {
  if (!record || typeof record !== 'object') return false;
  if (!ID_PATTERN.test(record.id) || !SA_ROAD_LINE_KINDS.includes(record.kind))
    return false;
  if (
    !textOrNull(record.details, LONG_TEXT) ||
    !textOrNull(record.road, SHORT_TEXT) ||
    !textOrNull(record.startSuburb, SHORT_TEXT) ||
    !textOrNull(record.endSuburb, SHORT_TEXT) ||
    !Array.isArray(record.startStreets) ||
    !Array.isArray(record.endStreets) ||
    record.startStreets.length > 3 ||
    record.endStreets.length > 3 ||
    ![...record.startStreets, ...record.endStreets].every(
      (name) => typeof name === 'string' && name.length <= SHORT_TEXT,
    )
  )
    return false;
  if (
    (record.startMs !== null && !Number.isFinite(record.startMs)) ||
    (record.endMs !== null && !Number.isFinite(record.endMs))
  )
    return false;
  if (
    !Array.isArray(record.anchor) ||
    !inSaBounds(record.anchor[0], record.anchor[1])
  )
    return false;
  if (
    !Array.isArray(record.lines) ||
    !record.lines.length ||
    record.lines.length > SA_ROAD_EVENT_LIMITS.maxLinesPerFeature
  )
    return false;
  return record.lines.every(
    (line) =>
      Array.isArray(line) &&
      line.length >= 2 &&
      line.length <= SA_ROAD_EVENT_LIMITS.maxLineVertices + 1 &&
      line.every(
        (position) =>
          Array.isArray(position) && inSaBounds(position[0], position[1]),
      ),
  );
}

/** Strict check of the proxy's per-group status block. */
function validSources(sources) {
  if (!sources || typeof sources !== 'object' || Array.isArray(sources))
    return null;
  const checked = {};
  for (const group of SA_ROAD_SOURCE_GROUPS) {
    const entry = sources[group];
    if (!entry || typeof entry !== 'object') return null;
    if (!SA_ROAD_SOURCE_STATUSES.includes(entry.status)) return null;
    if (entry.fetchedAt !== null && !Number.isFinite(entry.fetchedAt))
      return null;
    if (entry.status === 'unavailable' && entry.fetchedAt !== null) return null;
    checked[group] = {
      status: entry.status,
      fetchedAt: entry.fetchedAt,
      mirror: entry.mirror === true,
    };
  }
  return checked;
}

/**
 * Validate a proxy response body as a whole before anything is rendered.
 * Unlike the upstream normalizer this never skips: a single malformed record
 * means the payload is not from our proxy, so the whole snapshot is refused.
 * @param {*} payload - Parsed `/api/sa-road-events` body.
 * @returns {{points: object[], lines: object[], fetchedAt: number,
 *   stale: boolean, mirror: boolean, sources: Record<string, {status:
 *   string, fetchedAt: number|null, mirror: boolean}>}|null} The snapshot, or
 *   null if malformed. `sources` says whether each upstream group is live,
 *   served stale, or unavailable (its records are then absent, not empty); a
 *   body without it is read as every group live (or stale, when `stale`).
 */
export function validateSaRoadEventsPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const { points, lines, fetchedAt } = payload;
  if (!Array.isArray(points) || !Array.isArray(lines)) return null;
  if (!Number.isFinite(fetchedAt)) return null;
  if (
    points.length > SA_ROAD_EVENT_LIMITS.maxPoints ||
    lines.length > SA_ROAD_EVENT_LIMITS.maxLines
  )
    return null;
  const ids = new Set();
  for (const record of points) {
    if (!validPointRecord(record) || ids.has(record.id)) return null;
    ids.add(record.id);
  }
  ids.clear();
  let vertices = 0;
  for (const record of lines) {
    if (!validLineRecord(record) || ids.has(record.id)) return null;
    ids.add(record.id);
    for (const line of record.lines) vertices += line.length;
  }
  if (vertices > SA_ROAD_EVENT_LIMITS.maxTotalVertices) return null;
  const stale = payload.stale === true;
  const mirror = payload.mirror === true;
  let sources;
  if (payload.sources === undefined) {
    const status = stale ? 'stale' : 'live';
    sources = Object.fromEntries(
      SA_ROAD_SOURCE_GROUPS.map((group) => [
        group,
        { status, fetchedAt, mirror: group === 'roadworks' && mirror },
      ]),
    );
  } else {
    sources = validSources(payload.sources);
    if (!sources) return null;
  }
  return { points, lines, fetchedAt, stale, mirror, sources };
}
