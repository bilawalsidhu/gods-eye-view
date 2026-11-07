// engine.imagery, the engine-neutral part: raster layers draped on the
// ground (terrain and 3D tiles) — XYZ tiles from a URL template, or one
// image (a canvas, a decoded image, RGBA bytes or an image URL) stretched
// over a longitude/latitude rectangle. This checks layer options and
// sources, keeps each layer's look (alpha, shown, split, order) and the
// split position, and tiles a Web Mercator template for the engines that
// mosaic their own tiles (Navara). Rectangles are degrees; colours are the
// image's own. No engine imports.

export const IMAGERY_SOURCE_KINDS = Object.freeze(['tiles', 'image']);
export const IMAGERY_SPLITS = Object.freeze(['none', 'left', 'right']);
/** Where imagery drapes now (GlobeImagery.surface). */
export const IMAGERY_SURFACES = Object.freeze(['globe', 'tiles', 'none']);
/** The latitude Web Mercator tiles stop at. */
export const WEB_MERCATOR_LIMIT = 85.05112878;

const isFiniteNumber = (value) =>
  typeof value === 'number' && Number.isFinite(value);
const isObject = (value) => value != null && typeof value === 'object';
const isWhole = (value) => Number.isInteger(value) && value >= 0;

function fail(message) {
  throw new TypeError(`Imagery layer: ${message}`);
}

const unit = (value, label) => {
  if (!(isFiniteNumber(value) && value >= 0 && value <= 1))
    fail(`${label} must be a number in 0..1: ${value}`);
  return value;
};

const splitOf = (value = 'none') => {
  if (!IMAGERY_SPLITS.includes(value))
    fail(`split must be one of ${IMAGERY_SPLITS.join(', ')}: ${value}`);
  return value;
};

/**
 * A rectangle in degrees, checked: { west, south, east, north } with south
 * below north; west > east crosses the antimeridian. Missing: the globe.
 */
function rectangleOf(rectangle) {
  if (rectangle == null)
    return Object.freeze({ west: -180, south: -90, east: 180, north: 90 });
  if (!isObject(rectangle)) fail('rectangle must be an object');
  const { west, south, east, north } = rectangle;
  if (
    ![west, south, east, north].every(isFiniteNumber) ||
    south >= north ||
    south < -90 ||
    north > 90 ||
    west < -180 ||
    west > 180 ||
    east < -180 ||
    east > 180 ||
    west === east
  )
    fail('rectangle must be { west, south, east, north } in degrees');
  return Object.freeze({ west, south, east, north });
}

// What an image source can hold: a canvas, an ImageBitmap or image element
// (anything with a width and a height), or { width, height, data } RGBA bytes.
function imageOf(image) {
  if (!isObject(image) && typeof image !== 'function')
    fail('image must be a canvas, an image or { width, height, data }');
  const { width, height } = image;
  if (!(isWhole(width) && width > 0 && isWhole(height) && height > 0))
    fail(`image must have a positive width and height: ${width}×${height}`);
  if (
    image.data !== undefined &&
    (!ArrayBuffer.isView(image.data) ||
      image.data.length !== width * height * 4)
  )
    fail('image data must be width × height × 4 RGBA bytes');
  return image;
}

/** Whether an image source holds RGBA bytes rather than a drawable image. */
export const isPixelImage = (image) => ArrayBuffer.isView(image?.data);

/**
 * An imagery source, checked, as the engines draw it:
 * - { kind: 'tiles', url, subdomains, minLevel, maxLevel, tileSize,
 *   rectangle, credit, opaque, maxRequests }: XYZ tiles in Web Mercator;
 *   `url` holds {z}, {x} and {y}, and {s} for one of `subdomains`;
 * - { kind: 'image', image | url, rectangle, credit }: one image over the
 *   rectangle, equirectangular (row 0 on the north edge).
 * The rectangle is in degrees (the globe when omitted); `credit` is HTML.
 */
export function normalizeImagerySource(source) {
  if (!isObject(source)) fail('source must be an object');
  const { kind } = source;
  if (!IMAGERY_SOURCE_KINDS.includes(kind))
    fail(
      `source kind must be one of ${IMAGERY_SOURCE_KINDS.join(', ')}: ${kind}`,
    );
  const rectangle = rectangleOf(source.rectangle);
  const credit = source.credit ?? null;
  if (credit !== null && typeof credit !== 'string')
    fail('credit must be a string of HTML');
  if (kind === 'image') {
    const hasImage = source.image != null;
    const hasUrl = source.url != null;
    if (hasImage === hasUrl) fail('an image source needs an image or a url');
    if (hasUrl && (typeof source.url !== 'string' || !source.url))
      fail('url must be a non-empty string');
    return Object.freeze({
      kind,
      image: hasImage ? imageOf(source.image) : null,
      url: hasUrl ? source.url : null,
      rectangle,
      credit,
    });
  }
  const { url } = source;
  if (
    typeof url !== 'string' ||
    !['{z}', '{x}', '{y}'].every((key) => url.includes(key))
  )
    fail('a tiles url must hold {z}, {x} and {y}');
  const subdomains = source.subdomains ?? ['a', 'b', 'c'];
  if (
    !Array.isArray(subdomains) ||
    !subdomains.length ||
    !subdomains.every((name) => typeof name === 'string')
  )
    fail('subdomains must be a list of strings');
  const minLevel = source.minLevel ?? 0;
  const maxLevel = source.maxLevel ?? 18;
  if (!(isWhole(minLevel) && isWhole(maxLevel) && minLevel <= maxLevel))
    fail(`levels must be whole numbers, min <= max: ${minLevel}..${maxLevel}`);
  const tileSize = source.tileSize ?? 256;
  if (!(isWhole(tileSize) && tileSize > 0))
    fail(`tileSize must be a positive whole number: ${tileSize}`);
  const maxRequests = source.maxRequests ?? null;
  if (maxRequests !== null && !(isWhole(maxRequests) && maxRequests > 0))
    fail(`maxRequests must be a positive whole number: ${maxRequests}`);
  if (source.opaque !== undefined && typeof source.opaque !== 'boolean')
    fail('opaque must be a boolean');
  return Object.freeze({
    kind,
    url,
    subdomains: Object.freeze([...subdomains]),
    minLevel,
    maxLevel,
    tileSize,
    rectangle,
    credit,
    opaque: source.opaque === true,
    maxRequests,
  });
}

/** createLayer options with defaults, or a TypeError. */
export function normalizeImageryLayerOptions(options) {
  if (!isObject(options)) fail('options must be an object');
  const { id } = options;
  if (typeof id !== 'string' || !id) fail('id must be a non-empty string');
  const order = options.order ?? 0;
  if (!isFiniteNumber(order)) fail(`order must be a number: ${order}`);
  if (options.show !== undefined && typeof options.show !== 'boolean')
    fail('show must be a boolean');
  return {
    id,
    order,
    source: normalizeImagerySource(options.source),
    alpha: unit(options.alpha ?? 1, 'alpha'),
    shown: options.show !== false,
    split: splitOf(options.split),
  };
}

/** A whole-globe rectangle wraps across the antimeridian. */
export const wrapsGlobe = ({ west, east }) => west === -180 && east === 180;

/**
 * engine.imagery over an engine's drawing: `build(state)` returns the
 * engine part of one layer ({ source(), look(), destroy(), ready?() }),
 * called with the layer's checked state ({ options, source, alpha, shown,
 * split, seq }) after it is stored; `source()` follows a new source and
 * `look()` a new alpha, show or split. `splitPosition(fraction)` draws the
 * engine's split, `surface()` answers GlobeImagery.surface. Layer ids are
 * unique while the layer lives; destroyAll() is for the engine's destroy.
 * `initialSplit` is the split position before one is set; `readSplit`,
 * when given, reads the one drawn (an engine whose split others set too).
 */
export function createImageryRegistry(
  build,
  {
    splitPosition = () => {},
    surface = () => 'globe',
    initialSplit = 0.5,
    readSplit = null,
  } = {},
) {
  const live = new Map();
  let split = initialSplit;
  let seq = 0;
  const imagery = {
    createLayer(input) {
      const options = normalizeImageryLayerOptions(input);
      if (live.has(options.id))
        throw new Error(`Imagery layer ${options.id} already exists`);
      const state = {
        options,
        source: options.source,
        alpha: options.alpha,
        shown: options.shown,
        split: options.split,
        seq: seq++,
        destroyed: false,
      };
      live.set(options.id, state);
      let part;
      try {
        part = build(state);
      } catch (error) {
        live.delete(options.id);
        throw error;
      }
      const alive = () => {
        if (state.destroyed) throw new Error('Imagery layer was destroyed');
      };
      const restyle = (key, value) => {
        alive();
        if (state[key] === value) return;
        state[key] = value;
        part.look();
      };
      const layer = {
        id: options.id,
        setSource(next) {
          alive();
          state.source = normalizeImagerySource(next);
          part.source();
        },
        source: () => state.source,
        setAlpha: (alpha) => restyle('alpha', unit(alpha, 'alpha')),
        alpha: () => state.alpha,
        show(visible) {
          if (typeof visible !== 'boolean') fail('show takes a boolean');
          restyle('shown', visible);
        },
        shown: () => state.shown,
        setSplit: (side) => restyle('split', splitOf(side)),
        split: () => state.split,
        ready: () =>
          !state.destroyed && (part.ready ? part.ready() === true : true),
        destroy() {
          if (state.destroyed) return;
          state.destroyed = true;
          live.delete(options.id);
          part.destroy();
        },
        isDestroyed: () => state.destroyed,
      };
      state.layer = layer;
      return layer;
    },
    list: () =>
      [...live.values()]
        .sort((a, b) => a.options.order - b.options.order || a.seq - b.seq)
        .map(({ options, source, shown, alpha, split: side }) => ({
          id: options.id,
          kind: source.kind,
          shown,
          alpha,
          split: side,
          order: options.order,
        })),
    setSplitPosition(fraction) {
      unit(fraction, 'split position');
      if (fraction === imagery.splitPosition()) return;
      split = fraction;
      splitPosition(fraction);
    },
    splitPosition: () => readSplit?.() ?? split,
    surface,
  };
  return {
    imagery,
    live,
    /** The live layers in draw order: lowest order first, then creation. */
    ordered: () =>
      [...live.values()].sort(
        (a, b) => a.options.order - b.options.order || a.seq - b.seq,
      ),
    destroyAll() {
      for (const state of [...live.values()]) state.layer.destroy();
    },
  };
}

// Web Mercator tiles of a template, for the engines that mosaic them
// (Navara draws one atlas per tiles layer).

const MAX_TILE_SIDE = 8;
export const mercatorX = (lon) => (lon + 180) / 360;
export const mercatorY = (lat) => {
  const r =
    (Math.max(-WEB_MERCATOR_LIMIT, Math.min(WEB_MERCATOR_LIMIT, lat)) *
      Math.PI) /
    180;
  return (1 - Math.log(Math.tan(Math.PI / 4 + r / 2)) / Math.PI) / 2;
};

/**
 * The tiles over `box` (degrees) that a view `rectangle` (radians, or null:
 * all of the box) shows at `level`, or the level below until they are at
 * most 8×8: { key, z, x, y, width, height, bounds: [x, y, w, h] in Web
 * Mercator units }, or null when the view misses the box. Never a global
 * mosaic.
 */
export function imageryTilePlan(box, rectangle, level) {
  let area = { ...box };
  if (rectangle && rectangle.east >= rectangle.west) {
    const degrees = 180 / Math.PI;
    area = {
      west: Math.max(box.west, rectangle.west * degrees),
      east: Math.min(box.east, rectangle.east * degrees),
      south: Math.max(box.south, rectangle.south * degrees),
      north: Math.min(box.north, rectangle.north * degrees),
    };
  }
  if (area.west >= area.east || area.south >= area.north) return null;
  for (let z = Math.max(0, Math.floor(level)); z >= 0; z--) {
    const n = 2 ** z;
    const x = Math.max(0, Math.floor(mercatorX(area.west) * n));
    const y = Math.max(0, Math.floor(mercatorY(area.north) * n));
    const right = Math.min(n - 1, Math.ceil(mercatorX(area.east) * n) - 1);
    const bottom = Math.min(n - 1, Math.ceil(mercatorY(area.south) * n) - 1);
    const width = right - x + 1,
      height = bottom - y + 1;
    if (width <= MAX_TILE_SIDE && height <= MAX_TILE_SIDE)
      return {
        key: [z, x, y, width, height].join('/'),
        z,
        x,
        y,
        width,
        height,
        bounds: [x / n, y / n, width / n, height / n],
      };
  }
  return null;
}

/** One tile's URL: {z}/{x}/{y}, and {s} picked by the tile from `subdomains`. */
export function imageryTileUrl(
  template,
  x,
  y,
  z,
  subdomains = ['a', 'b', 'c'],
) {
  return template
    .replaceAll('{x}', String(x))
    .replaceAll('{y}', String(y))
    .replaceAll('{z}', String(z))
    .replaceAll('{s}', subdomains[(x + y) % subdomains.length]);
}

/**
 * The tile level whose texels match the ground under a camera `height` m
 * up at `latitude` (radians), seen with a vertical field of view `fovy`
 * over `heightPx` CSS pixels.
 */
export function imageryTileLevel({ height, latitude, fovy, heightPx }) {
  const metresPerPixel =
    (2 * Math.max(1, height) * Math.tan(fovy / 2)) / Math.max(1, heightPx);
  return Math.ceil(
    Math.log2((156543.033928 * Math.cos(latitude)) / metresPerPixel),
  );
}

/**
 * Tile loads `limit` at a time. A task is { url, controllers, live(),
 * draw(image), fail(error) }; one no longer live is skipped, and an image
 * that arrives for one is closed without drawing. Cancellation holds its
 * admission slot until fetch AND decode settle.
 */
export function createImageryTileQueue({ load, limit = 6 }) {
  let active = 0,
    peak = 0,
    destroyed = false;
  const pending = [],
    controllers = new Set();
  function pump() {
    while (!destroyed && active < limit && pending.length) {
      const task = pending.shift();
      if (!task.live()) continue;
      const controller = new AbortController();
      controllers.add(controller);
      task.controllers.add(controller);
      active++;
      peak = Math.max(peak, active);
      Promise.resolve()
        .then(() => load(task.url, controller.signal))
        .then((image) => {
          try {
            if (!destroyed && !controller.signal.aborted && task.live())
              task.draw(image);
          } finally {
            image?.close?.();
          }
        })
        .catch((error) => {
          if (!destroyed && !controller.signal.aborted && task.live())
            task.fail(error);
        })
        .finally(() => {
          controllers.delete(controller);
          task.controllers.delete(controller);
          active--;
          pump();
        });
    }
  }
  return {
    add(tasks) {
      if (!destroyed) {
        pending.push(...tasks);
        pump();
      }
    },
    prune() {
      for (let i = pending.length - 1; i >= 0; i--)
        if (!pending[i].live()) pending.splice(i, 1);
    },
    diagnostics: () => ({
      active,
      queued: pending.filter((t) => t.live()).length,
      peak,
    }),
    destroy() {
      destroyed = true;
      pending.length = 0;
      for (const c of controllers) c.abort();
    },
  };
}
