import { msg } from '../i18n/index.js';
import { cameraOf, drawOf, findGlobe } from '../render/rendererOf.js';
import { diffContacts, heatColor, niceCell } from './model.js';
import { withAlpha } from './overlays.js';
import { lonLatOf } from './sampling.js';

const MAX_CANVAS = 2048;
const MAX_DRAWN = 2000;
const COMPARE_COLORS = {
  appeared: '#4dff9a',
  gone: '#ff5c5c',
  stayed: '#9fb6c3',
};

/**
 * Two read-only views of the recording drawn on the globe: a heat map of where
 * contacts were densest in a period, and a comparison of who was present at
 * two moments. Neither moves the replay clock. `getJson` fetches a history
 * route; `getWindow` returns { fromSec, toSec } for the period; `getFilters`
 * returns { layers, bbox } as query text.
 */
export function createAnalysis({
  viewer,
  getJson,
  getWindow,
  getFilters,
  onChange,
}) {
  const compareSet = drawOf(viewer).points({
    id: 'replay-compare',
    pickable: false,
  });
  const camera = cameraOf(viewer);
  // The heat map is one image laid over the globe as an imagery layer, so it
  // follows the terrain and is drawn once however many squares it holds.
  let heatLayer = null;
  let heat = null;
  let compare = null;
  let hint = '';
  let busy = 0;

  const redraw = () => {
    onChange?.();
  };

  /** The part of the globe on screen, in degrees, and how wide it is. */
  function view() {
    const rect = camera.viewRectangle();
    if (!rect) return { bbox: null, width: 360 };
    const { west, east } = rect;
    return {
      bbox: [west, rect.south, east, rect.north],
      width: east >= west ? east - west : east + 360 - west,
    };
  }

  function removeHeat() {
    heatLayer?.remove();
    heatLayer = null;
  }

  async function showHeat(on) {
    removeHeat();
    heat = null;
    hint = '';
    if (!on) return redraw();
    const window = getWindow();
    if (!window) {
      hint = msg('No recording');
      return redraw();
    }
    busy += 1;
    try {
      const { bbox, width } = view();
      const cell = niceCell(width);
      const query = new URLSearchParams({
        from: String(Math.floor(window.fromSec)),
        to: String(Math.floor(window.toSec)),
        cell: String(cell),
        ...getFilters(),
      });
      if (bbox && !query.has('bbox')) query.set('bbox', bbox.join(','));
      const { cells, max } = await getJson(`/api/history/density?${query}`);
      if (!cells.length) {
        hint = msg('Nothing recorded in this period');
        return;
      }
      const gxs = cells.map((c) => c.gx);
      const gys = cells.map((c) => c.gy);
      const minGx = Math.min(...gxs);
      const minGy = Math.min(...gys);
      const w = Math.min(MAX_CANVAS, Math.max(...gxs) - minGx + 1);
      const h = Math.min(MAX_CANVAS, Math.max(...gys) - minGy + 1);
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const context = canvas.getContext('2d');
      const image = context.createImageData(w, h);
      for (const c of cells) {
        const x = c.gx - minGx;
        const y = h - 1 - (c.gy - minGy);
        if (x >= w || y < 0) continue;
        image.data.set(heatColor(c.n, max), (y * w + x) * 4);
      }
      context.putImageData(image, 0, 0);
      // A newer request may have replaced this one while the data loaded.
      removeHeat();
      heatLayer = findGlobe(viewer).imagery.add({
        kind: 'single-image',
        url: canvas.toDataURL('image/png'),
        rectangle: {
          west: minGx * cell - 180,
          south: minGy * cell - 90,
          east: (minGx + w) * cell - 180,
          north: (minGy + h) * cell - 90,
        },
      });
      heat = { max, cell, squares: cells.length };
    } catch {
      hint = msg('Heat map failed');
    } finally {
      busy -= 1;
      redraw();
    }
  }

  // The squares are sized for the view they were drawn for, so when the camera
  // stops somewhere new the heat map is drawn again for it.
  let settle = null;
  const onMoveEnd = () => {
    if (!heat) return;
    clearTimeout(settle);
    settle = setTimeout(() => showHeat(true), 600);
  };
  const offMoveEnd = camera.on('moveEnd', onMoveEnd);

  async function contactsAt(ms) {
    const query = new URLSearchParams({
      to: String(Math.floor(ms / 1000)),
      ...getFilters(),
    });
    return (await getJson(`/api/history/at?${query}`)).points;
  }

  async function runCompare(aMs, bMs) {
    compareSet.clear();
    compare = null;
    hint = '';
    if (!Number.isFinite(aMs) || !Number.isFinite(bMs)) {
      hint = msg('Pick two times first');
      return redraw();
    }
    busy += 1;
    try {
      const [before, after] = await Promise.all([
        contactsAt(aMs),
        contactsAt(bMs),
      ]);
      const { appeared, gone, stayed } = diffContacts(before, after);
      if (!before.length && !after.length)
        hint = msg('Nothing recorded near those times');
      const items = [];
      for (const [kind, list] of [
        ['stayed', stayed],
        ['gone', gone],
        ['appeared', appeared],
      ])
        for (const p of list.slice(0, MAX_DRAWN))
          items.push({
            id: `replay-compare:${kind}:${p.layer}:${p.id}`,
            pos: lonLatOf(p),
            pixelSize: kind === 'stayed' ? 4 : 8,
            color: withAlpha(
              COMPARE_COLORS[kind],
              kind === 'stayed' ? 0.55 : 1,
            ),
            meta: { name: p.id },
          });
      compareSet.set(items);
      compare = {
        appeared: appeared.length,
        gone: gone.length,
        stayed: stayed.length,
      };
    } catch {
      hint = msg('Comparison failed');
    } finally {
      busy -= 1;
      redraw();
    }
  }

  return {
    state: () => ({ heat, compare, hint, busy: busy > 0 }),
    showHeat,
    /** Redraws the heat map for the current period, if it is on. */
    refreshHeat: () => (heat ? showHeat(true) : undefined),
    compare: runCompare,
    clearCompare() {
      compareSet.clear();
      compare = null;
      hint = '';
      redraw();
    },
    destroy() {
      clearTimeout(settle);
      offMoveEnd();
      removeHeat();
      compareSet.dispose();
    },
  };
}
