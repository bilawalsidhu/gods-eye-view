// The GhostMaps drawing on the globe contract, the same on every engine.
// Each drawn product edition owns three sets:
// - a ground 'polygon' set: KML polygons, their fill and their outline;
// - a ground 'corridor' set: KML lines, in pixels;
// - a sprite mover set: placemark icons, from an atlas of the edition's
//   decoded images.
// Picks return `ghostmaps:${productId}:${index}:${part}` (a polygon's
// outline adds `:outline`), which the layer resolves to its report.
// Placemarks draw over the scene (depth test off) and are hidden beyond the
// horizon instead, as they would sink into terrain and 3D tiles otherwise.
// They stand on the sampled surface, measured for the ones on screen.

import * as geo from '../../../geo/index.js';
import { normalizeGroundItem } from '../../../globe/ground.js';
import { rgbaFromCss } from '../../shared/color.js';
import { imageAtlasLayout } from '../../shared/render/imageAtlas.js';
import { createSurfacePoints } from '../../../globe/surfacePlacement.js';

const LAYER_ID = 's2-ghostmaps';
const TRANSPARENT = Object.freeze([0, 0, 0, 0]);
const WHITE = Object.freeze([1, 1, 1, 1]);
// Polygons under lines; placemarks are movers, over every ground fill.
const POLYGON_ORDER = 0;
const LINE_ORDER = 1;
// Atlas cells hold an icon at its own size up to this side; a larger icon
// keeps its drawn size, from a smaller texture.
const MAX_CELL_PX = 128;
const CELL_PAD_PX = 2;
// The horizon test lifts each placemark by this much: to first order the
// same margin as an occluder 1000 m under WGS84, since ground can lie below
// the ellipsoid (NYC −22 m).
const HORIZON_LIFT_M = 2000;

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

/** A KML colour (rgba in 0..1), else the product colour, at `alpha` when given. */
function colorOf(rgba, fallback, alpha) {
  if (rgba) return [rgba[0], rgba[1], rgba[2], alpha ?? rgba[3]];
  const { red, green, blue } = rgbaFromCss(fallback);
  return [red, green, blue, alpha ?? 1];
}

/** Placemark scale: the KML icon scale at 0.7, within 0.35..1.5. */
export const ghostMapsIconScale = (style) =>
  clamp((style.iconScale ?? 1) * 0.7, 0.35, 1.5);
/** Line width in pixels, within 1.5..8. */
export const ghostMapsLineWidth = (style) =>
  clamp(style.lineWidth ?? 2, 1.5, 8);
/** Polygon outline width in pixels, within 1.5..6. */
export const ghostMapsOutlineWidth = (style) =>
  clamp(style.lineWidth ?? 2, 1.5, 6);

const imageFromUrl = async (url) => {
  const image = new Image();
  image.src = url;
  await image.decode();
  return image;
};

// An item the contract accepts, or null (a degenerate KML ring or line).
function checked(kind, item) {
  try {
    normalizeGroundItem(kind, item);
    return item;
  } catch {
    return null;
  }
}

/**
 * The items of one edition's features, by kind; each carries the feature
 * index it belongs to (`report`), so a report can be dropped in place.
 */
function editionItems(productId, features, color, markerImage) {
  const polygons = [];
  const lines = [];
  const pins = [];
  for (const [index, feature] of features.entries()) {
    const { style } = feature;
    feature.geometries.forEach((geometry, part) => {
      const id = `ghostmaps:${productId}:${index}:${part}`;
      if (geometry.type === 'point') {
        const url = style.icon || markerImage(color);
        if (!url) return;
        const [lon, lat] = geometry.position;
        pins.push({
          report: index,
          id,
          url,
          cartographic: geo.cartographic.fromDegrees(lon, lat),
          position: geo.cartesian3.fromDegrees(lon, lat),
          horizon: geo.cartesian3.fromDegrees(lon, lat, HORIZON_LIFT_M),
          scale: ghostMapsIconScale(style),
          color: style.icon && style.iconColor ? [...style.iconColor] : WHITE,
          show: true,
        });
      } else if (geometry.type === 'line') {
        const item = checked('corridor', {
          positions: geometry.positions,
          color: colorOf(style.lineColor, color),
          widthPx: ghostMapsLineWidth(style),
          pickId: id,
        });
        if (item) lines.push({ report: index, item });
      } else {
        const fill =
          style.fill === false
            ? TRANSPARENT
            : colorOf(
                style.polyColor,
                color,
                style.polyColor ? undefined : 0.25,
              );
        const outline =
          style.outline === false
            ? null
            : {
                color: colorOf(style.lineColor, color),
                widthPx: ghostMapsOutlineWidth(style),
              };
        const area = checked('polygon', {
          rings: [geometry.outer, ...geometry.holes],
          fill,
          // The outline runs on the outer ring only: a polygon with holes
          // gets it as an item of its own.
          ...(outline && !geometry.holes.length ? { outline } : {}),
          pickId: id,
        });
        if (!area) return;
        polygons.push({ report: index, item: area });
        if (outline && geometry.holes.length)
          polygons.push({
            report: index,
            item: {
              rings: [geometry.outer],
              outline,
              pickId: `${id}:outline`,
            },
          });
      }
    });
  }
  return { polygons, lines, pins };
}

/**
 * The atlas of `images` (url → decoded image): one square cell per image,
 * the image centred in it. Returns the atlas and, per url, its cell and
 * drawn side in pixels.
 */
function packIcons(images, createCanvas) {
  const entries = [...images].map(([url, image], index) => {
    const width = image.naturalWidth || image.width || 1;
    const height = image.naturalHeight || image.height || 1;
    const side = Math.max(width, height);
    const cell = Math.min(MAX_CELL_PX, side);
    return { url, image, width, height, side, key: String(index), cell };
  });
  const cell = Math.max(...entries.map((entry) => entry.cell));
  const layout = imageAtlasLayout(
    entries.map(({ key, cell: size }) => ({ key, width: size, height: size })),
    { cell: cell + 2 * CELL_PAD_PX, pad: CELL_PAD_PX },
  );
  const canvas = createCanvas();
  canvas.width = layout.width;
  canvas.height = layout.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('GhostMaps icons need a canvas');
  const lookup = new Map();
  entries.forEach((entry, index) => {
    const { x, y } = layout.rects[index];
    const fit = entry.cell / entry.side;
    const width = entry.width * fit;
    const height = entry.height * fit;
    context.drawImage(
      entry.image,
      x + (entry.cell - width) / 2,
      y + (entry.cell - height) / 2,
      width,
      height,
    );
    lookup.set(entry.url, { key: entry.key, side: entry.side });
  });
  return { atlas: { canvas, cells: layout.cells }, lookup };
}

/**
 * @param {import('../../../globe/contract.js').GlobeEngine} engine
 * @param {{ loadImage?: (url: string) => Promise<object>,
 *   createCanvas?: () => object }} [options] Test seams: icon decoding and
 *   the atlas canvas.
 */
export function createGhostMapsDisplay(
  engine,
  {
    loadImage = imageFromUrl,
    createCanvas = () => document.createElement('canvas'),
  } = {},
) {
  const paints = new Set();
  let sequence = 0;
  let destroyed = false;
  let removeCull = null;
  const lastCamera = geo.cartesian3.create(Number.NaN, 0, 0);
  const request = () => engine.render.request(LAYER_ID);
  const surface = createSurfacePoints(engine, {
    groups: () =>
      [...paints].map((paint) => ({ set: paint.sprites, points: paint.pins })),
    request,
  });

  // Hides the placemarks beyond the horizon; true when any show changed.
  function cull(paint) {
    let changed = false;
    paint.pins.forEach((pin, index) => {
      const show = engine.projector.horizonVisible(pin.horizon);
      if (show === pin.show) return;
      pin.show = show;
      paint.sprites?.set(index, { show });
      changed = true;
    });
    if (changed) paint.sprites?.commit();
    return changed;
  }
  function cullAll() {
    let changed = false;
    for (const paint of paints) changed = cull(paint) || changed;
    if (changed) request();
  }
  // Culls again whenever the camera moved, while any placemark is drawn.
  function syncCull() {
    const wanted = [...paints].some((paint) => paint.pins.length);
    if (!wanted) {
      removeCull?.();
      removeCull = null;
      return;
    }
    removeCull ??= engine.frames.preRender.addEventListener(() => {
      const live = engine.camera.livePosition;
      if (geo.cartesian3.equals(live, lastCamera)) return;
      geo.cartesian3.clone(live, lastCamera);
      cullAll();
    });
  }

  function writePins(paint) {
    const { sprites, pins, lookup } = paint;
    if (!sprites) return;
    pins.forEach((pin, index) => {
      const cell = lookup.get(pin.url);
      sprites.set(index, {
        position: pin.position,
        cell: cell.key,
        scale: (pin.scale * cell.side) / paint.sizePx,
        color: pin.color,
        show: pin.show,
        pickId: pin.id,
      });
    });
    sprites.setCount(pins.length);
    sprites.commit();
  }

  function commitGround(paint) {
    paint.polygonSet.replace(paint.polygons.map(({ item }) => item));
    paint.polygonSet.commit();
    paint.lineSet.replace(paint.lines.map(({ item }) => item));
    paint.lineSet.commit();
  }

  async function drawPins(paint) {
    const urls = [...new Set(paint.pins.map((pin) => pin.url))];
    const decoded = await Promise.allSettled(urls.map((url) => loadImage(url)));
    if (paint.disposed) return;
    const images = new Map();
    decoded.forEach((result, index) => {
      if (result.status === 'fulfilled' && result.value)
        images.set(urls[index], result.value);
    });
    // An icon that does not decode draws nothing, as a billboard without
    // an image.
    paint.pins = paint.pins.filter((pin) => images.has(pin.url));
    if (!paint.pins.length) return;
    const { atlas, lookup } = packIcons(images, createCanvas);
    paint.lookup = lookup;
    paint.sizePx = Math.max(...[...lookup.values()].map(({ side }) => side));
    paint.sprites = engine.movers.createSet({
      id: `${paint.prefix}:pins`,
      kind: 'sprite',
      capacity: paint.pins.length,
      depthTest: 'always',
      pickable: true,
      sprite: { atlas, sizePx: paint.sizePx },
    });
    for (const pin of paint.pins)
      pin.show = engine.projector.horizonVisible(pin.horizon);
    writePins(paint);
    syncCull();
    surface.place();
  }

  return {
    requestRender: request,
    onClick: (run) =>
      engine.input.on('click', run, {
        pick: true,
      }),
    draw(productId, features, color, markerImage) {
      if (destroyed) throw new Error('The GhostMaps display was destroyed');
      const prefix = `${LAYER_ID}:${productId}:${++sequence}`;
      const { polygons, lines, pins } = editionItems(
        productId,
        features,
        color,
        markerImage,
      );
      const paint = {
        prefix,
        polygons,
        lines,
        pins,
        lookup: new Map(),
        sizePx: 1,
        sprites: null,
        disposed: false,
        polygonSet: engine.ground.createSet({
          id: `${prefix}:polygons`,
          kind: 'polygon',
          order: POLYGON_ORDER,
          pickable: true,
        }),
        lineSet: engine.ground.createSet({
          id: `${prefix}:lines`,
          kind: 'corridor',
          order: LINE_ORDER,
          pickable: true,
        }),
      };
      paints.add(paint);
      const dispose = () => {
        if (paint.disposed) return;
        paint.disposed = true;
        paints.delete(paint);
        paint.polygonSet.destroy();
        paint.lineSet.destroy();
        paint.sprites?.destroy();
        paint.sprites = null;
        paint.pins = [];
        syncCull();
        request();
      };
      paint.dispose = dispose;
      let ready;
      try {
        commitGround(paint);
        ready = drawPins(paint).then(() => {
          if (!paint.disposed) request();
        });
      } catch (error) {
        dispose();
        throw error;
      }
      return {
        ready,
        // Take one report off in place: an expired event leaves its
        // edition's drawing, which stays for the reports that remain.
        drop(index) {
          if (paint.disposed) return true;
          const keep = ({ report }) => report !== index;
          const before = paint.polygons.length + paint.lines.length;
          paint.polygons = paint.polygons.filter(keep);
          paint.lines = paint.lines.filter(keep);
          if (paint.polygons.length + paint.lines.length !== before)
            commitGround(paint);
          const pins = paint.pins.filter(keep);
          if (pins.length !== paint.pins.length) {
            paint.pins = pins;
            writePins(paint);
            syncCull();
          }
          request();
          return true;
        },
        destroy: dispose,
      };
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      surface.destroy();
      removeCull?.();
      removeCull = null;
      for (const paint of paints) paint.dispose();
    },
  };
}
