// The real FIRMS PNGs in one engine mover atlas.
import { packImageAtlas } from '../../shared/render/imageAtlas.js';

const WHITE = Object.freeze([1, 1, 1, 1]);
const CELL = 60,
  PAD = 2,
  BASE_SIZE = 56;
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
    set = null,
    atlas = null;
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
    const atlas = packImageAtlas(entries, {
      canvas: createCanvas(),
      cell: CELL,
      pad: PAD,
    });
    return { ...atlas, lookup };
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
        depthTest: 'always',
        pickable: true,
        sharpen: true,
        sprite: {
          atlas: { canvas: next.canvas, cells: next.cells },
          sizePx: BASE_SIZE,
        },
      });
      atlas = next;
    }
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
      schedule();
    },
  };
  return {
    collection,
    add(description) {
      if (destroyed) return null;
      if (rows.length >= capacity)
        throw new RangeError('FIRMS sprite capacity exceeded');
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
          schedule();
        },
      };
      rows.push(row);
      schedule();
      return row;
    },
    /** The hand-off fade: every marker at `alpha`, drawn while `show`. */
    setFade(alpha, show) {
      if (destroyed) return;
      const next = alpha >= 1 ? WHITE : Object.freeze([1, 1, 1, alpha]);
      if (next[3] === fade[3] && Boolean(show) === fadeShown) return;
      fade = next;
      fadeShown = Boolean(show);
      schedule();
    },
    setVisible(value) {
      if (destroyed || visible === Boolean(value)) return;
      visible = Boolean(value);
      if (!visible) hide();
      schedule();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      generation++;
      rows = [];
      images.clear();
      loaded.clear();
      set?.destroy();
      set = null;
      atlas = null;
    },
  };
}
