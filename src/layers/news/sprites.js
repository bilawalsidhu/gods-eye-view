// Marker sprites for news reports: a disc filled with the severity colour,
// the category's icon in it, and a rim for attestation. Drawn once per look
// on a canvas and handed to Cesium as a data URL, so its texture atlas keeps
// one copy per look however often the layer re-renders.

import { NEWS_CATEGORIES, NEWS_SEVERITY } from './model.js';

const CANVAS = 64;
const BODY = 52; // disc diameter inside the canvas; the rest is rim and ring
const INK = '#0a0a0f';
const RIM = '#ffffff';
const SELECTED = '#00d4ff';

/** Canvas pixels per marker pixel: the billboard is drawn at this ratio. */
export const SPRITE_SCALE = CANVAS / BODY;

const cache = new Map();

/**
 * Paint one marker look centred at (cx, cy) with a disc of `body` pixels: the
 * sprites and the event cards' badges draw the same thing.
 */
export function paintMarker(ctx, { category, severity, rim }, cx, cy, body) {
  const k = body / BODY; // the strokes below are tuned for the 52 px body
  const r = body / 2;
  // A dark edge keeps the lightest fills apart from bright ground.
  ctx.beginPath();
  ctx.arc(cx, cy, r + 1.5 * k, 0, 2 * Math.PI);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.85)';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, 2 * Math.PI);
  ctx.fillStyle = (NEWS_SEVERITY[severity] || NEWS_SEVERITY[0]).color;
  ctx.fill();

  // Attestation is the rim's form, never its colour.
  if (rim === 'confirmed' || rim === 'claimed') {
    ctx.beginPath();
    ctx.arc(cx, cy, r - 3.5 * k, 0, 2 * Math.PI);
    ctx.setLineDash(rim === 'claimed' ? [7 * k, 5 * k] : []);
    ctx.lineWidth = 7 * k;
    ctx.strokeStyle = RIM;
    ctx.stroke();
    ctx.setLineDash([]);
  } else {
    ctx.beginPath();
    ctx.arc(cx, cy, r - 1 * k, 0, 2 * Math.PI);
    ctx.lineWidth = 2 * k;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.75)';
    ctx.stroke();
  }

  const style = NEWS_CATEGORIES[category] || NEWS_CATEGORIES.other;
  const icon = body * 0.56;
  ctx.save();
  ctx.translate(cx - icon / 2, cy - icon / 2);
  ctx.scale(icon / 16, icon / 16);
  const path = new Path2D(style.icon);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 1.7;
  ctx.strokeStyle = INK;
  if (style.solid) {
    ctx.fillStyle = INK;
    ctx.fill(path);
  } else ctx.stroke(path);
  ctx.restore();
}

/**
 * Data URL of the sprite for a look, or null where there is no canvas (the
 * layer then falls back to a plain point).
 * @param {{category: string, severity: number, rim: 'confirmed'|'claimed'|'thin', selected?: boolean}} look
 */
export function markerSprite({ category, severity, rim, selected = false }) {
  const key = `${category}|${severity}|${rim}|${selected ? 1 : 0}`;
  if (cache.has(key)) return cache.get(key);
  const canvas = globalThis.document?.createElement?.('canvas');
  const ctx = canvas?.getContext?.('2d');
  if (!ctx || typeof globalThis.Path2D !== 'function') return null;
  canvas.width = canvas.height = CANVAS;
  const c = CANVAS / 2;
  paintMarker(ctx, { category, severity, rim }, c, c, BODY);
  if (selected) {
    ctx.beginPath();
    ctx.arc(c, c, CANVAS / 2 - 2, 0, 2 * Math.PI);
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = SELECTED;
    ctx.stroke();
  }
  const url = canvas.toDataURL('image/png');
  cache.set(key, url);
  return url;
}
