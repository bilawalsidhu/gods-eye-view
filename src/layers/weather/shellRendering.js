import { acquireWeatherImage } from './infraredImage.js';
import { imageryHostStatus } from './imageryHost.js';
import { WEATHER_DETAIL_SIZE, WEATHER_IMAGE_SIZES } from './source.js';

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
// canvases); nothing older survives them. Cesium holds the shown canvases
// through the material uniforms in any case.
export const WEATHER_SHELL_CACHE_BYTES = 128 * 1024 * 1024;
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const MATERIAL_TYPE = 'WeatherFrame';
// Renders after an image swap: one queues the upload, one uploads and draws, one spare.
const UPLOAD_FRAMES = 3;
// An empty detail window: the full-extent image shows everywhere.
const NO_WINDOW = Object.freeze({ west: 0, south: 0, east: -1, north: -1 });
// Detail windows, in degrees.
const DETAIL_MIN_WIDTH = 6;
const DETAIL_GRID = 0.5;
const shellHeights = new WeakMap();
// Cesium binds a 1×1 white texture to an image uniform until its first upload:
// draw nothing until the full-extent image has arrived, and sample the detail
// image only once it has arrived. The window is west, south, east, north in the
// full-extent image's texture coordinates.
const MATERIAL_SOURCE = `czm_material czm_getMaterial(czm_materialInput materialInput)
{
  czm_material material = czm_getDefaultMaterial(materialInput);
  vec2 st = materialInput.st;
  vec4 coarse = texture(image, st);
  vec2 dst = (st - window.xy) / max(window.zw - window.xy, vec2(1e-6));
  float inside = float(all(greaterThanEqual(st, window.xy)) && all(lessThanEqual(st, window.zw)));
  float useDetail = inside * step(1.5, float(detailDimensions.x));
  vec4 c = mix(coarse, texture(detail, clamp(dst, 0.0, 1.0)), useDetail);
  material.diffuse = czm_gammaCorrect(c.rgb);
  material.alpha = c.a * alpha * step(1.5, float(imageDimensions.x));
  return material;
}
`;

function registerMaterial(cesium) {
  const cache = cesium.Material._materialCache;
  if (cache.getMaterial(MATERIAL_TYPE)) return;
  // A plain template: building the first material from a fabric would make that
  // instance Cesium's shared template and keep its last image alive.
  cache.addMaterial(MATERIAL_TYPE, {
    fabric: {
      type: MATERIAL_TYPE,
      uniforms: {
        image: cesium.Material.DefaultImageId,
        detail: cesium.Material.DefaultImageId,
        alpha: 1,
        window: { type: 'vec4', x: 0, y: 0, z: -1, w: -1 },
      },
      // Diffuse and alpha share these samples, so one source, not components.
      source: MATERIAL_SOURCE,
    },
    translucent: false,
  });
}

const sameEdges = (a, b) =>
  a.west === b.west &&
  a.south === b.south &&
  a.east === b.east &&
  a.north === b.north;

/** Keep weather shells first in the primitive collection, in ascending height:
 * higher shells draw over lower ones and other opaque content draws over both. */
export function orderWeatherShells(primitives, primitive, height) {
  shellHeights.set(primitive, height);
  if (typeof primitives.lowerToBottom !== 'function') return;
  const shells = [];
  for (let i = 0; i < primitives.length; i++) {
    const item = primitives.get(i);
    if (shellHeights.has(item)) shells.push(item);
  }
  const ordered = [...shells].sort(
    (a, b) => shellHeights.get(a) - shellHeights.get(b),
  );
  if (ordered.every((item, i) => primitives.get(i) === item)) return;
  for (const item of ordered.reverse()) primitives.lowerToBottom(item);
}

/** One raised rectangle drawing one full-extent image and, inside a window of
 * it, an optional detail image. The owner calls destroy(). */
export function createShellSurface({
  viewer,
  cesium,
  rectangle,
  height,
  onSettled = () => {},
}) {
  registerMaterial(cesium);
  const scene = viewer.scene;
  const primitives = scene.primitives;
  const material = new cesium.Material({
    fabric: { type: MATERIAL_TYPE },
    translucent: false,
  });
  // Flat shading keeps the product colours independent of the viewing angle.
  const appearance = new cesium.EllipsoidSurfaceAppearance({
    aboveGround: true,
    flat: true,
    translucent: false,
    material,
  });
  // Cesium orders its translucent pass itself (weighted OIT or distance), which
  // cannot honour stacked heights. Draw in the opaque pass in scene.primitives
  // order, alpha-blended and without depth writes, so higher shells draw over
  // lower ones and nothing is hidden or picked through a shell.
  appearance.getRenderState = () => ({
    depthTest: { enabled: true },
    depthMask: false,
    blending: cesium.BlendingState.ALPHA_BLEND,
  });
  const primitive = new cesium.Primitive({
    geometryInstances: new cesium.GeometryInstance({
      geometry: new cesium.RectangleGeometry({
        rectangle,
        height,
        granularity: cesium.Math.toRadians(0.5),
        vertexFormat: cesium.EllipsoidSurfaceAppearance.VERTEX_FORMAT,
      }),
    }),
    appearance,
    asynchronous: true,
    allowPicking: false,
  });
  primitives.add(primitive);
  orderWeatherShells(primitives, primitive, height);
  let image = null;
  let frames = 0;
  // The detail image, its own upload count and a window waiting for it to draw.
  let detail = null;
  let detailFrames = 0;
  let pendingWindow = null;
  let offRender = null;
  let destroyed = false;

  const fits = (size, value) =>
    !size || (size.x === value.width && size.y === value.height);
  const uploaded = () =>
    image !== null && fits(material.uniforms.imageDimensions, image);
  const detailDrawn = () =>
    detail !== null &&
    detailFrames === 0 &&
    fits(material.uniforms.detailDimensions, detail);
  const drawn = () =>
    primitive.ready &&
    uploaded() &&
    frames === 0 &&
    (detail === null || (detailDrawn() && pendingWindow === null));
  function appliedWindow() {
    const { x, y, z, w } = material.uniforms.window;
    return z < x ? null : { west: x, south: y, east: z, north: w };
  }
  function setWindow(rect) {
    const next = rect ?? NO_WINDOW;
    const { x, y, z, w } = material.uniforms.window;
    if (
      x === next.west &&
      y === next.south &&
      z === next.east &&
      w === next.north
    )
      return;
    material.uniforms.window = new cesium.Cartesian4(
      next.west,
      next.south,
      next.east,
      next.north,
    );
    scene.requestRender();
  }
  // The render governor may idle the scene; request frames only until the
  // asynchronous geometry is ready and the latest images have been drawn.
  function tick() {
    if (primitive.ready) {
      if (frames > 0) frames--;
      if (detailFrames > 0) detailFrames--;
    }
    // A texture is never shown at another window's place.
    if (pendingWindow && primitive.ready && detailDrawn()) {
      setWindow(pendingWindow);
      pendingWindow = null;
    }
    if (primitive.show && !drawn()) {
      scene.requestRender();
      return;
    }
    offRender?.();
    offRender = null;
    if (drawn()) onSettled();
  }
  function wake() {
    if (destroyed || !primitive.show || image === null || drawn()) return;
    offRender ??= scene.postRender.addEventListener(tick);
    scene.requestRender();
  }

  return {
    setImage(next) {
      if (destroyed || next === image) return;
      image = next;
      material.uniforms.image = next;
      frames = UPLOAD_FRAMES;
      wake();
    },
    setAlpha(value) {
      if (destroyed || material.uniforms.alpha === value) return;
      material.uniforms.alpha = value;
      scene.requestRender();
    },
    /** Draw `next` inside `rect` (west, south, east, north in the full-extent
     * image's texture coordinates, 0–1); null clears it. In the same window only
     * the image changes, and Cesium keeps drawing the previous texture until
     * this one is uploaded. A different window applies once its image has
     * drawn; until then the full-extent image covers it. */
    setDetail(next, rect) {
      if (destroyed) return;
      if (!next) {
        if (detail === null) return;
        detail = null;
        detailFrames = 0;
        pendingWindow = null;
        material.uniforms.detail = cesium.Material.DefaultImageId;
        setWindow(null);
        scene.requestRender();
        return;
      }
      if (next !== detail) {
        detail = next;
        material.uniforms.detail = next;
        detailFrames = UPLOAD_FRAMES;
      }
      const applied = appliedWindow();
      if (applied && sameEdges(applied, rect)) {
        pendingWindow = null;
      } else {
        setWindow(null);
        pendingWindow = rect;
      }
      wake();
    },
    /** Returns whether visibility changed. */
    setShow(value) {
      const show = Boolean(value);
      if (destroyed || primitive.show === show) return false;
      primitive.show = show;
      wake();
      scene.requestRender();
      return true;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      offRender?.();
      offRender = null;
      if (!primitives.isDestroyed?.() && primitives.contains(primitive))
        primitives.remove(primitive);
      if (!primitive.isDestroyed()) primitive.destroy();
      // Primitive.destroy leaves the material and its texture alive.
      if (!material.isDestroyed()) material.destroy();
      image = null;
      detail = null;
      pendingWindow = null;
      scene.requestRender();
    },
    getDiagnostics() {
      return {
        height,
        ready: Boolean(primitive.ready),
        uploaded: uploaded(),
        show: primitive.show,
        alpha: material.uniforms.alpha,
        rendering: offRender !== null,
        // `uploaded` once the detail image has drawn; the window applies after.
        detail: { uploaded: detailDrawn(), window: appliedWindow() },
      };
    },
  };
}

function fitTexture(cesium, { width, height }) {
  const limit = cesium.ContextLimits?.maximumTextureSize;
  // Halve, down to 1024 px wide, on devices with a smaller texture limit.
  while (limit > 0 && width > limit && width > 1024) {
    width /= 2;
    height /= 2;
  }
  return { width, height };
}

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

/** Observed weather on 3D Tiles: one raised shell per product and one
 * full-extent image per frame. The previous image stays until the next is ready.
 * Inside a window around the view the same surface samples a sharper image of
 * that area, so the two images share one mesh and never blend. */
export function createWeatherShell({
  viewer,
  cesium,
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
}) {
  if (!Object.hasOwn(WEATHER_IMAGE_SIZES, product))
    throw new TypeError('Unknown weather product');
  const scene = viewer.scene;
  const size = fitTexture(cesium, WEATHER_IMAGE_SIZES[product]);
  const detailSize = fitTexture(cesium, WEATHER_DETAIL_SIZE);
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
    scene.requestRender();
  }
  function failDetail(job) {
    if (detailJob !== job) return;
    clearTimeout(job.timeout);
    detailJob = null;
    if (detail?.stale) dropDetail();
    scene.requestRender();
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
    const rectangle = detailed
      ? viewer.camera?.computeViewRectangle?.(scene.globe?.ellipsoid)
      : null;
    const degrees = cesium.Math.toDegrees;
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
      viewer.camera?.moveEnd?.addEventListener(() => {
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
      scene.requestRender();
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
    lastError = 'Weather tiles unavailable · previous frame retained';
    frame.resolve(false);
    scene.requestRender();
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
    scene.requestRender();
    onChange();
  }
  function install(frame, image) {
    if (frame.closed || incoming !== frame) return;
    if (surface?.bounds === frame.bounds) {
      // Cesium keeps drawing the previous texture until this one is uploaded.
      surface.setImage(image);
      commit(frame);
      return;
    }
    // First frame or a new extent: stage an invisible surface and keep the
    // previous one until the new geometry and texture are drawable.
    const { west, south, east, north } = frame.snapshot.bounds;
    const next = createShellSurface({
      viewer,
      cesium,
      height,
      rectangle: cesium.Rectangle.fromDegrees(west, south, east, north),
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
      if (changed) scene.requestRender();
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
      scene.requestRender();
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
      scene.requestRender();
    },
    setAlpha(value) {
      alpha = value;
      surface?.setAlpha(alpha);
      scene.requestRender();
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
      scene.requestRender();
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
