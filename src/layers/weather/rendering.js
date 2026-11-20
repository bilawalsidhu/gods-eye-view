import { weatherTileUrl, closeWeatherPixels } from './source.js';
import { WEATHER_IMAGERY_SHOWS, WEATHER_IMAGERY_Z } from './imageryOrder.js';
import { imageryHostStatus } from './imageryHost.js';
import { globeImageryHost } from './shellRendering.js';
import { drawMosaicTile, createFrameTileFetch } from './rasterTiles.js';
import { weatherDisplay } from './display.js';
import { msg } from '../../i18n/index.js';
import {
  findCamera,
  findCredits,
  findFrame,
  findGlobe,
} from '../../render/rendererOf.js';
import { readResponseBytesCapped } from '../../sources/httpBody.js';
import {
  acquireInfraredMosaic,
  processInfraredImage,
} from './infraredImage.js';
// Bounded display detail for the hourly, approximately 3 km global product
// when it is drawn from one 2048 × 1024 mosaic.
const GLOBAL_TILE_MAXIMUM_LEVEL = 3;
// Detail of the tiled products when the feed does not name its own.
const TILE_MAXIMUM_LEVEL = 6;
// The deepest level a feed may name: about 150 m a pixel.
const SUPPLIED_MAXIMUM_LEVEL_LIMIT = 12;
// Six decoded 2048×1024 canvases (8 MiB each) bound the cache below 50 MiB.
const MAX_MOSAICS = 6;
const MAX_PREFETCH_TILES = 8;
// How often a staged frame waiting out its quiet interval rechecks readiness.
export const READY_WAKE_MS = 150;

/**
 * A degrees rectangle's overlap with another, or null; either may cross the
 * antimeridian (`west > east`), as a view rectangle can.
 */
export function rectangleOverlap(a, b) {
  let aEast = a.east;
  let aWest = a.west;
  let bEast = b.east;
  let bWest = b.west;
  if (aEast < aWest && bEast > 0) aEast += 360;
  else if (bEast < bWest && aEast > 0) bEast += 360;
  if (aEast < aWest && bWest < 0) bWest += 360;
  else if (bEast < bWest && aWest < 0) aWest += 360;
  const wrap = (lon) =>
    lon >= -180 && lon <= 180 ? lon : ((((lon + 180) % 360) + 360) % 360) - 180;
  const west = wrap(Math.max(aWest, bWest));
  const east = wrap(Math.min(aEast, bEast));
  if ((a.west < a.east || b.west < b.east) && east <= west) return null;
  const south = Math.max(a.south, b.south);
  const north = Math.min(a.north, b.north);
  if (south >= north) return null;
  return { west, south, east, north };
}

/** A tile of the geographic scheme (two level-zero tiles), in degrees. */
export function geographicTile(x, y, level) {
  const size = 180 / 2 ** level;
  const west = -180 + x * size;
  const north = 90 - y * size;
  return { west, south: north - size, east: west + size, north };
}

/** HTTP statuses a weather tile is fetched again for, rather than failing. */
const RETRY_STATUSES = [429, 503];

/** Globe imagery through the renderer's globe port: own at most a displayed
 * and a staging frame; the application clock is never touched. */
function createGlobeRendering({
  viewer,
  globeOf,
  cameraOf,
  creditsOf,
  frameOf,
  toBitmap,
  getHost,
  onChange,
  timeoutMs,
  now,
  fetchImpl,
  decodeImage,
  createCanvas,
  frameSource,
}) {
  const requestRender = () => frameOf(viewer)?.requestRender('weather');
  const onPostRender = (cb) => frameOf(viewer).on('postRender', cb);
  let current = null;
  let incoming = null;
  const retiring = new Set();
  let alpha = 0.7;
  let frameHidden = false;
  let lastError = null;
  const mosaics = new Map();
  let prefetchJob = null;
  let prefetchedKey = null;

  /** The deepest level the feed's own tiles of `product` go to, or null. */
  function suppliedLevel(product) {
    if (!frameSource?.getTile) return null;
    let level = null;
    try {
      level = frameSource.maximumLevel?.(product) ?? null;
    } catch {
      return null;
    }
    return Number.isInteger(level) &&
      level >= 0 &&
      level <= SUPPLIED_MAXIMUM_LEVEL_LIMIT
      ? level
      : null;
  }

  /** Global clouds come from one mosaic unless the feed tiles them itself. */
  function fromMosaic(product) {
    return product === 'clouds' && suppliedLevel(product) === null;
  }

  function profile(product) {
    return {
      tileSize: 256,
      maximumLevel:
        suppliedLevel(product) ??
        (product === 'clouds' ? GLOBAL_TILE_MAXIMUM_LEVEL : TILE_MAXIMUM_LEVEL),
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
      frameSource,
    });
    // An aborted decode may still finish; never repopulate a cleared instance.
    signal.throwIfAborted();
    mosaics.delete(key);
    mosaics.set(key, result.texture);
    while (mosaics.size > MAX_MOSAICS)
      mosaics.delete(mosaics.keys().next().value);
    return { ...result, cached: false };
  }

  /** Level 0–1 tiles of the visible product bounds, at most eight. */
  function prefetchTiles(snapshot) {
    const bounds = snapshot.bounds;
    const view = cameraOf(viewer)?.viewRectangle?.();
    const coverage = view ? rectangleOverlap(bounds, view) : bounds;
    if (!coverage) return [];
    const tiles = [];
    for (let z = 0; z <= 1; z++) {
      for (let y = 0; y < 2 ** z; y++) {
        for (let x = 0; x < 2 ** (z + 1); x++) {
          if (!rectangleOverlap(coverage, geographicTile(x, y, z))) continue;
          tiles.push({ z, x, y });
          if (tiles.length === MAX_PREFETCH_TILES) return tiles;
        }
      }
    }
    return tiles;
  }
  function tileUrls(snapshot, time, tiles) {
    const template = weatherTileUrl(snapshot.product, time, {
      size: profile(snapshot.product).tileSize,
    });
    return tiles.map(({ z, x, y }) =>
      template.replace('{z}', z).replace('{x}', x).replace('{y}', y),
    );
  }
  /** Warm tiles through the frame source; the pixels themselves are released. */
  function prefetchFrameTiles(snapshot, time, tiles, signal) {
    const size = profile(snapshot.product).tileSize;
    return Promise.all(
      tiles.map(async ({ z, x, y }) =>
        closeWeatherPixels(
          await frameSource.getTile({
            product: snapshot.product,
            time,
            z,
            x,
            y,
            size,
            signal,
          }),
        ),
      ),
    );
  }

  function creditText(snapshot) {
    const sourceCredit = weatherDisplay(snapshot).credit;
    return sourceCredit !== undefined
      ? sourceCredit
      : snapshot.product === 'lightning'
        ? 'NOAA/NWS lightning density · derived from Vaisala NLDN/GLD360'
        : snapshot.product === 'radar'
          ? 'NOAA nowCOAST · NWS/OAR MRMS'
          : 'NOAA nowCOAST · NESDIS GOES / global satellite partners';
  }
  /**
   * The frame's credit is owed while its layer is drawn (shown, even
   * transparent while it stages), through the renderer's credits port.
   */
  function syncCredit(frame) {
    const text =
      (!frame.closed && frame.layer?.show === true && frame.credit) || null;
    if (frame.creditShown === text) return;
    frame.offCredit?.();
    frame.offCredit = null;
    frame.creditShown = text;
    if (text) frame.offCredit = creditsOf(viewer)?.addStatic({ text }) ?? null;
  }
  function setCredit(frame) {
    const text = creditText(frame.creditSnapshot ?? frame.snapshot);
    if (frame.credit === text) return false;
    frame.credit = text;
    if (frame.layer) syncCredit(frame);
    return true;
  }
  /**
   * Take the credit of a refreshed manifest of the same product. Each frame
   * keeps the snapshot it was staged from, whose time and bounds still match,
   * and remembers the refreshed one for its credit, including a frame that
   * is still loading and takes its credit when installed.
   */
  function updateSnapshot(snapshot) {
    let changed = false;
    for (const frame of new Set([current, incoming, ...retiring])) {
      if (!frame || frame.product !== snapshot.product) continue;
      frame.creditSnapshot = snapshot;
      if (frame.credit !== undefined && setCredit(frame)) changed = true;
    }
    if (changed) requestRender();
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
    clearTimeout(frame.wake);
    syncCredit(frame);
    // Removing the layer cancels its tile requests in flight.
    frame.layer?.remove();
  }
  function cancelIncoming() {
    if (!incoming) return;
    const previous = incoming;
    incoming = null;
    remove(previous);
    previous.resolve(false);
  }
  /**
   * Follow the host: a globe host draws the frame, any other hides it (the
   * globe drapes nothing while hidden) and drops what was staging for it.
   */
  function rehome() {
    const host = getHost();
    const { kind } = host;
    const hidden = frameHidden || imageryHostStatus(host) !== null;
    const changed =
      (current && current.kind !== kind) ||
      (incoming && incoming.kind !== kind);
    const visibilityChanged = current && current.layer.show === hidden;
    if (changed || imageryHostStatus(host) !== null) {
      cancelPrefetch();
      cancelIncoming();
      for (const frame of retiring) remove(frame);
    }
    if (current) {
      if (!hidden && current.layer.alpha !== alpha) current.layer.alpha = alpha;
      if (visibilityChanged) current.layer.show = !hidden;
      current.kind = kind;
      syncCredit(current);
    }
    if (changed || visibilityChanged) requestRender();
    return Boolean(changed || visibilityChanged);
  }
  return {
    rehome,
    cancelPrefetch,
    updateSnapshot,
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
        const global = fromMosaic(snapshot.product);
        const tiles = global ? [] : prefetchTiles(snapshot);
        const supplied = !global && Boolean(frameSource?.getTile);
        const urls = global || supplied ? [] : tileUrls(snapshot, time, tiles);
        const key = global
          ? `${time}|${infrared}`
          : supplied
            ? `${snapshot.product}|${time}|${tiles.map(({ z, x, y }) => `${z}/${x}/${y}`).join('|')}`
            : urls.join('|');
        if (prefetchJob?.key === key || prefetchedKey === key) return false;
        cancelPrefetch();
        job = { key, controller: new AbortController() };
        prefetchJob = job;
        const { signal } = job.controller;
        job.timeout = setTimeout(() => job.controller.abort(), timeoutMs);
        if (global) await mosaic(time, infrared, signal);
        else if (supplied)
          await prefetchFrameTiles(snapshot, time, tiles, signal);
        else
          await Promise.all(
            urls.map(async (url) => {
              const response = await fetchImpl(url, { signal });
              if (!response.ok)
                throw new Error(msg('Weather prefetch unavailable'));
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
    async setFrame(
      snapshot,
      time,
      { signal, infrared = 'filtered', creditSnapshot } = {},
    ) {
      signal?.throwIfAborted();
      cancelPrefetch();
      rehome();
      cancelIncoming();
      const host = getHost();
      const { kind } = host;
      if (imageryHostStatus(host)) return false;
      const globe = globeOf(viewer);
      if (!globe) return false;
      const nextProfile = profile(snapshot.product);
      if (
        current?.time === time &&
        current.product === snapshot.product &&
        current.kind === kind &&
        current.infrared === infrared
      ) {
        updateSnapshot(creditSnapshot ?? snapshot);
        return true;
      }
      lastError = null;
      const { west, south, east, north } = snapshot.bounds;
      const rectangle = { west, south, east, north };
      const global = fromMosaic(snapshot.product);
      const frame = {
        snapshot,
        creditSnapshot,
        time,
        infrared,
        mosaic: global
          ? { fetched: false, decodeMs: null, cached: false }
          : undefined,
        controller: new AbortController(),
        kind,
        product: snapshot.product,
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
        clearTimeout(frame.wake);
        frame.wake = null;
        frame.offAbort?.();
        if (ok) {
          lastError = null;
          const previous = current;
          current = frame;
          frame.loadMs = now() - frame.startedAt;
          frame.layer.alpha = alpha;
          frame.layer.show = !frameHidden;
          syncCredit(frame);
          requestRender();
          if (previous) {
            retiring.add(previous);
            previous.offRetire = onPostRender(() => {
              remove(previous);
              requestRender();
            });
          }
        } else {
          lastError = msg(
            'Weather tiles unavailable · previous frame retained',
          );
          remove(frame);
        }
        frame.resolve(ok);
        requestRender();
        onChange();
      };
      const abort = () => {
        if (incoming === frame) cancelIncoming();
        requestRender();
      };
      signal?.addEventListener('abort', abort, { once: true });
      frame.offAbort = () => signal?.removeEventListener('abort', abort);
      frame.timeout = setTimeout(() => finish(false), timeoutMs);
      const install = (texture) => {
        if (frame.closed) return;
        // Keep at most two installed layers during rapid successive selections.
        if (retiring.size) {
          frame.offInstall = onPostRender(() => {
            frame.offInstall();
            frame.offInstall = null;
            try {
              install(texture);
            } catch {
              finish(false);
            }
          });
          requestRender();
          return;
        }
        setCredit(frame);
        const tileSize = nextProfile.tileSize;
        /** Readiness accounting: each own tile the renderer issues or defers. */
        const admit = (tile, issue) => {
          if (frame.closed) return undefined;
          const result = issue();
          const tileKey = `${tile.level}/${tile.x}/${tile.y}`;
          if (!result) {
            // Scheduler admission is part of readiness, not a successful tile.
            frame.deferred.add(tileKey);
            frame.lastActivity = now();
            return result;
          }
          frame.deferred.delete(tileKey);
          frame.pending++;
          frame.lastActivity = now();
          return Promise.resolve(result)
            .then((image) => {
              frame.loaded++;
              return image;
            })
            .finally(() => {
              frame.pending--;
              frame.lastActivity = now();
              if (!frame.closed) requestRender();
            });
        };
        const spec = global
          ? {
              kind: 'canvas',
              tiling: 'geographic',
              rectangle,
              maxLevel: GLOBAL_TILE_MAXIMUM_LEVEL,
              tileSize,
              drawTile: (tile, canvas) =>
                drawMosaicTile(texture, rectangle, tile, canvas),
              admit,
              zOrder: WEATHER_IMAGERY_Z[snapshot.product],
              shows: WEATHER_IMAGERY_SHOWS[snapshot.product],
            }
          : {
              kind: 'xyz',
              url: weatherTileUrl(snapshot.product, time, { size: tileSize }),
              tiling: 'geographic',
              rectangle,
              tileSize,
              maxLevel: nextProfile.maximumLevel,
              retryStatuses: RETRY_STATUSES,
              admit,
              // A host's frame source supplies the tiles in place of the
              // route, at most six at once.
              ...(frameSource?.getTile
                ? {
                    fetchTile: createFrameTileFetch({
                      frameSource,
                      product: snapshot.product,
                      time,
                      createCanvas,
                      tileSize,
                      signal: frame.controller.signal,
                    }),
                    maxConcurrentRequests: 6,
                  }
                : {}),
              // Infrared tiles get the display transfer the mosaic already
              // carries.
              ...(snapshot.product === 'clouds-regional' ||
              snapshot.product === 'clouds'
                ? {
                    // The transfer runs on the upright tile the renderer
                    // decoded.
                    // Closed frames do not process late images.
                    tileTransform: (_tile, image) =>
                      frame.closed
                        ? image
                        : toBitmap(
                            processInfraredImage(image, infrared, createCanvas),
                          ),
                  }
                : {}),
              zOrder: WEATHER_IMAGERY_Z[snapshot.product],
              shows: WEATHER_IMAGERY_SHOWS[snapshot.product],
            };
        // A shown, transparent layer lets the renderer request staging tiles
        // while the last complete observation stays visible underneath it.
        frame.layer = globe.imagery.add(spec);
        frame.layer.drapeOn = 'surface';
        frame.layer.alpha = 0;
        syncCredit(frame);
        frame.offError = frame.layer.on('tileError', () => {
          if (frame.closed) return;
          frame.failed = true;
          lastError = msg('Some weather tiles unavailable');
          onChange();
        });
        let settled = 0;
        frame.offCamera = cameraOf(viewer)?.on('moveEnd', () => {
          // Tiles abandoned by a previous viewport are no longer admission work.
          frame.deferred.clear();
          frame.lastActivity = now();
          settled = 0;
          requestRender();
        });
        frame.offRender = onPostRender(() => {
          if (frame.failed) return finish(false);
          // Unrelated terrain/basemap work must not indefinitely hold a ready
          // observation. Require successful own tiles and a quiet scheduling
          // interval before admitting a frame when the rest of the globe is busy.
          const ownReady =
            frame.loaded > 0 &&
            frame.deferred.size === 0 &&
            now() - frame.lastActivity >= 200;
          if (
            ((frame.kind === 'globe' && globe.isSettled('imagery')) ||
              ownReady) &&
            frame.pending === 0
          ) {
            if (++settled >= 2) finish(true);
            else requestRender();
          } else settled = 0;
          // Waiting out the quiet interval needs another readiness check
          // later, not a render every frame: wake on a timer so the render
          // governor's frame cap still holds while a frame is staged.
          if (
            incoming === frame &&
            frame.pending === 0 &&
            frame.loaded > 0 &&
            !frame.wake
          )
            frame.wake = setTimeout(() => {
              frame.wake = null;
              if (!frame.closed && incoming === frame) requestRender();
            }, READY_WAKE_MS);
        });
        requestRender();
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
      requestRender();
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
      requestRender();
    },
    setAlpha(value) {
      alpha = value;
      if (current && current.layer.show) current.layer.alpha = alpha;
      requestRender();
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
      requestRender();
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
  createShell,
  globeOf = findGlobe,
  cameraOf = findCamera,
  creditsOf = findCredits,
  frameOf = findFrame,
  toBitmap = (canvas) =>
    globalThis.createImageBitmap(canvas, { premultiplyAlpha: 'none' }),
  getHost = () => globeImageryHost(viewer),
  onChange = () => {},
  timeoutMs = 25_000,
  now = () => performance.now(),
  fetchImpl = (...args) => globalThis.fetch(...args),
  decodeImage,
  createCanvas = () => document.createElement('canvas'),
  frameSource = null,
}) {
  const shared = {
    viewer,
    getHost,
    onChange,
    timeoutMs,
    now,
    fetchImpl,
    decodeImage,
    createCanvas,
    frameSource,
  };
  const globe = createGlobeRendering({
    ...shared,
    globeOf,
    cameraOf,
    creditsOf,
    frameOf,
    toBitmap,
  });
  const requestRender = () => frameOf(viewer)?.requestRender('weather');
  let shell = null;
  let active = null;
  let alpha = 0.7;
  let hidden = false;
  let shown = null;
  let restaging = null;
  // The last refreshed manifest, so a frame shown after it keeps its credit.
  let refreshed = null;

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
    // The restaged frame takes the newest refreshed credit; a refresh while
    // it loads reaches it through the globe's own updateSnapshot.
    target
      .setFrame(frame.snapshot, frame.time, {
        infrared: frame.infrared,
        ...(target === globe ? { creditSnapshot: shown?.latest } : {}),
      })
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
    requestRender();
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
      const before = refreshed;
      const ok = await target.setFrame(snapshot, time, options);
      if (ok) {
        // Keep a refresh that arrived while this frame loaded.
        const latest =
          refreshed !== before && refreshed?.product === snapshot.product
            ? refreshed
            : undefined;
        shown = {
          snapshot,
          time,
          infrared: options.infrared ?? 'filtered',
          ...(latest ? { latest } : {}),
        };
      }
      return ok;
    },
    // The shown frame keeps its staged snapshot for a restage on another
    // host; only the refreshed credit is remembered and applied.
    updateSnapshot(snapshot) {
      refreshed = snapshot;
      if (shown?.snapshot.product === snapshot.product)
        shown = { ...shown, latest: snapshot };
      globe.updateSnapshot(snapshot);
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
      refreshed = null;
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
