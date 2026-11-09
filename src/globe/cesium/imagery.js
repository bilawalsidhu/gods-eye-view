// engine.imagery on Cesium: one ImageryLayer per layer, on the imagery
// stack of the surface the map shows — the globe's imagery layers, or the
// shown 3D tileset's own (Cesium drapes imagery on tiles there), as
// The engine resolves the active surface. Layers sit above the
// base imagery, in their order among the engine's layers (higher on top,
// then creation); imagery added by others stays where it was put. A tiles
// source is a UrlTemplateImageryProvider in Web Mercator or geographic
// tiling (its transform applied to each tile as it arrives), an image
// source a one-tile provider over its rectangle (as
// SingleTileImageryProvider, but from the canvas or image itself, without a
// PNG round trip). The engine follows the surface on every frame while it
// holds a layer: on a switch each layer is built again on the new stack,
// never re-parented. A staged source is a second layer at alpha 0 right
// over the drawn one, whose tiles Cesium loads while the drawn one shows;
// it takes the drawn one's place once its own requests are in and quiet.
// A raised layer is a shell primitive instead (imageryShell.js), on every
// surface. Cesium stretches the edge texels of its base layer (the first
// layer shown on the globe) over the whole globe: an engine layer that
// covers less than the globe never becomes it, a floor lies under it then.

import * as Cesium from 'cesium';
import { createImageryRegistry, isPixelImage } from '../imagery.js';
import { createImageryShell } from './imageryShell.js';

const SPLIT = { none: 'NONE', left: 'LEFT', right: 'RIGHT' };
const NO_HOST = Object.freeze({ collection: null, surface: 'none' });
/** Delay before the one frame that retries tiles a provider deferred. */
export const TILE_RETRY_DELAY_MS = 250;
/** How often a staged source waiting out its quiet interval rechecks readiness. */
const STAGE_WAKE_MS = 150;
// A staged source's own tiles are in once no request was made or settled
// for this long; two frames in a row must find it so.
const STAGE_QUIET_MS = 200;
// Retries of a staged tile the server throttled (429, 503).
const STAGE_RETRIES = 3;

const rectangleOf = ({ west, south, east, north }) =>
  Cesium.Rectangle.fromDegrees(west, south, east, north);

const GLOBE = Object.freeze({ west: -180, south: -90, east: 180, north: 90 });
// The floor's image: one transparent pixel, as a texture source Cesium
// uploads without a canvas.
const CLEAR_PIXEL = Object.freeze({
  width: 1,
  height: 1,
  arrayBufferView: new Uint8Array(4),
});
// Whether a source draws on the whole globe (Web Mercator tiles stop at
// ±85.05°).
const coversGlobe = (source) =>
  !(source.kind === 'tiles' && source.scheme !== 'geographic') &&
  Object.entries(GLOBE).every(
    ([edge, value]) => source.rectangle[edge] === value,
  );

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

// A decoded tile with row 0 on the north edge, as a transform takes it:
// Cesium decodes tiles as ImageBitmaps already flipped (WebGL ignores
// UNPACK_FLIP_Y for them), so those are drawn upright on a canvas, which
// Cesium flips again as it uploads.
function upright(image, createCanvas) {
  if (typeof ImageBitmap === 'undefined' || !(image instanceof ImageBitmap))
    return image;
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext('2d');
  context.setTransform(1, 0, 0, -1, 0, image.height);
  context.drawImage(image, 0, 0);
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
    credit,
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
function admitTileRequests(provider, admission, requestRender, retry) {
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
  shell: createImageryShell,
});

/**
 * @param {Cesium.Viewer} viewer
 * @param {{ requestRender?: (reason: string) => void,
 *   tilesets?: () => object[], createCanvas?: (width: number, height: number) => object,
 *   factories?: object, setTimeout?: Function, clearTimeout?: Function }} [options]
 *   `tilesets` are the 3D tilesets the map may show (maps.js); a shown one
 *   with imagery layers hosts the imagery while the globe is hidden.
 *   `createCanvas`, `factories` (the tile provider, the layer, the image
 *   load, a raised layer's shell) and the timers are test seams.
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
  let removeGuard = null;
  // { layer, collection }: one transparent tile over the globe at alpha 0
  // (Cesium draws nothing of it), the globe's base layer while an engine
  // layer covering less than the globe would be.
  let floor = null;
  const now = () => globalThis.performance?.now() ?? Date.now();

  function host() {
    if (scene.globe.show === true)
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

  // The source an engine layer draws, or null for a layer of others.
  function sourceOf(layer) {
    for (const entry of entries) {
      if (entry.layer === layer) return entry.state.source;
      if (entry.staging?.layer === layer) return entry.staging.source;
    }
    return null;
  }

  function dropFloor() {
    if (!floor) return;
    const { layer, collection } = floor;
    floor = null;
    if (usable(collection) && collection.contains(layer))
      collection.remove(layer, true);
    else if (!layer.isDestroyed?.()) layer.destroy?.();
  }

  // Before Cesium picks the base layer (each frame, and after each change
  // here): the floor under the first layer shown on the globe when that is
  // an engine layer covering less than the globe, else none.
  function guardBase() {
    const { collection, surface } = host();
    const globe =
      surface === 'globe' &&
      usable(collection) &&
      typeof collection.get === 'function'
        ? collection
        : null;
    if (floor && floor.collection !== globe) dropFloor();
    if (!globe) return;
    let base = null;
    for (let i = 0; i < globe.length && !base; i++) {
      const layer = globe.get(i);
      if (layer !== floor?.layer && layer.show) base = layer;
    }
    const source = base && sourceOf(base);
    if (!source || coversGlobe(source)) {
      dropFloor();
      return;
    }
    if (floor) {
      if (globe.indexOf(floor.layer) > globe.indexOf(base))
        globe.lowerToBottom(floor.layer);
      return;
    }
    const layer = make.layer(
      singleImageProvider(CLEAR_PIXEL, rectangleOf(GLOBE), undefined),
      { alpha: 0, show: true },
    );
    globe.add(layer, 0);
    floor = { layer, collection: globe };
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

  const creditOf = (html) => (html ? new Cesium.Credit(html) : undefined);

  // Each tile through the source's transform, upright.
  function transformTiles(provider, transform) {
    const original = provider.requestImage.bind(provider);
    provider.requestImage = (x, y, level, request) => {
      const result = original(x, y, level, request);
      return result
        ? Promise.resolve(result).then((image) =>
            transform(upright(image, createCanvas)),
          )
        : result;
    };
    return provider;
  }

  // `drawing` is the entry or a staged job ({ credit, retry, image }).
  function providerFor(drawing, source) {
    let provider;
    if (source.kind === 'tiles') {
      provider = make.tiles({
        url: source.url,
        subdomains: [...source.subdomains],
        minimumLevel: source.minLevel,
        maximumLevel: source.maxLevel,
        tileWidth: source.tileSize,
        tileHeight: source.tileSize,
        tilingScheme:
          source.scheme === 'geographic'
            ? new Cesium.GeographicTilingScheme()
            : new Cesium.WebMercatorTilingScheme(),
        rectangle: rectangleOf(source.rectangle),
        hasAlphaChannel: !source.opaque,
        enablePickFeatures: false,
        ...(source.credit ? { credit: source.credit } : {}),
      });
      if (source.transform) transformTiles(provider, source.transform);
      if (source.maxRequests)
        admitTileRequests(
          provider,
          { limit: source.maxRequests, inFlight: 0 },
          requestRender,
          drawing.retry,
        );
    } else
      provider = singleImageProvider(
        drawable(drawing.image, createCanvas),
        rectangleOf(source.rectangle),
        undefined,
      );
    // Cesium reads a provider's credit every frame: a new credit of the same
    // source replaces it without a new layer.
    Object.defineProperty(provider, 'credit', {
      configurable: true,
      enumerable: true,
      get: () => drawing.credit,
    });
    return provider;
  }

  function applyLook(entry) {
    const { layer, state, shell } = entry;
    if (shell) {
      shell.setAlpha(state.alpha);
      shell.setShow(state.shown);
      return;
    }
    if (!layer) return;
    layer.alpha = state.alpha;
    layer.show = state.shown;
    layer.splitDirection = Cesium.SplitDirection[SPLIT[state.split]];
    guardBase();
  }

  // A raised layer's place among the shells: the engine's draw order.
  const rankOf = (entry) => entry.state.options.order * 1e6 + entry.state.seq;

  // A raised layer's detail rectangle in its image's texture coordinates.
  function detailWindow(source, detail) {
    const box = source.rectangle;
    const east = box.east <= box.west ? box.east + 360 : box.east;
    const x = east - box.west;
    const y = box.north - box.south;
    const r = detail.rectangle;
    return {
      west: (r.west - box.west) / x,
      south: (r.south - box.south) / y,
      east: (r.east - box.west) / x,
      north: (r.north - box.south) / y,
    };
  }

  // A raised layer on its shell: an image again on the same rectangle
  // (Cesium draws the last texture until it is uploaded), else a new shell
  // in place of the last. With `onDrawn` (a staged source) a shell on
  // another rectangle waits unseen until it has drawn, then replaces the
  // drawn one, and `onDrawn` runs once the image has drawn.
  function mountShell(entry, source, decoded, onDrawn = null) {
    const image = drawable(decoded, createCanvas);
    const same = (box) =>
      ['west', 'south', 'east', 'north'].every(
        (edge) => box[edge] === source.rectangle[edge],
      );
    let shell = entry.shell;
    if (shell && same(shell.rectangle)) shell.setImage(image);
    else {
      shell = make.shell({
        scene,
        rectangle: source.rectangle,
        height: entry.state.options.raise,
        rank: rankOf(entry),
        onSettled: () => {
          const waiting = entry.shellWaiting;
          if (waiting?.shell === shell && shell.drawn()) {
            entry.shellWaiting = null;
            waiting.done();
          }
          entry.detailWaiting?.check();
        },
      });
      shell.setImage(image);
      if (onDrawn && entry.shell) shell.setAlpha(0);
      else {
        entry.shell?.destroy();
        entry.shell = shell;
      }
    }
    const detail = entry.state.detail;
    if (detail)
      shell.setDetail(
        drawable(detail.image, createCanvas),
        detailWindow(source, detail),
      );
    applyLook(entry);
    requestRender('imagery');
    if (!onDrawn) return;
    const done = () => {
      if (entry.shell !== shell) {
        entry.shell?.destroy();
        entry.shell = shell;
        applyLook(entry);
      }
      onDrawn();
    };
    if (shell.drawn()) done();
    else entry.shellWaiting = { shell, done };
  }

  // The layer for the current source on the current host, in place of the
  // one drawn (at its index, so a new source keeps its stack position).
  function mount(entry) {
    const source = entry.state.source;
    if (entry.state.options.raise !== null) {
      if (entry.image) mountShell(entry, source, entry.image);
      return;
    }
    const { collection } = host();
    if (!usable(collection) || (source.kind === 'image' && !entry.image)) {
      detach(entry);
      guardBase();
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

  // An image source's image: now, or once its URL has loaded (null when it
  // fails). `owner()` says whether the load is still wanted.
  function imageOf(source, owner) {
    if (source.kind !== 'image') return Promise.resolve(null);
    if (source.image) return Promise.resolve(source.image);
    return Promise.resolve(make.loadImage(source.url)).then(
      (image) => (owner() ? image : null),
      (error) => {
        if (owner()) console.warn('[Imagery] image failed to load:', error);
        return null;
      },
    );
  }

  // An image source: its image now, or once its URL has loaded.
  function load(entry) {
    const source = entry.state.source;
    entry.loading = null;
    entry.credit = creditOf(source.credit);
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

  // A staged source on a draped layer: a second layer at alpha 0 right over
  // the drawn one. Its requests are counted; once they are in (the globe's
  // tiles all loaded, or its own quiet for a while) for two frames in a
  // row, it takes the drawn one's place, which goes after the next frame.
  function stageDraped(entry, job) {
    const { collection } = host();
    if (!usable(collection) || !entry.state.shown) {
      // Nothing draws it now: it replaces the drawn one at once.
      swapIn(entry, job);
      return;
    }
    job.collection = collection;
    const provider = providerFor(job, job.source);
    const requestImage = provider.requestImage.bind(provider);
    job.restoreRequests = () => {
      provider.requestImage = requestImage;
    };
    provider.requestImage = (x, y, level, request) => {
      if (job.closed) return undefined;
      const result = requestImage(x, y, level, request);
      const key = `${level}/${x}/${y}`;
      job.lastActivity = now();
      if (!result) {
        // Scheduler admission is part of readiness, not a loaded tile.
        job.deferred.add(key);
        return result;
      }
      job.deferred.delete(key);
      job.pending++;
      return Promise.resolve(result)
        .then((image) => {
          job.retries.delete(key);
          job.loaded++;
          return image;
        })
        .finally(() => {
          job.pending--;
          job.lastActivity = now();
          if (!job.closed) requestRender('imagery-stage');
        });
    };
    job.offError = provider.errorEvent?.addEventListener((error) => {
      if (job.closed) return;
      const status = error?.error?.statusCode;
      const key = `${error.level}/${error.x}/${error.y}`;
      const retries = job.retries.get(key) ?? 0;
      error.retry = false;
      if ((status === 429 || status === 503) && retries < STAGE_RETRIES) {
        job.retries.set(key, retries + 1);
        error.retry = true;
        return;
      }
      job.failed = true;
      requestRender('imagery-stage');
    });
    job.layer = make.layer(provider, { alpha: 0, show: true });
    job.layer.splitDirection = Cesium.SplitDirection[SPLIT[entry.state.split]];
    if (entry.layer && entry.collection === collection)
      collection.add(job.layer, collection.indexOf(entry.layer) + 1);
    else place(entry, job.layer, collection);
    guardBase();
    let settled = 0;
    job.offCamera = scene.camera?.moveEnd?.addEventListener(() => {
      // Tiles abandoned by the last view are no longer the source's work.
      job.deferred.clear();
      job.lastActivity = now();
      settled = 0;
      requestRender('imagery-stage');
    });
    job.offRender = scene.postRender?.addEventListener(() => {
      if (job.closed) return;
      if (job.failed) {
        closeJob(job);
        entry.staging = null;
        job.finish(false);
        return;
      }
      const own =
        job.loaded > 0 &&
        job.deferred.size === 0 &&
        now() - job.lastActivity >= STAGE_QUIET_MS;
      const globeIn =
        host().surface === 'globe' && scene.globe?.tilesLoaded === true;
      if ((globeIn || own) && job.pending === 0) {
        if (++settled >= 2) swapIn(entry, job);
        else requestRender('imagery-stage');
        return;
      }
      settled = 0;
      // Waiting out the quiet interval needs another check later, not a
      // frame every frame.
      if (job.pending === 0 && job.loaded > 0 && job.wake === null)
        job.wake = after(() => {
          job.wake = null;
          if (!job.closed) requestRender('imagery-stage');
        }, STAGE_WAKE_MS);
    });
    requestRender('imagery-stage');
  }

  function closeJob(job) {
    job.closed = true;
    job.offRender?.();
    job.offCamera?.();
    job.offError?.();
    job.retry.cancel();
    if (job.wake !== null) cancel(job.wake);
    job.wake = null;
    const { layer, collection } = job;
    job.layer = null;
    if (!layer) return;
    if (usable(collection) && collection.contains(layer))
      collection.remove(layer, true);
    else if (!layer.isDestroyed?.()) layer.destroy?.();
    guardBase();
  }

  // The staged source takes the drawn one's place.
  function swapIn(entry, job) {
    entry.staging = null;
    const layer = job.layer;
    job.restoreRequests?.();
    if (layer)
      Object.defineProperty(layer.imageryProvider, 'credit', {
        configurable: true,
        get: () => entry.credit,
      });
    job.layer = null;
    closeJob(job);
    entry.loading = null;
    entry.image = job.image;
    entry.credit = job.credit;
    entry.retry.cancel();
    entry.retry = job.retry;
    job.finish(true);
    if (!layer) {
      mount(entry);
      return;
    }
    const previous = entry.layer;
    const previousCollection = entry.collection;
    entry.layer = layer;
    entry.collection = job.collection;
    applyLook(entry);
    if (previous) {
      // The drawn one goes after the next frame, which draws the new one.
      const off = scene.postRender?.addEventListener(() => {
        off();
        if (usable(previousCollection) && previousCollection.contains(previous))
          previousCollection.remove(previous, true);
        else if (!previous.isDestroyed?.()) previous.destroy?.();
        requestRender('imagery-stage');
      });
      if (!off) {
        if (previousCollection?.contains(previous))
          previousCollection.remove(previous, true);
      }
    }
    requestRender('imagery-stage');
  }

  // Follow the surface: a layer whose stack is not the current one is
  // built again there (none: it waits without a layer); a staged source
  // on the last stack starts again on the new one.
  const follow = () => {
    const { collection } = host();
    for (const entry of entries) {
      if (entry.state.options.raise !== null) continue;
      if (entry.collection !== collection && (entry.layer || collection))
        mount(entry);
      const job = entry.staging;
      if (job?.layer && job.collection !== collection) {
        closeJob(job);
        Object.assign(job, freshJob(job));
        stageDraped(entry, job);
      }
    }
  };

  // A staged job's counters, new.
  const freshJob = (job) => ({
    closed: false,
    layer: null,
    collection: null,
    pending: 0,
    loaded: 0,
    failed: false,
    deferred: new Set(),
    retries: new Map(),
    lastActivity: now(),
    wake: null,
    retry: makeRetry(() => job.state),
  });
  const watch = () => {
    if (!removeWatch && scene.preRender)
      removeWatch = scene.preRender.addEventListener(follow);
    // Cesium picks the base layer before the frame's preRender.
    if (!removeGuard && scene.preUpdate)
      removeGuard = scene.preUpdate.addEventListener(guardBase);
  };
  const unwatch = () => {
    if (entries.size) return;
    removeWatch?.();
    removeWatch = null;
    removeGuard?.();
    removeGuard = null;
    dropFloor();
  };

  // One timer per layer: any number of provider deferrals while it is
  // armed share the same single retry frame.
  function makeRetry(stateOf) {
    let retryTimer = null;
    return {
      schedule() {
        if (retryTimer !== null) return;
        retryTimer = after(() => {
          retryTimer = null;
          if (!stateOf()?.destroyed) requestRender('imagery-retry');
        }, TILE_RETRY_DELAY_MS);
      },
      cancel() {
        if (retryTimer !== null) cancel(retryTimer);
        retryTimer = null;
      },
    };
  }

  function unstage(entry) {
    const job = entry.staging;
    entry.staging = null;
    if (!job) return;
    const waiting = entry.shellWaiting;
    entry.shellWaiting = null;
    if (waiting && waiting.shell !== entry.shell) waiting.shell.destroy();
    closeJob(job);
  }

  const registry = createImageryRegistry(
    (state) => {
      const entry = {
        state,
        layer: null,
        collection: null,
        image: null,
        loading: null,
        credit: undefined,
        shell: null,
        shellWaiting: null,
        detailWaiting: null,
        staging: null,
        retry: makeRetry(() => state),
      };
      entries.add(entry);
      watch();
      load(entry);
      return {
        source() {
          unstage(entry);
          load(entry);
        },
        credit() {
          entry.credit = creditOf(state.source.credit);
          requestRender('imagery-credit');
        },
        stage(source, finish) {
          unstage(entry);
          const job = {
            state,
            source,
            finish,
            image: null,
            credit: creditOf(source.credit),
          };
          Object.assign(job, freshJob(job));
          entry.staging = job;
          imageOf(source, () => entry.staging === job && !state.destroyed).then(
            (image) => {
              if (entry.staging !== job || state.destroyed) return;
              if (source.kind === 'image' && !image) {
                entry.staging = null;
                closeJob(job);
                finish(false);
                return;
              }
              job.image = image;
              if (state.options.raise === null) {
                stageDraped(entry, job);
                return;
              }
              // A raised layer: the image on its shell, in place once it
              // has drawn (a hidden shell draws nothing: at once).
              const swap = () => {
                if (entry.staging !== job) return;
                entry.staging = null;
                closeJob(job);
                entry.image = image;
                entry.credit = job.credit;
                finish(true);
              };
              if (state.shown) mountShell(entry, source, image, swap);
              else {
                mountShell(entry, source, image);
                swap();
              }
            },
          );
        },
        unstage: () => unstage(entry),
        detail(detail, finish) {
          entry.detailWaiting = null;
          const shell = entry.shell;
          if (!shell) {
            finish(detail !== null);
            return;
          }
          if (!detail) {
            shell.setDetail(null);
            return;
          }
          const image = drawable(detail.image, createCanvas);
          shell.setDetail(image, detailWindow(state.source, detail));
          const waiting = {
            check() {
              if (entry.detailWaiting !== waiting) return;
              if (shell.detail() !== image || !shell.drawn()) return;
              entry.detailWaiting = null;
              finish(true);
            },
          };
          entry.detailWaiting = waiting;
          waiting.check();
        },
        look() {
          applyLook(entry);
          if (entry.staging?.layer)
            entry.staging.layer.splitDirection =
              Cesium.SplitDirection[SPLIT[state.split]];
          // A hidden layer stages nothing: the staged source replaces the
          // drawn one at once.
          if (!state.shown && entry.staging?.layer)
            swapIn(entry, entry.staging);
          requestRender('imagery-look');
        },
        ready: () =>
          state.options.raise !== null
            ? Boolean(entry.shell?.drawn())
            : Boolean(entry.layer?.ready),
        destroy() {
          entries.delete(entry);
          entry.loading = null;
          unstage(entry);
          entry.retry.cancel();
          entry.shell?.destroy();
          entry.shell = null;
          entry.detailWaiting = null;
          detach(entry);
          guardBase();
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
