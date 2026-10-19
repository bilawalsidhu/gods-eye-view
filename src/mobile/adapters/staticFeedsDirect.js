import { normalizeFirePerimeterSnapshot } from '../../layers/perimeters/records.js';
import { validateCycloneSnapshot } from '../../layers/cyclones/source.js';
import { isAllowedGbfsHost, isAllowedGbfsPath } from '../../data/gbfsSource.js';
import {
  normalizeRadioBrowserStation,
  publicRadioStation,
} from '../../sources/radioBrowser.js';
import { RADIO_UUID_RE } from '../../layers/radio/policy.js';
import { filterTrailing24h, parseFirmsCsv } from '../../data/firmsCsv.js';
import {
  UPSTREAM_NOT_ALLOWED,
  asUnavailable,
  isUpstreamRefusal,
} from '../sourcePolicy.js';

/**
 * Keyless on-device static feeds: fire perimeters (NIFC WFIGS), cyclones
 * (NHC status + GIS), GBFS bikeshare, Radio Browser directory, and FIRMS
 * fire detections (vault key only). Portable normalizers are reused wherever
 * they exist; WFIGS/NHC/adsbdb-adjacent parsing that only exists server-side
 * is ported here with the same validation rules (never imported from
 * `server/`, which the browser bundle must not reach).
 *
 * @module mobile/adapters/staticFeedsDirect
 */

// ---------------------------------------------------------------------------
// fire perimeters (NIFC WFIGS)
// ---------------------------------------------------------------------------

/** WFIGS current interagency perimeters query (public, keyless). */
export const WFIGS_QUERY_URL =
  'https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/' +
  'WFIGS_Interagency_Perimeters_Current/FeatureServer/0/query?' +
  new URLSearchParams({
    where: '1=1',
    outFields: [
      'poly_IncidentName',
      'attr_UniqueFireIdentifier',
      'attr_IncidentSize',
      'attr_PercentContained',
      'attr_POOState',
      'attr_IncidentTypeCategory',
      'attr_FireDiscoveryDateTime',
      'poly_DateCurrent',
      'attr_FireCause',
      'attr_FireBehaviorGeneral',
      'attr_TotalIncidentPersonnel',
      'attr_POOCounty',
      'attr_EstimatedCostToDate',
      'attr_IncidentComplexityLevel',
      'attr_CpxName',
    ].join(','),
    maxAllowableOffset: '0.001',
    outSR: '4326',
    f: 'geojson',
  }).toString();

/** Peak seasons exceed one response page; the service reports the overflow. */
export const WFIGS_MAX_PAGES = 5;

/** Per-page body ceiling (mirrors the server proxy's 16 MiB). */
export const WFIGS_PAGE_CAP_BYTES = 16 * 1024 * 1024;

const wfigsOverflow = (payload) =>
  payload?.exceededTransferLimit === true ||
  payload?.properties?.exceededTransferLimit === true;

/**
 * Create the keyless on-device fire-perimeter source.
 * @param {{ fetchImpl?: Function }} options Caller-owned transport.
 * @returns {{ getSnapshot: Function }} WFIGS rows in the layer shape.
 */
export function createFirePerimeterDirectSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    /**
     * Read current perimeters (paged like the server proxy).
     * @param {{ signal?: AbortSignal }} options Caller signal.
     * @returns {Promise<object[]>} Normalized perimeter rows.
     */
    async getSnapshot({ signal } = {}) {
      const features = [];
      try {
        for (let page = 0; page < WFIGS_MAX_PAGES; page += 1) {
          signal?.throwIfAborted();
          const url =
            page === 0
              ? WFIGS_QUERY_URL
              : `${WFIGS_QUERY_URL}&resultOffset=${features.length}`;
          const response = await fetchImpl(url, {
            signal,
            capBytes: WFIGS_PAGE_CAP_BYTES,
          });
          if (!response.ok) throw new Error(`WFIGS HTTP ${response.status}`);
          const payload = await response.json();
          signal?.throwIfAborted();
          if (!Array.isArray(payload?.features)) {
            throw new Error('invalid_snapshot');
          }
          features.push(...payload.features);
          if (!wfigsOverflow(payload) || !payload.features.length) break;
        }
      } catch (error) {
        if (isUpstreamRefusal(error)) throw asUnavailable(error);
        throw error;
      }
      const rows = normalizeFirePerimeterSnapshot({ features });
      if (!rows) throw new Error('invalid_snapshot');
      return rows;
    },
  };
}

// ---------------------------------------------------------------------------
// cyclones (NHC CurrentStorms + tropical GIS)
// ---------------------------------------------------------------------------

/** NHC active-storm status document (public, keyless). */
export const CYCLONE_STATUS_URL = 'https://www.nhc.noaa.gov/CurrentStorms.json';

/** NOAA tropical GIS service root (public, keyless). */
export const CYCLONE_GIS_ROOT =
  'https://mapservices.weather.noaa.gov/tropical/rest/services/tropical/NHC_tropical_weather_summary/MapServer';

/** GIS layers: forecast points, track lines, cones (mirrors the proxy). */
export const CYCLONE_GIS_LAYERS = Object.freeze([
  Object.freeze({ id: 5, cap: 512 * 1024, count: 500, kind: 'points' }),
  Object.freeze({ id: 6, cap: 512 * 1024, count: 32, kind: 'track' }),
  Object.freeze({ id: 7, cap: 2 * 1024 * 1024, count: 32, kind: 'cone' }),
]);

/** Status document ceiling (mirrors the proxy's 128 KiB). */
export const CYCLONE_STATUS_CAP_BYTES = 128 * 1024;

const CYCLONE_COVERAGE =
  'Atlantic and eastern/central North Pacific; not worldwide cyclone coverage.';
const CYCLONE_SOURCE = 'NOAA NHC / CPHC';
const CYCLONE_ATTRIBUTION =
  'NOAA/NWS National Hurricane Center / Central Pacific Hurricane Center';

function invalidCyclone() {
  return new Error('invalid_cyclone_data');
}

function cycloneText(value, max = 80) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > max ||
    /[\u0000-\u001f<>]/.test(value)
  ) {
    throw invalidCyclone();
  }
  return value.trim();
}

function cycloneAdvisory(value) {
  if (typeof value !== 'string' || !/^\d{1,3}[A-Z]?$/i.test(value)) {
    throw invalidCyclone();
  }
  return value.replace(/^0+(?=\d)/, '').toUpperCase();
}

function cycloneNumber(value, min, max) {
  if (
    value === null ||
    value === undefined ||
    value === '' ||
    !['string', 'number'].includes(typeof value)
  ) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max
    ? parsed
    : null;
}

function cycloneIso(value, nowMs) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value)
  ) {
    throw invalidCyclone();
  }
  const parsed = Date.parse(value);
  if (
    !Number.isFinite(parsed) ||
    parsed > nowMs + 5 * 60_000 ||
    nowMs - parsed > 12 * 3600_000 ||
    new Date(parsed).toISOString().replace('.000Z', 'Z') !==
      value.replace('.000Z', 'Z')
  ) {
    throw invalidCyclone();
  }
  return new Date(parsed).toISOString();
}

function cyclonePosition(coordinates) {
  if (
    !Array.isArray(coordinates) ||
    coordinates.length !== 2 ||
    !coordinates.every(
      (part) => typeof part === 'number' && Number.isFinite(part),
    ) ||
    Math.abs(coordinates[0]) > 180 ||
    Math.abs(coordinates[1]) > 90
  ) {
    throw invalidCyclone();
  }
  return { longitude: coordinates[0], latitude: coordinates[1] };
}

function cycloneOfficialLink(value) {
  if (typeof value !== 'string' || value.length > 256) return null;
  try {
    const url = new URL(value);
    return url.origin === 'https://www.nhc.noaa.gov' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      /^\/text\/[A-Z0-9]+\.shtml$/.test(url.pathname)
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/**
 * Parse the NHC active-storm list into pending-geometry storm records
 * (same rules as the server proxy).
 * @param {*} payload Parsed CurrentStorms.json body.
 * @param {number} nowMs Reference time.
 * @returns {object[]} Storm records.
 */
export function parseCycloneStatus(payload, nowMs) {
  if (
    !Array.isArray(payload?.activeStorms) ||
    payload.activeStorms.length > 32
  ) {
    throw invalidCyclone();
  }
  const seen = new Set();
  return payload.activeStorms.map((raw) => {
    if (
      typeof raw?.id !== 'string' ||
      !/^(?:al|ep|cp)\d{6}$/.test(raw.id) ||
      seen.has(raw.id)
    ) {
      throw invalidCyclone();
    }
    seen.add(raw.id);
    const advisory = raw.forecastAdvisory;
    return {
      id: raw.id,
      name: cycloneText(raw.name),
      classification: cycloneText(raw.classification, 16),
      basin: raw.id.slice(0, 2).toUpperCase(),
      position: cyclonePosition([raw.longitudeNumeric, raw.latitudeNumeric]),
      positionAt: cycloneIso(raw.lastUpdate, nowMs),
      advisoryNumber: cycloneAdvisory(advisory?.advNum),
      issuedAt: cycloneIso(advisory?.issuance, nowMs),
      windKt: cycloneNumber(raw.intensity, 0, 300),
      pressureHpa: cycloneNumber(raw.pressure, 800, 1100),
      movement: {
        directionDegrees: cycloneNumber(raw.movementDir, 0, 360),
        speedKt: cycloneNumber(raw.movementSpeed, 0, 200),
      },
      advisoryUrl: cycloneOfficialLink(advisory?.url),
      outlookUrl: raw.id.startsWith('al')
        ? 'https://www.nhc.noaa.gov/gtwo.php?basin=atlc&fdays=7'
        : raw.id.startsWith('cp')
          ? 'https://www.nhc.noaa.gov/gtwo.php?basin=cpac&fdays=7'
          : 'https://www.nhc.noaa.gov/gtwo.php?basin=epac&fdays=7',
      geometryStatus: 'pending',
      geometryAdvisoryNumber: null,
      forecastPoints: [],
      track: null,
      cone: null,
    };
  });
}

function cycloneGeometry(raw, kind, budget) {
  const types =
    kind === 'points'
      ? ['Point']
      : kind === 'track'
        ? ['LineString', 'MultiLineString']
        : ['Polygon', 'MultiPolygon'];
  if (!types.includes(raw?.type)) throw invalidCyclone();
  const point = (value) => {
    cyclonePosition(value);
    if (++budget.count > 25_000) throw invalidCyclone();
    return [...value];
  };
  const line = (value, ring = false) => {
    if (
      !Array.isArray(value) ||
      value.length < (ring ? 4 : 2) ||
      value.length > 10_000
    ) {
      throw invalidCyclone();
    }
    const result = value.map(point);
    if (
      ring &&
      (result[0][0] !== result.at(-1)[0] || result[0][1] !== result.at(-1)[1])
    ) {
      throw invalidCyclone();
    }
    return result;
  };
  const list = (value, read) => {
    if (!Array.isArray(value) || !value.length || value.length > 128) {
      throw invalidCyclone();
    }
    return value.map(read);
  };
  const polygon = (value) => list(value, (ring) => line(ring, true));
  const coordinates =
    raw.type === 'Point'
      ? point(raw.coordinates)
      : raw.type === 'LineString'
        ? line(raw.coordinates)
        : raw.type === 'MultiLineString'
          ? list(raw.coordinates, (part) => line(part))
          : raw.type === 'Polygon'
            ? polygon(raw.coordinates)
            : list(raw.coordinates, polygon);
  return { type: raw.type, coordinates };
}

/**
 * Attach GIS forecast geometry to status storms. Earlier geometry is never
 * relabeled with a newer advisory (same rule as the server proxy): storms
 * without a complete, advisory-matched set keep their pending status.
 * @param {object[]} storms Status records from {@link parseCycloneStatus}.
 * @param {object[]} collections GIS FeatureCollections (points, track, cone).
 * @returns {object[]} Storms with geometry where it validated.
 */
export function attachCycloneGeometry(storms, collections) {
  const budget = { count: 0 };
  const parsed = CYCLONE_GIS_LAYERS.map((spec, index) => {
    const payload = collections[index];
    if (
      payload?.type !== 'FeatureCollection' ||
      payload.exceededTransferLimit ||
      !Array.isArray(payload.features) ||
      payload.features.length > spec.count
    ) {
      throw invalidCyclone();
    }
    return payload.features.map((feature) => {
      if (feature?.type !== 'Feature') throw invalidCyclone();
      const properties = feature.properties;
      const source =
        typeof properties?.idp_source === 'string' &&
        properties.idp_source.match(
          /^((?:al|ep|cp)\d{6})-(\d{1,3}[a-z]?)_5day_(pts|lin|pgn)$/i,
        );
      if (!source || source[3].toLowerCase() !== ['pts', 'lin', 'pgn'][index]) {
        throw invalidCyclone();
      }
      const number = cycloneAdvisory(properties.advisnum);
      if (number !== cycloneAdvisory(source[2])) throw invalidCyclone();
      return {
        id: source[1].toLowerCase(),
        advisoryNumber: number,
        geometry: cycloneGeometry(feature.geometry, spec.kind, budget),
        tauHours: cycloneNumber(properties.tau, 0, 168),
        windKt: cycloneNumber(properties.maxwind, 0, 300),
        gustKt: cycloneNumber(properties.gust, 0, 350),
      };
    });
  });
  return storms.map((storm) => {
    const groups = parsed.map((items) =>
      items.filter(
        (item) =>
          item.id === storm.id && item.advisoryNumber === storm.advisoryNumber,
      ),
    );
    if (groups[1].length > 1 || groups[2].length > 1) throw invalidCyclone();
    if (!groups[0].length || groups[1].length !== 1 || groups[2].length !== 1) {
      return storm;
    }
    const seen = new Set();
    const forecastPoints = groups[0]
      .map((item) => {
        if (item.tauHours === null || seen.has(item.tauHours)) {
          throw invalidCyclone();
        }
        seen.add(item.tauHours);
        return {
          position: cyclonePosition(item.geometry.coordinates),
          tauHours: item.tauHours,
          windKt: item.windKt,
          gustKt: item.gustKt,
        };
      })
      .sort((a, b) => a.tauHours - b.tauHours);
    return {
      ...storm,
      geometryStatus: 'current',
      geometryAdvisoryNumber: storm.advisoryNumber,
      forecastPoints,
      track: groups[1][0].geometry,
      cone: groups[2][0].geometry,
    };
  });
}

function cycloneLayerUrl(spec) {
  const url = new URL(`${CYCLONE_GIS_ROOT}/${spec.id}/query`);
  url.search = new URLSearchParams({
    where: '1=1',
    outFields:
      spec.kind === 'points'
        ? 'idp_source,advisnum,tau,maxwind,gust'
        : 'idp_source,advisnum',
    outSR: '4326',
    resultRecordCount: String(spec.count),
    geometryPrecision: '4',
    f: 'geojson',
  }).toString();
  return url.href;
}

/**
 * Create the keyless on-device cyclone source.
 * @param {{ fetchImpl?: Function, now?: Function }} options Transport + clock.
 * @returns {{ getSnapshot: Function }} Layer-valid cyclone snapshot.
 */
export function createCycloneDirectSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  /**
   * Fetch one JSON document with the proxy's ceilings.
   */
  async function upstream(url, capBytes, signal) {
    signal?.throwIfAborted();
    const response = await fetchImpl(url, {
      signal,
      redirect: 'error',
      headers: {
        Accept: 'application/geo+json,application/json',
        'User-Agent': 'Gods Eye View (public NOAA weather context)',
      },
      capBytes,
    });
    if (!response.ok) throw new Error('cyclone_upstream_unavailable');
    const payload = await response.json();
    signal?.throwIfAborted();
    return payload;
  }

  return {
    /**
     * Read the NHC status plus GIS geometry into the layer snapshot shape.
     * @param {{ signal?: AbortSignal }} options Caller signal.
     * @returns {Promise<object>} Validated snapshot, or honest unavailable.
     */
    async getSnapshot({ signal } = {}) {
      const nowMs = now();
      let status;
      try {
        status = await upstream(
          CYCLONE_STATUS_URL,
          CYCLONE_STATUS_CAP_BYTES,
          signal,
        );
      } catch (error) {
        if (isUpstreamRefusal(error)) {
          return {
            schemaVersion: 1,
            source: CYCLONE_SOURCE,
            attribution: CYCLONE_ATTRIBUTION,
            coverage: CYCLONE_COVERAGE,
            fetchedAt: nowMs,
            stale: false,
            unavailable: UPSTREAM_NOT_ALLOWED,
            reason: 'Cyclone upstream not allowed on this device',
            storms: [],
          };
        }
        throw error;
      }
      let storms = parseCycloneStatus(status, nowMs);
      if (storms.length) {
        try {
          const collections = [];
          for (const spec of CYCLONE_GIS_LAYERS) {
            collections.push(
              await upstream(cycloneLayerUrl(spec), spec.cap, signal),
            );
          }
          storms = attachCycloneGeometry(storms, collections);
        } catch {
          signal?.throwIfAborted();
          storms = storms.map((storm) => ({
            ...storm,
            geometryStatus: 'unavailable',
          }));
        }
      }
      signal?.throwIfAborted();
      return validateCycloneSnapshot({
        schemaVersion: 1,
        source: CYCLONE_SOURCE,
        attribution: CYCLONE_ATTRIBUTION,
        coverage: CYCLONE_COVERAGE,
        fetchedAt: nowMs,
        stale: false,
        unavailable: false,
        reason: null,
        storms,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// gbfs
// ---------------------------------------------------------------------------

/** Per-document body ceiling (mirrors the server proxy's 5 MiB). */
export const GBFS_DIRECT_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Create the keyless on-device GBFS source (fetches the operator document
 * directly instead of through `/api/gbfs/`).
 * @param {{ fetchImpl?: Function }} options Caller-owned transport.
 * @returns {{ getStations: Function }} Upstream GBFS document reader.
 */
export function createGbfsDirectSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    /**
     * Read one GBFS station document.
     * @param {string} upstreamUrl Public HTTPS GBFS document URL.
     * @param {{ signal?: AbortSignal }} options Caller signal.
     * @returns {Promise<object>} Parsed document, or honest unavailable.
     */
    async getStations(upstreamUrl, { signal } = {}) {
      let url;
      try {
        url = new URL(String(upstreamUrl));
      } catch {
        throw new TypeError('A public HTTPS GBFS URL is required');
      }
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.hash ||
        !isAllowedGbfsHost(url.hostname) ||
        !isAllowedGbfsPath(url.pathname)
      ) {
        throw new TypeError(
          'Only station_information/station_status endpoints on allowlisted GBFS hosts are allowed',
        );
      }
      signal?.throwIfAborted();
      let response;
      try {
        response = await fetchImpl(url.href, {
          signal,
          headers: { Accept: 'application/json' },
          capBytes: GBFS_DIRECT_MAX_BYTES,
        });
      } catch (error) {
        if (isUpstreamRefusal(error)) {
          return { unavailable: UPSTREAM_NOT_ALLOWED };
        }
        throw error;
      }
      signal?.throwIfAborted();
      if (!response.ok) throw new Error(`GBFS HTTP ${response.status}`);
      const payload = await response.json();
      signal?.throwIfAborted();
      if (!payload || typeof payload !== 'object') {
        throw new Error('Malformed GBFS payload');
      }
      return payload;
    },
  };
}

// ---------------------------------------------------------------------------
// radio
// ---------------------------------------------------------------------------

/**
 * Radio Browser mirror origins. Same pool as the server proxy's fallbacks
 * (kept as literals: `server/` must stay out of the browser bundle).
 */
export const RADIO_DIRECT_MIRRORS = Object.freeze([
  'https://de1.api.radio-browser.info',
  'https://de2.api.radio-browser.info',
  'https://nl1.api.radio-browser.info',
]);

/**
 * Single-level mirror host rule, identical to the server proxy's transport
 * check — deliberately tighter than Task 2's registry wildcard, which
 * admits multi-level subdomains.
 */
export const RADIO_MIRROR_HOST_RE = /^[a-z0-9-]+\.api\.radio-browser\.info$/;

/** Stations per directory read (matches the tuner directory limit). */
export const RADIO_DIRECT_LIMIT = 750;

/**
 * Resolve a mirror to its origin, or null unless it is a single-level
 * Radio Browser mirror host (scheme pinned to HTTPS, no ports/creds).
 * @param {*} value Mirror candidate.
 * @returns {string|null} Origin or null.
 */
export function radioMirrorOrigin(value) {
  let url;
  try {
    url = new URL(String(value ?? ''));
  } catch {
    return null;
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    !RADIO_MIRROR_HOST_RE.test(hostname)
  ) {
    return null;
  }
  return `https://${hostname}`;
}

/**
 * Create the keyless on-device Radio Browser source.
 * @param {{ fetchImpl?: Function, mirrors?: string[] }} options Transport + mirror pool.
 * @returns {{ getDirectory: Function, recordClick: Function }} Directory + click reporting.
 */
export function createRadioDirectSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  mirrors = RADIO_DIRECT_MIRRORS,
} = {}) {
  const origins = [
    ...new Set(
      (Array.isArray(mirrors) ? mirrors : [])
        .map(radioMirrorOrigin)
        .filter(Boolean),
    ),
  ];
  if (!origins.length) {
    throw new TypeError('No usable Radio Browser mirror origin');
  }

  /**
   * Fetch a directory path from the first healthy mirror.
   */
  async function fetchFromMirrors(path, { signal } = {}) {
    let lastError = null;
    for (const origin of origins) {
      signal?.throwIfAborted();
      try {
        const response = await fetchImpl(`${origin}${path}`, {
          signal,
          headers: {
            'User-Agent': 'GodsEyeView/1.0 (Radio Browser directory client)',
          },
        });
        if (!response.ok) {
          lastError = new Error(`Radio Browser returned ${response.status}`);
          continue;
        }
        const rows = await response.json();
        signal?.throwIfAborted();
        return rows;
      } catch (error) {
        signal?.throwIfAborted();
        if (isUpstreamRefusal(error)) throw asUnavailable(error);
        lastError = error;
      }
    }
    throw lastError || new Error('No Radio Browser mirror is available');
  }

  return {
    /**
     * Read the station directory (one broad query; rows normalized with the
     * shared Radio Browser normalizer).
     * @param {{ signal?: AbortSignal }} options Caller signal.
     * @returns {Promise<object>} Proxy-shaped directory, or honest unavailable.
     */
    async getDirectory({ signal } = {}) {
      const params = new URLSearchParams({
        has_geo_info: 'true',
        is_https: 'true',
        hidebroken: 'true',
        order: 'clickcount',
        reverse: 'true',
        limit: String(RADIO_DIRECT_LIMIT),
      });
      let rows;
      try {
        rows = await fetchFromMirrors(`/json/stations/search?${params}`, {
          signal,
        });
      } catch (error) {
        if (isUpstreamRefusal(error)) {
          return { stations: [], unavailable: UPSTREAM_NOT_ALLOWED };
        }
        throw error;
      }
      if (!Array.isArray(rows)) {
        throw new Error('Radio Browser catalog payload was not an array');
      }
      const stations = rows
        .map(normalizeRadioBrowserStation)
        .filter(Boolean)
        .map(publicRadioStation);
      return {
        stations,
        updatedAt: new Date().toISOString(),
        stale: false,
        degraded: false,
        degradedReason: null,
        coverage: null,
        acceptedGeneration: null,
        catalogInstance: origins[0],
      };
    },
    /**
     * Report a station click (best-effort, like the server proxy's void).
     * @param {string} id Station UUID.
     * @param {{ signal?: AbortSignal }} options Caller signal.
     * @returns {Promise<void>}
     */
    async recordClick(id, { signal } = {}) {
      if (typeof id !== 'string' || !RADIO_UUID_RE.test(id)) {
        throw new Error('Invalid radio station id');
      }
      signal?.throwIfAborted();
      for (const origin of origins) {
        try {
          await fetchImpl(`${origin}/json/url/${encodeURIComponent(id)}`, {
            signal,
          });
          return;
        } catch (error) {
          signal?.throwIfAborted();
          if (isUpstreamRefusal(error)) return;
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// firms
// ---------------------------------------------------------------------------

/** VIIRS + MODIS near-real-time sources (mirrors the server proxy). */
export const FIRMS_SOURCES = Object.freeze([
  'VIIRS_NOAA20_NRT',
  'VIIRS_NOAA21_NRT',
  'VIIRS_SNPP_NRT',
  'MODIS_NRT',
]);

/** Per-source CSV cap mirrors the server proxy (16 MiB per response). */
export const FIRMS_CSV_CAP_BYTES = 16 * 1024 * 1024;

/** Snapshot freshness window, matching the proxy cache TTL. */
export const FIRMS_DIRECT_TTL_MS = 30 * 60_000;

/**
 * Build one FIRMS area-CSV URL. The MAP_KEY travels in the path segment
 * (never a query string) over HTTPS; error strings never include the URL.
 * @param {string} key FIRMS MAP_KEY.
 * @param {string} source VIIRS/MODIS source name.
 * @returns {string} Area query URL.
 */
export function firmsAreaUrl(key, source) {
  return (
    'https://firms.modaps.eosdis.nasa.gov/api/area/csv/' +
    `${encodeURIComponent(key)}/${source}/world/2`
  );
}

/**
 * Create the on-device FIRMS source (vault key only — keyless resolves
 * honest `{ unavailable: 'KEY_REQUIRED' }`, never a fake empty).
 * @param {{ fetchImpl?: Function, getKey?: Function, now?: Function }} options Transport, vault reader, clock.
 * @returns {{ getSnapshot: Function }} Proxy-shaped fire snapshot.
 */
export function createFirmsDirectSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  getKey = null,
  now = () => Date.now(),
} = {}) {
  return {
    /**
     * Read every area feed and merge detections into the proxy shape.
     * @param {{ signal?: AbortSignal }} options Caller signal.
     * @returns {Promise<object>} `{ fetchedAt, stale, ttlMs, sources,
     *   count, fires }`, or `{ unavailable }` without a key / on refusal.
     */
    async getSnapshot({ signal } = {}) {
      const key = typeof getKey === 'function' ? await getKey() : null;
      signal?.throwIfAborted();
      if (typeof key !== 'string' || !key) {
        return { unavailable: 'KEY_REQUIRED' };
      }
      const fires = [];
      const sources = [];
      let refused = false;
      for (const source of FIRMS_SOURCES) {
        signal?.throwIfAborted();
        let text;
        try {
          const response = await fetchImpl(firmsAreaUrl(key, source), {
            signal,
            capBytes: FIRMS_CSV_CAP_BYTES,
          });
          if (!response.ok) {
            sources.push({ source, count: 0, ok: false });
            continue;
          }
          text = await response.text();
        } catch (error) {
          if (isUpstreamRefusal(error)) {
            refused = true;
            sources.push({ source, count: 0, ok: false });
            continue;
          }
          throw error;
        }
        signal?.throwIfAborted();
        const records = parseFirmsCsv(text);
        if (!records) {
          sources.push({ source, count: 0, ok: false });
          continue;
        }
        fires.push(...records);
        sources.push({ source, count: records.length, ok: true });
      }
      if (!sources.some((entry) => entry.ok)) {
        if (refused) return { unavailable: UPSTREAM_NOT_ALLOWED };
        throw new Error('all FIRMS sources failed');
      }
      const windowed = filterTrailing24h(fires, now());
      return {
        fetchedAt: now(),
        stale: false,
        ttlMs: FIRMS_DIRECT_TTL_MS,
        sources,
        count: windowed.length,
        fires: windowed,
      };
    },
  };
}
