// OpenMapTiles stand-ins for the EV charging tests: a `poi` layer of points.
import { PbfWriter } from 'pbf';
import {
  layerWriter,
  zigzag,
} from '../streetLevel/providers/mapillary/coverageFixture.mjs';

/**
 * Encode a tile with one `poi` layer from lon/lat features. A point outside
 * the tile lands in its buffer, as OpenMapTiles writes neighbouring POIs.
 * @param {{x: number, y: number, z: number}} tile
 * @param {Array<{lon: number, lat: number, id?: number}>} features Point
 *   positions, an optional feature id, and any other key as a property.
 * @param {number} [extent]
 * @returns {Uint8Array} Tile body.
 */
export function encodePoiTile(tile, features, extent = 4096) {
  const n = 2 ** tile.z;
  const layer = layerWriter('poi', extent);
  for (const { lon, lat, id, ...properties } of features) {
    const rad = (lat * Math.PI) / 180;
    const tx = ((lon + 180) / 360) * n;
    const ty =
      ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n;
    const px = Math.round((tx - tile.x) * extent);
    const py = Math.round((ty - tile.y) * extent);
    layer.add(1, [9, zigzag(px), zigzag(py)], properties, id);
  }
  const pbf = new PbfWriter();
  pbf.writeMessage(3, (_, out) => layer.write(out), null);
  return new Uint8Array(pbf.finish());
}
