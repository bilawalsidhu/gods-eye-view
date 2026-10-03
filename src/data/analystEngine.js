/**
 * Analyst query engine — answers spoken questions over data ALREADY sitting
 * client-side in the layers ("how many flights over Texas?", "biggest fire
 * near LA?", "which ships are headed to Oakland?").
 *
 * Design (owner-ratified, docs/voice-engine-evaluation-2026-07-23.md §5.3):
 *  - ENGINE (this module) is pure query logic over plain record arrays; it
 *    renders nothing. SURFACES (voice narration, panels, detection brackets)
 *    consume the returned result set — the engine/surface seam is the
 *    `items` array with stable {layerKey, id} identities.
 *  - v1 scope is CLIENT-SIDE DATA ONLY. The one enrichment path (flight
 *    routes) reads the already-cached adsbdb results surfaced by the layer
 *    accessor; the engine never fetches. Fleet-wide route search is
 *    explicitly out of scope.
 *  - Follow-up memory: the previous result set can be re-queried ("which of
 *    those is closest?") via `followUp: true`. Held per engine instance,
 *    cleared by `reset()` (layer toggles should reset via the caller).
 *
 * Providers (injected — keeps the engine pure and node-testable):
 *   getRecords(layerKey) → Array<record>            (layer accessor snapshot)
 *   resolveRegionRing(name) → Promise<{name, geometry|ring, prepared?}
 *     |{error:'region-timeout'}|{needsClarification, candidates}|null>
 *     (geometry = MultiPolygon coordinates; islands and holes all count)
 *   resolveAreaScope(scope) → Promise<{ok:true, area:{areaId, name, prepared,
 *     source, approximate}}|{ok:false, code, error}>  (area/drawn/annotation)
 *   getViewContext() → {lat, lon, viewRadiusKm, bounds?}  (camera-derived)
 *
 * @module data/analystEngine
 */

import { feedProvenanceEnvelope } from './layerSnapshot.js';
import { pointInRing } from './naturalEarthRegions.js';
import { pointInPreparedArea, prepareArea } from './areaGeometry.js';
import { VOICE_LAYER_MANIFEST, voiceLayer } from '../voice/layerManifest.js';

/**
 * Layers the engine understands, with the fields queries may reference,
 * derived from the voice layer manifest (one source for the tool enums, the
 * runner and this engine).
 */
export const ANALYST_LAYERS = Object.freeze(
  Object.fromEntries(
    VOICE_LAYER_MANIFEST.filter((entry) => entry.query).map((entry) => {
      const byType = (type) =>
        Object.entries(entry.query.fields)
          .filter(([, spec]) => spec.type === type)
          .map(([name]) => name);
      return [
        entry.id,
        Object.freeze({
          numeric: byType('number'),
          text: byType('text'),
          flags: byType('flag'),
          time: byType('time'),
          window: entry.query.window,
          timeField: entry.query.timeField,
          caveat: entry.query.caveat,
        }),
      ];
    }),
  ),
);

/** Fields every record carries regardless of layer. */
const COMMON_FIELDS = Object.freeze(['id', 'lat', 'lon']);
/** Derived per-record field for layers with a time field (hours before now). */
const AGE_FIELD = 'ageHours';
/** Spatial scope kinds `query()` accepts. */
export const ANALYST_SCOPE_KINDS = Object.freeze([
  'view',
  'region',
  'radius',
  'anywhere',
  'area',
  'drawn',
  'annotation',
]);

/**
 * Every field a query over these layers may filter or sort on.
 * @param {string[]} layerKeys Queried layer ids.
 * @returns {string[]} Field names, common fields first.
 */
export function analystFieldsFor(layerKeys) {
  const fields = new Set(COMMON_FIELDS);
  for (const key of layerKeys) {
    const layer = ANALYST_LAYERS[key];
    if (!layer) continue;
    for (const name of [
      ...layer.numeric,
      ...layer.text,
      ...layer.flags,
      ...layer.time,
    ])
      fields.add(name);
    if (layer.timeField) fields.add(AGE_FIELD);
  }
  return [...fields];
}

/** Epoch ms from a number or an ISO/date string; NaN when neither. */
function toEpochMs(value) {
  if (typeof value === 'number') return value;
  const text = String(value ?? '').trim();
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  return Date.parse(text);
}

const EARTH_R_KM = 6371;

/** Great-circle distance in km. */
export function haversineKm(lat1, lon1, lat2, lon2) {
  const d2r = Math.PI / 180;
  const dLat = (lat2 - lat1) * d2r;
  const dLon = (lon2 - lon1) * d2r;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * d2r) * Math.cos(lat2 * d2r) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * One filter: {field, op:'gt'|'lt'|'gte'|'lte'|'eq'|'neq'|'contains', value}.
 * With `time: true`, both sides compare as epoch ms (ISO strings accepted).
 */
export function applyFilter(records, filter, { time = false } = {}) {
  const { field, op } = filter || {};
  if (!field || !op) return records;
  const value = time ? toEpochMs(filter.value) : filter.value;
  return records.filter((r) => {
    const got = time ? toEpochMs(r[field]) : r[field];
    if (got === null || got === undefined || (time && !Number.isFinite(got)))
      return false;
    if (time && (op === 'eq' || op === 'neq'))
      return (got === value) === (op === 'eq');
    switch (op) {
      case 'gt':
        return Number(got) > Number(value);
      case 'gte':
        return Number(got) >= Number(value);
      case 'lt':
        return Number(got) < Number(value);
      case 'lte':
        return Number(got) <= Number(value);
      case 'eq': {
        if (typeof got === 'boolean' || typeof value === 'boolean')
          return Boolean(got) === Boolean(value);
        return String(got).toLowerCase() === String(value).toLowerCase();
      }
      case 'neq':
        return String(got).toLowerCase() !== String(value).toLowerCase();
      case 'contains':
        return String(got).toLowerCase().includes(String(value).toLowerCase());
      default:
        return false;
    }
  });
}

/** Scope records spatially. scope: {kind:'view'|'region'|'radius'|'anywhere'|'area', …}. */
export function applyScope(records, scope, resolved) {
  if (!scope || scope.kind === 'anywhere') return records;
  if (resolved?.prepared) {
    return records.filter((r) =>
      pointInPreparedArea(resolved.prepared, r.lat, r.lon),
    );
  }
  if (scope.kind === 'region' && resolved?.ring) {
    return records.filter(
      (r) =>
        Number.isFinite(r.lat) &&
        Number.isFinite(r.lon) &&
        pointInRing(resolved.ring, r.lat, r.lon),
    );
  }
  if (scope.kind === 'radius' || scope.kind === 'view') {
    const c = resolved?.center;
    const km = resolved?.km;
    if (!c || !Number.isFinite(km)) return records;
    return records.filter(
      (r) =>
        Number.isFinite(r.lat) &&
        Number.isFinite(r.lon) &&
        haversineKm(c.lat, c.lon, r.lat, r.lon) <= km,
    );
  }
  return records;
}

/** Numeric summary for the narration layer. */
function summarize(items, sortField) {
  const summary = { count: items.length };
  if (sortField && items.length) {
    // A loop, not Math.min(...vals): a full FIRMS day is ~160k values, past
    // the engine's argument limit.
    let min = Infinity;
    let max = -Infinity;
    for (const item of items) {
      const value = Number(item[sortField]);
      if (!Number.isFinite(value)) continue;
      if (value < min) min = value;
      if (value > max) max = value;
    }
    if (Number.isFinite(min)) {
      summary[`${sortField}Min`] = min;
      summary[`${sortField}Max`] = max;
    }
  }
  return summary;
}

const OPS_BY_TYPE = Object.freeze({
  number: ['gt', 'gte', 'lt', 'lte', 'eq', 'neq'],
  time: ['gt', 'gte', 'lt', 'lte', 'eq', 'neq'],
  text: ['eq', 'neq', 'contains'],
  flag: ['eq', 'neq'],
});
const COMMON_TYPES = Object.freeze({
  id: 'text',
  lat: 'number',
  lon: 'number',
  [AGE_FIELD]: 'number',
});
const COMMON_UNITS = Object.freeze({
  lat: 'deg',
  lon: 'deg',
  [AGE_FIELD]: 'h',
});

/**
 * The type a field has across the queried layers, or null when unknown.
 * @param {string[]} layerKeys Queried layer ids.
 * @param {string} field Field name.
 * @returns {'number'|'text'|'flag'|'time'|null} Field type.
 */
export function analystFieldType(layerKeys, field) {
  if (!analystFieldsFor(layerKeys).includes(field)) return null;
  if (COMMON_TYPES[field]) return COMMON_TYPES[field];
  for (const key of layerKeys) {
    const layer = ANALYST_LAYERS[key];
    if (!layer) continue;
    if (layer.numeric.includes(field)) return 'number';
    if (layer.text.includes(field)) return 'text';
    if (layer.flags.includes(field)) return 'flag';
    if (layer.time.includes(field)) return 'time';
  }
  return null;
}

function analystFieldUnit(layerKeys, field) {
  if (COMMON_UNITS[field]) return COMMON_UNITS[field];
  for (const key of layerKeys) {
    const unit = voiceLayer(key)?.query?.fields?.[field]?.unit;
    if (unit) return unit;
  }
  return null;
}

/** Spoken/written unit spellings → canonical unit. */
const UNIT_ALIASES = Object.freeze({
  m: 'm',
  meter: 'm',
  meters: 'm',
  metre: 'm',
  metres: 'm',
  ft: 'ft',
  foot: 'ft',
  feet: 'ft',
  km: 'km',
  kilometers: 'km',
  kilometres: 'km',
  mi: 'mi',
  mile: 'mi',
  miles: 'mi',
  nmi: 'nmi',
  'm/s': 'm/s',
  mps: 'm/s',
  kn: 'kn',
  kt: 'kn',
  kts: 'kn',
  knot: 'kn',
  knots: 'kn',
  'km/h': 'km/h',
  kmh: 'km/h',
  kph: 'km/h',
  mph: 'mph',
  h: 'h',
  hr: 'h',
  hrs: 'h',
  hour: 'h',
  hours: 'h',
  min: 'min',
  minutes: 'min',
  s: 's',
  sec: 's',
  seconds: 's',
  deg: 'deg',
  degrees: 'deg',
});
/** Canonical unit → [dimension, size in the dimension's base unit]. */
const UNIT_SCALE = Object.freeze({
  m: ['length', 1],
  ft: ['length', 0.3048],
  km: ['length', 1000],
  mi: ['length', 1609.344],
  nmi: ['length', 1852],
  'm/s': ['speed', 1],
  kn: ['speed', 1852 / 3600],
  'km/h': ['speed', 1 / 3.6],
  mph: ['speed', 0.44704],
  h: ['time', 3600],
  min: ['time', 60],
  s: ['time', 1],
});
const canonicalUnit = (unit) => {
  const text = String(unit).trim().toLowerCase();
  return UNIT_ALIASES[text] || text;
};

/**
 * Factor turning a value in `given` into the field's own unit, or null when
 * the two cannot be converted ("altitudeM(ft)" → 0.3048).
 */
function unitFactor(given, fieldUnit) {
  if (!fieldUnit) return null;
  const from = canonicalUnit(given);
  const to = canonicalUnit(fieldUnit);
  if (from === to) return 1;
  const a = UNIT_SCALE[from];
  const b = UNIT_SCALE[to];
  if (!a || !b || a[0] !== b[0]) return null;
  return a[1] / b[1];
}

/** Split "altitudeM(ft)" into the field and its written unit. */
function splitUnit(name) {
  if (typeof name !== 'string') return { field: name, unit: null };
  const match = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(name);
  return match
    ? { field: match[1], unit: match[2].trim() || null }
    : { field: name, unit: null };
}

const NUMERIC_TEXT = /^\s*[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?\s*$/;

/** A filter value in its field's type, or undefined when it is not one. */
function typedValue(type, value) {
  if (type === 'number') {
    if (typeof value === 'number')
      return Number.isFinite(value) ? value : undefined;
    if (typeof value === 'string' && NUMERIC_TEXT.test(value))
      return Number(value);
    return undefined;
  }
  if (type === 'flag') return typeof value === 'boolean' ? value : undefined;
  if (type === 'time') {
    if (typeof value === 'boolean') return undefined;
    const ms = toEpochMs(value);
    return Number.isFinite(ms) ? ms : undefined;
  }
  if (typeof value === 'string' && value.trim() !== '') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

const VALUE_WORDS = Object.freeze({
  number: 'a number',
  flag: 'true or false',
  time: 'an ISO time or epoch milliseconds',
  text: 'text',
});

function refusal(code, error, extra = {}) {
  return { ok: false, code, error, ...extra };
}

const validLat = (v) => typeof v === 'number' && v >= -90 && v <= 90;
const validLon = (v) => typeof v === 'number' && v >= -180 && v <= 180;

/**
 * Validate a query against the manifest before touching any records, so a
 * typo can never read as a confident zero or a silently widened answer.
 * Returns the normalized spec (bare field names, typed values in each
 * field's own unit) or a refusal.
 * @returns {{spec?: object, refusal?: object}} One of the two.
 */
function normalizeSpec(spec, layerKeys) {
  const scope = spec.scope;
  if (scope !== undefined && scope !== null) {
    const kind = String(scope.kind ?? '');
    if (!ANALYST_SCOPE_KINDS.includes(kind))
      return {
        refusal: refusal(
          'UNKNOWN_SCOPE',
          `Unknown scope kind "${kind}". Allowed: ${ANALYST_SCOPE_KINDS.join(', ')}.`,
          { allowed: [...ANALYST_SCOPE_KINDS] },
        ),
      };
    if (kind === 'region' && !String(scope.name ?? '').trim())
      return {
        refusal: refusal('BAD_SCOPE', 'A region scope needs a place name.'),
      };
    if (
      kind === 'area' &&
      (typeof scope.areaId !== 'string' || !scope.areaId.trim())
    )
      return {
        refusal: refusal(
          'BAD_SCOPE',
          'An area scope needs the areaId resolve_area returned.',
        ),
      };
    if (
      kind === 'annotation' &&
      scope.id !== undefined &&
      (typeof scope.id !== 'string' || !scope.id.trim())
    )
      return {
        refusal: refusal('BAD_SCOPE', 'scope.id must be an annotation id.'),
      };
    if (scope.center !== undefined && scope.center !== null) {
      if (!validLat(scope.center.lat) || !validLon(scope.center.lon))
        return {
          refusal: refusal(
            'BAD_SCOPE',
            'scope.center needs lat in -90..90 and lon in -180..180.',
          ),
        };
    } else if (kind === 'radius' && String(scope.name ?? '').trim()) {
      // A radius never geocodes: a name without a centre would silently
      // measure around the camera while the answer names the place.
      return {
        refusal: refusal(
          'BAD_SCOPE',
          `A radius around "${scope.name}" needs center {lat, lon}; or use kind=region for a named area.`,
        ),
      };
    }
    if (
      scope.km !== undefined &&
      !(
        typeof scope.km === 'number' &&
        Number.isFinite(scope.km) &&
        scope.km > 0
      )
    )
      return {
        refusal: refusal('BAD_SCOPE', 'scope.km must be a positive number.'),
      };
  }
  const allowed = analystFieldsFor(layerKeys);
  const badUnit = (field, unit, fieldUnit) =>
    refusal(
      'BAD_UNIT',
      fieldUnit
        ? `${field} is in ${fieldUnit}; "${unit}" does not convert to it.`
        : `${field} has no unit; drop "(${unit})".`,
      { field, expected: fieldUnit },
    );
  const filters = [];
  for (const filter of spec.filters || []) {
    const { field, unit } = splitUnit(String(filter?.field ?? ''));
    const type = analystFieldType(layerKeys, field);
    if (!type)
      return {
        refusal: refusal(
          'UNKNOWN_FIELD',
          `Unknown field "${field}" for ${layerKeys.join(', ')}. Allowed: ${allowed.join(', ')}.`,
          { field, allowed },
        ),
      };
    const ops = OPS_BY_TYPE[type];
    if (!ops.includes(filter.op))
      return {
        refusal: refusal(
          'BAD_OPERATOR',
          `Operator "${filter.op}" does not apply to ${field}. Allowed: ${ops.join(', ')}.`,
          { field, allowed: [...ops] },
        ),
      };
    let value = typedValue(type, filter.value);
    if (value === undefined)
      return {
        refusal: refusal(
          'BAD_VALUE',
          `${field} expects ${VALUE_WORDS[type]}.`,
          {
            field,
            expected: type,
          },
        ),
      };
    if (unit) {
      const fieldUnit = analystFieldUnit(layerKeys, field);
      const factor = type === 'number' ? unitFactor(unit, fieldUnit) : null;
      if (factor === null) return { refusal: badUnit(field, unit, fieldUnit) };
      value *= factor;
    }
    filters.push({ field, op: filter.op, value, type });
  }
  let sortBy = spec.sortBy || null;
  if (sortBy) {
    const { field, unit } = splitUnit(sortBy);
    sortBy = field;
    if (sortBy !== 'distance' && !allowed.includes(sortBy))
      return {
        refusal: refusal(
          'UNKNOWN_FIELD',
          `Unknown sort field "${sortBy}". Allowed: distance, ${allowed.join(', ')}.`,
          { field: sortBy, allowed: ['distance', ...allowed] },
        ),
      };
    if (unit) {
      const fieldUnit =
        sortBy === 'distance' ? 'km' : analystFieldUnit(layerKeys, sortBy);
      if (unitFactor(unit, fieldUnit) === null)
        return { refusal: badUnit(sortBy, unit, fieldUnit) };
    }
  }
  if (spec.sortDir !== undefined && !['asc', 'desc'].includes(spec.sortDir))
    return {
      refusal: refusal('BAD_SORT', 'sortDir must be asc or desc.', {
        allowed: ['asc', 'desc'],
      }),
    };
  return { spec: { ...spec, filters, sortBy } };
}

/**
 * The validated, normalized form of analyst_query arguments (bare field
 * names, typed values in each field's own unit), or null when invalid.
 * @param {object} spec Tool arguments.
 * @param {string[]} layerKeys Queried layer ids.
 * @returns {object|null} Normalized spec.
 */
export function normalizeAnalystSpec(spec, layerKeys) {
  return normalizeSpec(spec || {}, layerKeys).spec || null;
}

/**
 * Where a queried layer stands, so "off", "loading", "feed down" and a real
 * zero never read alike.
 * @returns {'off'|'loading'|'error'|'empty'|'ok'} Layer status.
 */
function layerStatus(snapshot, rowCount, warming) {
  if (snapshot && snapshot.enabled === false) return 'off';
  if (rowCount > 0) return 'ok';
  if (warming || snapshot?.feedState === 'loading') return 'loading';
  if (snapshot?.feedState === 'unavailable' || snapshot?.error) return 'error';
  return 'empty';
}
/** A layer in one of these states can answer, including with a real zero. */
const ANSWERABLE = new Set(['ok', 'empty']);

/** Rows per scan slice before yielding to the page. */
const SCAN_CHUNK = 20_000;
const yieldToPage = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Compile the filters into one predicate over (layerKey, row).
 * @returns {(key: string, row: object) => boolean} Predicate.
 */
function compileFilters(filters, read) {
  const tests = filters.map(({ field, op, value, type }) => {
    const lower = type === 'text' ? String(value).toLowerCase() : null;
    return (key, row) => {
      let got = read(key, row, field);
      if (got === null || got === undefined) return false;
      if (type === 'time') {
        got = toEpochMs(got);
        if (!Number.isFinite(got)) return false;
      }
      if (type === 'flag') {
        if (op === 'eq') return Boolean(got) === value;
        return Boolean(got) !== value;
      }
      if (type === 'text') {
        const text = String(got).toLowerCase();
        if (op === 'contains') return text.includes(lower);
        return (text === lower) === (op === 'eq');
      }
      const n = Number(got);
      if (!Number.isFinite(n)) return false;
      switch (op) {
        case 'gt':
          return n > value;
        case 'gte':
          return n >= value;
        case 'lt':
          return n < value;
        case 'lte':
          return n <= value;
        case 'eq':
          return n === value;
        case 'neq':
          return n !== value;
        default:
          return false;
      }
    };
  });
  return (key, row) => tests.every((test) => test(key, row));
}

/** Comparable form of a sort value; missing values sort last either way. */
function sortKey(type, value) {
  if (value === null || value === undefined || value === '') return null;
  if (type === 'text' || type === 'flag') return String(value);
  const n = type === 'time' ? toEpochMs(value) : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Negative when a ranks before b. */
function rankOrder(a, b, dir) {
  if (a.v === null || b.v === null) return (a.v === null) - (b.v === null);
  const order = typeof a.v === 'string' ? a.v.localeCompare(b.v) : a.v - b.v;
  return order * dir || String(a.row.id).localeCompare(String(b.row.id));
}

/**
 * Keep the best `limit` candidates without sorting the whole set.
 * @param {Array} top Current best, ranked; mutated.
 */
function offerTop(top, candidate, limit, dir) {
  if (top.length === limit && rankOrder(candidate, top[limit - 1], dir) >= 0)
    return;
  let lo = 0;
  let hi = top.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rankOrder(candidate, top[mid], dir) < 0) hi = mid;
    else lo = mid + 1;
  }
  top.splice(lo, 0, candidate);
  if (top.length > limit) top.pop();
}

/**
 * Count, filter and rank loaded rows grouped by layer. Shared by the general
 * engine and the Contacts-window path so both format and rank alike.
 * @param {Array<{key: string, rows: object[]}>} groups Candidate rows.
 * @param {object} options
 * @returns {Promise<object|null>} Selection, or null when cancelled.
 */
export async function selectAnalystRows(
  groups,
  {
    filters = [],
    sortBy = null,
    sortDir,
    limit = 10,
    layerKeys = groups.map((group) => group.key),
    ref = null,
    inScope = null,
    now = Date.now(),
    isCurrent = () => true,
    distanceOf = null,
  } = {},
) {
  const timeFieldOf = (key) => ANALYST_LAYERS[key]?.timeField || null;
  const ageOf = (key, row) => {
    const field = timeFieldOf(key);
    const t = field ? row[field] : null;
    return Number.isFinite(t)
      ? Math.round(((now - t) / 3_600_000) * 10) / 10
      : null;
  };
  const distance = (row) => {
    const own = distanceOf?.(row);
    if (Number.isFinite(own)) return own;
    return ref && Number.isFinite(row.lat) && Number.isFinite(row.lon)
      ? Math.round(haversineKm(ref.lat, ref.lon, row.lat, row.lon) * 10) / 10
      : null;
  };
  const read = (key, row, field) =>
    field === AGE_FIELD
      ? ageOf(key, row)
      : field === 'distanceKm'
        ? distance(row)
        : row[field];
  const passes = compileFilters(filters, read);
  const sortField = sortBy === 'distance' ? 'distanceKm' : sortBy;
  const sortType =
    sortBy === 'distance'
      ? 'number'
      : sortBy
        ? analystFieldType(layerKeys, sortBy)
        : null;
  const dir =
    (sortDir || (sortBy === 'distance' ? 'asc' : 'desc')) === 'asc' ? 1 : -1;
  const cap = Math.max(1, Math.min(50, Number(limit) || 10));
  const matched = [];
  const top = [];
  let count = 0;
  let min = Infinity;
  let max = -Infinity;
  let seen = 0;
  for (const { key, rows } of groups) {
    const kept = [];
    for (const row of rows) {
      if (++seen % SCAN_CHUNK === 0) {
        await yieldToPage();
        if (!isCurrent()) return null;
      }
      if (inScope && !inScope(row)) continue;
      if (!passes(key, row)) continue;
      kept.push(row);
      count++;
      if (sortField) {
        const raw = read(key, row, sortField);
        const v = sortKey(sortType, raw);
        if (sortBy !== 'distance' && typeof v === 'number') {
          if (v < min) min = v;
          if (v > max) max = v;
        }
        offerTop(top, { key, row, v }, cap, dir);
      } else if (top.length < cap) top.push({ key, row });
    }
    matched.push({ key, rows: kept });
  }
  const summary = { count };
  if (sortField && sortBy !== 'distance' && Number.isFinite(min)) {
    summary[`${sortBy}Min`] = min;
    summary[`${sortBy}Max`] = max;
  }
  // Fresh copies: callers may annotate items freely without touching the
  // remembered rows.
  const items = top.map(({ key, row }) => {
    const item = { layerKey: key, ...row };
    const age = ageOf(key, row);
    if (age !== null) item[AGE_FIELD] = age;
    if (sortBy === 'distance') item.distanceKm = distance(row);
    return item;
  });
  return { count, items, matched, summary };
}

/**
 * Create an engine bound to live providers. All spatial/text/number logic is
 * in the pure helpers above; this closure only sequences and remembers.
 */
export function createAnalystEngine(providers) {
  let lastResult = null;

  /**
   * Run one query.
   * @param {object} spec Query arguments (see the analyst_query tool).
   * @param {{signal?: AbortSignal, isCurrent?: () => boolean, beforeCommit?: (result: object) =>
   *   Promise<object|void>}} [options] A query that is no longer current
   *   (cancelled or superseded while awaiting a boundary or between scan
   *   slices) returns CANCELLED and never replaces the follow-up memory.
   *   `beforeCommit` lets a caller finish required async projection work and
   *   optionally supply the exact cohort that was presented before memory is
   *   changed.
   * @returns {Promise<object>} Result or refusal.
   */
  async function query(
    spec = {},
    { signal = null, isCurrent = () => true, beforeCommit = null } = {},
  ) {
    const cancelled = () =>
      refusal('CANCELLED', 'This query was superseded.', { cancelled: true });
    if (spec.followUp && !lastResult)
      return refusal(
        'NO_RESULT_CONTEXT',
        'There is no previous answer to follow up on. Ask the full question.',
        { coverage: { layersQueried: [], scope: 'none' } },
      );
    const followUp = Boolean(spec.followUp);
    const inheritsRememberedScope = followUp && spec.scope == null;
    // A follow-up re-filters the remembered set. Layers named explicitly
    // must be that set: "those hospitals" after an aircraft answer is a new
    // question, never a filter over the old aircraft.
    if (followUp && Array.isArray(spec.layers) && spec.layers.length) {
      const remembered = new Set(lastResult.layerKeys);
      const named = new Set(spec.layers);
      const same =
        remembered.size === named.size &&
        [...named].every((key) => remembered.has(key));
      if (!same)
        return refusal(
          'FOLLOW_UP_MISMATCH',
          `The last answer was about ${lastResult.layerKeys.join(', ')}, not ${spec.layers.join(', ')}. Ask again without followUp.`,
          {
            layers: [...spec.layers],
            remembered: [...lastResult.layerKeys],
            coverage: { layersQueried: [], scope: 'none' },
          },
        );
    }
    const layers = followUp
      ? lastResult.layerKeys
      : Array.isArray(spec.layers) && spec.layers.length
        ? spec.layers
        : ['flights'];

    if (!followUp) {
      const unknown = layers.filter((k) => !ANALYST_LAYERS[k]);
      if (unknown.length) {
        return refusal(
          'UNSUPPORTED_LAYER',
          `I can't query ${unknown
            .map((key) => {
              const why = voiceLayer(key)?.noQuery;
              return why ? `${key} (${why})` : key;
            })
            .join(
              ', ',
            )} — queryable layers: ${Object.keys(ANALYST_LAYERS).join(', ')}.`,
          {
            allowed: Object.keys(ANALYST_LAYERS),
            coverage: { layersQueried: [], scope: 'unsupported-layer' },
          },
        );
      }
    }
    const normalized = normalizeSpec(spec, layers);
    if (normalized.refusal) return normalized.refusal;
    spec = normalized.spec;

    // 1) Source records, grouped by layer and never copied.
    let groups;
    let layersQueried;
    let queriedSnapshots;
    let unanswered = [];
    if (followUp) {
      groups = lastResult.matched;
      layersQueried = lastResult.coverage.layersQueried;
      queriedSnapshots = lastResult.coverage.feedProvenance?.layers || [];
      unanswered = [...(lastResult.unanswered || [])];
    } else {
      groups = [];
      layersQueried = [];
      queriedSnapshots = [];
      for (const key of layers) {
        const rows = providers.getRecords(key) || [];
        const snapshot = providers.getLayerSnapshot?.(key);
        if (snapshot) queriedSnapshots.push(snapshot);
        const coverage = providers.getRecordCoverage?.(key, rows) || {};
        // Unknown when a capped layer cannot say how many it holds.
        const total = Number.isFinite(coverage.total)
          ? coverage.total
          : coverage.truncated
            ? null
            : rows.length;
        const layer = ANALYST_LAYERS[key];
        const status = layerStatus(
          snapshot,
          rows.length,
          providers.isWarming?.(key) === true,
        );
        // Why an enabled layer holds nothing here ("fly below 400 km…").
        const emptyNote =
          status === 'empty' ? providers.getEmptyNote?.(key) || null : null;
        layersQueried.push({
          layerKey: key,
          status,
          ...(emptyNote ? { note: emptyNote } : {}),
          returned: rows.length,
          total,
          truncated:
            coverage.truncated === true ||
            (total !== null && total > rows.length),
          ...(layer.window ? { window: layer.window } : {}),
          ...(snapshot
            ? {
                feedState: snapshot.feedState,
                source: snapshot.source,
                lastUpdate: snapshot.lastUpdate,
                enabled: snapshot.enabled,
                error: snapshot.error,
              }
            : {}),
        });
        groups.push({ key, rows });
      }
      // Nothing can answer: say why instead of answering zero.
      const statuses = layersQueried.map((layer) => layer.status);
      if (!statuses.some((status) => ANSWERABLE.has(status))) {
        const detail = {
          layers: [...layers],
          layerStatus: layersQueried.map(({ layerKey, status }) => ({
            layerKey,
            status,
          })),
          coverage: { layersQueried, scope: 'none' },
        };
        const names = `${layers.join(', ')} ${layers.length > 1 ? 'are' : 'is'}`;
        if (statuses.every((status) => status === 'off'))
          return refusal(
            'LAYER_OFF',
            `${names} off. Offer to turn it on.`,
            detail,
          );
        if (statuses.includes('loading'))
          return refusal(
            'NOT_READY',
            `${names} still loading or off — no records yet.`,
            detail,
          );
        return refusal(
          'FEED_UNAVAILABLE',
          `${names} unavailable or off right now.`,
          detail,
        );
      }
      unanswered = layersQueried
        .filter((layer) => !ANSWERABLE.has(layer.status))
        .map((layer) => layer.layerKey);
    }

    // 2) Spatial scope
    const rememberedPresentation = inheritsRememberedScope
      ? lastResult.presentation || null
      : null;
    const rememberedCoverageNote =
      rememberedPresentation?.coverageNote ||
      (inheritsRememberedScope ? lastResult.coverage?.note : null);
    let resolvedScope = null;
    let scopeNote =
      rememberedPresentation?.coverageScope ||
      (inheritsRememberedScope ? lastResult.coverage?.scope : null) ||
      'anywhere';
    // Human phrasing for the same scope, so every spoken count can name what it
    // measured ("8 in view", "about 30 within 250 km of Austin") instead of
    // arriving as a bare number that contradicts the panel.
    let scopeLabel =
      rememberedPresentation?.scopeLabel || 'anywhere in the loaded data';
    let scopeDetail = rememberedPresentation?.display?.scope || scopeLabel;
    // A follow-up re-filters a set that was already scoped, so it only narrows
    // further when a new scope is given.
    const scope = spec.scope || { kind: followUp ? 'anywhere' : 'view' };
    if (scope.kind === 'region') {
      const region = await providers.resolveRegionRing(scope.name, { signal });
      if (!isCurrent()) return cancelled();
      if (region?.error === 'region-timeout') {
        return {
          ok: false,
          code: 'region-timeout',
          error: `Looking up the boundary for "${scope.name}" is taking too long — ask again in a moment.`,
          coverage: { layersQueried, scope: `region:${scope.name}:timeout` },
        };
      }
      if (region?.needsClarification) {
        return refusal(
          'NEEDS_CLARIFICATION',
          region.error ||
            `"${scope.name}" names more than one place — ask which one.`,
          {
            needsClarification: true,
            query: scope.name,
            candidates: region.candidates || [],
            coverage: {
              layersQueried,
              scope: `region:${scope.name}:ambiguous`,
            },
          },
        );
      }
      const prepared =
        region?.prepared ||
        (region?.geometry
          ? prepareArea(region.geometry)
          : region?.ring
            ? prepareArea([[region.ring]])
            : null);
      if (!prepared) {
        return {
          ok: false,
          code: 'REGION_UNRESOLVED',
          error: `I couldn't resolve a boundary for "${scope.name}" — try a state, country, or a named natural region.`,
          coverage: { layersQueried, scope: `region:${scope.name}:unresolved` },
        };
      }
      resolvedScope = { ...region, prepared };
      scopeNote = `region:${region.name}`;
      scopeLabel = `over ${region.name}`;
      const regionSource = region.sourceLabel || region.source;
      scopeDetail = `${scopeLabel}${region.approximate ? ' (approximate outline)' : ''}${regionSource ? ` · ${regionSource}` : ''}`;
    } else if (
      scope.kind === 'area' ||
      scope.kind === 'drawn' ||
      scope.kind === 'annotation'
    ) {
      const found = providers.resolveAreaScope
        ? await providers.resolveAreaScope(scope)
        : {
            ok: false,
            code: 'AREA_UNAVAILABLE',
            error: 'Area scopes are not available here.',
          };
      if (!isCurrent()) return cancelled();
      if (!found?.ok || !found.area?.prepared) {
        return refusal(
          found?.code || 'AREA_UNKNOWN',
          found?.error || 'That area is not available.',
          { coverage: { layersQueried, scope: `${scope.kind}:unresolved` } },
        );
      }
      const area = found.area;
      resolvedScope = { prepared: area.prepared, name: area.name };
      scopeNote = `area:${area.areaId || scope.kind}`;
      scopeLabel = `inside ${area.name}`;
      const sourceLabel = area.sourceLabel || area.source;
      scopeDetail = `${scopeLabel}${area.approximate ? ' (approximate outline)' : ''}${sourceLabel ? ` · ${sourceLabel}` : ''}`;
      if (area.areaId) resolvedScope.areaId = area.areaId;
    } else if (scope.kind === 'radius') {
      // An explicit center always wins. Otherwise, when Contacts is active its
      // SUBJECT is the centre the operator is actually reasoning about: the
      // panel counts a contact-centred window, so centring the radius on the
      // camera made the two disagree — a parked, high-altitude camera answered
      // "46 within 250 km" while the panel showed a far larger contact-centred
      // count. Same question, two numbers.
      const explicitCenter = scope.center || null;
      const subject = explicitCenter
        ? null
        : providers.getContextSubject?.() || null;
      const view = providers.getViewContext();
      // Only a subject that actually SUPPLIED the centre may name it. A
      // subject present but without usable coordinates silently fell back to
      // the camera while the label still read "within 250 km of <contact>" —
      // a count centred on one place, reported as centred on another, with
      // nothing in the payload to show which.
      const subjectCenter =
        Number.isFinite(subject?.lat) && Number.isFinite(subject?.lon)
          ? { lat: subject.lat, lon: subject.lon }
          : null;
      const center = explicitCenter ||
        subjectCenter || { lat: view.lat, lon: view.lon };
      resolvedScope = { center, km: Number(scope.km) || 100 };
      if (subjectCenter) resolvedScope.centeredOn = subject.label || null;
      scopeNote = resolvedScope.centeredOn
        ? `radius:${resolvedScope.km}km@${resolvedScope.centeredOn}`
        : `radius:${resolvedScope.km}km`;
      scopeLabel = resolvedScope.centeredOn
        ? `within ${resolvedScope.km} km of ${resolvedScope.centeredOn}`
        : `within ${resolvedScope.km} km`;
      scopeDetail = scopeLabel;
    } else if (scope.kind === 'view') {
      const view = providers.getViewContext();
      resolvedScope = {
        center: { lat: view.lat, lon: view.lon },
        km: view.viewRadiusKm,
      };
      scopeNote = `view:${Math.round(view.viewRadiusKm)}km`;
      // TODO: "in view" is a radius around the camera centre, not the visible
      // footprint; the display detail says so until a footprint scope lands.
      scopeLabel = 'in view';
      scopeDetail = `within ${Math.round(view.viewRadiusKm)} km of the view centre`;
    }
    const inScope = resolvedScope?.prepared
      ? (row) => pointInPreparedArea(resolvedScope.prepared, row.lat, row.lon)
      : (scope.kind === 'radius' || scope.kind === 'view') &&
          resolvedScope?.center &&
          Number.isFinite(resolvedScope.km)
        ? (row) =>
            Number.isFinite(row.lat) &&
            Number.isFinite(row.lon) &&
            haversineKm(
              resolvedScope.center.lat,
              resolvedScope.center.lon,
              row.lat,
              row.lon,
            ) <= resolvedScope.km
        : null;

    // 3) Filter, count and rank in one pass, yielding between slices.
    const selection = await selectAnalystRows(groups, {
      filters: spec.filters,
      sortBy: spec.sortBy,
      sortDir: spec.sortDir,
      limit: spec.limit,
      layerKeys: layers,
      ref:
        spec.sortBy === 'distance'
          ? resolvedScope?.center || providers.getViewContext()
          : null,
      inScope,
      now: providers.now?.() ?? Date.now(),
      isCurrent,
    });
    if (!selection || !isCurrent()) return cancelled();

    const totals = layersQueried.reduce(
      (sum, layer) => ({
        returned: sum.returned + (layer.returned ?? 0),
        total:
          sum.total === null || layer.total === null
            ? null
            : sum.total + (layer.total ?? layer.returned ?? 0),
        truncated: sum.truncated || layer.truncated === true,
      }),
      { returned: 0, total: 0, truncated: false },
    );
    const windows = [
      ...new Set(layersQueried.map((layer) => layer.window).filter(Boolean)),
    ];
    const caveats = [];
    if (totals.truncated)
      caveats.push(
        totals.total === null
          ? `counted the first ${totals.returned.toLocaleString('en-US')} loaded records`
          : `counted ${totals.returned.toLocaleString('en-US')} of ${totals.total.toLocaleString('en-US')} loaded records`,
      );
    for (const layer of layersQueried) {
      if (layer.note) caveats.push(`${layer.layerKey}: ${layer.note}`);
      else if (!ANSWERABLE.has(layer.status))
        caveats.push(`${layer.layerKey} ${layer.status}`);
    }
    const distanceScoped =
      spec.sortBy === 'distance' ||
      scope.kind === 'view' ||
      scope.kind === 'radius';
    for (const key of layers) {
      const caveat = ANALYST_LAYERS[key]?.caveat;
      if (caveat && distanceScoped) caveats.push(`${key}: ${caveat}`);
    }

    const result = {
      ok: true,
      count: selection.count,
      // False when a layer was capped: the count is then a floor and the
      // ranking covers only the records examined.
      complete: !totals.truncated,
      ...(unanswered.length ? { partial: true, unanswered } : {}),
      items: selection.items,
      summary: selection.summary,
      scopeLabel,
      // For on-screen text; the model speaks the count and scopeLabel only.
      display: {
        scope: scopeDetail,
        ...(rememberedPresentation?.display?.window || windows.length
          ? {
              window:
                rememberedPresentation?.display?.window || windows.join('; '),
            }
          : {}),
        ...(rememberedPresentation?.display?.caveat || caveats.length
          ? {
              caveat:
                rememberedPresentation?.display?.caveat || caveats.join('; '),
            }
          : {}),
      },
      coverage: {
        layersQueried,
        records: totals,
        scope: scopeNote,
        ...(rememberedCoverageNote ? { note: rememberedCoverageNote } : {}),
        ...(queriedSnapshots.length
          ? { feedProvenance: feedProvenanceEnvelope(queriedSnapshots) }
          : {}),
        followUp,
      },
      // Surfaced so the narration can name the centre it measured from rather
      // than implying a view-centred answer.
      ...(resolvedScope?.centeredOn
        ? { centeredOn: resolvedScope.centeredOn }
        : rememberedPresentation?.centeredOn
          ? { centeredOn: rememberedPresentation.centeredOn }
          : {}),
      ...(rememberedPresentation?.window
        ? { window: structuredClone(rememberedPresentation.window) }
        : {}),
      ...(resolvedScope?.areaId
        ? { areaId: resolvedScope.areaId }
        : rememberedPresentation?.areaId
          ? { areaId: rememberedPresentation.areaId }
          : {}),
    };
    const memoryOverride =
      typeof beforeCommit === 'function'
        ? (await beforeCommit(result)) || null
        : null;
    if (!isCurrent()) return cancelled();
    lastResult = {
      matched: memoryOverride?.matched || selection.matched,
      layerKeys: [...(memoryOverride?.layerKeys || layers)],
      coverage: memoryOverride?.coverage || result.coverage,
      unanswered: [
        ...(memoryOverride?.unanswered === undefined
          ? unanswered
          : memoryOverride.unanswered),
      ],
      presentation: structuredClone(
        memoryOverride?.presentation || {
          scopeLabel: result.scopeLabel,
          display: result.display,
          coverageScope: result.coverage?.scope,
          ...(result.coverage?.note
            ? { coverageNote: result.coverage.note }
            : {}),
          ...(result.centeredOn ? { centeredOn: result.centeredOn } : {}),
          ...(result.window ? { window: result.window } : {}),
          ...(result.areaId ? { areaId: result.areaId } : {}),
        },
      ),
    };
    return result;
  }

  return {
    query,
    /**
     * Make another tool's result set "the last answer" (osm_query's places),
     * so a follow-up filters exactly what the user just heard about.
     * @param {string} layerKey Queryable layer the rows belong to.
     * @param {Array<object>} rows Records in that layer's analyst shape.
     * @param {{scope?: string}} [options]
     */
    remember(layerKey, rows, { scope = 'handoff' } = {}) {
      if (!ANALYST_LAYERS[layerKey] || !Array.isArray(rows)) return false;
      lastResult = {
        matched: [{ key: layerKey, rows: rows.slice() }],
        layerKeys: [layerKey],
        coverage: {
          layersQueried: [
            {
              layerKey,
              status: rows.length ? 'ok' : 'empty',
              returned: rows.length,
              total: rows.length,
              truncated: false,
            },
          ],
          records: {
            returned: rows.length,
            total: rows.length,
            truncated: false,
          },
          scope,
          followUp: false,
        },
      };
      return true;
    },
    reset() {
      lastResult = null;
    },
    hasMemory() {
      return Boolean(lastResult);
    },
  };
}
