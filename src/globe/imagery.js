// engine.imagery, the engine-neutral part: raster layers draped on the
// ground (terrain and 3D tiles) or raised on a shell above it — XYZ tiles
// from a URL template (Web Mercator or geographic), or one image (a canvas,
// a decoded image, RGBA bytes or an image URL) stretched over a
// longitude/latitude rectangle. This checks layer options and sources,
// keeps each layer's look (alpha, shown, split, order), its staged source
// and detail and the split position, and tiles a template for the engines
// that mosaic their own tiles (Navara). Rectangles are degrees; colours are
// the image's own. No engine imports.

const IMAGERY_SOURCE_KINDS = Object.freeze(['tiles', 'image']);
const IMAGERY_SPLITS = Object.freeze(['none', 'left', 'right']);
/** How a tiles source cuts the globe: Web Mercator XYZ, or geographic
 * (EPSG:4326, 2×1 tiles at level 0, Cesium's GeographicTilingScheme). */
const IMAGERY_TILE_SCHEMES = Object.freeze(['webMercator', 'geographic']);
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

// A raised layer's shell rises with the camera: from far away coarse 3D
// tiles stand tens of kilometres above the ground and would hide it. 4 m
// per kilometre of camera height, at most 60 km, in 500 m steps; a uniform
// lift keeps stacked shells in their order.
const LIFT_PER_METRE = 0.004;
const MAX_LIFT = 60_000;
const LIFT_STEP = 500;

/** Metres every raised layer rises for a camera this high above the ellipsoid. */
export function raisedLift(cameraHeight) {
  if (!(cameraHeight > 0)) return 0;
  const lift = Math.min(MAX_LIFT, cameraHeight * LIFT_PER_METRE);
  return Math.round(lift / LIFT_STEP) * LIFT_STEP;
}

/**
 * An imagery source, checked, as the engines draw it:
 * - { kind: 'tiles', url, subdomains, minLevel, maxLevel, tileSize,
 *   rectangle, credit, opaque, maxRequests, scheme, transform }: XYZ tiles
 *   in Web Mercator or geographic (`scheme`); `url` holds {z}, {x} and
 *   {y}, and {s} for one of `subdomains`; `transform(image)`, when given,
 *   turns each decoded tile (row 0 on the north edge) into what draws;
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
  const scheme = source.scheme ?? 'webMercator';
  if (!IMAGERY_TILE_SCHEMES.includes(scheme))
    fail(`scheme must be one of ${IMAGERY_TILE_SCHEMES.join(', ')}: ${scheme}`);
  const transform = source.transform ?? null;
  if (transform !== null && typeof transform !== 'function')
    fail('transform must be a function of a decoded tile');
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
    scheme,
    transform,
  });
}

/**
 * Whether two checked sources draw the same pixels and differ at most in
 * their credit: the same template and tiling, or the same image URL. A
 * source holding an image is never the same (setSource with the same
 * canvas draws its new pixels).
 */
export function sameImageryPixels(a, b) {
  if (a.kind !== b.kind) return false;
  const edges = ['west', 'south', 'east', 'north'];
  if (!edges.every((edge) => a.rectangle[edge] === b.rectangle[edge]))
    return false;
  if (a.kind === 'image') return !a.image && !b.image && a.url === b.url;
  return (
    a.url === b.url &&
    a.subdomains.join() === b.subdomains.join() &&
    a.minLevel === b.minLevel &&
    a.maxLevel === b.maxLevel &&
    a.tileSize === b.tileSize &&
    a.opaque === b.opaque &&
    a.maxRequests === b.maxRequests &&
    a.scheme === b.scheme &&
    a.transform === b.transform
  );
}

/**
 * A raised layer's detail, checked: { image, rectangle }, an image (as an
 * image source holds one) drawn in place of the layer's own inside a
 * rectangle that does not cross the antimeridian; null clears it.
 */
export function normalizeImageryDetail(detail) {
  if (detail === null) return null;
  if (!isObject(detail)) fail('a detail is { image, rectangle } or null');
  const rectangle = rectangleOf(detail.rectangle);
  if (detail.rectangle == null || rectangle.west > rectangle.east)
    fail('a detail rectangle must not cross the antimeridian');
  return Object.freeze({ image: imageOf(detail.image), rectangle });
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
  const raise = options.raise ?? null;
  if (raise !== null && !(isFiniteNumber(raise) && raise > 0))
    fail(`raise must be a positive number of metres: ${raise}`);
  const source = normalizeImagerySource(options.source);
  if (raise !== null) raisedSource(source);
  return {
    id,
    order,
    source,
    alpha: unit(options.alpha ?? 1, 'alpha'),
    shown: options.show !== false,
    split: splitOf(options.split),
    raise,
  };
}

// A raised layer draws one image on its shell, never tiles.
function raisedSource(source) {
  if (source.kind !== 'image') fail('a raised layer draws an image source');
  return source;
}

/** A whole-globe rectangle wraps across the antimeridian. */
export const wrapsGlobe = ({ west, east }) => west === -180 && east === 180;

/**
 * engine.imagery over an engine's drawing: `build(state)` returns the
 * engine part of one layer ({ source(), look(), destroy(), ready?(),
 * stage?(), unstage?(), credit?(), detail?() }), called with the layer's
 * checked state ({ options, source, alpha, shown, split, seq, detail })
 * after it is stored; `source()` follows a new source and `look()` a new
 * alpha, show or split. `credit()` follows a source that changed only its
 * credit (`source()` when the part has none). `stage(source, finish)`
 * builds a source aside while the drawn one stays, and calls
 * `finish(true)` as it draws it in its place (the state's source is the
 * new one from then on) or `finish(false)` when it cannot; `unstage()`
 * drops one in progress. `detail(detail, finish)` does the same for a
 * raised layer's detail (null: cleared at once). Without `stage` a staged
 * source replaces the drawn one at once. `splitPosition(fraction)` draws
 * the engine's split, `surface()` answers GlobeImagery.surface. Layer ids
 * are unique while the layer lives; destroyAll() is for the engine's
 * destroy. `initialSplit` is the split position before one is set;
 * `readSplit`, when given, reads the one drawn (an engine whose split
 * others set too).
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
        detail: null,
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
      // The source and the detail being staged: { value, resolve }.
      let staged = null;
      let detailing = null;
      const settle = (job, ok) => {
        if (job) job.resolve(ok);
      };
      const dropStaged = () => {
        const job = staged;
        staged = null;
        if (!job) return;
        job.offAbort?.();
        part.unstage?.();
        settle(job, false);
      };
      const dropDetail = () => {
        const job = detailing;
        detailing = null;
        settle(job, false);
      };
      const alive = () => {
        if (state.destroyed) throw new Error('Imagery layer was destroyed');
      };
      const restyle = (key, value) => {
        alive();
        if (state[key] === value) return;
        state[key] = value;
        part.look();
      };
      const checkedSource = (next) => {
        const source = normalizeImagerySource(next);
        return options.raise === null ? source : raisedSource(source);
      };
      // A source the drawn one differs from only in its credit.
      const inPlace = (source) => {
        if (!sameImageryPixels(state.source, source)) return false;
        const changed = state.source.credit !== source.credit;
        state.source = source;
        if (changed) (part.credit ?? part.source)();
        return true;
      };
      const layer = {
        id: options.id,
        setSource(next, { staged: stage = false, signal = null } = {}) {
          alive();
          const source = checkedSource(next);
          if (!stage) {
            dropStaged();
            if (!inPlace(source)) {
              state.source = source;
              part.source();
            }
            return undefined;
          }
          dropStaged();
          if (signal?.aborted) return Promise.resolve(false);
          if (inPlace(source)) return Promise.resolve(true);
          if (!part.stage) {
            state.source = source;
            part.source();
            return Promise.resolve(true);
          }
          return new Promise((resolve) => {
            const job = { value: source, resolve };
            staged = job;
            if (signal) {
              const abort = () => {
                if (staged === job) dropStaged();
              };
              signal.addEventListener('abort', abort, { once: true });
              job.offAbort = () => signal.removeEventListener('abort', abort);
            }
            part.stage(source, (ok) => {
              if (staged !== job || state.destroyed) return;
              staged = null;
              job.offAbort?.();
              if (ok) state.source = source;
              settle(job, ok);
            });
          });
        },
        source: () => state.source,
        staging: () => staged !== null,
        setDetail(next) {
          alive();
          if (options.raise === null)
            fail('only a raised layer takes a detail');
          const detail = normalizeImageryDetail(next ?? null);
          const pending = detailing !== null;
          dropDetail();
          if (!detail) {
            // A detail still loading is cleared too: the backend may draw it.
            if (state.detail === null && !pending) return Promise.resolve(true);
            state.detail = null;
            part.detail?.(null, () => {});
            return Promise.resolve(true);
          }
          return new Promise((resolve) => {
            const job = { value: detail, resolve };
            detailing = job;
            const finish = (ok) => {
              if (detailing !== job || state.destroyed) return;
              detailing = null;
              if (ok) state.detail = detail;
              settle(job, ok);
            };
            if (part.detail) part.detail(detail, finish);
            else finish(true);
          });
        },
        detail: () => state.detail,
        setAlpha: (alpha) => restyle('alpha', unit(alpha, 'alpha')),
        alpha: () => state.alpha,
        show(visible) {
          if (typeof visible !== 'boolean') fail('show takes a boolean');
          restyle('shown', visible);
        },
        shown: () => state.shown,
        setSplit: (side) => restyle('split', splitOf(side)),
        split: () => state.split,
        raise: () => options.raise,
        ready: () =>
          !state.destroyed && (part.ready ? part.ready() === true : true),
        destroy() {
          if (state.destroyed) return;
          state.destroyed = true;
          live.delete(options.id);
          const job = staged;
          staged = null;
          job?.offAbort?.();
          settle(job, false);
          dropDetail();
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

// The tiles of a template, Web Mercator or geographic, for the engines that
// mosaic them (Navara draws one atlas per tiles layer).

const MAX_TILE_SIDE = 8;
export const mercatorX = (lon) => (lon + 180) / 360;
export const mercatorY = (lat) => {
  const r =
    (Math.max(-WEB_MERCATOR_LIMIT, Math.min(WEB_MERCATOR_LIMIT, lat)) *
      Math.PI) /
    180;
  return (1 - Math.log(Math.tan(Math.PI / 4 + r / 2)) / Math.PI) / 2;
};

/** Geographic tiles: x across 2^(z+1) columns, y down 2^z rows from 90°. */
export const geographicY = (lat) =>
  (90 - Math.max(-90, Math.min(90, lat))) / 180;

/**
 * The tiles over `box` (degrees) that a view `rectangle` (radians, or null:
 * all of the box) shows at `level`, or the level below until they are at
 * most 8×8: { key, z, x, y, width, height, bounds }, or null when the view
 * misses the box. Never a global mosaic. `bounds` is [x, y, w, h] in Web
 * Mercator units, or for `scheme` 'geographic' the atlas's [west, south,
 * east, north] in degrees.
 */
export function imageryTilePlan(box, rectangle, level, scheme = 'webMercator') {
  const geographic = scheme === 'geographic';
  const sourceEast = box.east < box.west ? box.east + 360 : box.east;
  let area = { ...box, east: sourceEast };
  if (rectangle) {
    const degrees = 180 / Math.PI;
    const west = rectangle.west * degrees;
    const east =
      rectangle.east * degrees + (rectangle.east < rectangle.west ? 360 : 0);
    const spans = [-360, 0, 360]
      .map((shift) => [
        Math.max(box.west + shift, west),
        Math.min(sourceEast + shift, east),
      ])
      .filter(([left, right]) => left < right);
    if (!spans.length) return null;
    area = {
      west: Math.min(...spans.map(([left]) => left)),
      east: Math.max(...spans.map(([, right]) => right)),
      south: Math.max(box.south, rectangle.south * degrees),
      north: Math.min(box.north, rectangle.north * degrees),
    };
  }
  if (area.west >= area.east || area.south >= area.north) return null;
  const toX = mercatorX;
  const toY = geographic ? geographicY : mercatorY;
  for (let z = Math.max(0, Math.floor(level)); z >= 0; z--) {
    const columns = geographic ? 2 ** (z + 1) : 2 ** z;
    const rows = 2 ** z;
    const x = Math.max(0, Math.floor(toX(area.west) * columns));
    const y = Math.max(0, Math.floor(toY(area.north) * rows));
    const right = Math.ceil(toX(area.east) * columns) - 1;
    const bottom = Math.min(rows - 1, Math.ceil(toY(area.south) * rows) - 1);
    const width = right - x + 1,
      height = bottom - y + 1;
    if (width <= MAX_TILE_SIDE && height <= MAX_TILE_SIDE)
      return {
        key: [scheme, z, x, y, width, height].join('/'),
        z,
        x,
        y,
        width,
        height,
        bounds: geographic
          ? [
              (x / columns) * 360 - 180,
              90 - ((y + height) / rows) * 180,
              ((x + width) / columns) * 360 - 180,
              90 - (y / rows) * 180,
            ]
          : [x / columns, y / rows, width / columns, height / rows],
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
 * over `heightPx` CSS pixels. A geographic level 0 tile spans half the
 * globe's width, so its level is one below Web Mercator's.
 */
export function imageryTileLevel({
  height,
  latitude,
  fovy,
  heightPx,
  scheme = 'webMercator',
}) {
  const metresPerPixel =
    (2 * Math.max(1, height) * Math.tan(fovy / 2)) / Math.max(1, heightPx);
  const level = Math.ceil(
    Math.log2((156543.033928 * Math.cos(latitude)) / metresPerPixel),
  );
  return scheme === 'geographic' ? level - 1 : level;
}

/**
 * Tile loads `limit` at a time. A task is { url, controllers, live(),
 * draw(image), fail(error) }; one no longer live is skipped, and an image
 * that arrives for one is closed without drawing. Cancellation holds its
 * admission slot until fetch AND decode settle.
 */
export function createImageryTileQueue({ load, limit = 6 }) {
  let active = 0,
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
    destroy() {
      destroyed = true;
      pending.length = 0;
      for (const c of controllers) c.abort();
    },
  };
}
