import { acquireWeatherImage } from './infraredImage.js';
import { imageryHostStatus } from './imageryHost.js';
import { WEATHER_IMAGE_SIZES } from './source.js';

/** Metres above the ellipsoid. Lower shells draw first, so lightning draws last. */
export const WEATHER_SHELL_HEIGHTS = Object.freeze({
  wind: 5_000,
  clouds: 5_500,
  'clouds-regional': 5_800,
  radar: 6_200,
  lightning: 6_600,
});
// Decoded canvases per renderer. The displayed frame and the newest decode are
// never evicted, so two 4096×2048 frames may briefly exceed the budget.
export const WEATHER_SHELL_CACHE_BYTES = 48 * 1024 * 1024;
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const MATERIAL_TYPE = 'WeatherFrame';
// Renders after an image swap: one queues the upload, one uploads and draws, one spare.
const UPLOAD_FRAMES = 3;
const shellHeights = new WeakMap();

function registerMaterial(cesium) {
  const cache = cesium.Material._materialCache;
  if (cache.getMaterial(MATERIAL_TYPE)) return;
  // A plain template: building the first material from a fabric would make that
  // instance Cesium's shared template and keep its last image alive.
  cache.addMaterial(MATERIAL_TYPE, {
    fabric: {
      type: MATERIAL_TYPE,
      uniforms: { image: cesium.Material.DefaultImageId, alpha: 1 },
      components: {
        diffuse: 'texture(image, materialInput.st).rgb',
        // Cesium binds a 1×1 white texture until the first upload; draw nothing until then.
        alpha:
          'texture(image, materialInput.st).a * alpha * step(1.5, float(imageDimensions.x))',
      },
    },
    translucent: false,
  });
}

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

/** One raised rectangle drawing one image. The owner calls destroy(). */
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
  let offRender = null;
  let destroyed = false;

  const uploaded = () => {
    const size = material.uniforms.imageDimensions;
    return (
      image !== null &&
      (!size || (size.x === image.width && size.y === image.height))
    );
  };
  const drawn = () => primitive.ready && uploaded() && frames === 0;
  // The render governor may idle the scene; request frames only until the
  // asynchronous geometry is ready and the latest image has been drawn.
  function tick() {
    if (frames > 0 && primitive.ready) frames--;
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
      };
    },
  };
}

function imageSize(cesium, product) {
  let { width, height } = WEATHER_IMAGE_SIZES[product];
  const limit = cesium.ContextLimits?.maximumTextureSize;
  // Halve, down to 1024 px wide, on devices with a smaller texture limit.
  while (limit > 0 && width > limit && width > 1024) {
    width /= 2;
    height /= 2;
  }
  return { width, height };
}

/** Observed weather on 3D Tiles: one raised shell per product and one
 * full-extent image per frame. The previous image stays until the next is ready. */
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
  const size = imageSize(cesium, product);
  const infrared = product === 'clouds' || product === 'clouds-regional';
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

  const suspended = () => imageryHostStatus(getHost()) !== null;
  const cacheKey = (time, mode) => `${time}|${infrared ? mode : 'none'}`;
  const boundsKey = ({ west, south, east, north }) =>
    `${west},${south},${east},${north}`;

  function evict(keep) {
    for (const [key, entry] of images) {
      if (imageBytes <= cacheBytes) return;
      if (key === keep || key === current?.key) continue;
      images.delete(key);
      imageBytes -= entry.bytes;
    }
  }
  async function acquire(time, mode, signal, onFetched) {
    signal.throwIfAborted();
    const key = cacheKey(time, mode);
    const entry = images.get(key);
    if (entry) {
      images.delete(key);
      images.set(key, entry);
      return { texture: entry.image, decodeMs: 0, cached: true };
    }
    const result = await acquireWeatherImage(product, time, {
      signal,
      mode,
      size,
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
    evict(key);
    return { ...result, cached: false };
  }
  function applyVisibility() {
    return surface?.setShow(!hidden && !suspended()) ?? false;
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
    surface.setAlpha(alpha);
    applyVisibility();
    current = {
      time: frame.time,
      product: frame.product,
      infrared: frame.infrared,
      bounds: frame.bounds,
      key: frame.key,
      mosaic: frame.mosaic,
      loadMs: now() - frame.startedAt,
    };
    lastError = null;
    evict(null);
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
      }
      const changed = applyVisibility();
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
        const key = cacheKey(time, mode);
        if (prefetchJob?.key === key || prefetchedKey === key) return false;
        cancelPrefetch();
        job = { key, controller: new AbortController() };
        prefetchJob = job;
        const { signal } = job.controller;
        job.timeout = setTimeout(() => job.controller.abort(), timeoutMs);
        await acquire(time, mode, signal);
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
      void acquire(time, mode, frame.controller.signal, () => {
        frame.mosaic.fetched = true;
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
      }
      applyVisibility();
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
      surface?.destroy();
      surface = null;
      current = null;
      hidden = false;
      lastError = null;
      images.clear();
      imageBytes = 0;
      scene.requestRender();
    },
    getDiagnostics() {
      return {
        host: 'shell',
        height,
        imageSize: { ...size },
        shell: surface?.getDiagnostics() ?? null,
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
