/**
 * Map a Nominatim search hit into the result shape the camera framing already
 * reads (types + viewport). Pure — no network.
 *
 * Every numeric field arrives as a string from the upstream JSON and may be
 * absent, blank, or nonsense. A coordinate that is not a real coordinate must
 * be refused rather than coerced: `Number(null)` is 0, so a missing pair read
 * as `(0, 0)` would fly the operator to the Atlantic and look like a hit.
 */

const ADDRESS_TYPE_MAP = Object.freeze({
  country: ['country', 'political'],
  nation: ['country', 'political'],
  state: ['administrative_area_level_1', 'political'],
  province: ['administrative_area_level_1', 'political'],
  region: ['administrative_area_level_1', 'political'],
  county: ['administrative_area_level_2', 'political'],
  district: ['administrative_area_level_2', 'political'],
  municipality: ['locality', 'political'],
  city: ['locality', 'political'],
  town: ['locality', 'political'],
  village: ['locality', 'political'],
  hamlet: ['locality', 'political'],
  suburb: ['neighborhood', 'political'],
  neighbourhood: ['neighborhood', 'political'],
  neighborhood: ['neighborhood', 'political'],
  quarter: ['neighborhood', 'political'],
  postcode: ['postal_code'],
  road: ['route'],
  highway: ['route'],
  peak: ['natural_feature'],
  mountain_range: ['natural_feature'],
  wood: ['natural_feature'],
  forest: ['natural_feature'],
  park: ['park'],
  nature_reserve: ['park', 'natural_feature'],
  aerodrome: ['airport'],
  airport: ['airport'],
  university: ['university'],
  stadium: ['stadium'],
  island: ['natural_feature'],
});

/**
 * Read a field that must be a finite number inside a range.
 *
 * Null, undefined, blank, whitespace, booleans, arrays and anything that does
 * not parse cleanly all return null. Only a string or number is considered, so
 * `Number([])` and `Number(true)` cannot become 0 and 1.
 *
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @returns {number|null}
 */
function boundedNumber(value, min, max) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return parsed >= min && parsed <= max ? parsed : null;
}

/** A latitude that is really a latitude, or null. */
export function nominatimLatitude(value) {
  return boundedNumber(value, -90, 90);
}

/** A longitude that is really a longitude, or null. */
export function nominatimLongitude(value) {
  return boundedNumber(value, -180, 180);
}

/** Framing types for the camera, derived from the hit's class and type. */
export function typesFromNominatim(hit) {
  const addresstype = String(hit?.addresstype || '').toLowerCase();
  const osmType = String(hit?.type || '').toLowerCase();
  const osmClass = String(hit?.class || '').toLowerCase();
  const mapped =
    ADDRESS_TYPE_MAP[addresstype] ||
    ADDRESS_TYPE_MAP[osmType] ||
    (osmClass === 'highway' ? ['route'] : null) ||
    (osmClass === 'leisure' ? ['park'] : null) ||
    (osmClass === 'natural' ? ['natural_feature'] : null) ||
    (osmClass === 'aeroway' ? ['airport'] : null) ||
    (osmClass === 'amenity' && osmType === 'university'
      ? ['university']
      : null);
  return mapped ? [...mapped] : ['point_of_interest', 'establishment'];
}

/**
 * The hit's bounding box as a viewport, or null.
 *
 * Nominatim gives `[south, north, west, east]` as strings. A box with an edge
 * outside the real world, an inverted edge, or a missing value is refused —
 * framing a viewport with a longitude of 999 sends the camera to nowhere.
 *
 * @param {object} hit
 * @returns {{southwest: {lat: number, lng: number}, northeast: {lat: number, lng: number}}|null}
 */
export function viewportFromNominatim(hit) {
  const box = Array.isArray(hit?.boundingbox) ? hit.boundingbox : [];
  if (box.length !== 4) return null;
  const south = nominatimLatitude(box[0]);
  const north = nominatimLatitude(box[1]);
  const west = nominatimLongitude(box[2]);
  const east = nominatimLongitude(box[3]);
  if (south === null || north === null || west === null || east === null)
    return null;
  if (south > north) return null;
  return {
    southwest: { lat: south, lng: west },
    northeast: { lat: north, lng: east },
  };
}

/**
 * Convert one Nominatim hit into a geocoding result, or null.
 *
 * @param {object} hit
 * @returns {{geometry: object, formatted_address: string, types: string[], address_components: object[]}|null}
 */
export function nominatimToGeocodeResult(hit) {
  const lat = nominatimLatitude(hit?.lat);
  const lng = nominatimLongitude(hit?.lon);
  if (lat === null || lng === null) return null;
  const label = String(hit?.display_name || hit?.name || '').trim();
  if (!label) return null;
  const types = typesFromNominatim(hit);
  const viewport = viewportFromNominatim(hit);
  const canonical = String(hit?.name || '').trim();
  return {
    geometry: {
      location: { lat, lng },
      ...(viewport ? { bounds: viewport, viewport } : {}),
    },
    formatted_address: label,
    types,
    address_components: canonical
      ? [{ long_name: canonical, short_name: canonical, types: [...types] }]
      : [],
  };
}

/**
 * Translate a `swLat,swLng|neLat,neLng` bias into Nominatim's
 * `viewbox=west,north,east,south`, or null when the string is unusable.
 *
 * Both edges are range-checked. A viewbox naming a longitude of 999 is not a
 * hint the upstream can use, and sending it is a malformed request rather than
 * a soft one.
 *
 * @param {string} bounds
 * @returns {string|null}
 */
export function nominatimViewboxFromBounds(bounds) {
  const match = String(bounds || '')
    .trim()
    .match(
      /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)\|(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/,
    );
  if (!match) return null;
  const swLat = nominatimLatitude(match[1]);
  const swLng = nominatimLongitude(match[2]);
  const neLat = nominatimLatitude(match[3]);
  const neLng = nominatimLongitude(match[4]);
  if ([swLat, swLng, neLat, neLng].some((value) => value === null)) return null;
  if (swLat >= neLat) return null;
  return `${swLng},${neLat},${neLng},${swLat}`;
}
