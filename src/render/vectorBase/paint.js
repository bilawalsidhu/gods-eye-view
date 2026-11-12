/**
 * @module render/vectorBase/paint
 * @description Paints one Web Mercator tile of a vector base on a canvas from
 * a loaded style ({@link module:render/vectorBase/style}): its background,
 * fill, line and circle layers in style order, then its symbol layers' text
 * labels. Cesium-free: the renderer hands the canvas to its own imagery.
 *
 * A tile `size` pixels wide at tile zoom `z` is painted at style zoom
 * `z + log2(size / 512)` (at least 0), as a 512 px style tile at that zoom shows the
 * same ground; sizes in the style are pixels of the painted tile. A source
 * past its `maxzoom` is drawn from its deepest tile over this one (over-
 * zoomed); below its `minzoom` it draws nothing. A feature whose filter
 * cannot be evaluated is left out; a value that cannot be is the property's
 * default.
 *
 * Labels are placed top layer first (a layer's own in their features' order
 * in the tile), each kept clear of those placed
 * before it and wholly inside its tile (a label across a tile edge is left
 * out, never cut); a point labels at itself, a line at the point halfway
 * along it, a polygon at its outer ring's bounding-box centre. Text wraps at
 * `text-max-width`; fonts are the system's sans-serif (serif for a
 * `text-font` naming one), bold or italic as the font name says.
 */
import { PbfReader } from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';
import { cssOf, fillTokens, parseColor } from './expressions.js';

/** The tile size style zooms are given for, pixels. */
export const STYLE_TILE_SIZE = 512;

/** Decoded source tiles kept for a style. */
const KEPT_TILES = 128;

const TYPES = { 1: 'Point', 2: 'LineString', 3: 'Polygon' };

/** A canvas of `size` square: in a page, else offscreen. */
function createCanvas(size) {
  if (typeof document !== 'undefined' && document.createElement) {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    return canvas;
  }
  if (typeof OffscreenCanvas !== 'undefined')
    return new OffscreenCanvas(size, size);
  throw new TypeError('no canvas to paint a vector tile on');
}

/** Bytes, gunzipped when they are gzip. */
async function inflate(bytes) {
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
  if (typeof DecompressionStream === 'undefined')
    throw new Error('a gzipped vector tile, and no DecompressionStream');
  const stream = new Blob([bytes])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A source tile's URL. */
function tileUrl(source, z, x, y) {
  const template = source.tiles[(x + y) % source.tiles.length];
  const ty = source.scheme === 'tms' ? 2 ** z - 1 - y : y;
  return template
    .replace(/{z}/g, z)
    .replace(/{x}/g, x)
    .replace(/{y}/g, ty)
    .replace(/{-y}/g, 2 ** z - 1 - y);
}

/** A source tile, decoded once per style; null where there is none. */
function sourceTile(style, url, fetchImpl) {
  let tile = style.tiles.get(url);
  if (tile) {
    // Most recently used last.
    style.tiles.delete(url);
    style.tiles.set(url, tile);
    return tile;
  }
  tile = (async () => {
    const response = await fetchImpl(url);
    // No tile there (an empty answer or none): nothing to draw.
    if (response.status === 204 || response.status === 404) return null;
    if (!response.ok)
      throw new Error(`${url} answered ${response.status ?? 'an error'}`);
    const bytes = await inflate(new Uint8Array(await response.arrayBuffer()));
    return bytes.length ? new VectorTile(new PbfReader(bytes)) : null;
  })();
  // A failed fetch is tried again by the next tile that needs it.
  tile.catch(() => style.tiles.delete(url));
  style.tiles.set(url, tile);
  while (style.tiles.size > KEPT_TILES)
    style.tiles.delete(style.tiles.keys().next().value);
  return tile;
}

/** The values each keyword property takes, as the specification lists them. */
const KEYWORDS = {
  'line-cap': ['butt', 'round', 'square'],
  'line-join': ['bevel', 'round', 'miter'],
  'text-transform': ['none', 'uppercase', 'lowercase'],
  'text-anchor': [
    'center',
    'left',
    'right',
    'top',
    'bottom',
    'top-left',
    'top-right',
    'bottom-left',
    'bottom-right',
  ],
};

/**
 * A value of a layer for a feature, or the property's default where it
 * cannot be evaluated or is nothing (null, undefined or NaN). MapLibre then
 * also takes the default for one that is not of the property's type, which {@link numberOf}, {@link colorOf} and
 * {@link keywordOf} check: a canvas given a value it cannot use ignores it,
 * so the last feature's would be drawn.
 */
export function valueOf(layer, key, f) {
  let v;
  try {
    v = layer.values[key]?.(f);
  } catch {
    v = undefined;
  }
  return v === null || v === undefined || Number.isNaN(v)
    ? layer.defaults?.[key]
    : v;
}

/** A number value: a finite number, else the property's default. */
export function numberOf(layer, key, f) {
  const v = valueOf(layer, key, f);
  return typeof v === 'number' && Number.isFinite(v)
    ? v
    : Number(layer.defaults?.[key]);
}

/**
 * A colour value as CSS: one `parseColor` reads, written back as
 * `rgba()` so the canvas reads it the same way, else the default (or `or`).
 */
export function colorOf(layer, key, f, or = layer.defaults?.[key]) {
  const css = (v) => {
    const parsed = parseColor(v);
    if (!parsed || !parsed.every(Number.isFinite)) return null;
    return cssOf(parsed);
  };
  return css(valueOf(layer, key, f)) ?? css(or);
}

/** A keyword value: one its property takes, else the default. */
export function keywordOf(layer, key, f) {
  const v = valueOf(layer, key, f);
  return KEYWORDS[key]?.includes(v) ? v : layer.defaults?.[key];
}

/** Paths a feature's rings or lines in tile pixels. */
function tracePath(ctx, rings, at) {
  ctx.beginPath();
  for (const ring of rings)
    for (let i = 0; i < ring.length; i++) {
      const [px, py] = at(ring[i]);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
}

/** The point halfway along a line, in tile pixels. */
function halfway(line, at) {
  const points = line.map(at);
  let length = 0;
  for (let i = 1; i < points.length; i++)
    length += Math.hypot(
      points[i][0] - points[i - 1][0],
      points[i][1] - points[i - 1][1],
    );
  let left = length / 2;
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1];
    const [x1, y1] = points[i];
    const step = Math.hypot(x1 - x0, y1 - y0);
    if (step >= left && step > 0) {
      const t = left / step;
      return [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t];
    }
    left -= step;
  }
  return points[0];
}

/** A CSS font for a `text-font` stack at `px`. */
function fontOf(stack, px) {
  const name = String([stack].flat()[0] ?? '');
  const bold = /bold|black|heavy|semibold/i.test(name) ? 'bold ' : '';
  const italic = /italic|oblique/i.test(name) ? 'italic ' : '';
  const family =
    /serif/i.test(name) && !/sans/i.test(name) ? 'serif' : 'sans-serif';
  return `${italic}${bold}${px}px ${family}`;
}

/** `text` broken into lines no wider than `max` pixels (by words). */
function wrap(ctx, text, max) {
  const lines = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(next).width > max) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    if (line) lines.push(line);
  }
  return lines;
}

/** Whether two `[x0, y0, x1, y1]` boxes overlap. */
const overlaps = (a, b) =>
  a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

/**
 * Paint tile `z/x/y` of a vector base.
 * @param {Awaited<ReturnType<typeof import('./style.js').loadVectorStyle>>} style
 * @param {number} z
 * @param {number} x
 * @param {number} y
 * @param {{size?: number, fetch?: typeof fetch, signal?: AbortSignal,
 *   canvas?: (size: number) => HTMLCanvasElement | OffscreenCanvas}} [options]
 *   `canvas` makes the canvas to paint on (by default one in the page, else
 *   an offscreen one).
 * @returns {Promise<HTMLCanvasElement | OffscreenCanvas>}
 */
export async function paintVectorTile(
  style,
  z,
  x,
  y,
  { size = 256, fetch: fetchImpl = globalThis.fetch, signal, canvas } = {},
) {
  // No style zoom is below 0.
  const zoom = Math.max(0, z + Math.log2(size / STYLE_TILE_SIZE));
  const shown = style.layers.filter(
    (layer) => zoom >= layer.minzoom && zoom < layer.maxzoom,
  );
  // Each source's tile over this one: its own, or its deepest one's.
  const tiles = new Map();
  for (const layer of shown) {
    if (layer.type === 'background' || tiles.has(layer.source)) continue;
    const source = style.sources[layer.source];
    if (z < source.minzoom) {
      tiles.set(layer.source, null);
      continue;
    }
    const zs = Math.min(z, source.maxzoom);
    const d = z - zs;
    const url = tileUrl(source, zs, x >> d, y >> d);
    tiles.set(layer.source, {
      tile: sourceTile(style, url, fetchImpl),
      scale: 2 ** d,
      dx: x - ((x >> d) << d),
      dy: y - ((y >> d) << d),
    });
  }
  for (const entry of tiles.values()) if (entry) entry.tile = await entry.tile;
  if (signal?.aborted)
    throw signal.reason ?? new DOMException('aborted', 'AbortError');

  const out = canvas ? canvas(size) : createCanvas(size);
  const ctx = out.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  const labels = [];

  for (const [order, layer] of shown.entries()) {
    if (layer.type === 'background') {
      const f = { zoom, properties: {}, type: 'Polygon' };
      try {
        const opacity = numberOf(layer, 'background-opacity', f);
        const color = colorOf(layer, 'background-color', f);
        ctx.globalAlpha = opacity;
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, size, size);
      } catch {
        // Not evaluated: no background from this layer.
      }
      ctx.globalAlpha = 1;
      continue;
    }
    const entry = tiles.get(layer.source);
    const source = entry?.tile?.layers?.[layer.sourceLayer];
    if (!source) continue;
    const k = (entry.scale * size) / source.extent;
    const at = (p) => [p.x * k - entry.dx * size, p.y * k - entry.dy * size];
    for (let i = 0; i < source.length; i++) {
      const feature = source.feature(i);
      const f = {
        zoom,
        properties: feature.properties,
        type: TYPES[feature.type],
        id: feature.id,
      };
      try {
        if (!f.type || !layer.filter(f)) continue;
        drawFeature(ctx, layer, feature, f, at, labels, order);
      } catch {
        // A filter not evaluated: the feature is left out.
      }
      ctx.globalAlpha = 1;
      ctx.setLineDash?.([]);
    }
  }
  placeLabels(ctx, labels, size);
  return out;
}

/**
 * Draw a feature of a fill, line or circle layer; queue a symbol's label.
 * Every value is evaluated (to the property's default where it cannot be)
 * before anything is drawn.
 */
function drawFeature(ctx, layer, feature, f, at, labels, order) {
  const v = (key) => valueOf(layer, key, f);
  const num = (key) => numberOf(layer, key, f);
  const color = (key) => colorOf(layer, key, f);
  switch (layer.type) {
    case 'fill': {
      if (f.type !== 'Polygon') return;
      const opacity = num('fill-opacity');
      const fill = color('fill-color');
      // An outline that comes to nothing is the fill's colour, as MapLibre's.
      const outline = layer.values['fill-outline-color']
        ? colorOf(layer, 'fill-outline-color', f, fill)
        : null;
      tracePath(ctx, feature.loadGeometry(), at);
      ctx.globalAlpha = opacity;
      ctx.fillStyle = fill;
      ctx.fill('evenodd');
      if (outline) {
        ctx.strokeStyle = outline;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      return;
    }
    case 'line': {
      if (f.type === 'Point') return;
      const width = num('line-width');
      const gap = num('line-gap-width');
      // A cased line (a gap between two lines) as one line its full width,
      // under what fills the gap.
      const drawn = gap > 0 ? gap + 2 * width : width;
      if (!(drawn > 0)) return;
      const opacity = num('line-opacity');
      const stroke = color('line-color');
      const cap = keywordOf(layer, 'line-cap', f);
      const join = keywordOf(layer, 'line-join', f);
      const dashes = layer.values['line-dasharray'] && v('line-dasharray');
      let dash =
        Array.isArray(dashes) && gap <= 0
          ? dashes.map((d) => Number(d) * width)
          : null;
      // A dash array that is not numbers: solid, its default.
      if (dash && !dash.every(Number.isFinite)) dash = null;
      tracePath(ctx, feature.loadGeometry(), at);
      ctx.globalAlpha = opacity;
      ctx.strokeStyle = stroke;
      ctx.lineWidth = drawn;
      ctx.lineCap = cap;
      ctx.lineJoin = join;
      if (dash) ctx.setLineDash(dash);
      ctx.stroke();
      return;
    }
    case 'circle': {
      if (f.type !== 'Point') return;
      const radius = num('circle-radius');
      const stroke = num('circle-stroke-width');
      const opacity = num('circle-opacity');
      const fill = color('circle-color');
      const strokeOpacity = stroke > 0 ? num('circle-stroke-opacity') : 0;
      const strokeColor = stroke > 0 ? color('circle-stroke-color') : null;
      for (const part of feature.loadGeometry())
        for (const p of part) {
          const [px, py] = at(p);
          ctx.beginPath();
          ctx.arc(px, py, radius, 0, Math.PI * 2);
          ctx.globalAlpha = opacity;
          ctx.fillStyle = fill;
          ctx.fill();
          if (stroke > 0) {
            ctx.globalAlpha = strokeOpacity;
            ctx.strokeStyle = strokeColor;
            ctx.lineWidth = stroke;
            ctx.stroke();
          }
        }
      return;
    }
    case 'symbol': {
      if (!layer.hasText) return;
      const field = v('text-field');
      // A string (not an expression) names properties as `{name}`.
      let text = layer.tokens
        ? fillTokens(String(field ?? ''), f.properties)
        : String(field ?? '');
      const transform = keywordOf(layer, 'text-transform', f);
      if (transform === 'uppercase') text = text.toUpperCase();
      if (transform === 'lowercase') text = text.toLowerCase();
      text = text.trim();
      if (!text) return;
      const geometry = feature.loadGeometry();
      const anchors = [];
      if (f.type === 'Point')
        for (const part of geometry) for (const p of part) anchors.push(at(p));
      else if (f.type === 'LineString') anchors.push(halfway(geometry[0], at));
      else {
        const ring = geometry[0].map(at);
        const xs = ring.map((p) => p[0]);
        const ys = ring.map((p) => p[1]);
        anchors.push([
          (Math.min(...xs) + Math.max(...xs)) / 2,
          (Math.min(...ys) + Math.max(...ys)) / 2,
        ]);
      }
      const px = num('text-size');
      const offset = layer.values['text-offset'] ? v('text-offset') : [0, 0];
      let dx = Number(offset?.[0] ?? 0) * px;
      let dy = Number(offset?.[1] ?? 0) * px;
      // An offset that is not numbers: none, its default.
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) dx = dy = 0;
      const maxWidth =
        (layer.values['text-max-width'] ? num('text-max-width') : 10) * px;
      const label = {
        text,
        px,
        font: fontOf(v('text-font'), px),
        color: color('text-color'),
        opacity: num('text-opacity'),
        halo: color('text-halo-color'),
        haloWidth: num('text-halo-width'),
        anchor: keywordOf(layer, 'text-anchor', f),
        maxWidth,
        order,
      };
      for (const anchor of anchors)
        labels.push({ ...label, x: anchor[0] + dx, y: anchor[1] + dy });
      return;
    }
  }
}

/** Place the labels top layer first, clear of each other, and draw them. */
function placeLabels(ctx, labels, size) {
  const placed = [];
  // Later in the style is on top, and placed first; within a layer, its
  // features in their order in the tile, as MapLibre places them.
  const order = labels.slice().sort((a, b) => b.order - a.order);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const label of order) {
    ctx.font = label.font;
    const lines = wrap(ctx, label.text, label.maxWidth);
    if (!lines.length) continue;
    const lineHeight = label.px * 1.2;
    const width = Math.max(...lines.map((l) => ctx.measureText(l).width));
    const height = lineHeight * lines.length;
    let cx = label.x;
    let cy = label.y;
    if (label.anchor.includes('top')) cy += height / 2;
    if (label.anchor.includes('bottom')) cy -= height / 2;
    if (label.anchor.includes('left')) cx += width / 2;
    if (label.anchor.includes('right')) cx -= width / 2;
    const pad = label.haloWidth + 1;
    const box = [
      cx - width / 2 - pad,
      cy - height / 2 - pad,
      cx + width / 2 + pad,
      cy + height / 2 + pad,
    ];
    if (box[0] < 0 || box[1] < 0 || box[2] > size || box[3] > size) continue;
    if (placed.some((b) => overlaps(b, box))) continue;
    placed.push(box);
    ctx.globalAlpha = label.opacity;
    lines.forEach((line, i) => {
      const ly = cy - height / 2 + lineHeight * (i + 0.5);
      if (label.haloWidth > 0) {
        ctx.lineWidth = label.haloWidth * 2;
        ctx.lineJoin = 'round';
        ctx.strokeStyle = label.halo;
        ctx.strokeText(line, cx, ly);
      }
      ctx.fillStyle = label.color;
      ctx.fillText(line, cx, ly);
    });
  }
  ctx.globalAlpha = 1;
}
