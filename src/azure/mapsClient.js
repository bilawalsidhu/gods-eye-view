import {
  fetchBffJson,
  finiteNumber,
  latitude,
  longitude,
} from './http.js';

export const AZURE_MAPS_BFF_CONTRACTS = Object.freeze({
  search: Object.freeze({
    method: 'GET',
    path: '/api/azure/maps/search',
    response: '{ results: AzureMapsSearchResult[], summary?: object }',
  }),
  reverseGeocode: Object.freeze({
    method: 'GET',
    path: '/api/azure/maps/reverse-geocode',
    response: '{ addresses: AzureMapsAddress[], summary?: object }',
  }),
  route: Object.freeze({
    method: 'POST',
    path: '/api/azure/maps/route',
    request: '{ coordinates: { latitude, longitude }[], travelMode?, traffic?, routeType?, language? }',
    response: '{ routes: AzureMapsRoute[] }',
  }),
  trafficStatus: Object.freeze({
    method: 'GET',
    path: '/api/azure/maps/traffic/status',
    response: '{ configured: boolean, available: boolean, reason?: string|null }',
  }),
});

function queryPath(path, entries) {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(entries)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(name, Array.isArray(value) ? value.join(',') : String(value));
  }
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

function ensureObject(data, label) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new TypeError(`${label} BFF response must be an object`);
  }
  return data;
}

export function azureMapsResultTypes(result) {
    const type = String(result?.type ?? '').toLowerCase();
    const entity = String(result?.address?.entityType ?? '').toLowerCase();
    const types = new Set();
    if (type.includes('poi')) types.add('point_of_interest');
    if (type.includes('street') && type.includes('cross')) types.add('intersection');
    else if (type.includes('street')) types.add('route');
    if (type.includes('address')) types.add('street_address');
    if (entity.includes('country') && !entity.includes('subdivision')) types.add('country');
    if (entity.includes('country') && entity.includes('subdivision')) types.add('administrative_area_level_1');
    if (entity.includes('municipalitysubdivision') || entity.includes('neighbourhood')) types.add('neighborhood');
    else if (entity.includes('municipality')) types.add('locality');
    if (entity.includes('postal')) types.add('postal_code');
    return [...types];
  }

export function azureMapsSearchResultToPlace(result) {
    const latitudeValue = Number(result?.position?.latitude);
    const longitudeValue = Number(result?.position?.longitude);
    if (!Number.isFinite(latitudeValue) || !Number.isFinite(longitudeValue)) return null;
    const address = result?.address || {};
    return {
      id: result?.id || null,
      lat: latitudeValue,
      lon: longitudeValue,
      label: address.freeformAddress || result?.name || null,
      primaryName: result?.name || address.freeformAddress || null,
      types: azureMapsResultTypes(result),
      viewport: null,
    };
  }

export function azureMapsRouteGeometry(route) {
    const geoJson = route?.geometry?.coordinates;
    if (Array.isArray(geoJson)) {
      const pairs = geoJson
        .map((point) => [Number(point?.[0]), Number(point?.[1])])
        .filter(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat));
      if (pairs.length >= 2) return pairs;
    }
    const points = (Array.isArray(route?.legs) ? route.legs : [])
      .flatMap((leg) => Array.isArray(leg?.points) ? leg.points : [])
      .map((point) => [Number(point?.longitude), Number(point?.latitude)])
      .filter(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat));
    return points.length >= 2 ? points : [];
}

/**
 * @typedef {{latitude:number, longitude:number}} AzureMapsCoordinate
 * @typedef {{
 *   id: string,
 *   type?: string,
 *   name: string,
 *   position: AzureMapsCoordinate,
 *   address?: {freeformAddress?:string, municipality?:string, countryCode?:string},
 *   score?: number
 * }} AzureMapsSearchResult
 * @typedef {{results: AzureMapsSearchResult[], summary?: object}} AzureMapsSearchResponse
 * @typedef {{
 *   formattedAddress: string,
 *   position: AzureMapsCoordinate,
 *   municipality?: string,
 *   countryCode?: string
 * }} AzureMapsAddress
 * @typedef {{addresses: AzureMapsAddress[], summary?: object}} AzureMapsReverseGeocodeResponse
 * @typedef {{
 *   summary: {lengthInMeters:number, travelTimeInSeconds:number, trafficDelayInSeconds?:number},
 *   legs?: object[],
 *   geometry?: object
 * }} AzureMapsRoute
 * @typedef {{routes: AzureMapsRoute[]}} AzureMapsRouteResponse
 * @typedef {{configured:boolean, available:boolean, reason?:string|null}} AzureMapsTrafficStatus
 */

export class AzureMapsBffClient {
  constructor({ fetchImpl = globalThis.fetch } = {}) {
    this.fetchImpl = fetchImpl;
  }

  /**
   * @param {string} query
   * @param {{limit?:number, language?:string, countrySet?:string|string[], latitude?:number, longitude?:number, signal?:AbortSignal}} options
   * @returns {Promise<AzureMapsSearchResponse>}
   */
  async search(query, options = {}) {
    const text = String(query ?? '').trim();
    if (!text) throw new TypeError('query is required');
    const limit = options.limit == null ? undefined : finiteNumber(options.limit, 'limit');
    const lat = options.latitude == null ? undefined : latitude(options.latitude);
    const lon = options.longitude == null ? undefined : longitude(options.longitude);
    if ((lat == null) !== (lon == null)) {
      throw new TypeError('latitude and longitude must be supplied together');
    }
    const data = await fetchBffJson(queryPath(AZURE_MAPS_BFF_CONTRACTS.search.path, {
      query: text,
      limit,
      language: options.language,
      countrySet: options.countrySet,
      lat,
      lon,
    }), { fetchImpl: this.fetchImpl, signal: options.signal });
    return ensureObject(data, 'Search');
  }

  /**
   * @param {AzureMapsCoordinate} coordinate
   * @param {{language?:string, signal?:AbortSignal}} options
   * @returns {Promise<AzureMapsReverseGeocodeResponse>}
   */
  async reverseGeocode(coordinate, options = {}) {
    const data = await fetchBffJson(queryPath(AZURE_MAPS_BFF_CONTRACTS.reverseGeocode.path, {
      lat: latitude(coordinate?.latitude),
      lon: longitude(coordinate?.longitude),
      language: options.language,
    }), { fetchImpl: this.fetchImpl, signal: options.signal });
    return ensureObject(data, 'Reverse geocode');
  }

  /**
   * @param {AzureMapsCoordinate[]} coordinates
   * @param {{travelMode?:string, traffic?:boolean, routeType?:string, language?:string, signal?:AbortSignal}} options
   * @returns {Promise<AzureMapsRouteResponse>}
   */
  async route(coordinates, options = {}) {
    if (!Array.isArray(coordinates) || coordinates.length < 2) {
      throw new TypeError('route requires at least two coordinates');
    }
    const normalized = coordinates.map((point) => ({
      latitude: latitude(point?.latitude),
      longitude: longitude(point?.longitude),
    }));
    const data = await fetchBffJson(AZURE_MAPS_BFF_CONTRACTS.route.path, {
      fetchImpl: this.fetchImpl,
      method: 'POST',
      signal: options.signal,
      body: {
        coordinates: normalized,
        ...(options.travelMode ? { travelMode: options.travelMode } : {}),
        ...(typeof options.traffic === 'boolean' ? { traffic: options.traffic } : {}),
        ...(options.routeType ? { routeType: options.routeType } : {}),
        ...(options.language ? { language: options.language } : {}),
      },
    });
    return ensureObject(data, 'Route');
  }

  /** @returns {Promise<AzureMapsTrafficStatus>} */
  async trafficStatus({ signal } = {}) {
    const data = await fetchBffJson(AZURE_MAPS_BFF_CONTRACTS.trafficStatus.path, {
      fetchImpl: this.fetchImpl,
      signal,
      cache: 'no-store',
    });
    return ensureObject(data, 'Traffic status');
  }

}
