import * as Cesium from 'cesium';
import { msg } from '../i18n/index.js';
import { diffContacts, heatColor, niceCell } from './model.js';

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
  const compareSource = new Cesium.CustomDataSource('replay-compare');
  viewer.dataSources.add(compareSource);
  // The heat map is one image laid over the globe as an imagery layer, so it
  // follows the terrain and is drawn once however many squares it holds.
  let heatLayer = null;
  let heat = null;
  let compare = null;
  let hint = '';
  let busy = 0;

  const redraw = () => {
    viewer.scene.requestRender?.();
    onChange?.();
  };

  /** The part of the globe on screen, in degrees, and how wide it is. */
  function view() {
    const rect = viewer.camera.computeViewRectangle?.();
    if (!rect) return { bbox: null, width: 360 };
    const deg = Cesium.Math.toDegrees;
    const west = deg(rect.west);
    const east = deg(rect.east);
    return {
      bbox: [west, deg(rect.south), east, deg(rect.north)],
      width: east >= west ? east - west : east + 360 - west,
    };
  }

  function removeHeat() {
    if (heatLayer) viewer.imageryLayers.remove(heatLayer, true);
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
      const provider = await Cesium.SingleTileImageryProvider.fromUrl(
        canvas.toDataURL('image/png'),
        {
          rectangle: Cesium.Rectangle.fromDegrees(
            minGx * cell - 180,
            minGy * cell - 90,
            (minGx + w) * cell - 180,
            (minGy + h) * cell - 90,
          ),
        },
      );
      // A newer request may have replaced this one while the image loaded.
      removeHeat();
      heatLayer = viewer.imageryLayers.addImageryProvider(provider);
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
  viewer.camera.moveEnd.addEventListener(onMoveEnd);

  async function contactsAt(ms) {
    const query = new URLSearchParams({
      to: String(Math.floor(ms / 1000)),
      ...getFilters(),
    });
    return (await getJson(`/api/history/at?${query}`)).points;
  }

  async function runCompare(aMs, bMs) {
    compareSource.entities.removeAll();
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
      for (const [kind, list] of [
        ['stayed', stayed],
        ['gone', gone],
        ['appeared', appeared],
      ])
        for (const p of list.slice(0, MAX_DRAWN))
          compareSource.entities.add({
            id: `replay-compare:${kind}:${p.layer}:${p.id}`,
            name: p.id,
            position: Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.alt || 0),
            point: {
              pixelSize: kind === 'stayed' ? 4 : 8,
              color: Cesium.Color.fromCssColorString(
                COMPARE_COLORS[kind],
              ).withAlpha(kind === 'stayed' ? 0.55 : 1),
            },
          });
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
      compareSource.entities.removeAll();
      compare = null;
      hint = '';
      redraw();
    },
    destroy() {
      clearTimeout(settle);
      viewer.camera.moveEnd.removeEventListener(onMoveEnd);
      removeHeat();
      viewer.dataSources.remove(compareSource, true);
    },
  };
}
