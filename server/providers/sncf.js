/**
 * SNCF Open Data proxy — the French passenger-station network.
 *
 * Upstream: the OpenDataSoft v2.1 catalogue API on ressources.data.sncf.com.
 *
 * WHY STATIONS, NOT VEHICLES: the SNCF catalogue exposes NO live vehicle
 * position dataset. The datasets that sound like one (api-sncf,
 * temps-reel-siri-sx-lite) carry ZERO records, and
 * position-des-trains-en-temps-reel does not exist. The only positional truth
 * available as catalogue records is the passenger-station network
 * (gares-de-voyageurs), which is what this layer renders: the French rail
 * network's 2 792 passenger stations as selectable ground anchors.
 *
 * The GTFS zip (eu.ftp.opendatasoft.com/sncf/gtfs/transilien-gtfs.zip,
 * 10.6 MB) is a SCHEDULE, not a live feed. It cannot honestly be called live
 * GPS, so it is not used and this layer is not called a live-train layer.
 *
 * Routes (the browser names a route, never a URL):
 *   GET /api/sncf/stations  -> { fetchedAt, count, total, stations: [...] }
 */

import { createOpenDataService } from '../../src/sources/openDataProxy.js';
import { readResponseJsonCapped } from '../../src/sources/httpBody.js';

const ODS_BASE = 'https://ressources.data.sncf.com/api/explore/v2.1/catalog';
const STATIONS_DATASET = 'gares-de-voyageurs';
/** ODS caps `limit` at 100. */
export const PAGE_SIZE = 100;
/** Hard ceiling on pages so a broken `total_count` cannot loop forever. */
export const MAX_PAGES = 40;
/** 2 792 stations as observed on 2026-10-25; allow headroom, refuse absurdness. */
export const MAX_STATIONS = 5_000;
/** The station network changes on the order of days, not minutes. */
export const STATION_TTL_MS = 6 * 3600_000;
/** One ODS page is about 25 kB; cap generously but never unbounded. */
export const MAX_PAGE_BYTES = 2 * 1024 * 1024;

/**
 * Read one field of an ODS record, whichever shape the record has.
 *
 * The OpenDataSoft catalogue serves the same dataset in two shapes:
 *
 *  - the v2.1 catalogue API (`/api/explore/v2.1/catalog/.../records`) hands
 *    back FLATTENED rows: {nom, libellecourt, segment_drg, ...};
 *  - the v1 records API (`/api/records/1.0/search/`) hands back the record
 *    BODY: {datasetid, recordid, fields: {nom, ...}, geometry, ...}.
 *
 * Reading only the top level therefore resolves EVERY name, short code, UIC
 * and coordinate to null against the second shape, and the row silently falls
 * back to its id - a station with no name on the map. Reading only `fields`
 * does the same against the first. So the record body is read FIRST and the
 * top level is the FALLBACK: one shape wins where both are present, and
 * neither shape loses a field.
 *
 * @param {object|null|undefined} raw The ODS record.
 * @param {string} key The field name.
 * @returns {*} The field value, or undefined when the record carries none.
 */
export function fieldValue(raw, key) {
  const body = raw?.fields;
  if (body && typeof body === 'object') {
    const value = body[key];
    if (value !== undefined && value !== null) return value;
  }
  return raw?.[key];
}

/**
 * Normalize one ODS station record into a plain row.
 * @param {object} raw ODS record.
 * @param {number} index Record index (fallback id).
 * @returns {{id: string, name: string|null, shortCode: string|null,
 *   uic: string|null, lon: number, lat: number, segment: string|null}|null}
 */
export function normalizeSncfStation(raw, index = 0) {
  const position = fieldValue(raw, 'position_geographique');
  const lon = Number(position?.lon);
  const lat = Number(position?.lat);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  if (Math.abs(lon) > 180 || Math.abs(lat) > 90) return null;
  const text = (value) => {
    const trimmed = String(value ?? '').trim();
    return trimmed || null;
  };
  const uic = text(fieldValue(raw, 'codes_uic'));
  const id = text(fieldValue(raw, 'id')) || uic || `sncf-station-${index + 1}`;
  return {
    id,
    name: text(fieldValue(raw, 'nom')),
    shortCode: text(fieldValue(raw, 'libellecourt')),
    uic,
    lon,
    lat,
    segment: text(fieldValue(raw, 'segment_drg')),
  };
}

/**
 * Normalize one ODS page payload.
 * @param {object} payload ODS response.
 * @returns {{total: number, rows: object[]}}
 */
export function normalizeSncfStationPage(payload) {
  const results = Array.isArray(payload?.results) ? payload.results : [];
  const total = Number(payload?.total_count);
  return {
    total: Number.isFinite(total) && total >= 0 ? total : results.length,
    rows: results
      .map((row, index) => normalizeSncfStation(row, index))
      .filter(Boolean),
  };
}

/**
 * Sweep the whole station catalogue page by page.
 *
 * Every read is byte-capped: the ODS `limit` is a request, not a guarantee.
 *
 * @param {typeof fetch} fetchImpl Injected fetch.
 * @param {AbortSignal} [signal] Abort signal.
 * @returns {Promise<{fetchedAt: number, count: number, total: number,
 *   stations: object[]}>}
 */
export async function loadSncfStations(fetchImpl, signal) {
  const rows = [];
  let total = 0;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    signal?.throwIfAborted();
    const offset = page * PAGE_SIZE;
    const url =
      `${ODS_BASE}/datasets/${STATIONS_DATASET}/records` +
      `?limit=${PAGE_SIZE}&offset=${offset}`;
    const response = await fetchImpl(url, {
      signal,
      redirect: 'manual',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      const error = new Error(`upstream HTTP ${response.status}`);
      error.upstreamStatus = response.status;
      throw error;
    }
    const payload = await readResponseJsonCapped(
      response,
      MAX_PAGE_BYTES,
      signal,
    );
    const pageRows = normalizeSncfStationPage(payload);
    total = Math.max(total, pageRows.total);
    for (const row of pageRows.rows) rows.push(row);
    if (rows.length >= Math.min(total, MAX_STATIONS)) break;
    if (pageRows.rows.length < PAGE_SIZE) break;
  }
  return {
    fetchedAt: Date.now(),
    count: rows.length,
    total,
    stations: rows.slice(0, MAX_STATIONS),
  };
}

/**
 * Build the SNCF open-data service.
 * @param {{fetchImpl?: typeof fetch}} [options]
 * @returns {{handle: Function, close: Function}}
 */
export function createSncfService({ fetchImpl = fetch } = {}) {
  return createOpenDataService({
    id: 'sncf',
    routes: new Map([['stations', 'unused']]),
    loader: async (route, fetchImplArg, signal) => {
      if (route !== 'stations') throw new Error(`unknown route ${route}`);
      return loadSncfStations(fetchImplArg, signal);
    },
    ttlMs: STATION_TTL_MS,
    maxBytes: 4_000_000,
    maxPerWindow: 2,
    globalMaxPerWindow: 6,
    timeoutMs: 60_000,
    fetchImpl,
  });
}

/**
 * Vite plugin wrapping the SNCF proxy.
 * @param {{fetchImpl?: typeof fetch}} [options]
 * @returns {import('vite').Plugin}
 */
export function sncfProxy(options = {}) {
  const service = createSncfService(options);
  function install(server) {
    server.middlewares.use('/api/sncf', async (req, res) => {
      const response = await service.handle({
        url: `http://localhost/api/sncf${req.url || '/'}`,
        method: req.method,
      });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(await response.text());
    });
    server.httpServer?.once('close', service.close);
  }
  return {
    name: 'sncf-proxy',
    closeBundle: service.close,
    configureServer: install,
    configurePreviewServer: install,
  };
}
