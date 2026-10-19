import { orderWeatherImagery } from '../weather/imageryOrder.js';
import { imageryHostStatus } from '../weather/imageryHost.js';
import { createRasterTileProvider } from '../weather/rasterTiles.js';
import {
  WEATHER_SHELL_HEIGHTS,
  createShellSurface,
} from '../weather/shellRendering.js';

/** Same stacking band as the other radar products. */
const IMAGERY_PRIORITY = 2;
const CREDIT_TEXT = 'Bureau of Meteorology · rain radar';
// A tile request quiet for this long, twice in a row, counts as drawn.
const SETTLE_MS = 150;
// A frame whose area is not in view requests no tiles; do not wait on it.
const EMPTY_MS = 600;
const boundsKey = ({ west, south, east, north }) =>
  `${west},${south},${east},${north}`;

/**
 * Globe hosts: one imagery layer per loop frame, every frame resident and
 * stacked at zero opacity, so showing a frame only changes opacity. That is
 * what makes the loop flicker-free; the layer count is bounded by the 12-frame
 * loop and the decoded frames are released with their layers.
 */
function createGlobeFrames({
  viewer,
  cesium,
  getHost,
  onChange,
  now,
  timeoutMs,
  createCanvas,
}) {
  const entries = new Map();
  let setKey = null;
  let shownKey = null;
  let alpha = 0.8;
  let lastError = null;
  let waiting = 0;

  const suspended = () => imageryHostStatus(getHost()) !== null;
  function remove(entry) {
    if (entry.closed) return;
    entry.closed = true;
    const { layer, collection } = entry;
    if (
      collection &&
      !collection.isDestroyed?.() &&
      collection.contains?.(layer)
    )
      collection.remove(layer, true);
    else if (!layer.isDestroyed?.()) layer.destroy?.();
    entries.delete(entry.key);
  }
  function paint() {
    for (const entry of entries.values()) {
      if (entry.closed) continue;
      const visible = entry.key === shownKey && !suspended();
      entry.layer.show = !suspended();
      entry.layer.alpha = visible ? alpha : 0;
    }
    viewer.scene.requestRender();
  }
  function add(frame, canvas, bounds, collection) {
    const rectangle = cesium.Rectangle.fromDegrees(
      bounds.west,
      bounds.south,
      bounds.east,
      bounds.north,
    );
    // One level-0 tile is the whole image; level 1 is its four native quarters.
    const tilingScheme = new cesium.GeographicTilingScheme({
      rectangle,
      numberOfLevelZeroTilesX: 1,
      numberOfLevelZeroTilesY: 1,
    });
    const provider = createRasterTileProvider({
      cesium,
      texture: canvas,
      rectangle,
      tilingScheme,
      maximumLevel: 1,
      tileSize: 256,
      credit: new cesium.Credit(CREDIT_TEXT, false),
      createCanvas,
    });
    const entry = {
      key: frame.key,
      collection,
      layer: null,
      pending: 0,
      loaded: 0,
      lastActivity: now(),
      created: now(),
      closed: false,
    };
    const requestImage = provider.requestImage.bind(provider);
    provider.requestImage = (x, y, level, request) => {
      if (entry.closed) return undefined;
      entry.pending++;
      entry.lastActivity = now();
      return Promise.resolve(requestImage(x, y, level, request))
        .then((image) => {
          entry.loaded++;
          return image;
        })
        .finally(() => {
          entry.pending--;
          entry.lastActivity = now();
          if (!entry.closed) viewer.scene.requestRender();
        });
    };
    entry.layer = collection.addImageryProvider(provider);
    entry.layer.alpha = 0;
    orderWeatherImagery(collection, entry.layer, IMAGERY_PRIORITY);
    entries.set(frame.key, entry);
    return entry;
  }
  function whenDrawn(fresh, signal) {
    return new Promise((resolve) => {
      if (!fresh.length) return resolve(true);
      let quiet = 0;
      let off = null;
      const finish = (ok) => {
        off?.();
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        waiting--;
        resolve(ok);
      };
      const abort = () => finish(false);
      const timer = setTimeout(() => finish(false), timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      waiting++;
      off = viewer.scene.postRender.addEventListener(() => {
        const time = now();
        const ready = fresh.every(
          (entry) =>
            entry.closed ||
            (entry.pending === 0 &&
              time - entry.lastActivity >= SETTLE_MS &&
              (entry.loaded > 0 || time - entry.created >= EMPTY_MS)),
        );
        if (ready && ++quiet >= 2) finish(true);
        else {
          if (!ready) quiet = 0;
          viewer.scene.requestRender();
        }
      });
      viewer.scene.requestRender();
    });
  }

  return {
    /** Reconcile resident layers with `set`; resolves once new frames are drawn. */
    async setFrames({ bounds, frames, images }, { signal } = {}) {
      signal?.throwIfAborted();
      const host = getHost();
      if (imageryHostStatus(host) || !host.collection) return false;
      const key = boundsKey(bounds);
      const wanted = new Set(frames.map(({ key: name }) => name));
      // A different radar or range: keep only what is on screen until the
      // new loop has drawn, then drop it.
      const replaced = setKey !== null && setKey !== key;
      const retiring = [];
      for (const entry of [...entries.values()]) {
        if (replaced || !wanted.has(entry.key)) {
          if (entry.key === shownKey && replaced) retiring.push(entry);
          else remove(entry);
        }
      }
      setKey = key;
      lastError = null;
      const fresh = [];
      for (const frame of frames) {
        const canvas = images.get(frame.key);
        if (!canvas || entries.has(frame.key)) continue;
        fresh.push(add(frame, canvas, bounds, host.collection));
      }
      paint();
      onChange();
      const ok = await whenDrawn(fresh, signal);
      for (const entry of retiring) {
        // The old frame stays up until the caller shows one of the new frames.
        if (entry.key !== shownKey || shownKey === null) remove(entry);
        else entry.retiring = true;
      }
      return ok;
    },
    show(key) {
      shownKey = key;
      for (const entry of [...entries.values()]) {
        if (entry.retiring && entry.key !== key && entries.has(key))
          remove(entry);
      }
      paint();
    },
    setAlpha(value) {
      alpha = value;
      paint();
    },
    /** Follow the imagery host: move layers when its collection changes. */
    rehome() {
      const host = getHost();
      const { collection } = host;
      let changed = false;
      for (const entry of entries.values()) {
        if (entry.collection === collection) continue;
        changed = true;
        entry.collection?.remove(entry.layer, false);
        entry.collection = collection;
        if (collection) {
          collection.add(entry.layer);
          orderWeatherImagery(collection, entry.layer, IMAGERY_PRIORITY);
        }
      }
      paint();
      return changed;
    },
    clear() {
      for (const entry of [...entries.values()]) remove(entry);
      setKey = null;
      shownKey = null;
      lastError = null;
      viewer.scene.requestRender();
    },
    getDiagnostics() {
      let pendingTiles = 0;
      for (const entry of entries.values()) pendingTiles += entry.pending;
      return {
        host: 'globe',
        imageryCount: entries.size,
        pendingTiles,
        loading: waiting > 0,
        shown: shownKey,
        error: imageryHostStatus(getHost()) || lastError,
      };
    },
  };
}

/**
 * 3D Tiles hosts do not drape imagery layers, so the loop draws on one raised
 * shell (the weather radar's own surface). Only the shown frame's texture is
 * bound; the decoded frames stay in the caller's canvases.
 */
function createShellFrames({ viewer, cesium, getHost, onChange, createShell }) {
  let surface = null;
  let setKey = null;
  let current = null;
  let incoming = null;
  let images = new Map();
  let shownKey = null;
  let alpha = 0.8;

  const suspended = () => imageryHostStatus(getHost()) !== null;
  const visible = () => !suspended();
  function apply() {
    const canvas = images.get(shownKey);
    if (surface && canvas) surface.setImage(canvas);
    surface?.setShow(visible());
    surface?.setAlpha(alpha);
  }
  function drop(surfaceToDrop) {
    surfaceToDrop?.destroy();
  }
  function cancelIncoming() {
    if (!incoming) return;
    const stale = incoming;
    incoming = null;
    drop(stale.surface);
    stale.resolve(false);
  }

  return {
    async setFrames({ bounds, frames, images: next }, { signal } = {}) {
      signal?.throwIfAborted();
      if (suspended()) return false;
      images = next;
      if (!frames.some(({ key }) => key === shownKey))
        shownKey = frames.at(-1)?.key ?? null;
      const key = boundsKey(bounds);
      if (surface && setKey === key) {
        apply();
        return true;
      }
      cancelIncoming();
      const canvas = images.get(shownKey);
      if (!canvas) return false;
      const rectangle = cesium.Rectangle.fromDegrees(
        bounds.west,
        bounds.south,
        bounds.east,
        bounds.north,
      );
      return new Promise((resolve) => {
        const job = { surface: null, resolve };
        incoming = job;
        const abort = () => {
          if (incoming === job) cancelIncoming();
        };
        signal?.addEventListener('abort', abort, { once: true });
        job.surface = createShell({
          viewer,
          cesium,
          rectangle,
          height: WEATHER_SHELL_HEIGHTS.radar,
          onSettled: () => {
            if (incoming !== job) return;
            incoming = null;
            signal?.removeEventListener('abort', abort);
            drop(surface);
            surface = job.surface;
            current = key;
            setKey = key;
            apply();
            viewer.scene.requestRender();
            onChange();
            resolve(true);
          },
        });
        job.surface.setAlpha(0);
        job.surface.setImage(canvas);
      });
    },
    show(key) {
      shownKey = key;
      apply();
    },
    setAlpha(value) {
      alpha = value;
      surface?.setAlpha(alpha);
      viewer.scene.requestRender();
    },
    rehome() {
      const before = surface?.getDiagnostics().show;
      if (suspended()) cancelIncoming();
      surface?.setShow(visible());
      return before !== undefined && before !== visible();
    },
    clear() {
      cancelIncoming();
      drop(surface);
      surface = null;
      setKey = null;
      current = null;
      images = new Map();
      shownKey = null;
      viewer.scene.requestRender();
    },
    getDiagnostics() {
      return {
        host: 'shell',
        height: WEATHER_SHELL_HEIGHTS.radar,
        imageryCount: Number(!!surface) + Number(!!incoming),
        pendingTiles: 0,
        loading: !!incoming,
        shown: shownKey,
        extent: current,
        error: imageryHostStatus(getHost()),
      };
    },
  };
}

/**
 * Draw the BoM loop on whichever host is visible: stacked imagery layers on a
 * globe, a raised shell on 3D Tiles. A host switch tears one down and
 * restages the last frame set on the other.
 * @param {object} options
 * @param {object} options.viewer Cesium viewer (scene and camera used).
 * @param {object} options.cesium Cesium namespace (injected for tests).
 * @param {() => {collection: object|null, kind: string}} [options.getHost]
 */
export function createBomRendering({
  viewer,
  cesium,
  getHost = () => ({ collection: viewer.imageryLayers, kind: 'globe' }),
  onChange = () => {},
  timeoutMs = 25_000,
  now = () => performance.now(),
  createCanvas = () => document.createElement('canvas'),
  createShell = createShellSurface,
}) {
  const shared = {
    viewer,
    cesium,
    getHost,
    onChange,
    now,
    timeoutMs,
    createCanvas,
    createShell,
  };
  const globe = createGlobeFrames(shared);
  const shell = createShellFrames(shared);
  let active = null;
  let alpha = 0.8;
  let last = null;
  let shownKey = null;

  const wanted = () => {
    const { kind } = getHost();
    return kind === 'tileset'
      ? 'shell'
      : kind === 'globe'
        ? 'globe'
        : (active ?? 'globe');
  };
  const renderer = () => (active === 'shell' ? shell : globe);
  function switchHost() {
    const next = wanted();
    if (next === active) return false;
    const previous = active;
    active = next;
    if (previous === null) {
      renderer().setAlpha(alpha);
      return false;
    }
    (previous === 'shell' ? shell : globe).clear();
    renderer().setAlpha(alpha);
    if (last) {
      const target = renderer();
      void target
        .setFrames(last)
        .then(() => {
          if (renderer() === target && shownKey) target.show(shownKey);
        })
        .catch(() => {});
    }
    viewer.scene.requestRender();
    return true;
  }
  return {
    rehome() {
      const switched = switchHost();
      return renderer().rehome() || switched;
    },
    async setFrames(set, options = {}) {
      options.signal?.throwIfAborted();
      switchHost();
      last = set;
      if (!set.frames.some(({ key }) => key === shownKey)) shownKey = null;
      return renderer().setFrames(set, options);
    },
    show(key) {
      switchHost();
      shownKey = key;
      renderer().show(key);
    },
    setAlpha(value) {
      alpha = value;
      renderer().setAlpha(value);
    },
    clear() {
      last = null;
      shownKey = null;
      globe.clear();
      shell.clear();
      active = null;
    },
    getDiagnostics() {
      switchHost();
      return renderer().getDiagnostics();
    },
  };
}
