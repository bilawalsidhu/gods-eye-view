import { withBase } from '../services/apiBase.js';
import { validCoordinate } from './geospatial.js';

function labels(values) {
  return [
    ...new Set(
      values
        .map((value) =>
          String(value || '')
            .replace(/[\x00-\x1f\x7f]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 120),
        )
        .filter(Boolean),
    ),
  ];
}

/** Normalize reverse-geocoder labels without exposing provider response objects. */
export function normalizeGoogleReverse(data) {
  if (data?.status !== 'OK' || !data.results?.length) return null;
  const result = data.results[0];
  const relevant = data.results.slice(0, 12);
  const components = Array.isArray(result.address_components)
    ? result.address_components
    : [];
  const component = (type) =>
    components.find((item) => item.types?.includes(type))?.long_name || null;
  return {
    formattedAddress: result.formatted_address || null,
    locality:
      component('locality') ||
      component('postal_town') ||
      component('administrative_area_level_2'),
    region: component('administrative_area_level_1'),
    country: component('country'),
    types: result.types || [],
    labels: labels(relevant.map((item) => item.formatted_address)).slice(0, 12),
    streetLabels: labels(
      relevant.flatMap((item) =>
        (item.address_components || [])
          .filter((entry) => entry.types?.includes('route'))
          .map((entry) => entry.long_name),
      ),
    ).slice(0, 12),
  };
}

/** Existing JSON protocols with application-selected endpoints and transport. */
export function createHttpGeospatialProvider({
  fetchImpl = (...args) => fetch(...args),
  resolveApiKey,
  endpoints = {},
} = {}) {
  const urls = {
    reverse: 'https://maps.googleapis.com/maps/api/geocode/json',
    textSearch: withBase('/api/google/text-search'),
    nearby: withBase('/api/google/nearby-places'),
    route: withBase('/api/route'),
    ...endpoints,
  };
  async function json(endpoint, params, { signal } = {}) {
    if (!endpoint) return null;
    const separator = endpoint.includes('?') ? '&' : '?';
    const response = await fetchImpl(
      `${endpoint}${separator}${new URLSearchParams(params)}`,
      { signal },
    );
    signal?.throwIfAborted();
    if (!response.ok) {
      await response.body?.cancel?.().catch(() => {});
      throw new Error('Geospatial service unavailable');
    }
    const data = await response.json();
    signal?.throwIfAborted();
    return data;
  }
  const places = (data) =>
    (Array.isArray(data?.places) ? data.places : [])
      .filter((place) => validCoordinate([place.longitude, place.latitude]))
      .slice(0, 20);
  return {
    attribution: {
      reverseGeocode: 'Google',
      textSearch: 'Google',
      nearby: 'Google',
      route: 'OpenStreetMap / OSRM',
    },
    routeProfiles: ['foot', 'car', 'bike'],
    async reverseGeocode(latitude, longitude, options) {
      const key = resolveApiKey?.();
      if (resolveApiKey && !key) return null;
      return normalizeGoogleReverse(
        await json(
          urls.reverse,
          { latlng: `${latitude},${longitude}`, ...(key ? { key } : {}) },
          options,
        ),
      );
    },
    async textSearch(query, { latitude, longitude, radiusM = 6000 }, options) {
      return places(
        await json(
          urls.textSearch,
          { q: query, lat: latitude, lon: longitude, radiusM },
          options,
        ),
      );
    },
    async nearby({ latitude, longitude, radiusM = 250 }, options) {
      return places(
        await json(
          urls.nearby,
          { lat: latitude, lon: longitude, radiusM },
          options,
        ),
      );
    },
    async route(coordinates, profile, options) {
      const coords = coordinates
        .map((pair) =>
          pair
            .slice(0, 2)
            .map((n) => n.toFixed(6))
            .join(','),
        )
        .join(';');
      const data = await json(urls.route, { profile, coords }, options);
      return data?.ok ? data : null;
    },
  };
}
