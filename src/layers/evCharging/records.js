import { PbfReader } from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';
import { tileToBBox } from '../../data/tomtomTiles.js';

/**
 * OpenMapTiles keeps every `poi` feature only at its maximum zoom, z14; z12
 * and z13 carry a few high-rank places and no charging stations, so a coarser
 * tile would read as an empty (falsely uncovered) area.
 */
export const CHARGING_TILE_ZOOM = 14;

/** OpenMapTiles files charging stations under the fuel class. */
const CHARGING_SUBCLASS = 'charging_station';

/**
 * Map one decoded `poi` feature to a charging-station record, or null for any
 * other POI. Tiles carry the published name and rank only: no sockets, power
 * or operator, so the record claims nothing more.
 * @param {object} feature GeoJSON feature from `VectorTileFeature#toGeoJSON`.
 * @param {string} fallbackId Tile-scoped id for a feature without one.
 * @returns {{id: string, name: string|null, latitude: number,
 *   longitude: number}|null} Record.
 */
export function normalizeChargingFeature(feature, fallbackId) {
  const properties = feature?.properties || {};
  if (
    properties.subclass !== CHARGING_SUBCLASS ||
    feature.geometry?.type !== 'Point'
  )
    return null;
  const [longitude, latitude] = feature.geometry.coordinates || [];
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180
  )
    return null;
  const name = [properties.name, properties.name_en, properties.name_int]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .find(Boolean);
  return {
    id: `ev-charging:${feature.id ?? fallbackId}`,
    name: name || null,
    latitude,
    longitude,
  };
}

/**
 * Decode the charging stations of one OpenMapTiles tile. Points in the tile
 * buffer belong to the neighbouring tile, so each station is kept only by the
 * tile that contains it and adjacent tiles never draw it twice.
 * @param {Uint8Array} bytes Tile body.
 * @param {number} z Tile zoom.
 * @param {number} x Tile column.
 * @param {number} y Tile row.
 * @returns {Array<object>} Records.
 */
export function decodeChargingTile(bytes, z, x, y) {
  const layer = new VectorTile(new PbfReader(bytes)).layers.poi;
  if (!layer) return [];
  if (layer.length > 40_000)
    throw new Error('Vector tile feature limit exceeded');
  const box = tileToBBox(z, x, y);
  const records = [];
  for (let i = 0; i < layer.length; i++) {
    const feature = layer.feature(i);
    // Most POIs are shops and amenities; skip them before building geometry.
    if (feature.properties.subclass !== CHARGING_SUBCLASS) continue;
    const record = normalizeChargingFeature(
      feature.toGeoJSON(x, y, z),
      `${z}/${x}/${y}:${i}`,
    );
    if (
      record &&
      record.latitude >= box.south &&
      record.latitude < box.north &&
      record.longitude >= box.west &&
      record.longitude < box.east
    )
      records.push(record);
  }
  return records;
}

/**
 * The planet build time OpenFreeMap names its versioned tile path after
 * (`…/planet/20261018_080001_pt/{z}/{x}/{y}.pbf`): when the mapped data was
 * extracted, not when the tile was fetched.
 * @param {string} template Tile URL template from the TileJSON.
 * @returns {number|null} Epoch milliseconds, or null without a build stamp.
 */
export function planetBuildTime(template) {
  const match = /\/(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})_[a-z]+\//.exec(
    template || '',
  );
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const time = Date.UTC(year, month - 1, day, hour, minute, second);
  return Number.isFinite(time) ? time : null;
}
