import {
  nominatimToGeocodeResult,
  nominatimViewboxFromBounds,
} from '../nominatimGeocode.js';
import { validCoordinate } from '../search/geospatial.js';
import { normalizeRegionalPlace } from '../data/regionalModel.js';
import { readResponseJsonCapped } from './httpBody.js';

/** Retain the established framing/type rules for JSON and JSONv2 results. */
export function normalizeNominatimResult(hit) {
  return nominatimToGeocodeResult(
    hit && { ...hit, class: hit.class || hit.category },
  );
}

export function normalizeNominatimReverse(hit) {
  const result = normalizeNominatimResult(hit);
  const region = normalizeRegionalPlace(hit);
  if (!result || !region) return null;
  const clean = (value) =>
    String(value || '')
      .replace(/[\x00-\x1f\x7f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);
  const street = clean(hit.address?.road || hit.address?.pedestrian);
  return {
    formattedAddress: result.formatted_address,
    locality: region.locality,
    region: region.region,
    country: region.country,
    types: result.types,
    labels: [clean(result.formatted_address)].filter(Boolean),
    streetLabels: street ? [street] : [],
  };
}

/**
 * Nominatim JSONv2 transport for explicitly configured endpoints. Callers own
 * scheduling and request headers; this does not select a public instance.
 */
export function createNominatimClient({
  searchEndpoint,
  reverseEndpoint,
  fetchImpl = (...args) => fetch(...args),
} = {}) {
  for (const endpoint of [searchEndpoint, reverseEndpoint]) {
    if (endpoint == null) continue;
    if (typeof endpoint !== 'string' || !endpoint || /[?#]/.test(endpoint))
      throw new TypeError('A query-free Nominatim endpoint is required');
    const url = new URL(endpoint, 'http://localhost');
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      !(
        (endpoint.startsWith('/') && !endpoint.startsWith('//')) ||
        /^https?:\/\//.test(endpoint)
      )
    )
      throw new TypeError('Invalid Nominatim endpoint');
  }
  async function request(endpoint, params, signal) {
    signal?.throwIfAborted();
    const response = await fetchImpl(
      `${endpoint}?${new URLSearchParams({
        format: 'jsonv2',
        addressdetails: '1',
        ...params,
      })}`,
      { signal, redirect: 'error' },
    );
    signal?.throwIfAborted();
    if (!response.ok) {
      await response.body?.cancel?.().catch(() => {});
      throw new Error('Geocoding service unavailable');
    }
    return readResponseJsonCapped(response, 512 * 1024, signal);
  }
  return {
    ...(searchEndpoint
      ? {
          async search(query, { bias, signal } = {}) {
            const viewbox = nominatimViewboxFromBounds(bias);
            const rows = await request(
              searchEndpoint,
              {
                q: query,
                limit: '1',
                ...(viewbox ? { viewbox, bounded: '0' } : {}),
              },
              signal,
            );
            if (!Array.isArray(rows))
              throw new Error('Invalid geocoding response');
            if (rows.length && !normalizeNominatimResult(rows[0]))
              throw new Error('Invalid geocoding result');
            return rows;
          },
        }
      : {}),
    ...(reverseEndpoint
      ? {
          async reverse(latitude, longitude, { signal } = {}) {
            if (!validCoordinate([longitude, latitude])) return null;
            const row = await request(
              reverseEndpoint,
              { lat: latitude, lon: longitude },
              signal,
            );
            // A successful, explicit no-result response is distinct from malformed data.
            if (row?.error === 'Unable to geocode') return null;
            if (!normalizeNominatimReverse(row))
              throw new Error('Invalid reverse geocoding result');
            return row;
          },
        }
      : {}),
  };
}
