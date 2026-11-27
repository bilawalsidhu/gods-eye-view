import { countryName } from '../data/wikidataCities.js';
import { ESRI_TILES } from '../maps/attribution.js';
import { getLocale } from '../i18n/index.js';
import { tilePosition } from '../stories/thumbs.js';

const TILE = 256;
export const TILE_MAX_LAT = 85.05112878;
export const onTileMap = (lat) =>
  Number.isFinite(lat) && Math.abs(lat) <= TILE_MAX_LAT;

/**
 * How close the card's close-up map looks, by the kind of item (the card's
 * `kind`): an airport, a fire, a vessel, a quake or a base shows its
 * surroundings; a place or a spot, its streets; a camera, the block it
 * watches. Anything else uses `default`.
 */
export const CLOSE_UP_ZOOM = Object.freeze({
  airport: 12,
  fire: 12,
  'fire perimeter': 11,
  vessel: 12,
  earthquake: 11,
  installation: 12,
  place: 14,
  camera: 16,
  'plate reader': 16,
  default: 14,
});

/**
 * The zoom of the close-up map for a card.
 * @param {{kind?: string}|null} card
 * @returns {number}
 */
export const closeUpZoom = (card) =>
  CLOSE_UP_ZOOM[card?.kind] ?? CLOSE_UP_ZOOM.default;

/**
 * What a card's close-up map is captioned with, when the card names its own
 * place: an airport by its name, city and country; a place from search by the
 * name the search found. Null for anything else, which the map captions with
 * the city nearest it.
 * @param {{layerId?: string, kind?: string, title?: string, place?: object, identity?: object}|null} card
 * @returns {string|null}
 */
export function closeUpPlace(card) {
  if (card?.layerId !== 'place') return null;
  const airport = card.place?.airport;
  if (airport)
    return [
      airport.name,
      airport.city,
      countryName(airport.country, getLocale()),
    ]
      .filter(Boolean)
      .join(', ');
  return card.identity?.label || card.title || null;
}

/**
 * A city as the close-up map's caption gives it: its name and its country.
 * @param {{name?: string, country?: string}|null} city
 * @returns {string}
 */
export const cityCaption = (city) =>
  city?.name
    ? [city.name, countryName(city.country, getLocale())]
        .filter(Boolean)
        .join(', ')
    : '';

/**
 * A 3 by 3 block of tiles round a spot, each placed (in whole pixels, from
 * the spot) so the spot sits at the centre of the block and neighbouring
 * tiles meet without a seam. Rows past the poles are left out; columns wrap
 * round the antimeridian.
 * @param {number} lat
 * @param {number} lon
 * @param {number} zoom
 * @param {string} [template] The tile address, with `{z}`, `{y}` and `{x}`;
 *   Esri World Imagery unless given.
 * @returns {Array<{key: string, src: string, left: number, top: number}>}
 */
export function tileBlock(lat, lon, zoom, template = ESRI_TILES) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];
  const n = 2 ** zoom;
  const { x, y } = tilePosition(lon, lat, zoom);
  const cx = Math.floor(x);
  const cy = Math.floor(y);
  // The centre tile's corner, rounded once, so every tile is a whole
  // 256 px from the next.
  const originLeft = Math.round((cx - x) * TILE);
  const originTop = Math.round((cy - y) * TILE);
  const list = [];
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      const row = cy + dy;
      if (row < 0 || row >= n) continue;
      const column = (((cx + dx) % n) + n) % n;
      list.push({
        key: `${zoom}/${column}/${row}`,
        src: template
          .replace('{z}', zoom)
          .replace('{y}', row)
          .replace('{x}', column),
        left: originLeft + dx * TILE,
        top: originTop + dy * TILE,
      });
    }
  return list;
}

/** The map position captured when an item is pinned. */
export function pinMap(lat, lon, zoom = 13) {
  return onTileMap(lat) &&
    Number.isFinite(lon) &&
    Math.abs(lon) <= 180 &&
    Number.isInteger(zoom) &&
    zoom >= 0 &&
    zoom <= 22
    ? { lat, lon, zoom }
    : null;
}

/** Read the coordinate string kept by older pins. */
export function legacyPinMap(still) {
  const match =
    /^card-map:(\d{1,2})\/(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)$/.exec(still);
  return match
    ? pinMap(Number(match[2]), Number(match[3]), Number(match[1]))
    : null;
}
