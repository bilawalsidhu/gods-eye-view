import { tilesForBounds } from '../../data/tomtomTiles.js';
import { createOpenFreeMapSource } from '../../sources/openFreeMap.js';
import { validTileBounds } from '../../sources/vectorTiles.js';
import {
  CHARGING_TILE_ZOOM,
  decodeChargingTile,
  planetBuildTime,
} from './records.js';
import { mergeOcmSites } from './merge.js';
// A portable export (package.json): it marks text and loads no catalogs. The
// layer row translates the source label and the fixed error forms below.
import { msg } from '../../i18n/marker.js';

/** Per-view tile cap, as for ALPR, installations and street traffic. */
export const CHARGING_MAX_TILES = 16;

/**
 * Stations kept per view. A dense European centre holds about a hundred per
 * z14 tile; past this the nearest to the view centre are kept and the read
 * reports `saturated`.
 */
export const CHARGING_STATION_LIMIT = 2000;

/**
 * Whether `box` fits the per-view tile cap at the charging-station zoom.
 * @param {{south:number, west:number, north:number, east:number}} box View box.
 * @returns {boolean} True when the view can load.
 */
export function chargingViewFits(box) {
  return (
    tilesForBounds(box, CHARGING_TILE_ZOOM, {
      maxTiles: CHARGING_MAX_TILES + 1,
    }).length <= CHARGING_MAX_TILES
  );
}

/**
 * Name the upstream in the fixed forms the layer row translates
 * (`translateFeedError`), never with raw transport or decoder text.
 */
function chargingFeedError(error) {
  const causes = [error, error?.cause];
  const status = causes.map((cause) => cause?.status).find(Number.isInteger);
  const message =
    status === 429
      ? 'OpenFreeMap rate limited'
      : status
        ? `OpenFreeMap HTTP ${status}`
        : causes.some(
              (cause) =>
                cause?.name === 'TimeoutError' || cause instanceof TypeError,
            )
          ? 'OpenFreeMap network error'
          : 'Malformed OpenFreeMap response';
  return Object.assign(new Error(message, { cause: error }), {
    status: status ?? null,
  });
}

/**
 * Read mapped EV charging stations from OpenFreeMap's OpenMapTiles `poi`
 * layer for one bounded view. Keyless and browser-direct: the tiles are the
 * same immutable planet build street traffic and installations read.
 * @param {object} [options]
 * @param {Function} [options.tileFetchImpl] Injected fetch, for tests.
 * @param {object} [options.mapTiles] Injected vector tile source, for tests.
 * @param {?{isConfigured: Function, getSites: Function}} [options.ocm]
 *   Optional Open Charge Map client (openChargeMap.js). When the local server
 *   reports a key, its sites enrich matching stations and add the rest; when
 *   it does not, reads are exactly the OpenStreetMap reads.
 * @returns {{getStations: Function, destroy: Function, label: string,
 *   attribution: object}} Source.
 */
export function createChargingSource({
  tileFetchImpl = (...args) => globalThis.fetch(...args),
  mapTiles = createOpenFreeMapSource({
    fetchImpl: tileFetchImpl,
    decode: decodeChargingTile,
    maxTiles: CHARGING_MAX_TILES,
  }),
  ocm = null,
} = {}) {
  /**
   * The Open Charge Map read for `box`: null without a key, else its sites or
   * the fixed error that replaced them. Rejects only on abort, so a failed
   * enrichment can never fail the OpenStreetMap read.
   */
  async function readOcm(box, signal) {
    if (!ocm || !(await ocm.isConfigured({ signal }))) return null;
    try {
      const read = await ocm.getSites(box, { signal });
      return read.unkeyed ? null : { ...read, error: null };
    } catch (error) {
      if (error?.name === 'AbortError' || signal?.aborted) throw error;
      return {
        sites: [],
        saturated: false,
        stale: false,
        error: /^(Open Charge Map |Malformed Open Charge Map )/.test(
          error?.message,
        )
          ? error.message
          : 'Open Charge Map network error',
      };
    }
  }

  return {
    /**
     * @param {{south:number, west:number, north:number, east:number}} box View box.
     * @param {{signal?: AbortSignal}} [options]
     * @returns {Promise<{records: Array<object>, zoomIn: boolean,
     *   partial: boolean, saturated: boolean, observedAt: number|null}>}
     *   `observedAt` is the planet build time of the tiles read.
     */
    async getStations(box, { signal } = {}) {
      if (!validTileBounds(box))
        throw new TypeError('EV charging requires a bounded viewport');
      signal?.throwIfAborted();
      // Refuse a wide view before any request, rather than reading a sample.
      if (!chargingViewFits(box))
        return {
          records: [],
          zoomIn: true,
          partial: false,
          saturated: false,
          observedAt: null,
        };
      // Started alongside the tiles; awaited only once they have succeeded.
      const ocmRead = readOcm(box, signal);
      ocmRead.catch(() => {});
      let metadata, result;
      try {
        metadata = await mapTiles.getMetadata(signal);
        result = await mapTiles.fetchBounds(box, {
          zoom: CHARGING_TILE_ZOOM,
          signal,
        });
      } catch (error) {
        if (error?.name === 'AbortError' || signal?.aborted) throw error;
        throw chargingFeedError(error);
      }
      signal?.throwIfAborted();
      let records = [
        ...new Map(
          result.tiles.flat().map((record) => [record.id, record]),
        ).values(),
      ];
      const saturated = records.length > CHARGING_STATION_LIMIT;
      if (saturated) {
        const lat = (box.south + box.north) / 2;
        const lon = (box.west + box.east) / 2;
        const scale = Math.cos((lat * Math.PI) / 180);
        const distance = (record) =>
          (record.latitude - lat) ** 2 +
          ((record.longitude - lon) * scale) ** 2;
        records = records
          .sort((a, b) => distance(a) - distance(b))
          .slice(0, CHARGING_STATION_LIMIT);
      }
      const snapshot = {
        records,
        zoomIn: false,
        partial: result.partial,
        saturated,
        observedAt: planetBuildTime(metadata?.template),
      };
      const enrichment = await ocmRead;
      signal?.throwIfAborted();
      if (!enrichment) return snapshot;
      const merged = mergeOcmSites(records, enrichment.sites);
      return {
        ...snapshot,
        records: merged.records,
        enrichment: {
          source: 'ocm',
          error: enrichment.error,
          matched: merged.matched,
          added: merged.added,
          saturated: enrichment.saturated,
          stale: enrichment.stale,
        },
      };
    },
    destroy() {
      mapTiles.clear();
    },
    label: msg('OpenStreetMap · community mapped'),
    attribution: {
      name: 'OpenStreetMap',
      description: '© OpenStreetMap contributors, ODbL',
      text: '© OpenStreetMap contributors, ODbL',
      href: 'https://www.openstreetmap.org/copyright',
    },
  };
}
