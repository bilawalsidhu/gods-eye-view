/**
 * Path import: GeoJSON.
 *
 * Accepts a FeatureCollection, a single Feature, or a bare geometry, and reads
 * the geometry types that map onto whiteboard marks:
 *
 * - `LineString` / `MultiLineString`: lines.
 * - `Polygon` / `MultiPolygon`: areas, from each polygon's outer ring.
 * - `Point` / `MultiPoint`: pins.
 * - `GeometryCollection`: each member.
 *
 * This is also the format the board exports (`pathExport.js`), so a saved
 * drawing can be brought back in.
 *
 * No Cesium, no DOM.
 */
import { PathImportError } from './pathXml.js';

/** Nesting ceiling for GeometryCollection inside GeometryCollection. */
const MAX_COLLECTION_DEPTH = 8;

/**
 * @param {string} text GeoJSON document text.
 * @returns {Array<{kind: 'line'|'area'|'pin', name: string, points: Array<[number, number]>}>}
 */
export function parseGeoJson(text) {
  let json;
  try {
    json = JSON.parse(String(text ?? '').replace(/^﻿/, ''));
  } catch {
    throw new PathImportError(
      'malformed-json',
      'The file is not valid JSON, so it cannot be read as GeoJSON.',
    );
  }
  if (!json || typeof json !== 'object' || Array.isArray(json))
    throw new PathImportError(
      'not-geojson',
      'The file is JSON but not a GeoJSON object.',
    );

  const features = [];
  if (json.type === 'FeatureCollection') {
    for (const feature of Array.isArray(json.features) ? json.features : [])
      collectFeature(feature, features);
  } else if (json.type === 'Feature') {
    collectFeature(json, features);
  } else if (typeof json.type === 'string') {
    collectGeometry(json, '', features, 0);
  } else {
    throw new PathImportError(
      'not-geojson',
      'The file is JSON but has no GeoJSON "type".',
    );
  }
  return features;
}

function collectFeature(feature, features) {
  if (!feature || typeof feature !== 'object') return;
  collectGeometry(feature.geometry, nameOf(feature.properties), features, 0);
}

/** The first non-empty of the property names people use for a feature's name. */
function nameOf(properties) {
  if (!properties || typeof properties !== 'object') return '';
  for (const key of ['name', 'title', 'label']) {
    const value = properties[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function collectGeometry(geometry, name, features, depth) {
  if (!geometry || typeof geometry !== 'object') return;
  const coords = geometry.coordinates;
  switch (geometry.type) {
    case 'Point':
      features.push({ kind: 'pin', name, points: [pairOf(coords)] });
      return;
    case 'MultiPoint':
      for (const point of list(coords))
        features.push({ kind: 'pin', name, points: [pairOf(point)] });
      return;
    case 'LineString':
      features.push({ kind: 'line', name, points: list(coords).map(pairOf) });
      return;
    case 'MultiLineString':
      for (const line of list(coords))
        features.push({ kind: 'line', name, points: list(line).map(pairOf) });
      return;
    case 'Polygon':
      features.push({
        kind: 'area',
        name,
        points: list(list(coords)[0]).map(pairOf),
      });
      return;
    case 'MultiPolygon':
      for (const polygon of list(coords))
        features.push({
          kind: 'area',
          name,
          points: list(list(polygon)[0]).map(pairOf),
        });
      return;
    case 'GeometryCollection':
      if (depth >= MAX_COLLECTION_DEPTH) return;
      for (const member of list(geometry.geometries))
        collectGeometry(member, name, features, depth + 1);
      return;
    default:
  }
}

const list = (value) => (Array.isArray(value) ? value : []);

/** A position as [lon, lat]; NaN where absent or not a number, for the validator to drop. */
function pairOf(position) {
  const [lon, lat] = list(position);
  return [
    typeof lon === 'number' ? lon : Number.NaN,
    typeof lat === 'number' ? lat : Number.NaN,
  ];
}
