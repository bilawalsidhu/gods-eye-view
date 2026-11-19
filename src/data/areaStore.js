/**
 * Session-scoped store of area handles. A voice turn refers to an area by its
 * `areaId`; the geometry itself stays here and never goes to the model.
 *
 * Records are immutable once stored. A source with a stable identity (an OSM
 * relation, a Natural Earth region, an annotation) keeps the same id when it
 * is stored again, so repeating "outline Bagmati" does not mint new handles.
 * Least recently used records are evicted past `maxEntries`, except those
 * `isPinned` reports as still in use.
 *
 * Pure: no Cesium, DOM or network.
 * @module data/areaStore
 */

import {
  multiPolygonAreaKm2,
  multiPolygonCounts,
  normalizeMultiPolygon,
  prepareArea,
} from './areaGeometry.js';

/** Where an area came from, as the model and the panel name it. */
export const AREA_SOURCES = Object.freeze([
  'natural-earth',
  'us-census',
  'wof',
  'datasf',
  'osm',
  'openfreemap',
  'annotation',
  'drawn',
  'approximate',
]);

/** Levels a resolved area can have. */
export const AREA_LEVELS = Object.freeze([
  'country',
  'admin1',
  'admin2',
  'city',
  'district',
  'natural',
  'site',
  'drawn',
]);

const round = (value, digits) => {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
};

/**
 * Create an area store.
 * @param {{maxEntries?: number, maxQueryEntries?: number, now?: () => number, isPinned?: (areaId: string) => boolean}} [options]
 */
export function createAreaStore({
  maxEntries = 32,
  maxQueryEntries = Math.max(32, maxEntries * 8),
  now = () => Date.now(),
  isPinned = () => false,
} = {}) {
  /** Insertion order doubles as recency: get() re-inserts. */
  const records = new Map();
  /** query key → areaId, for cached resolutions. */
  const queries = new Map();
  let seq = 0;

  function forgetRecordQueries(areaId) {
    for (const [key, queried] of queries)
      if (queried === areaId) queries.delete(key);
  }

  /**
   * Drop least recently used records past the bound, skipping pinned ones
   * (an area an outline on the map still refers to keeps its geometry for as
   * long as the outline exists; the annotation cap bounds how many that is).
   */
  function evict(keep) {
    if (records.size <= maxEntries) return;
    for (const id of [...records.keys()]) {
      if (records.size <= maxEntries) break;
      // The record just stored is always kept; pinned ones may exceed the bound.
      if (id === keep || isPinned(id)) continue;
      records.delete(id);
      forgetRecordQueries(id);
    }
  }

  /**
   * Store an area. Returns the stored record, or null when the geometry is
   * unusable.
   * @param {object} input
   * @param {object|Array} input.geometry GeoJSON Polygon/MultiPolygon or coordinates.
   * @param {string} input.name
   * @param {string} input.source One of AREA_SOURCES.
   * @param {string} [input.sourceId] Stable identity, e.g. `ne:state:india-punjab`.
   * @param {string} [input.level]
   * @param {boolean} [input.approximate]
   * @param {object} [input.meta] Extra facts (country, license, completeness).
   * @returns {object|null}
   */
  function put(input) {
    const geometry = normalizeMultiPolygon(input?.geometry);
    if (!geometry) return null;
    const prepared = prepareArea(geometry);
    if (!prepared) return null;
    const areaId = input.sourceId
      ? String(input.sourceId)
      : `area-${(seq += 1)}`;
    const counts = multiPolygonCounts(geometry);
    const record = Object.freeze({
      areaId,
      name: String(input.name || 'Unnamed area').slice(0, 160),
      level: AREA_LEVELS.includes(input.level) ? input.level : null,
      source: AREA_SOURCES.includes(input.source)
        ? input.source
        : 'approximate',
      approximate: Boolean(input.approximate),
      geometry,
      prepared,
      bbox: prepared.bbox,
      areaKm2: multiPolygonAreaKm2(geometry),
      parts: counts.parts,
      holes: counts.holes,
      meta: Object.freeze({ ...(input.meta || {}) }),
      storedAt: now(),
    });
    records.delete(areaId);
    records.set(areaId, record);
    evict(areaId);
    return record;
  }

  /** The record for an id, marking it recently used; null when unknown or evicted. */
  function get(areaId) {
    const record = records.get(String(areaId ?? ''));
    if (!record) return null;
    records.delete(record.areaId);
    records.set(record.areaId, record);
    return record;
  }

  return {
    put,
    get,
    has: (areaId) => records.has(String(areaId ?? '')),
    /** Remember which area a query resolved to. */
    rememberQuery(key, areaId) {
      if (!key || !records.has(areaId)) return;
      queries.delete(key);
      queries.set(key, areaId);
      while (queries.size > maxQueryEntries)
        queries.delete(queries.keys().next().value);
    },
    /** The area a query resolved to earlier, if still stored. */
    recallQuery(key) {
      const id = queries.get(key);
      const record = id ? get(id) : null;
      if (!record) {
        queries.delete(key);
        return null;
      }
      queries.delete(key);
      queries.set(key, id);
      return record;
    },
    /** Newest first. */
    list: () => [...records.values()].reverse(),
    /** The most recently stored or used record matching `predicate`. */
    latest(predicate = () => true) {
      return [...records.values()].reverse().find(predicate) || null;
    },
    delete(areaId) {
      const id = String(areaId ?? '');
      const deleted = records.delete(id);
      if (deleted) forgetRecordQueries(id);
      return deleted;
    },
    clear() {
      records.clear();
      queries.clear();
    },
    get size() {
      return records.size;
    },
  };
}

/**
 * The model-facing summary of an area: identity, size and provenance, never
 * coordinates beyond a rounded bbox.
 * @param {object} record
 * @returns {object}
 */
export function summarizeArea(record) {
  if (!record) return null;
  return {
    areaId: record.areaId,
    name: record.name,
    level: record.level,
    source: record.source,
    ...(record.meta.country ? { country: record.meta.country } : {}),
    bbox: record.bbox.map((v) => round(v, 3)),
    areaKm2:
      record.areaKm2 >= 100
        ? Math.round(record.areaKm2)
        : round(record.areaKm2, 2),
    parts: record.parts,
    holes: record.holes,
    ...(record.approximate ? { approximate: true } : {}),
  };
}
