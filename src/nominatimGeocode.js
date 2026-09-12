/**
 * Map a Nominatim search hit into the Google Geocoding result shape that
 * searchAndFlyTo already frames (types + viewport). Pure — no network.
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

/** Google-style `types` for camera framing, derived from Nominatim class/type. */
export function typesFromNominatim(hit) {
  const addresstype = String(hit?.addresstype || '').toLowerCase();
  const osmType = String(hit?.type || '').toLowerCase();
  const osmClass = String(hit?.class || '').toLowerCase();
  const mapped = ADDRESS_TYPE_MAP[addresstype]
    || ADDRESS_TYPE_MAP[osmType]
    || (osmClass === 'highway' ? ['route'] : null)
    || (osmClass === 'leisure' ? ['park'] : null)
    || (osmClass === 'natural' ? ['natural_feature'] : null)
    || (osmClass === 'aeroway' ? ['airport'] : null)
    || (osmClass === 'amenity' && osmType === 'university' ? ['university'] : null);
  return mapped ? [...mapped] : ['point_of_interest', 'establishment'];
}

/**
 * Nominatim boundingbox is [south, north, west, east]. Returns the Google
 * viewport shape, or null when the box is missing/degenerate.
 */
export function viewportFromNominatim(hit) {
  const bbox = Array.isArray(hit?.boundingbox) ? hit.boundingbox.map(Number) : [];
  const [south, north, west, east] = bbox;
  if (![south, north, west, east].every(Number.isFinite)) return null;
  if (south >= north) return null;
  return {
    southwest: { lat: south, lng: west },
    northeast: { lat: north, lng: east },
  };
}

/** Convert one Nominatim search row into a Google Geocoding-style result. */
export function nominatimToGeocodeResult(hit) {
  const lat = Number(hit?.lat);
  const lng = Number(hit?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const viewport = viewportFromNominatim(hit);
  return {
    formatted_address: String(hit.display_name || hit.name || '').trim() || null,
    types: typesFromNominatim(hit),
    geometry: {
      location: { lat, lng },
      viewport,
      bounds: viewport,
    },
  };
}

/**
 * Translate GEV's Google-style `swLat,swLng|neLat,neLng` bias into Nominatim's
 * `viewbox=west,north,east,south`. Returns null when the string is unusable.
 */
export function nominatimViewboxFromBounds(bounds) {
  const match = String(bounds || '').trim()
    .match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)\|(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const swLat = Number(match[1]);
  const swLng = Number(match[2]);
  const neLat = Number(match[3]);
  const neLng = Number(match[4]);
  if (![swLat, swLng, neLat, neLng].every(Number.isFinite)) return null;
  if (swLat < -90 || neLat > 90 || swLat >= neLat) return null;
  return `${swLng},${neLat},${neLng},${swLat}`;
}
