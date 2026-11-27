/**
 * @module render/cesium/terrainTiles
 * @description Quantized-mesh terrain tiles fetched through a terrain
 * spec's `fetchTile`, the way imagery layers fetch theirs.
 *
 * Cesium still reads `layer.json` itself, decides which tiles a frame needs,
 * schedules and cancels their requests and decodes the meshes; only the
 * fetch of each tile's bytes goes through `fetchTile`. Every resource
 * Cesium derives from the terrain's resource (its `layer.json`, each tile)
 * is a {@link tileFetchResource}, so a tile request reaches `fetchTile`
 * with the tile's URL as Cesium resolved it.
 */
import * as Cesium from 'cesium';

/** Delay before a deferred terrain tile is asked for again. */
export const TERRAIN_RETRY_DELAY_MS = 250;

/** A tile `fetchTile` says is not there; Cesium draws the parent's instead. */
export class MissingTerrainTile extends Error {
  constructor() {
    super('Terrain tile is missing');
    this.name = 'MissingTerrainTile';
  }
}

const wait = (ms, signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal.removeEventListener('abort', aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal.addEventListener('abort', aborted, { once: true });
  });

/** Whether a resource's template values name one tile. */
const isTile = (values) =>
  Number.isInteger(values?.x) &&
  Number.isInteger(values?.y) &&
  Number.isInteger(values?.z);

/**
 * A Cesium `Resource` whose tile fetches go through `fetchTile`.
 *
 * `tileOf` gives the tile, in the terrain's own tiling scheme (rows from
 * the north, as `requestTileGeometry` counts them), that a Cesium request
 * is for; without one it is read from the resolved template values.
 * @param {object} options Cesium `Resource` options.
 * @param {(request: {tile: import('../contract/globe').TileRequest,
 *   url: string, signal: AbortSignal})
 *   => Promise<import('../contract/globe').TileFetch>} fetchTile
 * @param {(request: object|undefined) => import('../contract/globe').TileRequest|undefined} tileOf
 * @param {{retryDelayMs?: number}} [timing]
 * @returns {object} A Cesium `Resource`.
 */
export function tileFetchResource(options, fetchTile, tileOf, timing = {}) {
  const retryDelayMs = timing.retryDelayMs ?? TERRAIN_RETRY_DELAY_MS;

  class TileFetchResource extends Cesium.Resource {
    /**
     * Clones stay of this kind, so derived tile resources keep the hook.
     * `clone(result)` copies every field onto `result`, its URL included.
     */
    clone(result) {
      return super.clone(
        result ?? new TileFetchResource({ url: this.url, parseUrl: false }),
      );
    }

    fetchArrayBuffer() {
      const values = this.templateValues;
      if (!isTile(values)) return super.fetchArrayBuffer();
      const request = this.request;
      const url = this.url;
      const tile = tileOf(request) ?? {
        x: values.x,
        y: values.y,
        level: values.z,
      };
      if (
        request.state === Cesium.RequestState.ISSUED ||
        request.state === Cesium.RequestState.ACTIVE
      )
        throw new Cesium.RuntimeError('The Resource is already being fetched.');
      const controller = new AbortController();
      request.url = url;
      request.state = Cesium.RequestState.UNISSUED;
      request.deferred = undefined;
      // Cesium cancels a request whose tile is no longer wanted.
      request.cancelFunction = () => controller.abort();
      request.requestFunction = async () => {
        for (;;) {
          const answer = await fetchTile({
            tile: { ...tile },
            url,
            signal: controller.signal,
          });
          controller.signal.throwIfAborted();
          if (answer?.defer) {
            await wait(retryDelayMs, controller.signal);
            continue;
          }
          if (!answer || answer.missing) throw new MissingTerrainTile();
          return answer.bytes;
        }
      };
      const promise = Cesium.RequestScheduler.request(request);
      if (!promise) return undefined;
      return promise.finally(() => {
        request.cancelFunction = undefined;
      });
    }
  }

  return new TileFetchResource(options);
}

/**
 * A terrain provider whose tile requests tell `tileFetchResource` which
 * tile each is for. Requests Cesium makes without a `Request` are given one.
 * @param {object} provider Cesium `CesiumTerrainProvider`.
 * @param {WeakMap<object, import('../contract/globe').TileRequest>} tiles
 * @returns {object} The same provider.
 */
export function trackTileRequests(provider, tiles) {
  const own = provider.requestTileGeometry.bind(provider);
  provider.requestTileGeometry = (x, y, level, request) => {
    const asked = request ?? new Cesium.Request({ throttle: false });
    tiles.set(asked, { x, y, level });
    return own(x, y, level, asked);
  };
  return provider;
}
