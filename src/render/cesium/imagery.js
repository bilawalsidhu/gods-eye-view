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
 *
 * With `imageryFrames`, a handle given a timed source (`setFrames`) hides
 * its own layer and draws the frames its clock shows instead, each a Cesium
 * layer of its own just above it: the nearest frame (in `blend` mode the
 * later frame over the earlier one, at its share of the way), and the next
 * `prefetch` frames loading unseen at alpha 0. A frame is ready
 * (`frameReady`) once the globe's tiles drawn are drawn from its own
 * imagery (`imageryFrames.js`).
 */
import * as Cesium from 'cesium';
import { vectorBaseProvider } from './vectorBase.js';
import { creditMarkup } from './credits.js';
import { listenerList } from './common.js';
import {
  createTileVideos,
  framesOf,
  heldFrames,
  layerDrawn,
  shownAt,
  videoProvider,
} from './imageryFrames.js';
import { withTileRequestHook } from './tileRequests.js';
import { createIonImagery } from './mapImagery.js';

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
    retryAttempts: 3,
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
 * The Cesium layer options a spec asks for: one hidden below its minimum
 * level is shown only from the globe level as fine as it (Cesium's globe
 * tiles are geographic, two Web Mercator tiles across a level's one).
 * @param {import('../contract/globe').ImagerySpec} spec
 * @returns {object|undefined}
 */
export function layerOptions(spec) {
  if (!spec.hiddenBelowMinLevel || !(spec.minLevel > 0)) return undefined;
  const tiling =
    spec.tiling ?? (spec.kind === 'canvas' ? 'geographic' : 'webMercator');
  const shift = tiling === 'geographic' ? 0 : 1;
  return { minimumTerrainLevel: Math.max(0, spec.minLevel - shift) };
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
    case 'single-image':
      return Cesium.SingleTileImageryProvider.fromUrl(resourceOf(spec), common);
    case 'world': {
      const accessToken = String(worldDataToken || '').trim();
      if (!accessToken)
        throw new TypeError(
          'World imagery needs the renderer’s world data token',
        );
      // Bing through ion, its tiles over HTTPS on any page, with ion's
      // credits, as the map stacks have always drawn it.
      return createIonImagery(
        WORLD_ASSETS[spec.worldStyle ?? 'aerial'] ?? WORLD_ASSETS.aerial,
        accessToken,
      );
    }
    // The app's own: the vector base's tiles, painted from its style.
    case 'vectorStyle':
      return vectorBaseProvider(spec.style);
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
  // Straight alpha throughout, as Cesium uploads its own tiles: WebGL does
  // not premultiply an ImageBitmap, so one premultiplied here stays so.
  const straight = {
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'default',
  };
  const upright = await createImageBitmap(
    image,
    isBitmap(image) ? { ...FLIPPED, ...straight } : straight,
  );
  // The input is the hook's until it settles; a bitmap it returns is the
  // renderer's, spent once copied.
  let result;
  try {
    result = await spec.tileTransform(tile, upright);
    return await createImageBitmap(result, { ...FLIPPED, ...straight });
  } finally {
    if (isBitmap(result) && result !== upright) result.close();
    upright.close();
  }
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
 *
 * A tile `admit` defers is asked again on a later frame: the one a request
 * of a layer with the same `admit` in flight asks for as it settles, or,
 * with none in flight (`busy`), the one `retrySoon` asks for. So layers
 * whose shared budget is full never keep the scene drawing while they
 * wait.
 * @param {object} provider
 * @param {import('../contract/globe').ImagerySpec} spec
 * @param {{started: () => void, settled: () => void, retrySoon: () => void,
 *   laterFrame: () => Promise<void>, signals: Set<AbortController>,
 *   busy?: () => boolean, requests?: Set<object>}} ctx
 *   `requests`: the Cesium requests in flight, cancelled as the layer goes.
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
    requestImage({ x, y, level, request }, ask) {
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
        if (request) ctx.requests?.add(request);
        let result = Promise.resolve(started);
        if (spec.tileTransform)
          result = result.then((image) => transformTile(spec, tile, image));
        return result.finally(() => {
          inFlight -= 1;
          if (request) ctx.requests?.delete(request);
          ctx.settled();
        });
      };
      if (!spec.admit) return issue();
      const answer = guarded(() => spec.admit(tile, issue));
      if (answer === undefined && !waitsOnBudget && !ctx.busy?.())
        ctx.retrySoon();
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
  /** Tiles in flight by the `admit` their layers share. */
  const admitPending = new Map();
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
    const options = layerOptions(record.spec);
    const layer =
      record.provider !== undefined
        ? new Cesium.ImageryLayer(record.provider, options)
        : Cesium.ImageryLayer.fromProviderAsync(
            record.providerPromise,
            options,
          );
    layer.alpha = record.alpha;
    // A layer showing timed frames hides its own imagery.
    layer.show = record.show && !record.timed;
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
    const requests = new Set();
    // Layers given one `admit` share its waits: a tile it defers is asked
    // again on the frame any of their tiles asks for as it settles.
    const shared = spec.admit ?? {};
    const ctx = {
      busy: () => (admitPending.get(shared) ?? 0) > 0,
      requests,
      started: () => {
        pending += 1;
        admitPending.set(shared, (admitPending.get(shared) ?? 0) + 1);
      },
      settled: () => {
        pending -= 1;
        const left = (admitPending.get(shared) ?? 1) - 1;
        if (left > 0) admitPending.set(shared, left);
        else admitPending.delete(shared);
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
    const watchErrors = (provider) =>
      provider.errorEvent?.addEventListener?.((error) => {
        if (error?.error instanceof MissingTile) return;
        if (listeners.tileError.size === 0) return;
        const status = error?.error?.statusCode;
        listeners.tileError.fire({
          tile: { x: error?.x, y: error?.y, level: error?.level },
          ...(Number.isFinite(status) ? { status } : {}),
        });
      });
    record.listeners = listeners;
    record.ctx = ctx;
    record.watchErrors = watchErrors;
    const made = providerFor(spec, { worldDataToken: worldDataToken() });
    if (typeof made?.then === 'function') {
      record.providerPromise = Promise.resolve(made).then((provider) => {
        const hooked = hookProvider(provider, spec, ctx);
        if (!record.removed) record.offError = watchErrors(provider);
        record.provider = hooked;
        return hooked;
      });
      // A provider that fails to build (its metadata, or a single image)
      // loads no tile: told as an error of the layer's root tile.
      record.providerPromise.catch((error) => {
        if (record.removed || listeners.tileError.size === 0) return;
        const status = error?.statusCode;
        listeners.tileError.fire({
          tile: { x: 0, y: 0, level: 0 },
          ...(Number.isFinite(status) ? { status } : {}),
        });
      });
    } else {
      record.provider = hookProvider(made, spec, ctx);
      record.offError = watchErrors(made);
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
        record.cesium.show = record.show && !record.timed;
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
        dropFrames(record);
        for (const controller of signals) controller.abort();
        // Cesium leaves a removed layer's requests running: cancelled, they
        // are aborted and free their per-server slots on the next frame.
        for (const request of requests) request.cancel?.();
        requests.clear();
        listeners.tileError.clear();
        listeners.frameReady.clear();
        if (usable(record.host) && record.host.contains(record.cesium))
          record.host.remove(record.cesium, true);
        else if (!record.cesium.isDestroyed()) record.cesium.destroy();
        record.host = null;
        requestRender('imagery');
      },
    };
    if (capabilities.has('imageryFrames')) {
      handle.setFrames = (source, options = {}) => {
        const frames = framesOf(source);
        if (record.removed) return;
        dropFrames(record);
        record.timed = {
          video: source.kind === 'video',
          frames,
          mode: options.mode === 'blend' ? 'blend' : 'nearest',
          prefetch: Math.max(0, Math.floor(options.prefetch ?? 1)),
          clock: options.clock === 'own' ? 'own' : 'scene',
          own: null,
          at: null,
          announced: null,
          layers: new Map(),
          videos: source.kind === 'video' ? createTileVideos() : null,
        };
        record.cesium.show = false;
        requestRender('imagery');
      };
      handle.setFrameTime = (ms) => {
        // On the scene clock the frame port's time decides.
        if (record.timed?.clock !== 'own') return;
        record.timed.own = Number(ms);
        requestRender('imagery');
      };
    }
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

  // --- Timed frames (`imageryFrames`) ---------------------------------------

  /** A Cesium layer drawing one frame of a record's timed source. */
  function frameLayer(record, frame) {
    const timed = record.timed;
    const spec = { ...record.spec, url: frame.url };
    const entry = { layer: null, host: null, offError: null };
    let made;
    try {
      made = timed.video
        ? videoProvider(record.spec, frame, timed.videos)
        : providerFor(spec, { worldDataToken: worldDataToken() });
    } catch (error) {
      report(error);
      made = Promise.reject(error);
    }
    if (typeof made?.then === 'function') {
      const provider = Promise.resolve(made).then((provider) => {
        if (!entry.removed) entry.offError = record.watchErrors(provider);
        return hookProvider(provider, spec, record.ctx);
      });
      provider.catch(() => {});
      entry.layer = Cesium.ImageryLayer.fromProviderAsync(
        provider,
        layerOptions(spec),
      );
    } else {
      entry.offError = record.watchErrors(made);
      entry.layer = new Cesium.ImageryLayer(
        timed.video ? made : hookProvider(made, spec, record.ctx),
        layerOptions(spec),
      );
    }
    entry.layer.alpha = 0;
    return entry;
  }

  function dropFrameLayer(entry) {
    entry.removed = true;
    entry.offError?.();
    if (usable(entry.host) && entry.host.contains(entry.layer))
      entry.host.remove(entry.layer, true);
    else if (!entry.layer.isDestroyed()) entry.layer.destroy();
    entry.host = null;
  }

  /** Let go of a record's timed source and its frames' layers. */
  function dropFrames(record) {
    const timed = record.timed;
    if (!timed) return;
    for (const entry of timed.layers.values()) dropFrameLayer(entry);
    timed.layers.clear();
    timed.videos?.clear();
    record.timed = null;
    if (!record.cesium.isDestroyed()) record.cesium.show = record.show;
  }

  /**
   * Before each frame: the frames each timed layer's clock shows now, and
   * those it prefetches, as layers just above its own, in time order.
   */
  function stepFrames(time) {
    if (disposed) return;
    const sceneMs = time ? Cesium.JulianDate.toDate(time).getTime() : NaN;
    for (const record of layers) {
      const timed = record.timed;
      if (!timed || record.removed) continue;
      const ms = timed.clock === 'own' ? (timed.own ?? NaN) : sceneMs;
      const at = shownAt(timed.frames, ms, timed.mode);
      timed.at = at;
      const held = at ? heldFrames(timed.frames, at, timed.prefetch) : [];
      for (const [index, entry] of timed.layers)
        if (!held.includes(index) || entry.layer.isDestroyed()) {
          dropFrameLayer(entry);
          timed.layers.delete(index);
        }
      const host =
        usable(record.host) && record.host.contains(record.cesium)
          ? record.host
          : null;
      const weights = new Map(at?.shown.map((s) => [s.index, s.weight]));
      let place = host ? host.indexOf(record.cesium) + 1 : -1;
      for (const index of held.sort((a, b) => a - b)) {
        let entry = timed.layers.get(index);
        if (!entry) {
          entry = frameLayer(record, timed.frames[index]);
          timed.layers.set(index, entry);
        }
        const layer = entry.layer;
        const weight = weights.get(index);
        // Prefetched frames load unseen: shown, at alpha 0.
        layer.show = record.show;
        layer.alpha = weight === undefined ? 0 : record.alpha * weight;
        layer.splitDirection = Cesium.SplitDirection[SPLITS[record.split]];
        if (entry.host !== host) {
          if (usable(entry.host) && entry.host.contains(layer))
            entry.host.remove(layer, false);
          entry.host = null;
          if (host) {
            host.add(layer, Math.min(place, host.length));
            entry.host = host;
          }
        } else if (host && host.indexOf(layer) !== place) {
          host.remove(layer, false);
          host.add(layer, Math.min(place, host.length));
        }
        if (host) place = host.indexOf(layer) + 1;
      }
    }
  }

  /** Whether a frame's layer is drawn where it drapes. */
  function frameDrawn(entry) {
    if (!entry?.host || !entry.layer.ready) return false;
    if (entry.host === globeCollection()) return layerDrawn(scene, entry.layer);
    return objects()?.tilesLoaded === true;
  }

  /** After each frame: each timed layer's shown frame, once it is drawn. */
  function announceFrames() {
    if (disposed) return;
    // Most frames have no timed layer: the copy below is made only for one.
    let timedLayers = false;
    for (const record of layers) if (record.timed?.at) timedLayers = true;
    if (!timedLayers) return;
    for (const record of layers.slice()) {
      const timed = record.timed;
      // A layer removed by another's listener says nothing.
      if (record.removed || !timed?.at || !record.show) continue;
      const time = timed.frames[timed.at.nearest].time;
      if (time === timed.announced) continue;
      if (!timed.at.shown.every((s) => frameDrawn(timed.layers.get(s.index))))
        continue;
      timed.announced = time;
      record.listeners.frameReady.fire(time);
    }
  }

  const frameOffs = capabilities.has('imageryFrames')
    ? [
        scene.preRender?.addEventListener?.((_, time) => stepFrames(time)),
        scene.postRender?.addEventListener?.(() => announceFrames()),
      ]
    : [];

  return {
    add,
    list: () => layers.map((record) => record.handle),
    /** How many layers the port holds, without listing them. */
    get size() {
      return layers.length;
    },
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
      for (const off of frameOffs.splice(0)) off?.();
      clearTimeout(retryTimer);
      retryTimer = null;
      for (const resolve of waiters.splice(0)) resolve();
    },
  };
}
