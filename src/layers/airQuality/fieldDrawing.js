// The model field drawn through the renderer's ports: globe imagery on the
// globe, the draw port's raster shell over photorealistic 3D tiles.
import {
  rendererOf,
  findDraw,
  findFrame,
  findGlobe,
} from '../../render/rendererOf.js';
import { WEATHER_IMAGERY_Z } from '../weather/imageryOrder.js';
import {
  followShellLift,
  WEATHER_SHELL_HEIGHTS,
} from '../weather/shellPlacement.js';
import { FIELD_FADE } from './field.js';

/** The global image's and the Europe inset's slots, under wind's. */
const SLOTS = Object.freeze({
  global: 'air-quality',
  europe: 'air-quality-inset',
});
/** New globe images replace the old ones once drawn, or after this long. */
const SWAP_AFTER_MS = 1500;
const CACHE_SIZE = 8;

let shells = 0;
let paints = 0;

const pageCanvas = () => globalThis.document?.createElement?.('canvas');

/** One painted image on a canvas, or null if the source canvas lacks a 2D context. */
function canvasFor({ width, height, rgba }, limit, canvas = pageCanvas()) {
  const context = canvas?.getContext?.('2d');
  if (!context) return null;
  canvas.width = width;
  canvas.height = height;
  const pixels = context.createImageData(width, height);
  pixels.data.set(rgba);
  context.putImageData(pixels, 0, 0);
  if (limit > 0 && Math.max(width, height) > limit) {
    const ratio = limit / Math.max(width, height);
    const small = globalThis.document.createElement('canvas');
    small.width = Math.max(1, Math.floor(width * ratio));
    small.height = Math.max(1, Math.floor(height * ratio));
    small.getContext('2d')?.drawImage(canvas, 0, 0, small.width, small.height);
    return small;
  }
  return canvas;
}

/**
 * The colour field on whichever surface the map shows, as wind's colour
 * field is: one `single-image` imagery layer per image on the globe, or over
 * 3D tiles a raised shell per image that rises with the camera, each in the
 * air-quality slot under wind (the Europe inset over the global field).
 *
 * A new step never blinks and never doubles: shells take the new image in
 * place (the port keeps drawing the old one until the new one can be drawn
 * whole), and on the globe the new images are added clear, load under the
 * old ones, and take their place in one frame once the globe's imagery has
 * settled (or after `SWAP_AFTER_MS`). `setStrength` scales every shown
 * image's opacity (the fade by camera height); 0 hides them. The last eight
 * sets of canvases are kept by key.
 * @param {{getViewer: () => object | null, getHost: () => {collection: object | null, kind: string}}} options
 */
export function createFieldDrawing({ getViewer, getHost }) {
  /** What is drawn: `{ name, imagery }` on the globe, `{ name, field, offLift }` as shells. */
  let entries = [];
  let drawnOn = null;
  let pending = null;
  let shownKey = null;
  let strength = FIELD_FADE.maxAlpha;
  const cache = new Map();
  /** New globe images, clear while they load under the ones shown. */
  let incoming = [];
  let swapTimer = null;
  let offSwap = null;

  const applyStrength = (entry) => {
    const show = strength > 0;
    if (entry.imagery) {
      entry.imagery.alpha = strength;
      entry.imagery.show = show;
      return;
    }
    entry.field.update({ alpha: strength });
    entry.field.show = show;
  };
  const dropEntry = (entry) => {
    entry.offLift?.();
    entry.field?.dispose();
    entry.imagery?.remove();
  };
  const stopSwap = () => {
    clearTimeout(swapTimer);
    swapTimer = null;
    offSwap?.();
    offSwap = null;
  };
  /** The loaded new globe images take the old ones' place, in one frame. */
  const swap = () => {
    stopSwap();
    if (!incoming.length) return;
    for (const entry of entries) dropEntry(entry);
    entries = incoming;
    incoming = [];
    for (const entry of entries) applyStrength(entry);
  };
  /** Swap once the globe's imagery has settled with the new images in it. */
  const swapLater = (viewer) => {
    const globe = findGlobe(viewer);
    const frame = findFrame(viewer);
    if (typeof globe?.isSettled !== 'function' || !frame?.on) {
      swap();
      return;
    }
    stopSwap();
    swapTimer = setTimeout(swap, SWAP_AFTER_MS);
    offSwap = frame.on('postRender', () => {
      if (globe.isSettled('imagery')) swap();
    });
    frame.requestRender?.('air-quality');
  };
  const remove = () => {
    pending = null;
    stopSwap();
    for (const entry of incoming.splice(0)) dropEntry(entry);
    for (const entry of entries.splice(0)) dropEntry(entry);
    drawnOn = null;
    shownKey = null;
  };
  /** One globe image; `staged`, clear until it takes an old one's place. */
  const addImagery = (host, { name, canvas, rectangle }, staged = false) => {
    const imagery = host.collection.add({
      kind: 'single-image',
      image: canvas,
      rectangle,
      zOrder: WEATHER_IMAGERY_Z[SLOTS[name]],
    });
    imagery.drapeOn = 'surface';
    const entry = { name, imagery };
    if (staged) {
      // Shown but clear: the renderer loads it without drawing it.
      imagery.alpha = 0;
      imagery.show = true;
    } else applyStrength(entry);
    return entry;
  };
  const addShell = (viewer, draw, { name, canvas, rectangle, key }) => {
    const seq = (shells += 1);
    const field = draw.field({
      kind: 'rasterShell',
      id: `air-quality-shell:${name}:${seq}`,
      image: { canvas, key },
      rectangle,
      heightM: WEATHER_SHELL_HEIGHTS[SLOTS[name]],
      alpha: strength,
    });
    const offLift = followShellLift(viewer, (liftM) => field.update({ liftM }));
    const entry = { name, field, offLift };
    applyStrength(entry);
    return entry;
  };
  const paintedFor = (key, paint, viewer) => {
    const cached = cache.get(key);
    if (cached) {
      cache.delete(key);
      cache.set(key, cached);
      return cached;
    }
    const first = pageCanvas();
    if (!first?.getContext?.('2d')) return null;
    const limit = rendererOf(viewer)?.quality?.device?.()?.maxTextureSize ?? 0;
    const version = (paints += 1);
    const images = paint().map(({ name, rectangle, ...pixels }, i) => ({
      name,
      rectangle,
      canvas: canvasFor(pixels, limit, i === 0 ? first : undefined),
      key: `air-quality-field:${name}:${version}`,
    }));
    if (images.some(({ canvas }) => !canvas)) return null;
    cache.set(key, images);
    if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
    return images;
  };
  const forget = () => cache.clear();
  const drawing = {
    remove,
    forget,
    visible: () => strength > 0,
    prepare(key, paint) {
      const viewer = getViewer();
      if (!strength || !viewer || !globalThis.document?.createElement)
        return false;
      return paintedFor(key, paint, viewer) !== null;
    },
    /**
     * Draw the images `paint()` returns, known by `key`: the same key on the
     * same host keeps what is drawn, without painting again.
     * @returns {boolean} Whether the field is drawn.
     */
    show(key, paint) {
      const viewer = getViewer();
      const host = getHost();
      const hostKey = `${key}|${host?.kind}`;
      if (hostKey === shownKey) return true;
      const draw = host?.kind === 'tileset' ? findDraw(viewer) : null;
      if (
        !viewer ||
        !host ||
        host.kind === 'none' ||
        (host.kind === 'tileset' ? !draw?.field : !host.collection?.add)
      ) {
        remove();
        return false;
      }
      if (strength === 0) {
        // Invisible: nothing is painted or encoded. What is drawn (hidden)
        // goes, and this key is painted once the field shows again.
        remove();
        pending = { key, paint };
        return true;
      }
      pending = null;
      const images = paintedFor(key, paint, viewer);
      if (!images) {
        remove();
        return false;
      }
      if (host.kind === 'tileset') {
        if (drawnOn !== 'tileset') remove();
        // A shell already drawn takes its new image in place.
        const next = images.map((image) => {
          const entry = entries.find(({ name }) => name === image.name);
          if (!entry) return addShell(viewer, draw, image);
          entry.field.update({
            image: { canvas: image.canvas, key: image.key },
            rectangle: image.rectangle,
          });
          return entry;
        });
        for (const entry of entries)
          if (!next.includes(entry)) dropEntry(entry);
        entries = next;
      } else if (drawnOn === 'globe' && entries.length) {
        // A newer step than one still loading replaces that one.
        stopSwap();
        for (const entry of incoming.splice(0)) dropEntry(entry);
        incoming = images.map((image) => addImagery(host, image, true));
        swapLater(viewer);
      } else {
        remove();
        entries = images.map((image) => addImagery(host, image));
      }
      drawnOn = host.kind;
      shownKey = hostKey;
      return true;
    },
    /** Every image's share of its own opacity (0 hides them). */
    setStrength(value) {
      if (value === strength) return;
      strength = value;
      for (const entry of entries) applyStrength(entry);
      if (value > 0 && pending) {
        const { key, paint } = pending;
        pending = null;
        if (drawing.show(key, paint))
          findFrame(getViewer())?.requestRender?.('air-quality');
      }
    },
    /** Let go of what is drawn and of the painted images. */
    dispose() {
      remove();
      forget();
    },
  };
  return drawing;
}
