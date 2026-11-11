// The FIRMS glow PNGs as one engine.movers sprite set over an atlas of the
// decoded images, the same on every engine. Each glow is drawn at its own
// pixel size (a scale of its side over BASE_SIZE), centred on its anchor,
// over the scene (depth test off), in the sprite order's 'firms' slot.
import { packImageAtlas } from '../../shared/render/imageAtlas.js';
import { SPRITE_LAYER_ORDER } from '../../../data/spriteOrder.js';

const WHITE = Object.freeze([1, 1, 1, 1]);
const CELL = 60,
  PAD = 2,
  BASE_SIZE = 56;
/** The glows' draw order among the sprite layers (data/spriteOrder.js). */
export const FIRMS_SPRITE_ORDER = SPRITE_LAYER_ORDER.indexOf('firms');

const imageFromUrl = (url) =>
  new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      image.onload = image.onerror = null;
      resolve(image);
    };
    image.onerror = () => {
      image.onload = image.onerror = null;
      reject(new Error('FIRMS sprite decode failed'));
    };
    image.src = url;
  });

/**
 * A bank of glow sprites: `collection` is billboard-collection shaped
 * ({ length, get(i), removeAll() }) and each row's `show` is writable, as
 * the layer's horizon cull expects. Writes are drawn on the next microtask,
 * once the images they name are decoded; a show flip rewrites only that
 * instance.
 * @param {import('../../../globe/contract.js').GlobeEngine} engine
 * @param {{ id: string, capacity: number,
 *   loadImage?: (url: string) => Promise<object>,
 *   createCanvas?: () => object }} options `loadImage` and `createCanvas`
 *   are test seams (Node has neither Image nor canvas).
 */
export function createFirmsSpriteBank(
  engine,
  {
    id,
    capacity,
    loadImage = imageFromUrl,
    createCanvas = () => document.createElement('canvas'),
  } = {},
) {
  let rows = [],
    visible = false,
    // The heatmap hand-off: every marker's alpha, and whether any shows.
    fade = WHITE,
    fadeShown = true,
    destroyed = false,
    generation = 0,
    queued = false,
    // Every row is rewritten on the next flush (else only `showDirty`).
    full = true,
    set = null,
    atlas = null;
  const showDirty = new Set();
  const images = new Map();
  const loaded = new Map();
  const getImage = (url) => {
    let task = images.get(url);
    if (!task) {
      task = Promise.resolve()
        .then(() => loadImage(url))
        .then((image) => {
          if (!destroyed) loaded.set(url, image);
          return image;
        })
        .catch((error) => {
          images.delete(url);
          throw error;
        });
      images.set(url, task);
    }
    return task;
  };
  const hide = () => {
    full = true;
    if (set && set.count() !== 0) {
      set.setCount(0);
      set.commit();
    }
  };
  function buildAtlas() {
    const lookup = new Map();
    const entries = [...loaded].map(([url, image], index) => {
      const width = image.naturalWidth ?? image.width,
        height = image.naturalHeight ?? image.height;
      if (!(width > 0 && width <= BASE_SIZE && height === width))
        throw new Error('FIRMS sprite dimensions are invalid');
      const key = String(index);
      lookup.set(url, { key, scale: width / BASE_SIZE });
      return { key, image, width, height };
    });
    const packed = packImageAtlas(entries, {
      canvas: createCanvas(),
      cell: CELL,
      pad: PAD,
    });
    return { ...packed, lookup };
  }
  async function flush() {
    if (destroyed) return;
    if (!visible || !fadeShown || !rows.length) {
      hide();
      return;
    }
    const version = generation,
      snapshot = rows.slice();
    const urls = [...new Set(snapshot.map((row) => row.image))];
    await Promise.all(urls.map(getImage));
    if (destroyed || !visible || version !== generation) return;
    if (!atlas || urls.some((url) => !atlas.lookup.has(url))) {
      const next = buildAtlas();
      set?.destroy();
      set = engine.movers.createSet({
        id,
        kind: 'sprite',
        capacity,
        order: FIRMS_SPRITE_ORDER,
        depthTest: 'always',
        pickable: true,
        sharpen: true,
        sprite: {
          atlas: { canvas: next.canvas, cells: next.cells },
          sizePx: BASE_SIZE,
        },
      });
      atlas = next;
      full = true;
    }
    if (full || set.count() !== snapshot.length) {
      snapshot.forEach((row, index) => {
        const cell = atlas.lookup.get(row.image);
        set.set(index, {
          position: row.position,
          cell: cell.key,
          scale: cell.scale,
          color: fade,
          show: row.show,
          pickId: row.id,
        });
      });
      set.setCount(snapshot.length);
    } else
      for (const index of showDirty)
        if (index < snapshot.length)
          set.set(index, { show: snapshot[index].show });
    full = false;
    showDirty.clear();
    set.commit();
  }
  function schedule() {
    generation++;
    if (queued || destroyed) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      const version = generation;
      void flush().catch(() => {
        if (!destroyed && visible && version === generation)
          console.error('FIRMS sprite atlas failed');
      });
    });
  }
  const collection = {
    get length() {
      return rows.length;
    },
    get(index) {
      return rows[index];
    },
    removeAll() {
      if (destroyed) return;
      rows = [];
      full = true;
      schedule();
    },
  };
  return {
    collection,
    add(description) {
      if (destroyed) return null;
      if (rows.length >= capacity)
        throw new RangeError('FIRMS sprite capacity exceeded');
      const index = rows.length;
      let show = description.show !== false;
      const row = {
        ...description,
        get show() {
          return show;
        },
        set show(value) {
          const next = Boolean(value);
          if (next === show || destroyed) return;
          show = next;
          showDirty.add(index);
          schedule();
        },
      };
      rows.push(row);
      full = true;
      schedule();
      return row;
    },
    /** Whether a pick id names one of the bank's rows. */
    owns(pickId) {
      for (const row of rows) if (row.id === pickId) return true;
      return false;
    },
    /** The hand-off fade: every marker at `alpha`, drawn while `show`. */
    setFade(alpha, show) {
      if (destroyed) return;
      const next = alpha >= 1 ? WHITE : Object.freeze([1, 1, 1, alpha]);
      if (next[3] === fade[3] && Boolean(show) === fadeShown) return;
      fade = next;
      fadeShown = Boolean(show);
      full = true;
      schedule();
    },
    setVisible(value) {
      if (destroyed || visible === Boolean(value)) return;
      visible = Boolean(value);
      if (!visible) hide();
      schedule();
    },
    /** The mover set drawing the glows (null before the first flush). */
    get set() {
      return set;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      generation++;
      rows = [];
      showDirty.clear();
      images.clear();
      loaded.clear();
      set?.destroy();
      set = null;
      atlas = null;
    },
  };
}
