import { acquireWeatherImage } from './infraredImage.js';
import { imageryHostStatus } from '../shared/imageryHost.js';
import { WEATHER_DETAIL_SIZE, WEATHER_IMAGE_SIZES } from './source.js';
import { msg } from '../../i18n/index.js';
import * as geo from '../../geo/index.js';

/** Metres above the ellipsoid. Lower shells draw first, so lightning draws last. */
export const WEATHER_SHELL_HEIGHTS = Object.freeze({
  wind: 5_000,
  clouds: 5_500,
  'clouds-regional': 5_800,
  radar: 6_200,
  lightning: 6_600,
});
// Decoded canvases per renderer, full-extent and detail images alike: the shown
// frame and the warmed next frame, each full-extent and detail (four 4096×2048
// canvases); nothing older survives them. The engine holds the shown canvases
// through its raised layer in any case.
export const WEATHER_SHELL_CACHE_BYTES = 128 * 1024 * 1024;
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
// Detail windows, in degrees.
const DETAIL_MIN_WIDTH = 6;
const DETAIL_GRID = 0.5;

const sameEdges = (a, b) =>
  a.west === b.west &&
  a.south === b.south &&
  a.east === b.east &&
  a.north === b.north;

/** The detail window for a view footprint over product bounds (both in degrees;
 * a footprint across the antimeridian has west > east), or null when the
 * full-extent image is already the best available. The window is centred on
 * the footprint, max(2 × its longitude span, 6°) wide and half as tall, with
 * edges on a 0.5° grid inside the bounds. It is enabled only when narrower than
 * half the product's longitude extent and when the footprint overlaps the
 * product. `previous` is returned unchanged while the footprint centre stays in
 * its inner half and the wanted width is within 50 % of its width. */
export function detailWindow(footprint, bounds, previous = null) {
  if (!footprint || !bounds) return null;
  const across = footprint.east < footprint.west;
  const span = footprint.east - footprint.west + (across ? 360 : 0);
  let lon = footprint.west + span / 2;
  if (lon > 180) lon -= 360;
  const lat = (footprint.south + footprint.north) / 2;
  const wanted = Math.max(2 * span, DETAIL_MIN_WIDTH);
  if (previous) {
    const width = previous.east - previous.west;
    const height = previous.north - previous.south;
    if (
      Math.abs(lon - (previous.west + previous.east) / 2) <= width / 4 &&
      Math.abs(lat - (previous.south + previous.north) / 2) <= height / 4 &&
      Math.abs(wanted - width) <= width / 2
    )
      return previous;
  }
  const inner = {
    west: Math.ceil(bounds.west / DETAIL_GRID) * DETAIL_GRID,
    south: Math.ceil(bounds.south / DETAIL_GRID) * DETAIL_GRID,
    east: Math.floor(bounds.east / DETAIL_GRID) * DETAIL_GRID,
    north: Math.floor(bounds.north / DETAIL_GRID) * DETAIL_GRID,
  };
  // Whole degrees keep both the edges and the 2:1 height on the grid; the
  // tolerance absorbs radian round trips.
  const width = Math.ceil(wanted - 1e-9);
  const height = width / 2;
  const overlaps =
    footprint.south < bounds.north &&
    footprint.north > bounds.south &&
    (across
      ? footprint.west < bounds.east || footprint.east > bounds.west
      : footprint.west < bounds.east && footprint.east > bounds.west);
  if (
    !overlaps ||
    width >= (bounds.east - bounds.west) / 2 ||
    width > inner.east - inner.west ||
    height > inner.north - inner.south
  )
    return null;
  const snap = (value) => Math.round(value / DETAIL_GRID) * DETAIL_GRID;
  const west = Math.min(
    Math.max(snap(lon - width / 2), inner.west),
    inner.east - width,
  );
  const south = Math.min(
    Math.max(snap(lat - height / 2), inner.south),
    inner.north - height,
  );
  const next = { west, south, east: west + width, north: south + height };
  return previous && sameEdges(previous, next) ? previous : next;
}

// Halves, down to 1024 px wide, on devices with a smaller texture limit.
function fitTexture({ width, height }, limit) {
  while (limit > 0 && width > limit && width > 1024) {
    width /= 2;
    height /= 2;
  }
  return { width, height };
}

/** Observed weather on 3D Tiles: one raised shell per product and one
 * full-extent image per frame. The previous image stays until the next is ready.
 * Inside a window around the view the same surface samples a sharper image of
 * that area, so the two images share one mesh and never blend. The surfaces
 * are the engine's (`createSurface`, render/display.js), as are the render
 * requests, the view footprint, the camera's move-end event and the GPU's
 * texture limit. A `frameSource` with `getImage` supplies both images,
 * the detail window through its `bbox`. */
export function createWeatherShell({
  product,
  height = WEATHER_SHELL_HEIGHTS[product],
  getHost = () => ({ collection: null, kind: 'tileset' }),
  onChange = () => {},
  timeoutMs = 25_000,
  now = () => performance.now(),
  fetchImpl = (...args) => globalThis.fetch(...args),
  decodeImage,
  createCanvas = () => document.createElement('canvas'),
  cacheBytes = WEATHER_SHELL_CACHE_BYTES,
  createSurface,
  requestRender,
  viewRectangle,
  moveEnd,
  maxTextureSize = Infinity,
  frameSource = null,
}) {
  if (!Object.hasOwn(WEATHER_IMAGE_SIZES, product))
    throw new TypeError('Unknown weather product');
  const size = fitTexture(WEATHER_IMAGE_SIZES[product], maxTextureSize);
  const detailSize = fitTexture(WEATHER_DETAIL_SIZE, maxTextureSize);
  const infrared = product === 'clouds' || product === 'clouds-regional';
  // Global infrared contrast depends on the requested extent, so a window would
  // not match the image around it; the globe host also shows one mosaic.
  const detailed = product !== 'clouds';
  let surface = null;
  let current = null;
  let incoming = null;
  let alpha = 0.7;
  let hidden = false;
  let lastError = null;
  const images = new Map();
  let imageBytes = 0;
  let prefetchJob = null;
  let prefetchedKey = null;
  // The detail window for the shown bounds, the image drawn in it and its fetch.
  let view = null;
  let viewBounds = null;
  let detail = null;
  let detailJob = null;
  let offCamera = null;

  const suspended = () => imageryHostStatus(getHost()) !== null;
  const visible = () => !hidden && !suspended();
  const boundsKey = ({ west, south, east, north }) =>
    `${west},${south},${east},${north}`;
  const cacheKey = (time, mode, box = null) =>
    `${time}|${infrared ? mode : 'none'}${box ? `|${boundsKey(box)}` : ''}`;
  const wantedDetail = () =>
    current && view ? cacheKey(current.time, current.infrared, view) : null;

  function evict(keep = []) {
    const kept = new Set([...keep, current?.key, detail?.key]);
    for (const [key, entry] of images) {
      if (imageBytes <= cacheBytes) return;
      if (kept.has(key)) continue;
      images.delete(key);
      imageBytes -= entry.bytes;
    }
  }
  async function acquire(
    time,
    mode,
    signal,
    { box = null, keep = [], onFetched } = {},
  ) {
    signal.throwIfAborted();
    const key = cacheKey(time, mode, box);
    const entry = images.get(key);
    if (entry) {
      images.delete(key);
      images.set(key, entry);
      return { texture: entry.image, decodeMs: 0, cached: true };
    }
    const result = await acquireWeatherImage(product, time, {
      signal,
      mode,
      size: box ? detailSize : size,
      bbox: box,
      maxBytes: MAX_IMAGE_BYTES,
      createCanvas,
      fetchImpl,
      decodeImage,
      now,
      onFetched,
      frameSource,
    });
    // An aborted decode may still finish; never repopulate a cleared instance.
    signal.throwIfAborted();
    const previous = images.get(key);
    if (previous) imageBytes -= previous.bytes;
    images.delete(key);
    const bytes = result.texture.width * result.texture.height * 4;
    images.set(key, { image: result.texture, bytes });
    imageBytes += bytes;
    evict([key, ...keep]);
    return { ...result, cached: false };
  }
  /** The detail box in the full-extent image's texture coordinates. */
  function detailRect() {
    const b = current.extent;
    const w = detail.box;
    const x = b.east - b.west;
    const y = b.north - b.south;
    return {
      west: (w.west - b.west) / x,
      south: (w.south - b.south) / y,
      east: (w.east - b.west) / x,
      north: (w.north - b.south) / y,
    };
  }
  function syncDetail() {
    if (detail && current) surface?.setDetail(detail.image, detailRect());
    else surface?.setDetail(null);
  }
  function applyVisibility() {
    return surface?.setShow(visible()) ?? false;
  }
  function cancelDetail() {
    clearTimeout(detailJob?.timeout);
    detailJob?.controller.abort();
    detailJob = null;
  }
  function dropDetail() {
    detail = null;
    // The full-extent image covers the window in the same turn.
    surface?.setDetail(null);
  }
  function installDetail(job, image) {
    if (detailJob !== job) return;
    clearTimeout(job.timeout);
    detailJob = null;
    detail = { box: job.box, key: job.key, image, stale: false };
    syncDetail();
    evict();
    requestRender();
  }
  function failDetail(job) {
    if (detailJob !== job) return;
    clearTimeout(job.timeout);
    detailJob = null;
    if (detail?.stale) dropDetail();
    requestRender();
  }
  /** Bring the detail to the shown frame and window. The previous detail image
   * stays until the next is decoded unless the window itself moved, and over at
   * most one newer frame (see commit). */
  function refreshDetail() {
    const key = wantedDetail();
    if (!key) {
      cancelDetail();
      dropDetail();
      return;
    }
    if (detail && boundsKey(detail.box) !== boundsKey(view)) dropDetail();
    syncDetail();
    if (detail?.key === key) {
      detail.stale = false;
      cancelDetail();
      return;
    }
    // Another frame's detail: the next commit drops it unless replaced first.
    if (detail) detail.stale = true;
    if (!visible()) {
      cancelDetail();
      return;
    }
    if (detailJob?.key === key) return;
    cancelDetail();
    const job = { key, box: view, controller: new AbortController() };
    detailJob = job;
    job.timeout = setTimeout(() => job.controller.abort(), timeoutMs);
    void acquire(current.time, current.infrared, job.controller.signal, {
      box: view,
    })
      .then(({ texture }) => installDetail(job, texture))
      .catch(() => failDetail(job));
  }
  /** Recompute the window from the camera's ground footprint; returns whether it changed. */
  function computeView() {
    const rectangle = detailed ? viewRectangle() : null;
    const degrees = geo.math.toDegrees;
    const footprint = rectangle && {
      west: degrees(rectangle.west),
      south: degrees(rectangle.south),
      east: degrees(rectangle.east),
      north: degrees(rectangle.north),
    };
    const next = detailWindow(
      footprint,
      current.extent,
      viewBounds === current.bounds ? view : null,
    );
    viewBounds = current.bounds;
    if (next === view) return false;
    view = next;
    return true;
  }
  function watchCamera() {
    if (offCamera || !detailed) return;
    offCamera =
      moveEnd?.addEventListener(() => {
        if (current && computeView()) refreshDetail();
      }) ?? null;
  }
  function cancelPrefetch() {
    clearTimeout(prefetchJob?.timeout);
    prefetchJob?.controller.abort();
    prefetchJob = null;
    prefetchedKey = null;
  }
  function watch(frame, signal) {
    if (!signal) return;
    frame.owned = true;
    const abort = () => {
      if (incoming === frame) cancelIncoming();
      requestRender();
    };
    signal.addEventListener('abort', abort, { once: true });
    frame.offAbort = () => signal.removeEventListener('abort', abort);
  }
  function close(frame) {
    frame.closed = true;
    frame.controller.abort();
    clearTimeout(frame.timeout);
    frame.offAbort?.();
    frame.surface?.destroy();
    frame.surface = null;
  }
  function cancelIncoming() {
    if (!incoming) return;
    const frame = incoming;
    incoming = null;
    close(frame);
    frame.resolve(false);
  }
  function fail(frame) {
    if (incoming !== frame) return;
    incoming = null;
    close(frame);
    lastError = msg('Weather tiles unavailable · previous frame retained');
    frame.resolve(false);
    requestRender();
    onChange();
  }
  function commit(frame) {
    if (incoming !== frame) return;
    incoming = null;
    clearTimeout(frame.timeout);
    frame.offAbort?.();
    if (frame.surface) {
      surface?.destroy();
      surface = frame.surface;
      frame.surface = null;
    }
    const { west, south, east, north } = frame.snapshot.bounds;
    current = {
      time: frame.time,
      product: frame.product,
      infrared: frame.infrared,
      bounds: frame.bounds,
      extent: { west, south, east, north },
      key: frame.key,
      mosaic: frame.mosaic,
      loadMs: now() - frame.startedAt,
    };
    surface.setAlpha(alpha);
    applyVisibility();
    lastError = null;
    evict();
    // The full-extent image swaps first; the detail follows for the same time.
    watchCamera();
    if (viewBounds !== current.bounds) computeView();
    // An older frame's detail stays over at most one newer frame.
    if (detail?.stale && detail.key !== wantedDetail()) dropDetail();
    refreshDetail();
    frame.resolve(true);
    requestRender();
    onChange();
  }
  function install(frame, image) {
    if (frame.closed || incoming !== frame) return;
    if (surface?.bounds === frame.bounds) {
      // The surface keeps drawing the previous image until this one draws.
      surface.setImage(image);
      commit(frame);
      return;
    }
    // First frame or a new extent: stage an invisible surface and keep the
    // previous one until the new geometry and texture are drawable.
    const { west, south, east, north } = frame.snapshot.bounds;
    const next = createSurface({
      height,
      // The extent in radians.
      rectangle: {
        west: geo.math.toRadians(west),
        south: geo.math.toRadians(south),
        east: geo.math.toRadians(east),
        north: geo.math.toRadians(north),
      },
      onSettled: () => commit(frame),
    });
    next.bounds = frame.bounds;
    frame.surface = next;
    next.setAlpha(0);
    next.setImage(image);
  }

  return {
    product,
    rehome() {
      if (suspended()) {
        cancelPrefetch();
        cancelIncoming();
        cancelDetail();
      }
      const changed = applyVisibility();
      if (current && !suspended()) {
        computeView();
        refreshDetail();
      }
      if (changed) requestRender();
      return changed;
    },
    cancelPrefetch,
    async prefetch(snapshot, time, { infrared: mode = 'filtered' } = {}) {
      let job;
      try {
        if (
          hidden ||
          incoming ||
          suspended() ||
          snapshot.product !== product ||
          !snapshot.times.includes(time)
        )
          return false;
        // Warm the next frame's detail window too while the window stays put.
        const box =
          view && viewBounds === boundsKey(snapshot.bounds) ? view : null;
        const coarse = cacheKey(time, mode);
        const key = box ? cacheKey(time, mode, box) : coarse;
        if (prefetchJob?.key === key || prefetchedKey === key) return false;
        cancelPrefetch();
        job = { key, controller: new AbortController() };
        prefetchJob = job;
        const { signal } = job.controller;
        job.timeout = setTimeout(() => job.controller.abort(), timeoutMs);
        // Both images at once: one after the other would outlast playback's step.
        await Promise.all([
          acquire(time, mode, signal, { keep: box ? [key] : [] }),
          box ? acquire(time, mode, signal, { box, keep: [coarse] }) : null,
        ]);
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
      { signal, infrared: mode = 'filtered' } = {},
    ) {
      signal?.throwIfAborted();
      cancelPrefetch();
      const bounds = boundsKey(snapshot.bounds);
      const same = (frame) =>
        frame?.time === time &&
        frame.product === snapshot.product &&
        frame.infrared === mode &&
        frame.bounds === bounds;
      // A request for the frame a host switch is restaging joins that work.
      if (same(incoming) && !incoming.owned && !suspended()) {
        watch(incoming, signal);
        return incoming.result;
      }
      cancelIncoming();
      applyVisibility();
      if (suspended()) return false;
      if (same(current)) return true;
      lastError = null;
      const frame = {
        snapshot,
        time,
        infrared: mode,
        bounds,
        product: snapshot.product,
        key: cacheKey(time, mode),
        mosaic: { fetched: false, decodeMs: null, cached: false },
        controller: new AbortController(),
        startedAt: now(),
        surface: null,
        owned: false,
        closed: false,
        resolve: null,
      };
      incoming = frame;
      frame.result = new Promise((resolve) => {
        frame.resolve = resolve;
      });
      watch(frame, signal);
      frame.timeout = setTimeout(() => fail(frame), timeoutMs);
      void acquire(time, mode, frame.controller.signal, {
        onFetched: () => {
          frame.mosaic.fetched = true;
        },
      })
        .then(({ texture, decodeMs, cached }) => {
          frame.mosaic.decodeMs = decodeMs;
          frame.mosaic.cached = cached;
          install(frame, texture);
        })
        .catch(() => fail(frame));
      requestRender();
      onChange();
      return frame.result;
    },
    setHidden(value) {
      hidden = Boolean(value);
      if (hidden) {
        cancelPrefetch();
        cancelIncoming();
        cancelDetail();
      }
      applyVisibility();
      if (!hidden) refreshDetail();
      requestRender();
    },
    setAlpha(value) {
      alpha = value;
      surface?.setAlpha(alpha);
      requestRender();
    },
    clear() {
      cancelPrefetch();
      cancelIncoming();
      cancelDetail();
      offCamera?.();
      offCamera = null;
      dropDetail();
      surface?.destroy();
      surface = null;
      current = null;
      view = null;
      viewBounds = null;
      hidden = false;
      lastError = null;
      images.clear();
      imageBytes = 0;
      requestRender();
    },
    getDiagnostics() {
      const drawn = surface?.getDiagnostics();
      const applied = drawn?.detail.window;
      return {
        host: 'shell',
        height,
        imageSize: { ...size },
        shell: drawn
          ? {
              ...drawn,
              detail: {
                bbox: view
                  ? [view.west, view.south, view.east, view.north]
                  : null,
                size: { ...detailSize },
                // The wanted window is applied and its image drawn.
                ready: Boolean(
                  detail &&
                  current &&
                  detail.key === wantedDetail() &&
                  drawn.ready &&
                  drawn.show &&
                  drawn.detail.uploaded &&
                  applied &&
                  sameEdges(applied, detailRect()),
                ),
                enabled: view !== null,
              },
            }
          : null,
        cache: {
          mosaics: images.size,
          bytes: imageBytes,
          prefetching: !!prefetchJob,
        },
        imageryCount: Number(!!surface) + Number(!!incoming?.surface),
        mosaic: (incoming || current)?.mosaic,
        infrared: (incoming || current)?.infrared ?? 'filtered',
        loading: !!incoming,
        time: hidden ? null : (current?.time ?? null),
        hidden,
        product: current?.product ?? null,
        frameLoadMs: current?.loadMs ?? null,
        error: imageryHostStatus(getHost()) || lastError,
      };
    },
  };
}
