export const USGS_WATER_LAYER_ID = 'san-antonio-usgs-water';
export const USGS_WATER_API =
  'https://api.waterdata.usgs.gov/ogcapi/v1/collections/';
export const USGS_WATER_BBOX = Object.freeze([-98.85, 29.05, -98.08, 29.85]);
export const USGS_OBSERVATION_TTL_MS = 15 * 60 * 1000;
export const USGS_METADATA_TTL_MS = 24 * 60 * 60 * 1000;
export const USGS_WINDOW_MS = 24 * 60 * 60 * 1000;
export const USGS_PROVISIONAL_URL =
  'https://waterdata.usgs.gov/provisional-data-statement/';

export const USGS_WATER_LIMITS = Object.freeze({
  pageSize: 500,
  batchSize: 50,
  maxObservations: 2000,
  maxLocations: 256,
  maxSeries: 2000,
  maxPages: 64,
  maxResponseBytes: 8 * 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
  timeoutMs: 60000,
});

/** Only validated USGS identities can form an official station link. */
export function usgsStationUrl(id) {
  if (!/^USGS-\d{4,15}$/.test(id))
    throw new TypeError('Invalid USGS monitoring location id');
  return `https://waterdata.usgs.gov/monitoring-location/${id}/`;
}
