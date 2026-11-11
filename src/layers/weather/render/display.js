// The observed weather rasters (rain radar, satellite clouds, lightning
// density) on the globe contract, the same on every engine. Where imagery
// drapes on the globe, each frame is one engine.imagery layer: the
// product's geographic tiles (the regional infrared through the infrared
// mask, a tile transform) or, for the global infrared, its decoded mosaic
// as one image. A new frame is a staged source: the shown frame stays
// until the next one's tiles are in, then the layer swaps them. On 3D
// tiles the frame is a raised layer at the product's shell height
// (shellRendering.js decides the frames, the detail window around the view
// and the prefetch; here a shell surface is one raised layer, its detail
// the layer's detail). A host switch tears one down and restages the shown
// frame on the other. Lower products draw first: clouds, radar, lightning.

import { weatherTileUrl } from '../source.js';
import {
  engineImageryHost,
  imageryHostStatus,
} from '../../shared/imageryHost.js';
import {
  createWeatherShell,
  WEATHER_SHELL_HEIGHTS,
} from '../shellRendering.js';
import { weatherDisplay, escapeCreditText } from '../display.js';
import { msg } from '../../../i18n/index.js';
import { readResponseBytesCapped } from '../../../sources/httpBody.js';
import {
  acquireInfraredMosaic,
  processInfraredImage,
} from '../infraredImage.js';
import * as geo from '../../../geo/index.js';

/** Imagery order of each product (and the wind field under them), over
 * Recent Imagery and the event imagery. */
export const WEATHER_IMAGERY_ORDER = Object.freeze({
  wind: 20,
  clouds: 21,
  'clouds-regional': 21,
  radar: 22,
  lightning: 23,
});
// Bounded display detail for the hourly, approximately 3 km global product.
const GLOBAL_TILE_MAXIMUM_LEVEL = 3;
// Six decoded 2048×1024 canvases (8 MiB each) bound the cache below 50 MiB.
const MAX_MOSAICS = 6;
const MAX_PREFETCH_TILES = 8;
const TILE_SIZE = 256;
// A source that draws nothing, until the first frame is in.
const EMPTY_IMAGE = Object.freeze({
  width: 1,
  height: 1,
  data: new Uint8Array(4),
});
let layers = 0;

function creditText(snapshot) {
  const sourceCredit = weatherDisplay(snapshot).credit;
  return sourceCredit !== undefined
    ? escapeCreditText(sourceCredit)
    : snapshot.product === 'lightning'
      ? 'NOAA/NWS lightning density · derived from Vaisala NLDN/GLD360'
      : snapshot.product === 'radar'
        ? 'NOAA nowCOAST · NWS/OAR MRMS'
        : 'NOAA nowCOAST · NESDIS GOES / global satellite partners';
}

// Radians back to degrees, without the round trip's last bits.
const degree = (radians) => Math.round(geo.math.toDegrees(radians) * 1e9) / 1e9;
const degreesOf = (rectangle) => ({
  west: degree(rectangle.west),
  south: degree(rectangle.south),
  east: degree(rectangle.east),
  north: degree(rectangle.north),
});
const boundsOf = ({ west, south, east, north }) => ({
  west,
  south,
  east,
  north,
});

/** Draped frames: one imagery layer, each new frame staged over the shown one. */
function createDrapedWeather(
  engine,
  {
    onChange,
    timeoutMs,
    now,
    fetchImpl,
    decodeImage,
    createCanvas,
    frameSource,
  },
) {
  const id = `weather-${++layers}`;
  let layer = null;
  let current = null;
  let incoming = null;
  let alpha = 0.7;
  let hidden = false;
  let lastError = null;
  const mosaics = new Map();
  let prefetchJob = null;
  let prefetchedKey = null;
  const suspended = () => engine.imagery.surface() === 'none';

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
  // Up to eight geographic tiles of levels 0 and 1 over the view.
  function prefetchTiles(snapshot, time) {
    const box = boundsOf(snapshot.bounds);
    const view = engine.camera.viewRectangle();
    const area = view ? degreesOf(view) : box;
    const cover =
      view && area.east >= area.west
        ? {
            west: Math.max(box.west, area.west),
            east: Math.min(box.east, area.east),
            south: Math.max(box.south, area.south),
            north: Math.min(box.north, area.north),
          }
        : box;
    if (cover.west >= cover.east || cover.south >= cover.north) return [];
    const template = weatherTileUrl(snapshot.product, time, {
      size: TILE_SIZE,
    });
    const urls = [];
    for (let z = 0; z <= 1; z++) {
      const span = 180 / 2 ** z;
      for (let y = 0; y < 2 ** z; y++)
        for (let x = 0; x < 2 ** (z + 1); x++) {
          const west = -180 + x * span;
          const north = 90 - y * span;
          if (
            west >= cover.east ||
            west + span <= cover.west ||
            north <= cover.south ||
            north - span >= cover.north
          )
            continue;
          urls.push(
            template.replace('{z}', z).replace('{x}', x).replace('{y}', y),
          );
          if (urls.length === MAX_PREFETCH_TILES) return urls;
        }
    }
    return urls;
  }
  function ensureLayer(snapshot) {
    if (layer) return layer;
    layer = engine.imagery.createLayer({
      id,
      order: WEATHER_IMAGERY_ORDER[snapshot.product] ?? 21,
      alpha,
      show: !hidden,
      source: {
        kind: 'image',
        image: EMPTY_IMAGE,
        rectangle: boundsOf(snapshot.bounds),
      },
    });
    return layer;
  }
  // A frame's source: its tiles (through the infrared mask) or its mosaic.
  function sourceOf(frame, texture) {
    const credit = creditText(frame.creditSnapshot ?? frame.snapshot);
    const rectangle = boundsOf(frame.snapshot.bounds);
    if (texture) return { kind: 'image', image: texture, rectangle, credit };
    return {
      kind: 'tiles',
      url: weatherTileUrl(frame.product, frame.time, { size: TILE_SIZE }),
      scheme: 'geographic',
      tileSize: TILE_SIZE,
      maxLevel: frame.product === 'clouds' ? GLOBAL_TILE_MAXIMUM_LEVEL : 6,
      rectangle,
      credit,
      transform: frame.transform,
    };
  }
  /**
   * Take the credit of a refreshed manifest of the same product: the shown
   * frame keeps its pixels and changes its credit; a frame still loading
   * takes it once it is shown.
   */
  function updateSnapshot(snapshot) {
    if (incoming?.product === snapshot.product)
      incoming.creditSnapshot = snapshot;
    if (!current || current.product !== snapshot.product) return;
    current.creditSnapshot = snapshot;
    const source = sourceOf(current, current.texture);
    if (source.credit !== layer?.source().credit) layer?.setSource(source);
  }
  function cancelIncoming() {
    if (!incoming) return;
    const frame = incoming;
    incoming = null;
    clearTimeout(frame.timeout);
    frame.offAbort?.();
    frame.controller.abort();
    frame.resolve(false);
  }
  function finish(frame, ok) {
    if (incoming !== frame) return;
    incoming = null;
    clearTimeout(frame.timeout);
    frame.offAbort?.();
    if (ok) {
      lastError = null;
      frame.loadMs = now() - frame.startedAt;
      current = frame;
      layer.setAlpha(alpha);
      layer.show(!hidden);
      // A refresh that arrived while the frame loaded.
      updateSnapshot(frame.creditSnapshot ?? frame.snapshot);
    } else {
      lastError = msg('Weather tiles unavailable · previous frame retained');
      frame.controller.abort();
    }
    frame.resolve(ok);
    engine.render.request('weather');
    onChange();
  }

  return {
    rehome() {
      if (suspended()) {
        cancelPrefetch();
        cancelIncoming();
      }
      return false;
    },
    cancelPrefetch,
    updateSnapshot,
    async prefetch(snapshot, time, { infrared = 'filtered' } = {}) {
      let job;
      try {
        if (hidden || incoming || suspended() || !snapshot.times.includes(time))
          return false;
        if (frameSource?.getTile && snapshot.product !== 'clouds') return false;
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
      if (frameSource?.getTile && snapshot.product !== 'clouds') return false;
      cancelPrefetch();
      cancelIncoming();
      if (suspended()) return false;
      if (
        current?.time === time &&
        current.product === snapshot.product &&
        current.infrared === infrared
      ) {
        updateSnapshot(creditSnapshot ?? snapshot);
        return true;
      }
      lastError = null;
      const global = snapshot.product === 'clouds';
      const frame = {
        snapshot,
        creditSnapshot,
        time,
        infrared,
        product: snapshot.product,
        texture: null,
        // The regional infrared mask, the same function for every tile.
        transform:
          snapshot.product === 'clouds-regional'
            ? (image) => processInfraredImage(image, infrared, createCanvas)
            : null,
        mosaic: global
          ? { fetched: false, decodeMs: null, cached: false }
          : undefined,
        controller: new AbortController(),
        startedAt: now(),
        resolve: null,
      };
      incoming = frame;
      const result = new Promise((resolve) => {
        frame.resolve = resolve;
      });
      const abort = () => {
        if (incoming === frame) cancelIncoming();
        engine.render.request('weather');
      };
      signal?.addEventListener('abort', abort, { once: true });
      frame.offAbort = () => signal?.removeEventListener('abort', abort);
      frame.timeout = setTimeout(() => finish(frame, false), timeoutMs);
      const stage = (texture = null) => {
        if (incoming !== frame) return;
        frame.texture = texture;
        ensureLayer(snapshot)
          .setSource(sourceOf(frame, texture), {
            staged: true,
            signal: frame.controller.signal,
          })
          .then((ok) => finish(frame, ok));
        engine.render.request('weather');
        onChange();
      };
      if (global)
        void mosaic(time, infrared, frame.controller.signal, () => {
          frame.mosaic.fetched = true;
        })
          .then(({ texture, decodeMs, cached }) => {
            frame.mosaic.decodeMs = decodeMs;
            frame.mosaic.cached = cached;
            stage(texture);
          })
          .catch(() => finish(frame, false));
      else stage();
      onChange();
      return result;
    },
    setHidden(value) {
      hidden = Boolean(value);
      if (hidden) {
        cancelPrefetch();
        cancelIncoming();
      }
      layer?.show(!hidden && current !== null);
      engine.render.request('weather');
    },
    setAlpha(value) {
      alpha = value;
      if (current) layer?.setAlpha(alpha);
      engine.render.request('weather');
    },
    clear() {
      cancelPrefetch();
      cancelIncoming();
      layer?.destroy();
      layer = null;
      current = null;
      hidden = false;
      lastError = null;
      mosaics.clear();
      engine.render.request('weather');
    },
    getDiagnostics() {
      return {
        host: 'globe',
        cache: { mosaics: mosaics.size, prefetching: !!prefetchJob },
        imageryCount: Number(!!current) + Number(!!incoming),
        mosaic: (incoming || current)?.mosaic,
        infrared: (incoming || current)?.infrared ?? 'filtered',
        loading: !!incoming,
        time: hidden ? null : (current?.time ?? null),
        hidden,
        product: current?.product ?? null,
        frameLoadMs: current?.loadMs ?? null,
        error: imageryHostStatus(engineImageryHost(engine)) || lastError,
      };
    },
  };
}

/**
 * One shell surface of shellRendering.js as a raised imagery layer at the
 * product's height: its image a staged source, its detail the layer's.
 * `onSettled` runs once the latest image (and detail) draws.
 */
export function createRaisedWeatherSurface(
  engine,
  product,
  { rectangle, height, onSettled = () => {} },
) {
  const box = degreesOf(rectangle);
  const layer = engine.imagery.createLayer({
    id: `weather-shell-${++layers}`,
    order: WEATHER_IMAGERY_ORDER[product] ?? 21,
    raise: height,
    alpha: 0,
    source: { kind: 'image', image: EMPTY_IMAGE, rectangle: box },
  });
  let image = null;
  let drawnImage = null;
  let detail = null;
  let detailWindow = null;
  let drawnDetail = null;
  let destroyed = false;
  const settle = () => {
    if (
      !destroyed &&
      image !== null &&
      drawnImage === image &&
      drawnDetail === detail
    )
      onSettled();
  };
  return {
    setImage(next) {
      if (destroyed || next === image) return;
      image = next;
      layer
        .setSource(
          { kind: 'image', image: next, rectangle: box },
          { staged: true },
        )
        .then((ok) => {
          if (!ok || image !== next) return;
          drawnImage = next;
          settle();
        });
    },
    setAlpha(value) {
      if (!destroyed) layer.setAlpha(value);
    },
    /** `rect` is west, south, east, north in the image's texture coordinates. */
    setDetail(next, rect) {
      if (destroyed) return;
      if (!next) {
        if (detail === null) return;
        detail = drawnDetail = detailWindow = null;
        layer.setDetail(null);
        return;
      }
      if (next === detail && detailWindow && rect) {
        const same = ['west', 'south', 'east', 'north'].every(
          (edge) => detailWindow[edge] === rect[edge],
        );
        if (same) return;
      }
      detail = next;
      detailWindow = rect;
      const x = box.east - box.west;
      const y = box.north - box.south;
      layer
        .setDetail({
          image: next,
          rectangle: {
            west: box.west + rect.west * x,
            south: box.south + rect.south * y,
            east: box.west + rect.east * x,
            north: box.south + rect.north * y,
          },
        })
        .then((ok) => {
          if (!ok || detail !== next) return;
          drawnDetail = next;
          settle();
        });
    },
    /** Returns whether visibility changed. */
    setShow(value) {
      const show = Boolean(value);
      if (destroyed || layer.shown() === show) return false;
      layer.show(show);
      return true;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      layer.destroy();
      image = drawnImage = detail = drawnDetail = null;
    },
    getDiagnostics: () => ({
      height,
      ready: drawnImage !== null,
      uploaded: image !== null && drawnImage === image,
      show: !destroyed && layer.shown(),
      alpha: destroyed ? 0 : layer.alpha(),
      rendering: !destroyed && layer.staging(),
      detail: {
        uploaded: detail !== null && drawnDetail === detail,
        window: detail !== null && drawnDetail === detail ? detailWindow : null,
      },
    }),
  };
}

/**
 * The weather layer's renderer on any engine (index.js): draped frames
 * where imagery drapes on the globe, raised shells on 3D tiles.
 * @param {import('../../../globe/contract.js').GlobeEngine} engine
 * @param {{ onChange?: () => void, timeoutMs?: number, now?: () => number,
 *   fetchImpl?: typeof fetch, decodeImage?: Function,
 *   createCanvas?: () => HTMLCanvasElement }} [options]
 */
export function createWeatherDisplay(
  engine,
  {
    onChange = () => {},
    timeoutMs = 25_000,
    now = () => performance.now(),
    fetchImpl = (...args) => globalThis.fetch(...args),
    decodeImage,
    createCanvas = () => document.createElement('canvas'),
    frameSource = null,
    frameRendering = null,
  } = {},
) {
  const shared = {
    onChange,
    timeoutMs,
    now,
    fetchImpl,
    decodeImage,
    createCanvas,
    frameSource,
  };
  const getHost = () => engineImageryHost(engine);
  const draped = createDrapedWeather(engine, shared);
  const supplied =
    frameSource?.getTile && frameRendering
      ? frameRendering(engine, shared)
      : null;
  let globe = draped;
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
    shell = createWeatherShell({
      ...shared,
      product,
      height: WEATHER_SHELL_HEIGHTS[product],
      getHost,
      requestRender: () => engine.render.request('weather'),
      viewRectangle: () => engine.camera.viewRectangle(),
      moveEnd: engine.camera.moveEnd,
      maxTextureSize: engine.render.maxTextureSize(),
      createSurface: (frame) =>
        createRaisedWeatherSurface(engine, product, frame),
    });
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
    // The restaged frame takes the newest refreshed credit.
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
    engine.render.request('weather');
    return true;
  }
  return {
    rehome() {
      if (engine.imagery.surface() === 'none') {
        draped.cancelPrefetch();
        supplied?.cancelPrefetch();
      }
      const switched = switchHost();
      if (active === 'shell' && !shell) return switched;
      return renderer().rehome() || switched;
    },
    cancelPrefetch() {
      draped.cancelPrefetch();
      supplied?.cancelPrefetch();
      shell?.cancelPrefetch();
    },
    prefetch(snapshot, time, options) {
      switchHost();
      if (active === 'shell' && shell?.product !== snapshot.product)
        return Promise.resolve(false);
      const target =
        active === 'shell'
          ? shell
          : supplied && snapshot.product !== 'clouds'
            ? supplied
            : draped;
      return target.prefetch(snapshot, time, options);
    },
    async setFrame(snapshot, time, options = {}) {
      options.signal?.throwIfAborted();
      const next =
        supplied && snapshot.product !== 'clouds' ? supplied : draped;
      if (next !== globe) {
        globe.clear();
        globe = next;
        globe.setAlpha(alpha);
        globe.setHidden(hidden);
      }
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
      if (hidden) {
        restaging = null;
        draped.cancelPrefetch();
        supplied?.cancelPrefetch();
        shell?.cancelPrefetch();
      }
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
      draped.clear();
      supplied?.clear();
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
