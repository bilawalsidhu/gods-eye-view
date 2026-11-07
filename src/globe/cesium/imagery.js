// engine.imagery on Cesium: one ImageryLayer per layer, on the imagery
// stack of the surface the map shows — the globe's imagery layers, or the
// shown 3D tileset's own (Cesium drapes imagery on tiles there), as
// src/maps/imageryHost.js resolves it for the shell. Layers sit above the
// base imagery, in their order among the engine's layers (higher on top,
// then creation); imagery added by others stays where it was put. A tiles
// source is a UrlTemplateImageryProvider in Web Mercator, an image source a
// one-tile provider over its rectangle (as SingleTileImageryProvider, but
// from the canvas or image itself, without a PNG round trip). The engine
// follows the surface on every frame while it holds a layer: on a switch
// each layer is built again on the new stack, never re-parented.

import * as Cesium from 'cesium';
import { createImageryRegistry, isPixelImage } from '../imagery.js';

const SPLIT = { none: 'NONE', left: 'LEFT', right: 'RIGHT' };
const NO_HOST = Object.freeze({ collection: null, surface: 'none' });
/** Delay before the one frame that retries tiles a provider deferred. */
export const TILE_RETRY_DELAY_MS = 250;

const rectangleOf = ({ west, south, east, north }) =>
  Cesium.Rectangle.fromDegrees(west, south, east, north);

const defaultCanvas = (width, height) =>
  Object.assign(document.createElement('canvas'), { width, height });

// RGBA bytes on a canvas Cesium can upload.
function drawable(image, createCanvas) {
  if (!isPixelImage(image)) return image;
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext('2d');
  const pixels = context.createImageData(image.width, image.height);
  pixels.data.set(image.data);
  context.putImageData(pixels, 0, 0);
  return canvas;
}

// One image over `rectangle`: SingleTileImageryProvider's tiling (one
// geographic tile at level 0), handing Cesium the image itself.
function singleImageProvider(image, rectangle, credit) {
  const tilingScheme = new Cesium.GeographicTilingScheme({
    rectangle,
    numberOfLevelZeroTilesX: 1,
    numberOfLevelZeroTilesY: 1,
  });
  return {
    tilingScheme,
    rectangle,
    tileWidth: image.width,
    tileHeight: image.height,
    minimumLevel: 0,
    maximumLevel: 0,
    tileDiscardPolicy: undefined,
    credit: credit ? new Cesium.Credit(credit) : undefined,
    errorEvent: new Cesium.Event(),
    hasAlphaChannel: true,
    proxy: undefined,
    getTileCredits: () => undefined,
    pickFeatures: () => undefined,
    // ImageryLayer consumes requestImage results as promises.
    requestImage: () => Promise.resolve(image),
  };
}

/**
 * Gate a provider's `requestImage` to `limit` requests in flight. Returning
 * `undefined` tells Cesium to retry on a later frame, but under
 * `requestRenderMode` there is no later frame unless something asks — and a
 * deferral must never ask for one itself: the retried tile would defer again
 * and ask again, keeping the scene rendering every frame. So a request that
 * finds the gate full asks for nothing (the request holding the slot asks
 * for one frame when it settles), and a request the provider itself
 * deferred goes through one coalesced delayed retry.
 */
export function admitTileRequests(provider, admission, requestRender, retry) {
  const original = provider.requestImage.bind(provider);
  provider.requestImage = (x, y, level, request) => {
    if (admission.inFlight >= admission.limit) return undefined;
    admission.inFlight += 1;
    const release = () => {
      admission.inFlight -= 1;
    };
    let promise;
    try {
      promise = original(x, y, level, request);
    } catch (error) {
      release();
      throw error;
    }
    if (!promise) {
      release();
      retry.schedule();
      return undefined;
    }
    return Promise.resolve(promise).finally(() => {
      release();
      requestRender('imagery-tiles');
    });
  };
  return provider;
}

const defaultFactories = Object.freeze({
  tiles: (options) => new Cesium.UrlTemplateImageryProvider(options),
  layer: (provider, options) => new Cesium.ImageryLayer(provider, options),
  loadImage: (url) => Cesium.Resource.fetchImage({ url }),
});

/**
 * @param {Cesium.Viewer} viewer
 * @param {{ requestRender?: (reason: string) => void,
 *   tilesets?: () => object[], createCanvas?: (width: number, height: number) => object,
 *   factories?: object, setTimeout?: Function, clearTimeout?: Function }} [options]
 *   `tilesets` are the 3D tilesets the map may show (maps.js); a shown one
 *   with imagery layers hosts the imagery while the globe is hidden.
 *   `createCanvas`, `factories` (the tile provider, the layer, the image
 *   load) and the timers are test seams.
 * @returns {{ imagery: import('../contract.js').GlobeImagery, destroy: () => void }}
 */
export function createCesiumImagery(
  viewer,
  {
    requestRender = () => viewer.scene.requestRender(),
    tilesets = () => [],
    createCanvas = defaultCanvas,
    factories = {},
    setTimeout: after = (run, ms) => globalThis.setTimeout(run, ms),
    clearTimeout: cancel = (id) => globalThis.clearTimeout(id),
  } = {},
) {
  const make = { ...defaultFactories, ...factories };
  const { scene } = viewer;
  const entries = new Set();
  let removeWatch = null;

  function host() {
    if (scene.globe?.show === true && viewer.imageryLayers)
      return { collection: viewer.imageryLayers, surface: 'globe' };
    const tileset = tilesets().find(
      (candidate) =>
        candidate?.show === true &&
        candidate.imageryLayers &&
        !candidate.isDestroyed?.(),
    );
    return tileset
      ? { collection: tileset.imageryLayers, surface: 'tiles' }
      : NO_HOST;
  }

  const usable = (collection) => collection && !collection.isDestroyed?.();
  function detach(entry) {
    const { layer, collection } = entry;
    entry.layer = null;
    entry.collection = null;
    if (!layer) return;
    if (usable(collection) && collection.contains(layer))
      collection.remove(layer, true);
    else if (!layer.isDestroyed?.()) layer.destroy?.();
  }

  // Above every engine layer under it in draw order, below every one over
  // it; at the top when none is over it.
  function place(entry, layer, collection) {
    let index = collection.length;
    for (const other of entries) {
      if (other === entry || other.collection !== collection || !other.layer)
        continue;
      const over =
        other.state.options.order > entry.state.options.order ||
        (other.state.options.order === entry.state.options.order &&
          other.state.seq > entry.state.seq);
      if (over) index = Math.min(index, collection.indexOf(other.layer));
    }
    collection.add(layer, index);
  }

  function providerFor(entry, source) {
    if (source.kind === 'tiles') {
      const provider = make.tiles({
        url: source.url,
        subdomains: [...source.subdomains],
        minimumLevel: source.minLevel,
        maximumLevel: source.maxLevel,
        tileWidth: source.tileSize,
        tileHeight: source.tileSize,
        tilingScheme: new Cesium.WebMercatorTilingScheme(),
        rectangle: rectangleOf(source.rectangle),
        hasAlphaChannel: !source.opaque,
        enablePickFeatures: false,
        ...(source.credit ? { credit: source.credit } : {}),
      });
      return source.maxRequests
        ? admitTileRequests(
            provider,
            { limit: source.maxRequests, inFlight: 0 },
            requestRender,
            entry.retry,
          )
        : provider;
    }
    return singleImageProvider(
      drawable(entry.image, createCanvas),
      rectangleOf(source.rectangle),
      source.credit,
    );
  }

  function applyLook(entry) {
    const { layer, state } = entry;
    if (!layer) return;
    layer.alpha = state.alpha;
    layer.show = state.shown;
    layer.splitDirection =
      Cesium.SplitDirection?.[SPLIT[state.split]] ?? layer.splitDirection;
  }

  // The layer for the current source on the current host, in place of the
  // one drawn (at its index, so a new source keeps its stack position).
  function mount(entry) {
    const { collection } = host();
    const source = entry.state.source;
    if (!usable(collection) || (source.kind === 'image' && !entry.image)) {
      detach(entry);
      return;
    }
    const layer = make.layer(providerFor(entry, source), {
      alpha: entry.state.alpha,
      show: entry.state.shown,
    });
    const previous = entry.layer;
    if (previous && entry.collection === collection) {
      collection.add(layer, collection.indexOf(previous));
      collection.remove(previous, true);
    } else {
      detach(entry);
      place(entry, layer, collection);
    }
    entry.layer = layer;
    entry.collection = collection;
    applyLook(entry);
    requestRender('imagery');
  }

  // An image source: its image now, or once its URL has loaded.
  function load(entry) {
    const source = entry.state.source;
    entry.loading = null;
    if (source.kind !== 'image' || source.image) {
      entry.image = source.image;
      mount(entry);
      return;
    }
    entry.image = null;
    const pending = Promise.resolve(make.loadImage(source.url));
    entry.loading = pending;
    pending.then(
      (image) => {
        if (entry.loading !== pending || entry.state.destroyed) return;
        entry.loading = null;
        entry.image = image;
        mount(entry);
      },
      (error) => {
        if (entry.loading !== pending) return;
        entry.loading = null;
        console.warn('[Imagery] image failed to load:', error);
      },
    );
  }

  // Follow the surface: a layer whose stack is not the current one is
  // built again there (none: it waits without a layer).
  const follow = () => {
    const { collection } = host();
    for (const entry of entries)
      if (entry.collection !== collection && (entry.layer || collection))
        mount(entry);
  };
  const watch = () => {
    if (!removeWatch && scene.preRender)
      removeWatch = scene.preRender.addEventListener(follow);
  };
  const unwatch = () => {
    if (entries.size || !removeWatch) return;
    removeWatch();
    removeWatch = null;
  };

  const registry = createImageryRegistry(
    (state) => {
      let retryTimer = null;
      const entry = {
        state,
        layer: null,
        collection: null,
        image: null,
        loading: null,
        // One timer per layer: any number of provider deferrals while it is
        // armed share the same single retry frame.
        retry: {
          schedule() {
            if (retryTimer !== null) return;
            retryTimer = after(() => {
              retryTimer = null;
              if (!state.destroyed) requestRender('imagery-retry');
            }, TILE_RETRY_DELAY_MS);
          },
          cancel() {
            if (retryTimer !== null) cancel(retryTimer);
            retryTimer = null;
          },
        },
      };
      entries.add(entry);
      watch();
      load(entry);
      return {
        source: () => load(entry),
        look() {
          applyLook(entry);
          requestRender('imagery-look');
        },
        ready: () => Boolean(entry.layer?.ready),
        destroy() {
          entries.delete(entry);
          entry.loading = null;
          entry.retry.cancel();
          detach(entry);
          unwatch();
          requestRender('imagery-destroy');
        },
      };
    },
    {
      // The scene's own: the shell's swipe controls set it too.
      readSplit: () =>
        Number.isFinite(scene.splitPosition) ? scene.splitPosition : 0.5,
      splitPosition(fraction) {
        scene.splitPosition = fraction;
        requestRender('imagery-split');
      },
      surface: () => host().surface,
    },
  );
  return {
    imagery: registry.imagery,
    destroy: () => registry.destroyAll(),
  };
}
