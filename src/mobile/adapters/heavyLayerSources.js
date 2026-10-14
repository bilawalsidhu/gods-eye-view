import { UPSTREAM_NOT_ALLOWED, asUnavailable } from '../sourcePolicy.js';
import { createTransitDirectSource } from './transitDirect.js';
import { createWindDirectSource } from './windDirect.js';
import { createCctvDirectSource, setCctvCatalog } from './cctvDirect.js';
import { createOverpassDirectSource } from './overpassDirect.js';
import { createNoaaTilesDirectSource } from './noaaTilesDirect.js';
import { createFlightsDirectSource } from './flightsDirect.js';
import { createAdsbdbDirectSource } from './adsbdbDirect.js';
import { createVesselsLiveSource } from './vesselsLive.js';
import {
  normalizeVesselTrack,
  vesselSnapshot,
} from '../../sources/live/vessels.js';
import { createCreditGovernor } from '../governors.js';
import { openSkySnapshot } from '../../sources/live/aircraft.js';
import { LiveSourceError } from '../../sources/live/contract.js';
import { validateWeatherSnapshot } from '../../layers/weather/source.js';

/**
 * Layer-boundary shape adapters for the five heavy on-device families.
 *
 * Each factory below returns the LEGACY layer-source shape while fetching
 * through the direct adapter, so `createStandaloneLayerSources` can select
 * direct on-device (`shouldUseDirect()`) without changing the web build.
 * Refusals follow the sourcePolicy contract: object-returning methods resolve
 * `{ unavailable: 'UPSTREAM_NOT_ALLOWED' }`; the transit Response-like
 * answers `{ ok: false, status: 503 }` with the marker as its JSON body.
 *
 * @module mobile/adapters/heavyLayerSources
 */

/**
 * Transit layer source backed by direct GTFS-RT fetches.
 * Legacy shape: `{ getFeeds, getHistory, requestSnapshot }`.
 * @param {{ fetchImpl?: Function }} transport Caller-owned transport.
 * @returns {{ getFeeds: Function, getHistory: Function, requestSnapshot: Function }}
 */
export function createTransitDirectLayerSource({ fetchImpl } = {}) {
  const direct = createTransitDirectSource(fetchImpl ? { fetchImpl } : {});
  return {
    /**
     * Read the public catalog of enabled feeds.
     * @param {{ signal?: AbortSignal }} options
     * @returns {Promise<Array<object>>}
     */
    async getFeeds({ signal } = {}) {
      signal?.throwIfAborted();
      const feeds = await direct.getFeedCatalog();
      signal?.throwIfAborted();
      return feeds;
    },
    /**
     * Vehicle history has no on-device source (needs the backend archive).
     * @returns {Promise<never>} Always rejects with `unavailable` attached.
     */
    async getHistory() {
      throw asUnavailable(
        new Error('Transit history needs the application backend'),
      );
    },
    /**
     * Fetch and decode one registered feed, answered in the legacy
     * Response-like shape the transit ingestion consumes.
     * @param {string} feedId Registered feed id.
     * @param {{ signal?: AbortSignal }} options
     * @returns {Promise<{ ok: boolean, status: number, headers: Headers, json: Function }>}
     */
    async requestSnapshot(feedId, { signal } = {}) {
      signal?.throwIfAborted();
      if (typeof feedId !== 'string' || !feedId || feedId.length > 160) {
        throw new TypeError('A transit feed identifier is required');
      }
      const snapshot = await direct.getSnapshot(feedId, { signal });
      signal?.throwIfAborted();
      if (snapshot?.unavailable) {
        return {
          ok: false,
          status: 503,
          headers: new Headers(),
          json: async () => snapshot,
        };
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => {
          signal?.throwIfAborted();
          return snapshot;
        },
      };
    },
  };
}

/** Wind models the legacy proxy accepts. */
const WIND_MODELS = Object.freeze(['gfs', 'ifs']);
/** Wind overlays the legacy proxy accepts. */
const WIND_OVERLAYS = Object.freeze(['none', 'temperature', 'pressure']);

/**
 * Wind layer source backed by direct GFS GRIB fetches.
 * Legacy shape: `{ getSnapshot }`. Only the GFS model exists on-device;
 * IFS answers honestly unavailable.
 * @param {{ fetchImpl?: Function }} transport Caller-owned transport.
 * @returns {{ getSnapshot: Function }}
 */
export function createWindDirectLayerSource({ fetchImpl } = {}) {
  const direct = createWindDirectSource(fetchImpl ? { fetchImpl } : {});
  return {
    /**
     * Fetch and decode the wind field valid closest to now.
     * @param {{ signal?: AbortSignal, model?: string, overlay?: string }} options
     * @returns {Promise<object>} Server-manifest-shaped snapshot.
     */
    async getSnapshot({ signal, model = 'gfs', overlay = 'none' } = {}) {
      if (!WIND_MODELS.includes(model)) throw new Error('Unknown wind model');
      if (!WIND_OVERLAYS.includes(overlay)) {
        throw new Error('Unknown weather overlay');
      }
      if (model !== 'gfs') {
        return { unavailable: UPSTREAM_NOT_ALLOWED };
      }
      const snapshot = await direct.getSnapshot({ overlay, signal });
      if (snapshot?.unavailable) return snapshot;
      return { model: 'gfs', overlay, ...snapshot };
    },
  };
}

/**
 * Whether a camera publishes a video stream (vs a still image).
 * @param {object} camera Layer camera record.
 * @returns {boolean}
 */
function isVideoCamera(camera) {
  return camera?.feedType === 'hls' || camera?.feedType === 'mjpeg';
}

/**
 * Direct upstream frame URL for a camera (never an `/api` proxy path).
 * @param {object} camera Layer camera record.
 * @returns {string|null}
 */
function directFrameUrl(camera) {
  if (!camera || isVideoCamera(camera)) return null;
  return (
    camera.snapshotUrl ||
    (!camera.feedType || camera.feedType === 'image' ? camera.url : null) ||
    null
  );
}

/**
 * CCTV layer source backed by direct camera fetches.
 * Legacy shape: `{ getCatalog, getHealth, getFrameUrl, getMediaUrl, getFrame }`.
 * Health has no on-device feed and answers honestly empty.
 * @param {{ fetchImpl?: Function }} transport Caller-owned transport.
 * @returns {{ getCatalog: Function, getHealth: Function, getFrameUrl: Function, getMediaUrl: Function, getFrame: Function }}
 */
export function createCctvDirectLayerSource({ fetchImpl } = {}) {
  const direct = createCctvDirectSource(fetchImpl ? { fetchImpl } : {});
  return {
    /**
     * Read the camera catalog (legacy `{ sources }` envelope).
     * @param {{ signal?: AbortSignal }} options
     * @returns {Promise<{ sources: Array<object> }>}
     */
    async getCatalog({ signal } = {}) {
      signal?.throwIfAborted();
      const sources = await direct.getCatalog();
      signal?.throwIfAborted();
      return { sources };
    },
    /**
     * Camera health has no on-device feed; the layer treats empty as unknown.
     * @returns {Promise<{ cameras: Array<object> }>}
     */
    async getHealth() {
      return { cameras: [] };
    },
    /**
     * Direct upstream frame URL, or null when the camera has none.
     * @param {object} camera Layer camera record.
     * @returns {string|null}
     */
    getFrameUrl(camera) {
      return directFrameUrl(camera);
    },
    /**
     * Direct upstream media URL for video cameras, else null.
     * @param {object} camera Layer camera record.
     * @returns {string|null}
     */
    getMediaUrl(camera) {
      return isVideoCamera(camera) ? camera?.url || null : null;
    },
    /**
     * Read one current frame through the direct adapter.
     * @param {object} camera Layer camera record.
     * @param {{ signal?: AbortSignal }} options
     * @returns {Promise<{ contentType: string, bytes: Uint8Array }|{ unavailable: string }>}
     */
    async getFrame(camera, { signal } = {}) {
      signal?.throwIfAborted();
      const cameraId = camera?.id;
      if (typeof cameraId !== 'string' || !cameraId) {
        throw new TypeError('A camera identifier is required');
      }
      const frame = await direct.getFrame(cameraId, { signal });
      signal?.throwIfAborted();
      if (frame?.unavailable) return frame;
      return { contentType: frame.contentType, bytes: frame.body };
    },
  };
}

/**
 * Weather imagery layer source backed by direct NOAA nowCOAST WMS.
 * Legacy shape: `{ getSnapshot, getImage }` (this supersedes the
 * Open-Meteo `weatherDirect` source for the imagery layers, which answered
 * tile imagery as unavailable).
 * @param {{ fetchImpl?: Function }} transport Caller-owned transport.
 * @returns {{ getSnapshot: Function, getImage: Function }}
 */
export function createWeatherDirectLayerSource({ fetchImpl } = {}) {
  const direct = createNoaaTilesDirectSource(fetchImpl ? { fetchImpl } : {});
  return {
    /**
     * Read the product manifest, validated against the layer contract.
     * @param {{ product?: string, signal?: AbortSignal }} options
     * @returns {Promise<object>}
     */
    async getSnapshot({ product = 'radar', signal } = {}) {
      const manifest = await direct.getManifest(product, { signal });
      signal?.throwIfAborted();
      return validateWeatherSnapshot(manifest, product);
    },
    /**
     * Read one image frame through direct WMS.
     * @param {{ product: string, time: string, size?: { width: number, height: number }, bbox?: { west: number, south: number, east: number, north: number }|null, signal?: AbortSignal }} options
     * @returns {Promise<{ contentType: string, bytes: Uint8Array }>}
     */
    async getImage({ product, time, size, bbox = null, signal } = {}) {
      const sizeArg =
        size === undefined ? undefined : `${size.width}x${size.height}`;
      const bboxArg =
        bbox === null
          ? undefined
          : [bbox.west, bbox.south, bbox.east, bbox.north].join(',');
      const bytes = await direct.getImage(product, time, {
        ...(sizeArg === undefined ? {} : { size: sizeArg }),
        ...(bboxArg === undefined ? {} : { bbox: bboxArg }),
        signal,
      });
      signal?.throwIfAborted();
      return { contentType: 'image/png', bytes };
    },
  };
}

/**
 * Overpass boundary source for `createOverpassFeatureSource({ boundarySource })`.
 * Maps parsed Overpass JSON to the elements array the feature seam consumes,
 * and registry refusals to the unavailable-capability shape.
 * Mirrors are REQUIRED (no baked defaults).
 * @param {{ fetchImpl?: Function, mirrors: Array<string> }} options Operator mirrors REQUIRED.
 * @returns {{ query: Function }}
 */
export function createOverpassDirectBoundarySource({
  fetchImpl,
  mirrors,
} = {}) {
  const direct = createOverpassDirectSource(
    fetchImpl ? { fetchImpl, mirrors } : { mirrors },
  );
  return {
    /**
     * Run one Overpass QL query, answering the elements array.
     * @param {string} text Overpass QL.
     * @param {{ signal?: AbortSignal }} options
     * @returns {Promise<Array<object>|object|null>} Elements, an
     *   unavailable-capability marker, or the raw payload when shapeless.
     */
    async query(text, { signal } = {}) {
      const payload = await direct.query(text, { signal });
      signal?.throwIfAborted();
      if (payload?.unavailable) {
        return {
          unavailable: true,
          code: payload.unavailable,
          retryable: false,
        };
      }
      if (payload && Array.isArray(payload.elements)) return payload.elements;
      return payload;
    },
  };
}

export { setCctvCatalog };

/**
 * Flights layer source backed by direct OpenSky (+ adsb.lol fallback) reads.
 * Legacy shape: `{ label, getSnapshot, getTrack, getEnrichment }`.
 * Tracks have no direct endpoint: `getTrack` rejects honestly unavailable
 * (the direct module exposes states + enrichment only).
 * @param {{ fetchImpl?: Function, getClientId?: Function|null, getClientSecret?: Function|null, governor?: object|null }} transport Caller-owned transport, vault readers, and credit governor.
 * @returns {{ label: string, getSnapshot: Function, getTrack: Function, getEnrichment: Function }}
 */
export function createFlightsDirectLayerSource({
  fetchImpl,
  getClientId = null,
  getClientSecret = null,
  governor = null,
} = {}) {
  const direct = createFlightsDirectSource({
    ...(fetchImpl ? { fetchImpl } : {}),
    getClientId,
    getClientSecret,
    governor: governor ?? createCreditGovernor(),
  });
  const adsbdb = createAdsbdbDirectSource(fetchImpl ? { fetchImpl } : {});
  return {
    label: 'Flights',
    /**
     * Read the current airborne snapshot around an optional anchor.
     * @param {{ latitude?: number, longitude?: number }} query View anchor.
     * @param {{ signal?: AbortSignal }} options Caller signal.
     * @returns {Promise<object>} Normalized OpenSky-shaped snapshot.
     */
    async getSnapshot(query = {}, { signal } = {}) {
      const states = await direct.getStates({
        lat: Number.isFinite(query.latitude) ? query.latitude : null,
        lon: Number.isFinite(query.longitude) ? query.longitude : null,
        signal,
      });
      signal?.throwIfAborted();
      return {
        ...openSkySnapshot(
          { time: states.time, states: states.states },
          {
            source: states.source,
            coverage: 'worldwide upstream snapshot',
            now: Date.now(),
          },
        ),
        status: 200,
      };
    },
    /**
     * Flight tracks have no direct endpoint (needs the backend archive).
     * @returns {Promise<never>} Always rejects with `unavailable` attached.
     */
    async getTrack() {
      throw asUnavailable(
        new Error('Flight tracks need the application backend'),
      );
    },
    /**
     * Enrich via direct adsbdb lookups, normalized with the `found` flag the
     * layers consume.
     * @param {{ kind: string, id: string }} query Enrichment query.
     * @param {{ signal?: AbortSignal }} options Caller signal.
     * @returns {Promise<object|null>} Enrichment, or null when unknown.
     */
    async getEnrichment(query, { signal } = {}) {
      if (!['type', 'route'].includes(query?.kind)) {
        throw new LiveSourceError('unsupported', 'Enrichment unavailable');
      }
      const result =
        query.kind === 'route'
          ? await adsbdb.lookupRoute(query.id, { signal })
          : await adsbdb.lookupAircraft(query.id, { signal });
      signal?.throwIfAborted();
      if (!result || result.unavailable) return result ?? null;
      return { ...result, found: true };
    },
  };
}

/** Vessel staleness bound mirrors `AISSTREAM_STALE_MS` (30 min). */
const VESSEL_DIRECT_STALE_MS = 30 * 60 * 1000;

/** Default poll cap mirrors the legacy `getSnapshot` default. */
const VESSEL_DIRECT_DEFAULT_MAX_ROWS = 12000;

/**
 * Great-circle distance in km (local copy; the codebase keeps small
 * per-module copies rather than a shared helper).
 */
function haversineKm(lat1, lon1, lat2, lon2) {
  const d2r = Math.PI / 180;
  const dLat = (lat2 - lat1) * d2r;
  const dLon = (lon2 - lon1) * d2r;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * d2r) * Math.cos(lat2 * d2r) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)));
}

const finiteNumber = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const textValue = (value) => {
  if (value === null || value === undefined) return '';
  const s = String(value).trim();
  return s;
};

/**
 * Map one AISStream envelope to a proxy-shaped vessel row. Mirrors the field
 * mapping in `server/providers/vessels/ais-store.js` `ingestAisStreamEnvelope`
 * (metadata/message fallbacks, static-data merge); final normalization stays
 * with `normalizeVesselObservation`, which drops positionless rows.
 * @param {string} mmsi Vessel MMSI.
 * @param {object} envelope Parsed AISStream envelope.
 * @returns {object|null} Proxy row, or null when unusable.
 */
function vesselRowFromEnvelope(mmsi, envelope) {
  if (!envelope || typeof envelope !== 'object') return null;
  const messageType = envelope?.MessageType;
  const message =
    envelope?.Message?.[messageType] &&
    typeof envelope.Message[messageType] === 'object'
      ? envelope.Message[messageType]
      : {};
  const metadata = envelope?.MetaData ?? envelope?.Metadata ?? {};
  const lat = finiteNumber(
    metadata.latitude ?? metadata.Latitude ?? message.Latitude,
  );
  const lon = finiteNumber(
    metadata.longitude ?? metadata.Longitude ?? message.Longitude,
  );
  const id = String(mmsi || '').trim();
  if (!id) return null;
  const name =
    textValue(metadata.ShipName ?? message.ShipName ?? message.shipname) ||
    `MMSI ${id}`;
  const epoch = Number.isFinite(
    Date.parse(metadata.time_utc ?? metadata.TimeUtc),
  )
    ? Math.floor(Date.parse(metadata.time_utc ?? metadata.TimeUtc) / 1000)
    : Math.floor(Date.now() / 1000);
  return {
    mmsi: id,
    lat,
    lon,
    name,
    imo: textValue(message.ImoNumber ?? message.IMO),
    type: textValue(message.ShipType ?? message.Shiptype ?? message.Type),
    destination: textValue(message.Destination),
    speed: finiteNumber(message.Sog ?? message.SOG),
    course: finiteNumber(message.Cog ?? message.COG),
    heading: finiteNumber(message.TrueHeading ?? message.Heading),
    last_position_epoch: epoch,
    last_position_UTC: metadata.time_utc ?? metadata.TimeUtc ?? null,
  };
}

/**
 * Vessel layer source backed by the on-device AISStream socket.
 * Legacy shape: `{ label, getSnapshot, getTrack }` (same contract as
 * `createVesselSource`: poll rows plus mmsi tracks). Positions accumulate
 * from the push socket into a latest-fix map; snapshots read that map, so a
 * quiet feed honestly reports few rows rather than an error.
 * @param {{ fetchImpl?: Function, getKey?: Function|null, createLive?: Function|null, clock?: Function }} options Transport, vault reader, live-handle seam (tests), clock.
 * @returns {{ label: string, getSnapshot: Function, getTrack: Function }} Legacy vessel source.
 */
export function createVesselDirectLayerSource({
  getKey = null,
  createLive = null,
  clock,
} = {}) {
  const now =
    typeof clock === 'function' ? clock : (clock?.now ?? (() => Date.now()));
  /** MMSI -> latest proxy row plus receipt time. */
  const latest = new Map();
  let live = null;
  function ensureLive() {
    if (!live) {
      const factory = createLive ?? createVesselsLiveSource;
      live = factory({
        ...(getKey ? { getKey } : {}),
        onVessel: ({ mmsi, envelope }) => {
          const row = vesselRowFromEnvelope(mmsi, envelope);
          if (row) latest.set(String(mmsi), { row, at: now() });
        },
        ...(clock ? { clock } : {}),
      });
    }
    return live;
  }
  function freshRows() {
    const cutoff = now() - VESSEL_DIRECT_STALE_MS;
    const rows = [];
    for (const [mmsi, entry] of latest) {
      if (entry.at < cutoff) {
        latest.delete(mmsi);
        continue;
      }
      rows.push(entry.row);
    }
    return rows;
  }
  return {
    label: 'Vessels',
    /**
     * Poll the accumulated live map (same shape as the proxy snapshot).
     * @param {{ maxRows?: number, area?: { lat: number, lon: number, radiusKm: number } }} query Row cap + optional area.
     * @param {{ signal?: AbortSignal }} options Caller signal.
     * @returns {Promise<object>} `{ records, source, coverage, ... }` via `vesselSnapshot`.
     */
    async getSnapshot(
      { maxRows = VESSEL_DIRECT_DEFAULT_MAX_ROWS, area } = {},
      { signal } = {},
    ) {
      signal?.throwIfAborted();
      const handle = ensureLive();
      const connected = await handle.connect({ signal });
      signal?.throwIfAborted();
      if (connected?.unavailable === 'KEY_REQUIRED') {
        throw new LiveSourceError('missing-key', 'AISSTREAM_API_KEY not set');
      }
      handle.tick();
      signal?.throwIfAborted();
      let rows = freshRows();
      if (
        Number.isFinite(area?.lat) &&
        Number.isFinite(area?.lon) &&
        Number.isFinite(area?.radiusKm)
      ) {
        rows = rows.filter(
          (row) =>
            Number.isFinite(row.lat) &&
            Number.isFinite(row.lon) &&
            haversineKm(area.lat, area.lon, row.lat, row.lon) <= area.radiusKm,
        );
      }
      rows.sort((a, b) => String(a.mmsi).localeCompare(String(b.mmsi)));
      const capped =
        Number.isFinite(maxRows) && maxRows >= 0
          ? rows.slice(0, maxRows)
          : rows;
      const snapshot = vesselSnapshot({ rows: capped });
      signal?.throwIfAborted();
      const liveState =
        typeof handle.snapshot === 'function' ? handle.snapshot() : {};
      return {
        ...snapshot,
        transportStatus: 'live',
        lastMessageAt: null,
        silentForMs: liveState.silentForMs ?? null,
        reconnectAttempt: liveState.attempts ?? 0,
      };
    },
    /**
     * Read one vessel's retained ring through the legacy track shape.
     * @param {string} reference Vessel MMSI.
     * @param {{ signal?: AbortSignal }} options Caller signal.
     * @returns {Promise<{ records: Array, complete: boolean }>} Track records.
     */
    async getTrack(reference, { signal } = {}) {
      signal?.throwIfAborted();
      const handle = ensureLive();
      const connected = await handle.connect({ signal });
      signal?.throwIfAborted();
      if (connected?.unavailable === 'KEY_REQUIRED') {
        throw new LiveSourceError('missing-key', 'AISSTREAM_API_KEY not set');
      }
      const ring =
        typeof handle.getTrack === 'function'
          ? handle.getTrack(String(reference ?? ''))
          : [];
      signal?.throwIfAborted();
      return {
        records: normalizeVesselTrack(
          (Array.isArray(ring) ? ring : []).map((sample) => ({
            lat: sample.latitude,
            lon: sample.longitude,
            t: Math.floor(Number(sample.at) / 1000),
          })),
        ),
        complete: false,
      };
    },
  };
}
