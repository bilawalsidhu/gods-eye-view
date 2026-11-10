// Marker sprites for news reports: a dark disc with the category's icon and
// a rim in the severity colour, the rim's form telling attestation. Drawn once per look
// on a canvas and handed to Cesium as a data URL, so its texture atlas keeps
// one copy per look however often the layer re-renders.

import { NEWS_CATEGORIES, NEWS_SEVERITY } from './model.js';

const CANVAS = 64;
const BODY = 52; // disc diameter inside the canvas; the rest is rim and ring
const INK = 'rgba(10, 10, 15, 0.92)';
const SELECTED = '#00d4ff';
const COUNT_INK = '#e8eaed';

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
  // GEV's dark glass disc, as its HUD buttons are; severity colours the rim
  // and the icon rather than filling the disc.
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, 2 * Math.PI);
  ctx.fillStyle = INK;
  ctx.fill();
  const color = (NEWS_SEVERITY[severity] || NEWS_SEVERITY[0]).color;

  // Attestation is the rim's form, never its colour.
  ctx.beginPath();
  ctx.arc(cx, cy, r - 3 * k, 0, 2 * Math.PI);
  ctx.setLineDash(rim === 'claimed' ? [7 * k, 5 * k] : []);
  ctx.lineWidth = (rim === 'thin' ? 2.5 : 6) * k;
  ctx.strokeStyle = color;
  ctx.stroke();
  ctx.setLineDash([]);

  const style = NEWS_CATEGORIES[category] || NEWS_CATEGORIES.other;
  const icon = body * 0.5;
  ctx.save();
  ctx.translate(cx - icon / 2, cy - icon / 2);
  ctx.scale(icon / 16, icon / 16);
  const path = new Path2D(style.icon);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 1.7;
  ctx.strokeStyle = color;
  if (style.solid) {
    ctx.fillStyle = color;
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

/**
 * Data URL of a country badge: the dark disc with a light rim and the number
 * of reports it stands for, drawn at the pixels it is shown at so the digits
 * stay sharp. Null where there is no canvas.
 * @param {number} count Reports the badge stands for.
 * @param {number} pixels The disc's diameter in drawn pixels.
 */
export function countSprite(count, pixels) {
  const body = Math.max(1, Math.round(pixels));
  const text = count > 99 ? '99+' : String(count);
  const key = `count|${text}|${body}`;
  if (cache.has(key)) return cache.get(key);
  const canvas = globalThis.document?.createElement?.('canvas');
  const ctx = canvas?.getContext?.('2d');
  if (!ctx) return null;
  const k = body / BODY;
  canvas.width = canvas.height = Math.round(CANVAS * k);
  const c = canvas.width / 2;
  const r = body / 2;
  ctx.beginPath();
  ctx.arc(c, c, r + 1.5 * k, 0, 2 * Math.PI);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.85)';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(c, c, r, 0, 2 * Math.PI);
  ctx.fillStyle = INK;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(c, c, r - 2 * k, 0, 2 * Math.PI);
  ctx.lineWidth = 3 * k;
  ctx.strokeStyle = COUNT_INK;
  ctx.stroke();
  ctx.fillStyle = COUNT_INK;
  ctx.font = `600 ${Math.round(body * (text.length > 2 ? 0.34 : 0.44))}px ui-monospace, Menlo, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, c, c + k);
  const url = canvas.toDataURL('image/png');
  cache.set(key, url);
  return url;
}
