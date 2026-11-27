/**
 * @module ui/cardMap
 * @description Draws a close-up or pinned map on one canvas. The shared
 * OpenFreeMap source fetches and caches the vector tiles for a location
 * and zoom. The painter draws each tile as it loads using cardMapStyle.js,
 * then adds names across the map. When the location, size or language
 * changes, the finished map stays visible while the next one is drawn.
 */
import { readonly, ref } from 'vue';
import { tileToBBox } from '../data/tomtomTiles.js';
import { createCardMapSource } from '../sources/openFreeMapCardMap.js';
import {
  cardMapColours,
  CARD_MAP_LABELS,
  CARD_MAP_SOURCE_MAXZOOM,
  cardMapStyle,
} from './cardMapStyle.js';
import { collectLabels, placeLabels } from './cardMapLabels.js';
import { tileBlock } from './mapTiles.js';
import { getLocale } from '../i18n/index.js';

const TILE = 256;

/** Device pixels per CSS pixel the map is painted at: 1, or 2 on a dense screen. */
export const cardMapScale = () =>
  (globalThis.devicePixelRatio || 1) >= 1.5 ? 2 : 1;

let source = null;
/** The one tile source every card map shares, made on first use. */
export const cardMapSource = () => (source ??= createCardMapSource());
/**
 * Use `next` as the card maps' tile source (a test's); returns a function
 * that puts the previous one back.
 */
export function setCardMapSource(next) {
  const previous = source;
  source = next;
  return () => {
    source = previous;
  };
}

const THEME_KEY = 'gev.cardMapTheme';

function savedTone() {
  try {
    return globalThis.localStorage?.getItem(THEME_KEY) === 'toner'
      ? 'toner'
      : 'dark';
  } catch {
    return 'dark';
  }
}

const selectedTheme = ref(savedTone());
export const cardMapTheme = readonly(selectedTheme);

export function toggleCardMapTheme() {
  selectedTheme.value = selectedTheme.value === 'dark' ? 'toner' : 'dark';
  try {
    globalThis.localStorage?.setItem(THEME_KEY, selectedTheme.value);
  } catch {
    // The live maps still share the choice without storage.
  }
}

/** Paint a single child tile, clipped by the scratch canvas edges. */
function paintCardTile(canvas, data, tile, depth, style) {
  const ctx = canvas.getContext('2d');
  const size = canvas.width;
  const span = 2 ** depth;
  const factor = (span * size) / data.extent;
  const left = (tile.x % span) * size;
  const top = (tile.y % span) * size;
  ctx.fillStyle = style.land;
  ctx.fillRect(0, 0, size, size);
  for (const layer of style.layers) {
    const features = data.layers[layer.source];
    if (!features || layer.width === 0) continue;
    ctx.save();
    ctx.lineCap = layer.round ? 'round' : 'butt';
    ctx.lineJoin = layer.round ? 'round' : 'miter';
    if (layer.type === 2) {
      ctx.strokeStyle = layer.color;
      ctx.lineWidth = layer.width;
      if (layer.dashed) ctx.setLineDash([3 * layer.width, 2 * layer.width]);
    } else {
      ctx.fillStyle = layer.color;
      if (layer.outline) ctx.strokeStyle = layer.outline;
    }
    for (const feature of features) {
      if (
        feature.type !== layer.type ||
        (layer.classes && !layer.classes.includes(feature.properties.class))
      )
        continue;
      if (layer.fadeTunnel)
        ctx.globalAlpha = feature.properties.brunnel === 'tunnel' ? 0.35 : 1;
      ctx.beginPath();
      for (const part of feature.parts) {
        ctx.moveTo(part[0] * factor - left, part[1] * factor - top);
        for (let i = 2; i < part.length; i += 2)
          ctx.lineTo(part[i] * factor - left, part[i + 1] * factor - top);
        if (layer.type === 3) ctx.closePath();
      }
      if (layer.type === 3) ctx.fill('evenodd');
      if (layer.type === 2 || layer.outline) ctx.stroke();
    }
    ctx.restore();
  }
}

/**
 * Where a card map's tiles sit round its spot, in CSS pixels from the spot.
 * Without a `frame`, the 3 by 3 block of tiles the spot is in the middle of;
 * with one, the tiles a frame that size centred on the spot shows. The canvas
 * covers `left`, `top`, `width` and `height`.
 * @param {number} lat
 * @param {number} lon
 * @param {number} zoom
 * @param {{width: number, height: number}|null} [frame]
 */
export function cardMapLayout(lat, lon, zoom, frame = null) {
  const block = tileBlock(lat, lon, zoom).map((tile) => {
    const [, x, y] = tile.key.split('/').map(Number);
    return { key: tile.key, z: zoom, x, y, left: tile.left, top: tile.top };
  });
  if (!block.length) return { tiles: [], left: 0, top: 0, width: 0, height: 0 };
  if (frame) {
    const left = -Math.round(frame.width / 2);
    const top = -Math.round(frame.height / 2);
    const tiles = block.filter(
      (t) =>
        t.left < left + frame.width &&
        t.left + TILE > left &&
        t.top < top + frame.height &&
        t.top + TILE > top,
    );
    return { tiles, left, top, width: frame.width, height: frame.height };
  }
  const left = Math.min(...block.map((t) => t.left));
  const top = Math.min(...block.map((t) => t.top));
  return {
    tiles: block,
    left,
    top,
    width: Math.max(...block.map((t) => t.left)) + TILE - left,
    height: Math.max(...block.map((t) => t.top)) + TILE - top,
  };
}

const isAbort = (error) => error?.name === 'AbortError';

/**
 * Draw a card map on `canvas`: the dark land at once, then each tile as
 * it loads, then the names over the whole map (cardMapLabels.js). `onState`
 * hears `loading`, then `ready` (some tiles or all drawn) or `failed` (none
 * could be read: the plain land stays).
 * @param {HTMLCanvasElement} canvas
 * @param {{lat: number, lon: number, zoom: number,
 *   frame?: {width: number, height: number}|null,
 *   view?: {left: number, top: number, width: number, height: number}|null,
 *   clearBottom?: number, locale?: string, theme?: 'dark'|'toner',
 *   onState?: (state: 'loading'|'ready'|'failed') => void}} options
 *   `view`: what shows of the map, in CSS pixels from the spot (the whole
 *   canvas unless given); names lie wholly inside it, clear of the marker on
 *   the spot and of a strip `clearBottom` high at its foot. `locale`: the
 *   language names are read in (the app's).
 * @returns {{done: Promise<void>, destroy: () => void}} `destroy` stops
 *   every request and frees the working canvas; the drawn canvas is the
 *   caller's.
 */
// Canvases that show a finished map, kept until a redraw is copied over.
const finished = new WeakSet();

export function drawCardMap(
  canvas,
  {
    lat,
    lon,
    zoom,
    frame = null,
    view = null,
    clearBottom = 0,
    locale = getLocale(),
    theme = 'dark',
    onState = () => {},
    onFrame = () => {},
  },
) {
  const controller = new AbortController();
  const { signal } = controller;
  let scratch = null;
  // A canvas that already shows a finished map keeps it until the redraw is
  // done: the redraw is painted aside and copied over in one step.
  let back = null;
  const plain = new Map();
  const free = () => {
    plain.clear();
    if (scratch) scratch.width = scratch.height = 0;
    scratch = null;
    if (back) back.width = back.height = 0;
    back = null;
  };
  const destroy = () => {
    controller.abort();
    free();
  };
  const layout = cardMapLayout(lat, lon, zoom, frame);
  const scale = cardMapScale();
  const shown = layout.tiles.length ? canvas?.getContext?.('2d') : null;
  if (!shown) {
    onState('failed');
    return { done: Promise.resolve(), destroy };
  }
  if (finished.has(canvas) && canvas.width > 0)
    back = canvas.ownerDocument.createElement('canvas');
  const target = back ?? canvas;
  const ctx = back ? back.getContext('2d') : shown;
  target.width = layout.width * scale;
  target.height = layout.height * scale;
  // Painted straight onto the canvas, this drawing's frame shows from now.
  if (!back) onFrame();
  const colours = cardMapColours(theme);
  ctx.fillStyle = colours.land;
  ctx.fillRect(0, 0, target.width, target.height);
  onState('loading');

  // Past the source's deepest zoom, each tile is drawn from the one over it.
  const zs = Math.min(zoom, CARD_MAP_SOURCE_MAXZOOM);
  const d = zoom - zs;
  const parentKey = (t) => `${zs}/${t.x >> d}/${t.y >> d}`;
  const parents = [
    ...new Map(
      layout.tiles.map((t) => [
        parentKey(t),
        { z: zs, x: t.x >> d, y: t.y >> d },
      ]),
    ).values(),
  ];
  const size = TILE * scale;
  const style = cardMapStyle({ theme, scale, zoom });
  let drawn = 0;
  const paint = (value, tile) => {
    if (signal.aborted) return;
    scratch ??= canvas.ownerDocument.createElement('canvas');
    if (scratch.width !== size || scratch.height !== size)
      scratch.width = scratch.height = size;
    paintCardTile(scratch, value, tile, d, style);
    ctx.drawImage(
      scratch,
      (tile.left - layout.left) * scale,
      (tile.top - layout.top) * scale,
    );
    drawn++;
  };
  const done = (async () => {
    try {
      signal.throwIfAborted();
      const result = await cardMapSource().fetchBounds(
        tileToBBox(parents[0].z, parents[0].x, parents[0].y),
        {
          zoom: zs,
          tiles: parents,
          signal,
          onTile: (value, parent) => {
            const key = `${parent.z}/${parent.x}/${parent.y}`;
            plain.set(key, value);
            for (const tile of layout.tiles)
              if (parentKey(tile) === key) paint(value, tile);
          },
        },
      );
      if (signal.aborted) return;
      if (!drawn || result?.partial) {
        // A missed tile leaves a finished frame in place until a later retry.
        onState('failed');
        return;
      }
      drawLabels(ctx, {
        layout,
        plain,
        d,
        scale,
        view,
        clearBottom,
        locale,
        colours,
      });
      if (back) {
        canvas.width = back.width;
        canvas.height = back.height;
        shown.drawImage(back, 0, 0);
        onFrame();
      }
      finished.add(canvas);
      onState('ready');
    } catch (error) {
      if (!signal.aborted && !isAbort(error)) onState('failed');
    } finally {
      free();
    }
  })();
  return { done, destroy };
}

/**
 * The names over a drawn map: each kept tile's grid placed on the map from
 * a tile drawn from it, then the names placed inside what shows.
 */
function drawLabels(
  ctx,
  { layout, plain, d, scale, view, clearBottom, locale, colours },
) {
  const span = TILE * 2 ** d;
  const tiles = [];
  for (const [key, kept] of plain) {
    const [, px, py] = key.split('/').map(Number);
    const child = layout.tiles.find((t) => t.x >> d === px && t.y >> d === py);
    if (!child) continue;
    const ox = child.left - layout.left - (child.x - (px << d)) * TILE;
    const oy = child.top - layout.top - (child.y - (py << d)) * TILE;
    const k = span / kept.extent;
    tiles.push({ kept, at: (x, y) => [ox + x * k, oy + y * k] });
  }
  // In map pixels: the spot is at (-left, -top).
  const sx = -layout.left;
  const sy = -layout.top;
  const shown = view || {
    left: layout.left,
    top: layout.top,
    width: layout.width,
    height: layout.height,
  };
  const left = Math.max(0, shown.left + sx);
  const top = Math.max(0, shown.top + sy);
  const right = Math.min(layout.width, shown.left + shown.width + sx);
  const bottom = Math.min(layout.height, shown.top + shown.height + sy);
  const m = CARD_MAP_LABELS.marker;
  placeLabels(ctx, collectLabels(tiles, { locale }), {
    bounds: [left, top, right, bottom],
    clear: [
      [sx - m, sy - m, sx + m, sy + m],
      ...(clearBottom > 0 ? [[left, bottom - clearBottom, right, bottom]] : []),
    ],
    scale,
    colours,
  });
}
