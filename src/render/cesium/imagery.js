/**
 * @module render/cesium/imagery
 * @description The Cesium globe port's imagery layers: a contract
 * `ImagerySpec` as a Cesium imagery provider, its tile hooks, and the layer
 * handles `globe.imagery` hands out (`src/render/contract/globe.d.ts`).
 *
 * Each handle owns one Cesium `ImageryLayer` and moves it to where its
 * `drapeOn` says it drapes: the globe's imagery collection, or the drawn
 * base tileset's own (`imageryOnTiles`). `all` drapes on the globe while it
 * is shown, else on the base tileset. Port layers keep their order among
 * themselves in every collection; layers others added to a collection stay
 * where they are.
 */
import * as Cesium from 'cesium';
import { creditMarkup } from './credits.js';
import { listenerList } from './common.js';
import { withTileRequestHook } from './tileRequests.js';

const SPLITS = { none: 'NONE', left: 'LEFT', right: 'RIGHT' };
const DRAPES = new Set(['surface', 'objects', 'all']);
/** Delay before the one frame that asks again for deferred tiles. */
export const TILE_RETRY_DELAY_MS = 250;
/** Ion's world imagery assets, by contract style. */
const WORLD_ASSETS = { aerial: 2, aerialLabels: 3 };

/** A tile the source says is not there: Cesium draws the parent's. */
class MissingTile extends Error {
  constructor() {
    super('No tile here');
    this.name = 'MissingTile';
  }
}

const rectangleOf = (rect) =>
  rect &&
  Cesium.Rectangle.fromDegrees(rect.west, rect.south, rect.east, rect.north);

const tilingOf = (name) =>
  name === 'geographic'
    ? new Cesium.GeographicTilingScheme()
    : new Cesium.WebMercatorTilingScheme();

/** A contract credit as Cesium's, or undefined. */
export const cesiumCredit = (credit) =>
  credit
    ? new Cesium.Credit(creditMarkup(credit), credit.inline === true)
    : undefined;

/** The URL, as a resource retrying the statuses the spec names. */
function resourceOf(spec) {
  if (!spec.retryStatuses?.length) return spec.url;
  const statuses = new Set(spec.retryStatuses);
  return new Cesium.Resource({
    url: spec.url,
    retryAttempts: 2,
    retryCallback: (_resource, error) => statuses.has(error?.statusCode),
  });
}

/**
 * A provider that draws each tile on a canvas (`canvas` imagery), with the
 * members Cesium's imagery layer reads.
 */
function canvasProvider(spec) {
  const tilingScheme = tilingOf(spec.tiling ?? 'geographic');
  const size = spec.tileSize ?? 256;
  const errorEvent = new Cesium.Event();
  return {
    tilingScheme,
    tileWidth: size,
    tileHeight: size,
    minimumLevel: spec.minLevel ?? 0,
    maximumLevel: spec.maxLevel,
    rectangle: rectangleOf(spec.rectangle) ?? tilingScheme.rectangle,
    credit: cesiumCredit(spec.credit),
    errorEvent,
    hasAlphaChannel: true,
    tileDiscardPolicy: undefined,
    proxy: undefined,
    getTileCredits: () => undefined,
    pickFeatures: () => undefined,
    requestImage(x, y, level) {
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      return guarded(() => {
        spec.drawTile({ x, y, level }, canvas);
        return Promise.resolve(canvas);
      });
    },
  };
}

/**
 * The Cesium provider a spec describes; a promise for the kinds Cesium
 * builds from metadata it fetches first.
 * @param {import('../contract/globe').ImagerySpec} spec
 * @param {{worldDataToken?: string}} options
 */
export function providerFor(spec, { worldDataToken } = {}) {
  const common = {
    rectangle: rectangleOf(spec.rectangle),
    minimumLevel: spec.minLevel,
    maximumLevel: spec.maxLevel,
    credit: cesiumCredit(spec.credit),
    ...(spec.tileSize
      ? { tileWidth: spec.tileSize, tileHeight: spec.tileSize }
      : {}),
  };
  for (const key of Object.keys(common))
    if (common[key] === undefined) delete common[key];
  switch (spec.kind) {
    case 'xyz':
      return new Cesium.UrlTemplateImageryProvider({
        url: resourceOf(spec),
        tilingScheme: tilingOf(spec.tiling),
        ...(spec.subdomains ? { subdomains: spec.subdomains } : {}),
        ...common,
      });
    case 'wmts':
      if (!spec.wmts) throw new TypeError('WMTS imagery needs its wmts fields');
      return new Cesium.WebMapTileServiceImageryProvider({
        url: resourceOf(spec),
        layer: spec.wmts.layer,
        style: spec.wmts.style,
        tileMatrixSetID: spec.wmts.tileMatrixSetId,
        ...(spec.wmts.format ? { format: spec.wmts.format } : {}),
        tilingScheme: tilingOf(spec.tiling),
        ...(spec.subdomains ? { subdomains: spec.subdomains } : {}),
        ...common,
      });
    case 'arcgis':
      return Cesium.ArcGisMapServerImageryProvider.fromUrl(resourceOf(spec), {
        enablePickFeatures: false,
        ...common,
      });
    case 'single-image':
      return Cesium.SingleTileImageryProvider.fromUrl(resourceOf(spec), common);
    case 'world': {
      const accessToken = String(worldDataToken || '').trim();
      if (!accessToken)
        throw new TypeError(
          'World imagery needs the renderer’s world data token',
        );
      return Cesium.IonImageryProvider.fromAssetId(
        WORLD_ASSETS[spec.worldStyle ?? 'aerial'] ?? WORLD_ASSETS.aerial,
        { accessToken },
      );
    }
    case 'canvas':
      if (typeof spec.drawTile !== 'function')
        throw new TypeError('Canvas imagery needs drawTile');
      return canvasProvider(spec);
    default:
      throw new TypeError(`Unknown imagery kind: ${spec.kind}`);
  }
}

/**
 * The URL a tile of an `xyz` spec is fetched from, as Cesium's URL template
 * provider builds it, for `fetchTile`.
 */
export function xyzTileUrl(spec, tilingScheme, { x, y, level }) {
  const subdomains = spec.subdomains?.length
    ? spec.subdomains
    : ['a', 'b', 'c'];
  const rows = tilingScheme.getNumberOfYTilesAtLevel(level);
  return spec.url
    .replaceAll('{x}', String(x))
    .replaceAll('{y}', String(y))
    .replaceAll('{z}', String(level))
    .replaceAll('{reverseY}', String(rows - y - 1))
    .replaceAll('{s}', subdomains[(x + y + level) % subdomains.length]);
}

/**
 * Cesium draws an `ImageBitmap` tile as decoded, flipped as it decodes its
 * own (`imageOrientation: 'flipY'`); any other image it flips as it uploads.
 */
const FLIPPED = { imageOrientation: 'flipY' };
const isBitmap = (image) =>
  typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap;

/** A tile's bytes decoded as Cesium decodes its own. */
const decodeTile = (blob) =>
  createImageBitmap(blob, {
    ...FLIPPED,
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'default',
  });

/**
 * `tileTransform` on an upright tile; its result goes back to Cesium
 * flipped, as Cesium's own bitmaps are.
 */
async function transformTile(spec, tile, image) {
  const upright = await createImageBitmap(
    image,
    isBitmap(image) ? FLIPPED : {},
  );
  const result = await spec.tileTransform(tile, upright);
  return createImageBitmap(result, FLIPPED);
}

/** A hook's synchronous throw as a failed tile, never a throw into the frame. */
function guarded(run) {
  try {
    return run();
  } catch (error) {
    return Promise.reject(error);
  }
}

/**
 * The provider with the spec's hooks and the port's accounting on its tile
 * requests: `admit` decides first, an issued request goes through
 * `fetchTile` (or the provider), then `tileTransform`; at most
 * `maxConcurrentRequests` are in flight.
 * @param {object} provider
 * @param {import('../contract/globe').ImagerySpec} spec
 * @param {{started: () => void, settled: () => void, retrySoon: () => void,
 *   laterFrame: () => Promise<void>, signals: Set<AbortController>}} ctx
 */
export function hookProvider(provider, spec, ctx) {
  const limit =
    spec.maxConcurrentRequests > 0 ? spec.maxConcurrentRequests : Infinity;
  let inFlight = 0;
  async function fetchVia(tile) {
    const url = xyzTileUrl(spec, provider.tilingScheme, tile);
    const controller = new AbortController();
    ctx.signals.add(controller);
    try {
      for (;;) {
        const answer = await spec.fetchTile({
          tile,
          url,
          signal: controller.signal,
        });
        controller.signal.throwIfAborted();
        if (answer?.defer) {
          // Its budget slot is free while it waits, so a deferred tile
          // never holds up the others.
          inFlight -= 1;
          try {
            await ctx.laterFrame();
            // Back in when the budget has room again.
            while (inFlight >= limit) {
              controller.signal.throwIfAborted();
              await ctx.laterFrame();
            }
          } finally {
            inFlight += 1;
          }
          controller.signal.throwIfAborted();
          continue;
        }
        if (!answer || answer.missing) throw new MissingTile();
        const blob = new Blob(
          [answer.bytes],
          answer.contentType ? { type: answer.contentType } : undefined,
        );
        return await decodeTile(blob);
      }
    } finally {
      ctx.signals.delete(controller);
    }
  }

  return withTileRequestHook(provider, {
    requestImage({ x, y, level }, ask) {
      const tile = { x, y, level };
      // Deferred by the budget: the request in flight asks for a frame as
      // it settles, so none is asked for here.
      let waitsOnBudget = false;
      const issue = () => {
        if (inFlight >= limit) {
          waitsOnBudget = true;
          return undefined;
        }
        waitsOnBudget = false;
        const started = spec.fetchTile ? fetchVia(tile) : guarded(ask);
        if (!started) {
          // Cesium's own request limits deferred it: one later frame asks
          // again.
          ctx.retrySoon();
          return undefined;
        }
        inFlight += 1;
        ctx.started();
        let result = Promise.resolve(started);
        if (spec.tileTransform)
          result = result.then((image) => transformTile(spec, tile, image));
        return result.finally(() => {
          inFlight -= 1;
          ctx.settled();
        });
      };
      if (!spec.admit) return issue();
      const answer = guarded(() => spec.admit(tile, issue));
      if (answer === undefined && !waitsOnBudget) ctx.retrySoon();
      return answer;
    },
  });
}

/**
 * The imagery layers of one globe port.
 * @param {object} scene Cesium Scene.
 * @param {{capabilities: ReadonlySet<string>, requestRender: (reason: string) => void,
 *   report: (error: unknown) => void, objects: () => object|null,
 *   worldDataToken?: () => string|undefined}} options
 *   `objects`: the drawn base tileset imagery drapes onto, or null.
 */
export function createCesiumImagery(
  scene,
  {
    capabilities,
    requestRender,
    report,
    objects,
    worldDataToken = () => undefined,
  },
) {
  /** Port layers, bottom to top. */
  const layers = [];
  let pending = 0;
  let retryTimer = null;
  let disposed = false;
  const waiters = [];

  const retrySoon = () => {
    if (retryTimer !== null || disposed) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      for (const resolve of waiters.splice(0)) resolve();
      if (!disposed) requestRender('imagery');
    }, TILE_RETRY_DELAY_MS);
  };
  const laterFrame = () =>
    new Promise((resolve) => {
      if (disposed) {
        setTimeout(resolve, TILE_RETRY_DELAY_MS);
        return;
      }
      waiters.push(resolve);
      retrySoon();
    });

  const globeCollection = () =>
    scene.imageryLayers ?? scene.globe?.imageryLayers;
  const usable = (collection) => collection && !collection.isDestroyed?.();

  /** The collection a layer should be in now. */
  function hostFor(record) {
    const tiles = capabilities.has('imageryOnTiles') ? objects() : null;
    const tileCollection =
      tiles && !tiles.isDestroyed?.() ? tiles.imageryLayers : null;
    if (record.drapeOn === 'surface') return globeCollection();
    if (record.drapeOn === 'objects') return tileCollection;
    if (scene.globe?.show !== true && usable(tileCollection))
      return tileCollection;
    return globeCollection();
  }

  /** Where to put a layer in a collection, keeping port order. */
  function placeIndex(record, collection) {
    const at = layers.indexOf(record);
    // A layer taken out of the collection by someone else is passed over.
    for (let i = at + 1; i < layers.length; i++) {
      const found =
        layers[i].host === collection
          ? collection.indexOf(layers[i].cesium)
          : -1;
      if (found >= 0) return found;
    }
    for (let i = at - 1; i >= 0; i--) {
      const found =
        layers[i].host === collection
          ? collection.indexOf(layers[i].cesium)
          : -1;
      if (found >= 0) return found + 1;
    }
    return record.base ? 0 : collection.length;
  }

  /** Moves a layer within its collection to its place among port layers. */
  function reorder(record) {
    const collection = record.host;
    if (!usable(collection) || !collection.contains(record.cesium)) return;
    const at = layers.indexOf(record);
    const inHere = (r) =>
      r.host === collection && collection.contains(r.cesium);
    const above = layers.slice(at + 1).find(inHere);
    const below = layers.slice(0, at).reverse().find(inHere);
    let guard = collection.length;
    while (
      above &&
      collection.indexOf(record.cesium) > collection.indexOf(above.cesium) &&
      guard-- > 0
    )
      collection.lower(record.cesium);
    guard = collection.length;
    while (
      below &&
      collection.indexOf(record.cesium) < collection.indexOf(below.cesium) &&
      guard-- > 0
    )
      collection.raise(record.cesium);
  }

  /** A Cesium layer for the record, with its look. */
  function build(record) {
    const layer =
      record.provider !== undefined
        ? new Cesium.ImageryLayer(record.provider)
        : Cesium.ImageryLayer.fromProviderAsync(record.providerPromise);
    layer.alpha = record.alpha;
    layer.show = record.show;
    layer.splitDirection = Cesium.SplitDirection[SPLITS[record.split]];
    return layer;
  }

  /** Puts each layer where it drapes now; rebuilds one a tileset destroyed. */
  function sync() {
    if (disposed) return;
    let changed = false;
    for (const record of layers) {
      if (record.removed) continue;
      if (record.cesium.isDestroyed()) {
        record.cesium = build(record);
        record.host = null;
      }
      // Taken out by someone else: put back where it drapes.
      if (usable(record.host) && !record.host.contains(record.cesium))
        record.host = null;
      const next = hostFor(record);
      const target = usable(next) ? next : null;
      if (record.host === target) continue;
      if (usable(record.host) && record.host.contains(record.cesium))
        record.host.remove(record.cesium, false);
      record.host = null;
      if (target) {
        target.add(record.cesium, placeIndex(record, target));
        record.host = target;
      }
      changed = true;
    }
    if (changed) requestRender('imagery');
  }

  function add(spec, index, { base = false } = {}) {
    if (disposed) throw new Error('This globe has been disposed');
    if (
      !capabilities.has('imageHooks') &&
      (spec.tileTransform || spec.admit || spec.kind === 'canvas')
    )
      throw new TypeError(
        'tileTransform, admit and canvas imagery need imageHooks',
      );
    if (spec.fetchTile && spec.kind !== 'xyz')
      throw new TypeError('fetchTile is supported for xyz imagery only');
    const listeners = {
      tileError: listenerList(report),
      frameReady: listenerList(report),
    };
    const signals = new Set();
    const ctx = {
      started: () => (pending += 1),
      settled: () => {
        pending -= 1;
        if (!disposed) requestRender('imagery');
      },
      retrySoon,
      laterFrame,
      signals,
    };
    const record = {
      spec: { ...spec },
      base,
      alpha: 1,
      show: true,
      split: 'none',
      drapeOn: 'all',
      lit: true,
      host: null,
      removed: false,
      provider: undefined,
      providerPromise: undefined,
      cesium: null,
      signals,
      offError: null,
    };
    const watchErrors = (provider) => {
      record.offError = provider.errorEvent?.addEventListener?.((error) => {
        if (error?.error instanceof MissingTile) return;
        if (listeners.tileError.size === 0) return;
        const status = error?.error?.statusCode;
        listeners.tileError.fire({
          tile: { x: error?.x, y: error?.y, level: error?.level },
          ...(Number.isFinite(status) ? { status } : {}),
        });
      });
    };
    const made = providerFor(spec, { worldDataToken: worldDataToken() });
    if (typeof made?.then === 'function') {
      record.providerPromise = Promise.resolve(made).then((provider) => {
        const hooked = hookProvider(provider, spec, ctx);
        if (!record.removed) watchErrors(provider);
        record.provider = hooked;
        return hooked;
      });
      record.providerPromise.catch(() => {});
    } else {
      record.provider = hookProvider(made, spec, ctx);
      watchErrors(made);
    }
    record.cesium = build(record);

    const handle = {
      get alpha() {
        return record.alpha;
      },
      set alpha(value) {
        record.alpha = Number(value);
        record.cesium.alpha = record.alpha;
        requestRender('imagery');
      },
      get show() {
        return record.show;
      },
      set show(value) {
        record.show = Boolean(value);
        record.cesium.show = record.show;
        requestRender('imagery');
      },
      get split() {
        return record.split;
      },
      set split(value) {
        if (!(value in SPLITS)) throw new TypeError(`Unknown split: ${value}`);
        record.split = value;
        record.cesium.splitDirection = Cesium.SplitDirection[SPLITS[value]];
        requestRender('imagery');
      },
      get drapeOn() {
        return record.drapeOn;
      },
      set drapeOn(value) {
        if (!DRAPES.has(value)) throw new TypeError(`Unknown drape: ${value}`);
        record.drapeOn = value;
        sync();
      },
      get lit() {
        return record.lit;
      },
      // Cesium lights imagery with its surface; an unlit layer is recorded
      // and drawn as the surface draws it.
      set lit(value) {
        record.lit = Boolean(value);
      },
      on(event, cb) {
        return listeners[event]?.on(cb) ?? (() => {});
      },
      raise() {
        const i = layers.indexOf(record);
        if (i < 0 || i === layers.length - 1) return;
        layers.splice(i, 1);
        layers.splice(i + 1, 0, record);
        reorder(record);
        requestRender('imagery');
      },
      lower() {
        const i = layers.indexOf(record);
        if (i <= 0) return;
        layers.splice(i, 1);
        layers.splice(i - 1, 0, record);
        reorder(record);
        requestRender('imagery');
      },
      remove() {
        if (record.removed) return;
        record.removed = true;
        const i = layers.indexOf(record);
        if (i >= 0) layers.splice(i, 1);
        record.offError?.();
        for (const controller of signals) controller.abort();
        listeners.tileError.clear();
        listeners.frameReady.clear();
        if (usable(record.host) && record.host.contains(record.cesium))
          record.host.remove(record.cesium, true);
        else if (!record.cesium.isDestroyed()) record.cesium.destroy();
        record.host = null;
        requestRender('imagery');
      },
    };
    record.handle = handle;

    let at = index;
    if (at === undefined) {
      // Above every layer of the same or a lower zOrder; none is 0.
      const z = Number.isFinite(spec.zOrder) ? spec.zOrder : 0;
      at = layers.length;
      while (at > 0 && (layers[at - 1].spec.zOrder ?? 0) > z) at -= 1;
    }
    if (at === undefined || at > layers.length) at = layers.length;
    layers.splice(Math.max(0, at), 0, record);
    sync();
    requestRender('imagery');
    return handle;
  }

  return {
    add,
    list: () => layers.map((record) => record.handle),
    /** Layers whose providers are still being built, as promises. */
    ready: (handles) =>
      Promise.allSettled(
        layers
          .filter((r) => handles.includes(r.handle) && r.providerPromise)
          .map((r) => r.providerPromise),
      ),
    sync,
    /** Whether any port layer has a tile request in flight. */
    pending: () => pending,
    /**
     * Stop asking for frames. Layers stay drawn where they are and their
     * handles keep working; a deferred fetch asks again on a timer.
     */
    dispose() {
      disposed = true;
      clearTimeout(retryTimer);
      retryTimer = null;
      for (const resolve of waiters.splice(0)) resolve();
    },
  };
}
