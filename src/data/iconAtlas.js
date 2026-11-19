/**
 * @module iconAtlas
 * @description The images icon sets draw, packed into one canvas. A layer asks for a
 * slot by image URL and raster size and gets a number at once; the image loads and is
 * packed later, and until then its slot is empty and rows using it draw nothing (as a
 * Cesium billboard waits for its image).
 *
 * The renderer uploads {@link iconAtlas}.canvas whenever `version` changes and reads
 * each slot's texture rectangle from `rects`.
 */

/**
 * Drawn width in device pixels (the drawing buffer's) past which an icon
 * row with no switch of its own draws its near image: the aircraft layers'
 * switch.
 */
export const NEAR_IMAGE_DEVICE_PX = 76;

/**
 * `NEAR_IMAGE_DEVICE_PX` in CSS pixels, for an icon item's
 * `imageLod.switchPx`, which the draw contract measures in CSS pixels: the
 * device switch divided by the drawing buffer's pixels per CSS pixel. That
 * is the scene's pixel ratio, which the quality port's frame signals report
 * as `pixelRatio`: on the default renderer its `pixelRatio` setting, or 1
 * while that is 0 (browser recommended). `devicePixelRatio` does not enter
 * it. A layer drawing through the port passes the ratio its frames report
 * and rewrites its rows' switch when that changes.
 * @param {number} [pixelRatio] Drawing-buffer pixels per CSS pixel (1).
 */
export function nearImageSwitchPx(pixelRatio = 1) {
  const ratio = Number.isFinite(pixelRatio) && pixelRatio > 0 ? pixelRatio : 1;
  return NEAR_IMAGE_DEVICE_PX / ratio;
}

/**
 * Slots the atlas holds. A renderer addresses each through one vec4
 * uniform, as many as its context has room for (`addressableIconSlots`):
 * every WebGL 2 context has room for all of them.
 */
export const MAX_ICON_SLOTS = 176;
/** Slots the renderer addresses, however few uniforms its context has. */
export const MIN_ICON_SLOTS = 64;
/**
 * Vertex uniform vectors the icon shader keeps for everything else: its own
 * and the renderer's (about 34), with room for drivers that keep constants
 * in uniforms.
 */
const OTHER_VERTEX_UNIFORMS = 80;

/**
 * How many slots a context with `maxVertexUniformVectors` addresses: all of
 * them on WebGL 2 (at least 256 vectors), at least `MIN_ICON_SLOTS`.
 * @param {number} maxVertexUniformVectors
 */
export function addressableIconSlots(maxVertexUniformVectors) {
  const room = Math.floor(maxVertexUniformVectors) - OTHER_VERTEX_UNIFORMS;
  return Math.max(
    MIN_ICON_SLOTS,
    Math.min(MAX_ICON_SLOTS, Number.isFinite(room) ? room : 0),
  );
}

const PADDING_PX = 2;
const START_SIZE_PX = 1024;
const MAX_SIZE_PX = 4096;

function createAtlas() {
  const slotOfKey = new Map();
  const entries = [];
  const listeners = new Set();
  const atlas = {
    /** Bumped whenever the canvas or a slot rectangle changes. */
    version: 0,
    canvas: null,
    width: 0,
    height: 0,
    /** Per slot `[u0, v0, u1, v1]`, zero until the image is packed. */
    rects: new Float32Array(MAX_ICON_SLOTS * 4),
    get size() {
      return entries.length;
    },

    /**
     * The slot for `url` rasterised at `sizePx` square. Given a `source` (a
     * canvas, or anything else `drawImage` takes), `url` is only its key:
     * the source is packed at once, as it is now, and never loaded.
     * @param {string} url
     * @param {number} sizePx
     * @param {CanvasImageSource} [source]
     * @returns {number}
     */
    slot(url, sizePx, source) {
      const key = `${sizePx}|${url}`;
      const known = slotOfKey.get(key);
      if (known !== undefined) return known;
      if (entries.length >= MAX_ICON_SLOTS)
        throw new RangeError(
          `The icon atlas holds at most ${MAX_ICON_SLOTS} images`,
        );
      const slot = entries.length;
      const entry = { url, sizePx, image: null, x: 0, y: 0 };
      entries.push(entry);
      slotOfKey.set(key, slot);
      if (source) placeLoaded(entry, source);
      else load(entry);
      return slot;
    },

    /** Whether `url` at `sizePx` already has a slot. */
    has(url, sizePx) {
      return slotOfKey.has(`${sizePx}|${url}`);
    },

    /** Whether a slot's image is packed and drawable. */
    ready(slot) {
      return atlas.rects[slot * 4 + 2] > 0;
    },

    /** Whether a slot's image failed to load, or had no room to pack. */
    failed(slot) {
      return entries[slot]?.failed === true;
    },

    /**
     * Call `listener` after every repack, so the renderer, drawing on demand,
     * can ask for the frame that shows a newly loaded image.
     * @param {() => void} listener
     * @returns {() => void} Stops listening.
     */
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  /** Pack an entry's loaded image, or leave its slot empty when it does not fit. */
  function placeLoaded(entry, image) {
    entry.image = image;
    // Node: nothing to pack into.
    if (
      typeof document === 'undefined' &&
      typeof OffscreenCanvas === 'undefined'
    )
      return;
    if (!pack()) {
      entry.image = null; // does not fit: leave its slot empty, keep the rest
      entry.failed = true;
      console.warn(
        `[iconAtlas] No room for ${entry.sizePx} px icon; slot stays empty`,
      );
      pack();
    }
  }

  function load(entry) {
    if (typeof Image === 'undefined') return; // Node: slots only
    const image = new Image(entry.sizePx, entry.sizePx);
    image.decoding = 'async';
    // A cross-origin image would taint the canvas and every texture upload.
    image.crossOrigin = 'anonymous';
    image.onload = () => placeLoaded(entry, image);
    image.onerror = () => {
      entry.failed = true;
      console.warn(
        `[iconAtlas] Icon failed to load: ${entry.url.slice(0, 80)}`,
      );
    };
    image.src = entry.url;
  }

  // Shelf packing over every loaded image, largest first, growing the canvas
  // until they fit. Rebuilt in full: the set is a few dozen images. Returns false,
  // changing nothing, when they cannot fit at the largest size.
  function pack() {
    const loaded = entries.filter((entry) => entry.image);
    loaded.sort((a, b) => b.sizePx - a.sizePx);
    let size = Math.max(atlas.width, START_SIZE_PX);
    while (!place(loaded, size)) {
      size *= 2;
      if (size > MAX_SIZE_PX) return false;
    }
    if (!atlas.canvas || atlas.width !== size) {
      atlas.canvas =
        typeof document !== 'undefined'
          ? Object.assign(document.createElement('canvas'), {
              width: size,
              height: size,
            })
          : new OffscreenCanvas(size, size);
      atlas.width = size;
      atlas.height = size;
    }
    const g = atlas.canvas.getContext('2d');
    g.clearRect(0, 0, size, size);
    atlas.rects.fill(0);
    for (const entry of loaded) {
      g.drawImage(entry.image, entry.x, entry.y, entry.sizePx, entry.sizePx);
      const slot = entries.indexOf(entry);
      const o = slot * 4;
      atlas.rects[o] = entry.x / size;
      atlas.rects[o + 1] = entry.y / size;
      atlas.rects[o + 2] = (entry.x + entry.sizePx) / size;
      atlas.rects[o + 3] = (entry.y + entry.sizePx) / size;
    }
    atlas.version++;
    for (const listener of listeners) listener();
    return true;
  }

  function place(loaded, size) {
    let x = 0;
    let y = 0;
    let shelf = 0;
    for (const entry of loaded) {
      const cell = entry.sizePx + PADDING_PX * 2;
      if (x + cell > size) {
        x = 0;
        y += shelf;
        shelf = 0;
      }
      if (y + cell > size) return false;
      entry.x = x + PADDING_PX;
      entry.y = y + PADDING_PX;
      x += cell;
      shelf = Math.max(shelf, cell);
    }
    return true;
  }

  return atlas;
}

/** The one atlas every icon set draws from. */
export const iconAtlas = createAtlas();
