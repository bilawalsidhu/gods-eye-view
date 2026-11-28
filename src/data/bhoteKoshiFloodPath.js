/**
 * Simplified GeoPera river centerline from the point nearest the owner-provided
 * Debris-Dammed Lake observation through Trishuli Bazaar. Every fourth published
 * vertex is retained, plus the exact endpoint nearest the verified bazaar pin.
 *
 * Source: https://github.com/geo-pera/bhotekoshi-2026-reconstruction/blob/main/vectors/river_centerline.geojson
 * License: CC BY-NC 4.0 (derived data; Planet Labs PBC / Vantor open data)
 * Coordinates: bhoteKoshiFloodPath.json
 */
import path from './bhoteKoshiFloodPath.json' with { type: 'json' };

export const BHOTE_KOSHI_FLOOD_PATH = Object.freeze(
  path.map((point) => Object.freeze(point)),
);
