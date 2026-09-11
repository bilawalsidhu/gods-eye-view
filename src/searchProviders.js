/**
 * Search-provider abstraction for God's Eye View.
 *
 * General geocoding and POI lookup are deliberately separate capabilities:
 * - Google Geocoding or OSM Nominatim resolves cities, regions, addresses and named features.
 * - Google Places or Foursquare resolves nearby POIs/venues.
 *
 * `auto` preserves existing Google behaviour when a Google key is configured, then falls back to
 * Nominatim for geocoding and Foursquare for POIs. Foursquare's service key stays server-side.
 */

function configuredGoogleKey() {
  const fromWindow = typeof window !== 'undefined' ? window.__GOOGLE_MAPS_API_KEY__ : '';
  const fromVite = import.meta?.env?.GOOGLE_MAPS_API_KEY || '';
  return String(fromWindow || fromVite || '').trim();
}

function finiteCoordinate(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normaliseNominatimTypes(item) {
  const category = String(item?.category || '').toLowerCase();
  const type = String(item?.type || '').toLowerCase();
  const addressType = String(item?.addresstype || '').toLowerCase();

  if (addressType === 'country' || type === 'country') return ['country'];
  if (['state', 'province', 'region', 'territory'].includes(addressType)
      || ['state', 'province', 'region', 'territory'].includes(type)) {
    return ['administrative_area_level_1'];
  }
  if (['county', 'district'].includes(addressType) || ['county', 'district'].includes(type)) {
    return ['administrative_area_level_2'];
  }
  if (['city', 'town', 'village', 'municipality'].includes(addressType)
      || ['city', 'town', 'village', 'municipality'].includes(type)) {
    return ['locality'];
  }
  if (['suburb', 'neighbourhood', 'neighborhood', 'quarter', 'borough'].includes(addressType)) {
    return ['neighborhood'];
  }
  if (category === 'highway' || ['road', 'street', 'residential', 'pedestrian'].includes(type)) {
    return ['route'];
  }
  if (['house', 'building', 'address'].includes(addressType) || category === 'building') {
    return ['street_address'];
  }
  if (category === 'leisure' && type === 'park') return ['park'];
  if (category === 'natural') return ['natural_feature'];
  if (category === 'aeroway' || ['aerodrome', 'airport'].includes(type)) return ['airport'];
  if (['university', 'college'].includes(type)) return ['university'];
  if (type === 'stadium') return ['stadium'];
  if (category === 'tourism') return ['tourist_attraction'];
  return ['establishment'];
}

function nominatimPrimaryName(item) {
  const named = item?.namedetails || {};
  if (typeof named.name === 'string' && named.name.trim()) return named.name.trim();
  const address = item?.address || {};
  for (const key of [
    'amenity', 'tourism', 'shop', 'building', 'attraction', 'road', 'neighbourhood',
    'suburb', 'city', 'town', 'village', 'municipality', 'county', 'state', 'country',
  ]) {
    if (typeof address[key] === 'string' && address[key].trim()) return address[key].trim();
  }
  return String(item?.display_name || '').split(',')[0].trim() || null;
}

export function normaliseNominatimResult(item) {
  const lat = finiteCoordinate(item?.lat);
  const lon = finiteCoordinate(item?.lon);
  if (lat === null || lon === null) return null;

  const bbox = Array.isArray(item?.boundingbox) ? item.boundingbox.map(Number) : [];
  const viewport = bbox.length === 4 && bbox.every(Number.isFinite)
    ? {
        southwest: { lat: bbox[0], lng: bbox[2] },
        northeast: { lat: bbox[1], lng: bbox[3] },
      }
    : null;

  return {
    lat,
    lon,
    label: String(item?.display_name || '').trim() || null,
    primaryName: nominatimPrimaryName(item),
    types: normaliseNominatimTypes(item),
    viewport,
    provider: 'nominatim',
  };
}

function extractGooglePrimaryName(result) {
  const resultTypes = new Set((result?.types || []).map((value) => String(value).toLowerCase()));
  const components = Array.isArray(result?.address_components) ? result.address_components : [];
  for (const component of components) {
    const componentTypes = (component?.types || []).map((value) => String(value).toLowerCase());
    if (componentTypes.some((value) => value !== 'political' && resultTypes.has(value))) {
      return component.long_name || null;
    }
  }
  return components[0]?.long_name || String(result?.formatted_address || '').split(',')[0].trim() || null;
}

function normaliseGoogleResult(result) {
  const lat = finiteCoordinate(result?.geometry?.location?.lat);
  const lon = finiteCoordinate(result?.geometry?.location?.lng);
  if (lat === null || lon === null) return null;
  return {
    lat,
    lon,
    label: result.formatted_address || null,
    primaryName: extractGooglePrimaryName(result),
    types: Array.isArray(result.types) ? result.types : [],
    viewport: result.geometry?.bounds || result.geometry?.viewport || null,
    provider: 'google',
  };
}

/** Forward-geocode a free-text place query. */
export async function forwardGeocode(query, { biasRect = null, signal, provider = 'auto' } = {}) {
  const q = String(query || '').trim();
  if (!q) return null;

  const googleKey = configuredGoogleKey();
  const chosen = provider === 'auto' ? (googleKey ? 'google' : 'nominatim') : provider;

  if (chosen === 'google') {
    if (!googleKey) return null;
    let url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(q)}&key=${googleKey}`;
    if (biasRect) url += `&bounds=${encodeURIComponent(biasRect)}`;
    const response = await fetch(url, { signal });
    if (response.ok === false) throw new Error(`Google geocoding failed: HTTP ${response.status}`);
    const data = await response.json();
    if (data?.status !== 'OK' || !Array.isArray(data?.results) || !data.results.length) return null;
    return normaliseGoogleResult(data.results[0]);
  }

  if (chosen !== 'nominatim') throw new Error(`Unknown geocoding provider: ${chosen}`);
  const params = new URLSearchParams({ q });
  if (biasRect) params.set('bias', biasRect);
  const response = await fetch(`/api/nominatim/search?${params}`, { signal });
  if (response.ok === false) throw new Error(`Nominatim geocoding failed: HTTP ${response.status}`);
  const data = await response.json();
  return normaliseNominatimResult(data?.result || null);
}

/**
 * Search a named POI near the supplied centre. Results are normalised to the shape used by the
 * existing Google Places recovery path. `auto` preserves Google when configured, else FSQ.
 */
export async function searchPlaces(query, centerLat, centerLon, radiusM, signal, provider = 'auto') {
  const q = String(query || '').trim();
  if (!q || !Number.isFinite(centerLat) || !Number.isFinite(centerLon)) return [];

  const googleKey = configuredGoogleKey();
  const chosen = provider === 'auto' ? (googleKey ? 'google' : 'foursquare') : provider;
  const params = new URLSearchParams({
    q,
    lat: String(centerLat),
    lon: String(centerLon),
    radiusM: String(radiusM),
  });

  const endpoint = chosen === 'google'
    ? '/api/google/text-search'
    : chosen === 'foursquare'
      ? '/api/foursquare/place-search'
      : null;
  if (!endpoint) return [];

  const response = await fetch(`${endpoint}?${params}`, { signal });
  if (response.status === 404 || response.status === 503) return [];
  if (response.ok === false) throw new Error(`${chosen} place search failed: HTTP ${response.status}`);
  const data = await response.json();
  return Array.isArray(data?.places) ? data.places : [];
}
