/**
 * @module ui/cardMapLabels
 * @description The names on a card's map, placed once over the whole map
 * after its tiles are drawn: places by rank, then names along major roads,
 * then open water. Each name is read in the app's language where the tile
 * has it, else the local name, else its Latin form. A name is placed only
 * where it overlaps no other, keeps clear of the item's marker and the
 * map's foot, and lies wholly inside what shows; right-to-left names are set
 * right to left. Sizes are CSS pixels; the canvas is drawn at its scale.
 */
import { CARD_MAP_COLOURS, CARD_MAP_LABELS } from './cardMapStyle.js';

import { nameKeys } from '../maps/labelNames.js';
export { nameKeys };

/**
 * A feature's name for the map: the first of {@link nameKeys} that is a
 * non-empty string, trimmed; '' for none.
 * @param {Record<string, unknown>} properties
 * @param {string} [locale]
 */
export function labelName(properties, locale) {
  for (const key of nameKeys(locale)) {
    const value = properties?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

const STRONG_RTL = /[֐-ࣿיִ-﷿ﹰ-ﻼ]/;
const STRONG_LTR = /[A-Za-zÀ-ɏͰ-ϿЀ-ԯऀ-෿฀-๿ᄀ-ᇿ぀-ヿ㐀-鿿가-힯]/;

/** Whether a name reads right to left: its first strong letter is Hebrew or Arabic. */
export function isRightToLeft(text) {
  for (const char of String(text)) {
    if (STRONG_RTL.test(char)) return true;
    if (STRONG_LTR.test(char)) return false;
  }
  return false;
}

/** The point halfway along a line. */
function halfway(points) {
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

/**
 * The names a map's kept tiles offer, in map pixels.
 * @param {Array<{kept: {layers: object}, at: (x: number, y: number) => [number, number]}>} tiles
 *   Each kept tile with the function that places its grid on the map.
 * @param {{locale?: string}} [options]
 * @returns {Array<object>} Candidates, best first.
 */
export function collectLabels(tiles, { locale } = {}) {
  const { places, roads, water } = CARD_MAP_LABELS;
  const out = [];
  const lines = (feature, at) =>
    feature.parts.map((flat) => {
      const points = [];
      for (let i = 0; i < flat.length; i += 2)
        points.push(at(flat[i], flat[i + 1]));
      return points;
    });
  for (const { kept, at } of tiles) {
    for (const feature of kept?.layers?.place ?? []) {
      const set = places[feature.properties.class];
      const text = labelName(feature.properties, locale);
      if (!set || !text || feature.type !== 1) continue;
      for (const [anchor] of lines(feature, at))
        out.push({
          kind: 'place',
          text,
          ...set,
          rank: Number(feature.properties.rank) || 99,
          anchor,
        });
    }
    for (const feature of kept?.layers?.transportation_name ?? []) {
      const text = labelName(feature.properties, locale);
      if (!text || feature.type !== 2) continue;
      if (!roads.classes.includes(feature.properties.class)) continue;
      for (const line of lines(feature, at))
        out.push({
          kind: 'road',
          text,
          priority: roads.priority,
          size: roads.size,
          weight: roads.weight,
          rank: roads.classes.indexOf(feature.properties.class),
          line,
        });
    }
    for (const feature of kept?.layers?.water_name ?? []) {
      const text = labelName(feature.properties, locale);
      if (!text || !water.classes.includes(feature.properties.class)) continue;
      for (const line of lines(feature, at))
        out.push({
          kind: 'water',
          text,
          priority: water.priority,
          size: water.size,
          weight: water.weight,
          italic: true,
          rank: water.classes.indexOf(feature.properties.class),
          anchor: feature.type === 1 ? line[0] : halfway(line),
        });
    }
  }
  const length = (line) =>
    line
      ? line
          .slice(1)
          .reduce(
            (sum, p, i) =>
              sum + Math.hypot(p[0] - line[i][0], p[1] - line[i][1]),
            0,
          )
      : 0;
  return out
    .map((label) => ({ ...label, length: length(label.line) }))
    .sort(
      (a, b) =>
        a.priority - b.priority || a.rank - b.rank || b.length - a.length,
    );
}

const MAX_LABEL_MEASUREMENTS = 128;

const overlaps = (a, b) =>
  a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
const inside = (box, bounds) =>
  box[0] >= bounds[0] &&
  box[1] >= bounds[1] &&
  box[2] <= bounds[2] &&
  box[3] <= bounds[3];

/** A rotated rectangle's bounding box. */
function rotatedBox(cx, cy, w, h, angle) {
  const c = Math.abs(Math.cos(angle));
  const s = Math.abs(Math.sin(angle));
  const hw = (w * c + h * s) / 2;
  const hh = (w * s + h * c) / 2;
  return [cx - hw, cy - hh, cx + hw, cy + hh];
}

/** Where a road's name goes: along its longest straight piece if the name fits there, else level at the line's middle. */
function roadPlacement(line, width) {
  let best = null;
  for (let i = 1; i < line.length; i++) {
    const [x0, y0] = line[i - 1];
    const [x1, y1] = line[i];
    const step = Math.hypot(x1 - x0, y1 - y0);
    if (!best || step > best.step) best = { step, x0, y0, x1, y1 };
  }
  if (best && best.step >= width + 2 * CARD_MAP_LABELS.gap) {
    let angle = Math.atan2(best.y1 - best.y0, best.x1 - best.x0);
    // Never upside down.
    if (angle > Math.PI / 2) angle -= Math.PI;
    if (angle < -Math.PI / 2) angle += Math.PI;
    return {
      x: (best.x0 + best.x1) / 2,
      y: (best.y0 + best.y1) / 2,
      angle,
    };
  }
  const [x, y] = halfway(line);
  return { x, y, angle: 0 };
}

/**
 * Place and draw a map's names.
 * @param {CanvasRenderingContext2D} ctx
 * @param {Array<object>} candidates From {@link collectLabels}, best first.
 * @param {{bounds: [number, number, number, number],
 *   clear?: Array<[number, number, number, number]>,
 *   scale?: number, colours?: object}} options In map pixels: `bounds`, what shows (a name
 *   lies wholly inside it); `clear`, boxes no name may cover (the marker,
 *   the foot).
 * @returns {Array<{text: string, box: number[], rtl: boolean, angle: number}>} What was drawn.
 */
export function placeLabels(
  ctx,
  candidates,
  { bounds, clear = [], scale = 1, colours = CARD_MAP_COLOURS },
) {
  const { font, halo, gap, roads } = CARD_MAP_LABELS;
  const placed = [];
  const taken = clear.slice();
  const names = { place: new Set(), water: new Set(), road: new Set() };
  ctx.save?.();
  ctx.setTransform?.(scale, 0, 0, scale, 0, 0);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  let measured = 0;
  for (const label of candidates) {
    if (measured >= MAX_LABEL_MEASUREMENTS) break;
    const used = names[label.kind];
    if (
      used.has(label.text) ||
      (label.kind === 'road' && used.size >= roads.most)
    )
      continue;
    if (label.anchor) {
      const [x, y] = label.anchor;
      if (x < bounds[0] || y < bounds[1] || x > bounds[2] || y > bounds[3])
        continue;
    }
    measured++;
    ctx.font = `${label.italic ? 'italic ' : ''}${label.weight} ${label.size}px ${font}`;
    const width = ctx.measureText(label.text).width + 2 * halo;
    const height = label.size * 1.3 + 2 * halo;
    const at =
      label.kind === 'road'
        ? roadPlacement(label.line, width)
        : { x: label.anchor[0], y: label.anchor[1], angle: 0 };
    const box = rotatedBox(at.x, at.y, width, height, at.angle);
    if (!inside(box, bounds)) continue;
    const padded = [box[0] - gap, box[1] - gap, box[2] + gap, box[3] + gap];
    if (taken.some((other) => overlaps(padded, other))) continue;
    taken.push(box);
    const rtl = isRightToLeft(label.text);
    ctx.save?.();
    ctx.translate(at.x, at.y);
    if (at.angle) ctx.rotate(at.angle);
    ctx.direction = rtl ? 'rtl' : 'ltr';
    ctx.lineWidth = halo * 2;
    ctx.strokeStyle = colours.nameHalo;
    ctx.strokeText(label.text, 0, 0);
    ctx.fillStyle = label.kind === 'water' ? colours.waterNames : colours.names;
    ctx.fillText(label.text, 0, 0);
    ctx.restore?.();
    used.add(label.text);
    placed.push({
      text: label.text,
      kind: label.kind,
      box,
      rtl,
      angle: at.angle,
    });
  }
  ctx.restore?.();
  return placed;
}
