import { weatherTileUrl } from './source.js';
import { orderWeatherImagery } from './imageryOrder.js';
import { imageryHostStatus } from './imageryHost.js';
import { createRasterTileProvider } from './rasterTiles.js';
import { createWeatherShell } from './shellRendering.js';
import { readResponseBytesCapped } from '../../sources/httpBody.js';
import {
  acquireInfraredMosaic,
  processInfraredImage,
} from './infraredImage.js';
// Bounded display detail for the hourly, approximately 3 km global product.
const GLOBAL_TILE_MAXIMUM_LEVEL = 3;
// Six decoded 2048×1024 canvases (8 MiB each) bound the cache below 50 MiB.
const MAX_MOSAICS = 6;
const MAX_PREFETCH_TILES = 8;

/** Globe imagery: own at most a displayed and a staging frame. Use native Cesium
 * tile scheduling, projection and texture disposal; the application clock is never touched. */
function createGlobeRendering({
  viewer,
  cesium,
  getHost,
  onChange,
  timeoutMs,
  now,
  fetchImpl,
  decodeImage,
  createCanvas,
}) {
  let current = null;
  let incoming = null;
  const retiring = new Set();
  let alpha = 0.7;
  let frameHidden = false;
  let lastError = null;
  const mosaics = new Map();
  let prefetchJob = null;
  let prefetchedKey = null;

  function profile(product) {
    return {
      tileSize: 256,
      maximumLevel: product === 'clouds' ? GLOBAL_TILE_MAXIMUM_LEVEL : 6,
    };
  }

  function cancelPrefetch() {
    clearTimeout(prefetchJob?.timeout);
    prefetchJob?.controller.abort();
    prefetchJob = null;
    prefetchedKey = null;
  }

  async function mosaic(time, mode, signal, onFetched) {
    signal.throwIfAborted();
    const key = `${time}|${mode}`;
    const texture = mosaics.get(key);
    if (texture) {
      mosaics.delete(key);
      mosaics.set(key, texture);
      return { texture, decodeMs: 0, cached: true };
    }
    const result = await acquireInfraredMosaic(time, {
      signal,
      mode,
      createCanvas,
      fetchImpl,
      decodeImage,
      now,
      onFetched,
    });
    // An aborted decode may still finish; never repopulate a cleared instance.
    signal.throwIfAborted();
    mosaics.delete(key);
    mosaics.set(key, result.texture);
    while (mosaics.size > MAX_MOSAICS)
      mosaics.delete(mosaics.keys().next().value);
    return { ...result, cached: false };
  }

  function prefetchTiles(snapshot, time) {
    const { west, south, east, north } = snapshot.bounds;
    const bounds = cesium.Rectangle.fromDegrees(west, south, east, north);
    const view = viewer.camera?.computeViewRectangle?.(
      viewer.scene.globe?.ellipsoid,
    );
    const coverage = view
      ? cesium.Rectangle.intersection(bounds, view)
      : bounds;
    if (!coverage) return [];
    const scheme = new cesium.GeographicTilingScheme();
    const template = weatherTileUrl(snapshot.product, time, {
      size: profile(snapshot.product).tileSize,
    });
    const urls = [];
    for (let z = 0; z <= 1; z++) {
      for (let y = 0; y < scheme.getNumberOfYTilesAtLevel(z); y++) {
        for (let x = 0; x < scheme.getNumberOfXTilesAtLevel(z); x++) {
          if (
            !cesium.Rectangle.intersection(
              coverage,
              scheme.tileXYToRectangle(x, y, z),
            )
          )
            continue;
          urls.push(
            template.replace('{z}', z).replace('{x}', x).replace('{y}', y),
          );
          if (urls.length === MAX_PREFETCH_TILES) return urls;
        }
      }
    }
    return urls;
  }

  function remove(frame) {
    if (!frame) return;
    frame.closed = true;
    frame.controller.abort();
    frame.offRetire?.();
    frame.offInstall?.();
    retiring.delete(frame);
    frame.offError?.();
    frame.offAbort?.();
    frame.offRender?.();
    frame.offCamera?.();
    clearTimeout(frame.timeout);
    for (const request of frame.requests) request.cancel?.();
    frame.requests.clear();
    frame.retries.clear();
    if (!frame.layer) return;
    const collection = frame.collection;
    if (
      collection &&
      !collection.isDestroyed?.() &&
      collection.contains(frame.layer)
    )
      collection.remove(frame.layer, true);
    else if (!frame.layer.isDestroyed?.()) frame.layer.destroy?.();
  }
  function cancelIncoming() {
    if (!incoming) return;
    const previous = incoming;
    incoming = null;
    remove(previous);
    previous.resolve(false);
  }
  function rehome() {
    const host = getHost();
    const { collection } = host;
    const hidden = frameHidden || imageryHostStatus(host) !== null;
    const changed =
      (current && current.collection !== collection) ||
      (incoming && incoming.collection !== collection);
    const visibilityChanged = current && current.layer.show === hidden;
    if (changed || imageryHostStatus(host) !== null) {
      cancelPrefetch();
      cancelIncoming();
      for (const frame of retiring) remove(frame);
    }
    if (current) {
      if (!hidden && current.layer.alpha !== alpha) current.layer.alpha = alpha;
      if (visibilityChanged) current.layer.show = !hidden;
    }
    if (current && current.collection !== collection) {
      current.collection?.remove(current.layer, false);
      current.collection = collection;
      if (collection) {
        collection.add(current.layer);
        orderWeatherImagery(collection, current.layer, current.priority);
      }
    }
    if (changed || visibilityChanged) viewer.scene.requestRender();
    return Boolean(changed || visibilityChanged);
  }
  return {
    rehome,
    cancelPrefetch,
    async prefetch(snapshot, time, { infrared = 'filtered' } = {}) {
      let job;
      try {
        if (
          frameHidden ||
          incoming ||
          imageryHostStatus(getHost()) ||
          !snapshot.times.includes(time)
        )
          return false;
        const global = snapshot.product === 'clouds';
        const urls = global ? [] : prefetchTiles(snapshot, time);
        const key = global ? `${time}|${infrared}` : urls.join('|');
        if (prefetchJob?.key === key || prefetchedKey === key) return false;
        cancelPrefetch();
        job = { key, controller: new AbortController() };
        prefetchJob = job;
        const { signal } = job.controller;
        job.timeout = setTimeout(() => job.controller.abort(), timeoutMs);
        if (global) await mosaic(time, infrared, signal);
        else
          await Promise.all(
            urls.map(async (url) => {
              const response = await fetchImpl(url, { signal });
              if (!response.ok) throw new Error('Weather prefetch unavailable');
              await readResponseBytesCapped(response, 4 * 1024 * 1024 + 65_536);
            }),
          );
        signal.throwIfAborted();
        if (prefetchJob === job) prefetchedKey = key;
        return true;
      } catch {
        job?.controller.abort();
        return false;
      } finally {
        clearTimeout(job?.timeout);
        if (job && prefetchJob === job) prefetchJob = null;
      }
    },
    async setFrame(snapshot, time, { signal, infrared = 'filtered' } = {}) {
      signal?.throwIfAborted();
      cancelPrefetch();
      rehome();
      cancelIncoming();
      const host = getHost();
      const { collection, kind } = host;
      if (imageryHostStatus(host)) return false;
      const nextProfile = profile(snapshot.product);
      if (
        current?.time === time &&
        current.product === snapshot.product &&
        current.kind === kind &&
        current.infrared === infrared
      )
        return true;
      lastError = null;
      const { west, south, east, north } = snapshot.bounds;
      const rectangle = cesium.Rectangle.fromDegrees(west, south, east, north);
      const global = snapshot.product === 'clouds';
      const frame = {
        snapshot,
        time,
        infrared,
        mosaic: global
          ? { fetched: false, decodeMs: null, cached: false }
          : undefined,
        controller: new AbortController(),
        collection,
        kind,
        priority:
          snapshot.product === 'xweather-alerts'
            ? 4
            : snapshot.product === 'lightning' ||
                snapshot.product === 'xweather-lightning'
              ? 3
              : snapshot.product === 'radar' ||
                  snapshot.product === 'xweather-radar'
                ? 2
                : 1,
        product: snapshot.product,
        requests: new Set(),
        retries: new Map(),
        deferred: new Set(),
        pending: 0,
        loaded: 0,
        lastActivity: now(),
        startedAt: now(),
        closed: false,
        failed: false,
        resolve: null,
      };
      incoming = frame;
      const result = new Promise((resolve) => {
        frame.resolve = resolve;
      });
      const finish = (ok) => {
        if (incoming !== frame) return;
        incoming = null;
        frame.offRender?.();
        frame.offRender = null;
        frame.offCamera?.();
        frame.offCamera = null;
        clearTimeout(frame.timeout);
        frame.offAbort?.();
        if (ok) {
          lastError = null;
          const previous = current;
          current = frame;
          frame.loadMs = now() - frame.startedAt;
          frame.layer.alpha = alpha;
          frame.layer.show = !frameHidden;
          viewer.scene.requestRender();
          if (previous) {
            retiring.add(previous);
            previous.offRetire = viewer.scene.postRender.addEventListener(
              () => {
                remove(previous);
                viewer.scene.requestRender();
              },
            );
          }
        } else {
          lastError = 'Weather tiles unavailable · previous frame retained';
          remove(frame);
        }
        frame.resolve(ok);
        viewer.scene.requestRender();
        onChange();
      };
      const abort = () => {
        if (incoming === frame) cancelIncoming();
        viewer.scene.requestRender();
      };
      signal?.addEventListener('abort', abort, { once: true });
      frame.offAbort = () => signal?.removeEventListener('abort', abort);
      frame.timeout = setTimeout(() => finish(false), timeoutMs);
      const install = (texture) => {
        if (frame.closed) return;
        // Keep at most two installed layers during rapid successive selections.
        if (retiring.size) {
          frame.offInstall = viewer.scene.postRender.addEventListener(() => {
            frame.offInstall();
            frame.offInstall = null;
            try {
              install(texture);
            } catch {
              finish(false);
            }
          });
          viewer.scene.requestRender();
          return;
        }
        const tilingScheme = new cesium.GeographicTilingScheme(
          global
            ? {
                rectangle,
                numberOfLevelZeroTilesX: 2,
                numberOfLevelZeroTilesY: 1,
              }
            : undefined,
        );
        const credit = new cesium.Credit(
          snapshot.product.startsWith('xweather-')
            ? 'Vaisala Xweather'
            : snapshot.product === 'lightning'
              ? 'NOAA/NWS lightning density · derived from Vaisala NLDN/GLD360'
              : snapshot.product === 'radar'
                ? 'NOAA nowCOAST · NWS/OAR MRMS'
                : 'NOAA nowCOAST · NESDIS GOES / global satellite partners',
          false,
        );
        const provider = global
          ? createRasterTileProvider({
              cesium,
              texture,
              rectangle,
              tilingScheme,
              maximumLevel: GLOBAL_TILE_MAXIMUM_LEVEL,
              tileSize: nextProfile.tileSize,
              credit,
              createCanvas,
            })
          : new cesium.UrlTemplateImageryProvider({
              url: weatherTileUrl(snapshot.product, time, {
                size: nextProfile.tileSize,
              }),
              tilingScheme,
              rectangle,
              tileWidth: nextProfile.tileSize,
              tileHeight: nextProfile.tileSize,
              maximumLevel: nextProfile.maximumLevel,
              enablePickFeatures: false,
              credit,
            });
        const requestImage = provider.requestImage.bind(provider);
        provider.requestImage = (x, y, level, request) => {
          if (frame.closed) return undefined;
          const result = requestImage(x, y, level, request);
          const tileKey = `${level}/${x}/${y}`;
          if (!result) {
            // Scheduler admission is part of readiness, not a successful tile.
            frame.deferred.add(tileKey);
            frame.lastActivity = now();
            return result;
          }
          frame.deferred.delete(tileKey);
          frame.pending++;
          frame.lastActivity = now();
          if (request) frame.requests.add(request);
          return Promise.resolve(result)
            .then((image) => {
              // Cesium decodes tiles as ImageBitmaps already flipped, since WebGL
              // ignores UNPACK_FLIP_Y for them; a canvas upload flips again.
              if (!frame.closed && snapshot.product === 'clouds-regional')
                image = processInfraredImage(image, infrared, createCanvas, {
                  flipY:
                    typeof ImageBitmap !== 'undefined' &&
                    image instanceof ImageBitmap,
                });
              frame.retries.delete(tileKey);
              frame.loaded++;
              return image;
            })
            .finally(() => {
              frame.pending--;
              frame.lastActivity = now();
              frame.requests.delete(request);
              if (!frame.closed) viewer.scene.requestRender();
            });
        };
        frame.offError = provider.errorEvent.addEventListener((error) => {
          if (frame.closed) return;
          const status = error?.error?.statusCode;
          // Cesium retries synchronously after this event; no delay hook is exposed.
          const tileKey = `${error.level}/${error.x}/${error.y}`;
          const retries = frame.retries.get(tileKey) ?? 0;
          error.retry = false;
          if ((status === 429 || status === 503) && retries < 3) {
            frame.retries.set(tileKey, retries + 1);
            error.retry = true;
            return;
          }
          frame.failed = true;
          lastError = 'Some weather tiles unavailable';
          onChange();
        });
        // A shown, transparent layer lets Cesium request staging tiles while the last
        // complete observation stays visible underneath it.
        frame.layer = collection.addImageryProvider(provider);
        frame.layer.alpha = 0;
        orderWeatherImagery(collection, frame.layer, frame.priority);
        let settled = 0;
        frame.offCamera = viewer.camera?.moveEnd?.addEventListener(() => {
          // Tiles abandoned by a previous viewport are no longer admission work.
          frame.deferred.clear();
          frame.lastActivity = now();
          settled = 0;
          viewer.scene.requestRender();
        });
        frame.offRender = viewer.scene.postRender.addEventListener(() => {
          if (frame.failed) return finish(false);
          // Unrelated terrain/basemap work must not indefinitely hold a ready
          // observation. Require successful own tiles and a quiet scheduling
          // interval before admitting a frame when the rest of the globe is busy.
          const ownReady =
            frame.loaded > 0 &&
            frame.deferred.size === 0 &&
            now() - frame.lastActivity >= 200;
          if (
            ((frame.kind === 'globe' && viewer.scene.globe.tilesLoaded) ||
              ownReady) &&
            frame.pending === 0
          ) {
            if (++settled >= 2) finish(true);
            else viewer.scene.requestRender();
          } else settled = 0;
          if (incoming === frame && frame.pending === 0 && frame.loaded > 0)
            viewer.scene.requestRender();
        });
        viewer.scene.requestRender();
        onChange();
      };
      if (global) {
        void mosaic(time, infrared, frame.controller.signal, () => {
          frame.mosaic.fetched = true;
        })
          .then(({ texture, decodeMs, cached }) => {
            frame.mosaic.decodeMs = decodeMs;
            frame.mosaic.cached = cached;
            install(texture);
          })
          .catch(() => finish(false));
      } else {
        try {
          install();
        } catch {
          finish(false);
        }
      }
      viewer.scene.requestRender();
      onChange();
      return result;
    },
    setHidden(value) {
      frameHidden = Boolean(value);
      if (frameHidden) {
        cancelPrefetch();
        cancelIncoming();
        for (const frame of retiring) remove(frame);
      }
      rehome();
      viewer.scene.requestRender();
    },
    setAlpha(value) {
      alpha = value;
      if (current && current.layer.show) current.layer.alpha = alpha;
      viewer.scene.requestRender();
    },
    clear() {
      cancelPrefetch();
      cancelIncoming();
      remove(current);
      for (const frame of retiring) remove(frame);
      current = null;
      frameHidden = false;
      lastError = null;
      mosaics.clear();
      viewer.scene.requestRender();
    },
    getDiagnostics() {
      return {
        host: 'globe',
        cache: { mosaics: mosaics.size, prefetching: !!prefetchJob },
        imageryCount:
          Number(!!current) + Number(!!incoming?.layer) + retiring.size,
        mosaic: (incoming || current)?.mosaic,
        infrared: (incoming || current)?.infrared ?? 'filtered',
        loading: !!incoming,
        time: frameHidden ? null : (current?.time ?? null),
        hidden: frameHidden,
        product: current?.product ?? null,
        pendingTiles: incoming?.pending ?? 0,
        deferredTiles: incoming?.deferred.size ?? 0,
        loadedTiles: (incoming || current)?.loaded ?? 0,
        frameLoadMs: current?.loadMs ?? null,
        error: imageryHostStatus(getHost()) || lastError,
      };
    },
  };
}

/** Globe hosts keep draped imagery; 3D Tiles hosts get a raised shell per product.
 * A host switch tears one renderer down and restages the last frame on the other. */
export function createWeatherRendering({
  viewer,
  cesium,
  getHost = () => ({ collection: viewer.imageryLayers, kind: 'globe' }),
  onChange = () => {},
  timeoutMs = 25_000,
  now = () => performance.now(),
  fetchImpl = (...args) => globalThis.fetch(...args),
  decodeImage,
  createCanvas = () => document.createElement('canvas'),
  createShell = createWeatherShell,
}) {
  const shared = {
    viewer,
    cesium,
    getHost,
    onChange,
    timeoutMs,
    now,
    fetchImpl,
    decodeImage,
    createCanvas,
  };
  const globe = createGlobeRendering(shared);
  let shell = null;
  let active = null;
  let alpha = 0.7;
  let hidden = false;
  let shown = null;
  let restaging = null;

  // A host without imagery keeps the active renderer, which retains its frame.
  const wanted = () => {
    const { kind } = getHost();
    return kind === 'tileset'
      ? 'shell'
      : kind === 'globe'
        ? 'globe'
        : (active ?? 'globe');
  };
  const renderer = () => (active === 'shell' ? shell : globe);
  function shellFor(product) {
    if (shell?.product === product) return shell;
    shell?.clear();
    shell = createShell({ ...shared, product });
    shell.setAlpha(alpha);
    shell.setHidden(hidden);
    return shell;
  }
  function restage(frame) {
    const target =
      active === 'shell' ? shellFor(frame.snapshot.product) : globe;
    restaging = frame;
    const settle = (ok) => {
      if (restaging !== frame) return;
      restaging = null;
      if (!ok) onChange();
    };
    target
      .setFrame(frame.snapshot, frame.time, { infrared: frame.infrared })
      .then(settle, () => settle(false));
  }
  function switchHost() {
    const next = wanted();
    if (next === active) return false;
    const previous = active;
    active = next;
    if (previous === null) return false;
    restaging = null;
    if (previous === 'shell') {
      shell?.clear();
      shell = null;
    } else globe.clear();
    if (active === 'globe') {
      globe.setAlpha(alpha);
      if (hidden) globe.setHidden(true);
    }
    if (shown && !hidden) restage(shown);
    viewer.scene.requestRender();
    return true;
  }
  return {
    rehome() {
      const switched = switchHost();
      if (active === 'shell' && !shell) return switched;
      return renderer().rehome() || switched;
    },
    cancelPrefetch() {
      renderer()?.cancelPrefetch();
    },
    prefetch(snapshot, time, options) {
      switchHost();
      if (active === 'shell' && shell?.product !== snapshot.product)
        return Promise.resolve(false);
      return renderer().prefetch(snapshot, time, options);
    },
    async setFrame(snapshot, time, options = {}) {
      options.signal?.throwIfAborted();
      switchHost();
      restaging = null;
      const target = active === 'shell' ? shellFor(snapshot.product) : globe;
      const ok = await target.setFrame(snapshot, time, options);
      if (ok)
        shown = { snapshot, time, infrared: options.infrared ?? 'filtered' };
      return ok;
    },
    setHidden(value) {
      hidden = Boolean(value);
      if (hidden) restaging = null;
      renderer()?.setHidden(hidden);
    },
    setAlpha(value) {
      alpha = value;
      renderer()?.setAlpha(value);
    },
    clear() {
      restaging = null;
      shown = null;
      hidden = false;
      shell?.clear();
      shell = null;
      globe.clear();
    },
    getDiagnostics() {
      const diagnostics =
        active === 'shell' && shell
          ? shell.getDiagnostics()
          : active === 'shell'
            ? {
                host: 'shell',
                cache: { mosaics: 0, bytes: 0, prefetching: false },
                imageryCount: 0,
                infrared: 'filtered',
                loading: false,
                time: null,
                hidden,
                product: null,
                frameLoadMs: null,
                error: imageryHostStatus(getHost()),
              }
            : globe.getDiagnostics();
      // A host switch restages the retained frame; keep reporting its time.
      return restaging && !hidden && diagnostics.time === null
        ? { ...diagnostics, time: restaging.time }
        : diagnostics;
    },
  };
}
