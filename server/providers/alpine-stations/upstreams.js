/**
 * Every Alpine-station upstream, as a fixed URL with its own read cap.
 *
 * Fixed because nothing a visitor sends reaches these: the route takes no
 * destination parameter, so the proxy cannot be pointed anywhere. The only
 * query value assembled at runtime is GeoSphere's `station_ids`, and that is
 * built from GeoSphere's own metadata response, not from a request.
 *
 * Caps are measured against the real payloads, with headroom:
 *
 *   SLF measurements    ~3.2 MB   (~9,500 rows, the whole rolling window)
 *   SLF stations        ~31 KB
 *   SwissMetNet meta    ~153 KB
 *   SwissMetNet VQHA80  ~16 KB
 *   TAWES metadata      ~87 KB
 *   TAWES observations  ~210 KB
 */

const KIB = 1024;
const MIB = 1024 * KIB;

/** Upstream wait ceiling. The SLF measurement payload is the slow one. */
export const UPSTREAM_TIMEOUT_MS = 25_000;

/**
 * Refresh windows.
 *
 * SLF publishes every 30 minutes and SwissMetNet and TAWES every 10, so a
 * five-minute window never serves data older than one publication while
 * cutting a 3 MB re-read that would change nothing.
 *
 * Station metadata is identity, not weather: names, cantons, altitudes and
 * positions change when a network is re-surveyed, so it is held for a day.
 */
export const OBSERVATION_CACHE_MS = 5 * 60 * 1000;
export const METADATA_CACHE_MS = 24 * 60 * 60 * 1000;

/**
 * How stale a cached payload may be and still be worth serving.
 *
 * A mountain-station map a few hours old beats an empty one, and the response
 * says it is cached. Past this the layer is better off reporting nothing.
 */
export const MAX_SERVE_STALE_MS = 12 * 60 * 60 * 1000;

export const SLF_STATIONS_URL =
  'https://measurement-api.slf.ch/public/api/imis/stations';
export const SLF_MEASUREMENTS_URL =
  'https://measurement-api.slf.ch/public/api/imis/measurements';
export const SLF_STATIONS_MAX_BYTES = 2 * MIB;
export const SLF_MEASUREMENTS_MAX_BYTES = 24 * MIB;

export const SMN_METADATA_URL =
  'https://data.geo.admin.ch/ch.meteoschweiz.ogd-smn/ogd-smn_meta_stations.csv';
export const SMN_OBSERVATIONS_URL =
  'https://data.geo.admin.ch/ch.meteoschweiz.messwerte-aktuell/VQHA80.csv';
export const SMN_METADATA_MAX_BYTES = 4 * MIB;
export const SMN_OBSERVATIONS_MAX_BYTES = 2 * MIB;

/**
 * The metadata file is ISO-8859-1, not UTF-8.
 *
 * `response.text()` assumes UTF-8 and mangles Oberägeri, Bière, Lötschental
 * and Château-d'Oex, so these bytes are read as bytes and decoded explicitly.
 */
export const SMN_METADATA_ENCODING = 'iso-8859-1';

export const TAWES_DATASET =
  'https://dataset.api.hub.geosphere.at/v1/station/current/tawes-v1-10min';
export const TAWES_METADATA_URL = `${TAWES_DATASET}/metadata`;
export const TAWES_METADATA_MAX_BYTES = 4 * MIB;
export const TAWES_OBSERVATIONS_MAX_BYTES = 8 * MIB;

/**
 * Stations per observation request.
 *
 * GeoSphere requires an explicit id list and the whole active network is about
 * 286 ids, roughly 1.8 KB of query string. Chunking keeps the URL well inside
 * any proxy's line limit and bounds the damage if the network grows.
 */
export const TAWES_STATIONS_PER_REQUEST = 150;
