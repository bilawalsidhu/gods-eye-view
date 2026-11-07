// Event cards on the globe: a picture, the headline in two lines, and "age ·
// sources · sides", with the severity colour down the left edge and the
// event's marker as a badge on the picture. Painted on a canvas and handed to
// the world overlay as a thumbnail entry, so the overlay places them, keeps
// them apart and draws their leader to the marker, as it does CCTV cards.
//
// The picture is the publisher's own (hotlinked, never copied, credited on
// the card); until it loads, or without one, the card shows a tile in the
// severity colour with the category icon.

import { WORLD_OVERLAY_STYLE } from '../../overlays/worldOverlayTokens.js';
import { NEWS_SEVERITY } from './model.js';
import { paintMarker } from './sprites.js';

/** Card size in CSS pixels. */
export const CARD_W = 168;
export const CARD_H = 136;
const PAD = 4;
const PIC_H = 84;
const EDGE = 3;
const SCALE = 2; // canvas pixels per CSS pixel
const TITLE_FONT = '600 11px Inter, "Noto Sans Arabic", system-ui, sans-serif';
const META_FONT = '9px "JetBrains Mono", "Noto Sans Arabic", monospace';
const CREDIT_FONT = '8px Inter, "Noto Sans Arabic", system-ui, sans-serif';
// The map shows about ten cards plus the clicked one; a few more stay ready
// for a pan back. The least recently drawn card goes, and its picture with it.
export const MAX_CARDS = 24;

const pictures = new Map(); // url → {image, state: 'loading'|'ok'|'failed', waiters}
const cards = new Map(); // event id → {canvas, key, view, look, pic}, oldest first

/** Forget a picture no kept card shows any more. */
function releasePicture(url) {
  if (!url || [...cards.values()].some((card) => card.view.image === url))
    return;
  const entry = pictures.get(url);
  if (!entry) return;
  entry.waiters.clear();
  entry.image.onload = entry.image.onerror = null;
  pictures.delete(url);
}

function picture(url, onLoad) {
  let entry = pictures.get(url);
  if (!entry) {
    const image = new Image();
    // No referrer: the publisher sees a plain image request, as from a link preview.
    image.referrerPolicy = 'no-referrer';
    image.decoding = 'async';
    entry = { image, state: 'loading', waiters: new Set() };
    pictures.set(url, entry);
    image.onload = () => {
      entry.state = 'ok';
      for (const done of entry.waiters) done();
      entry.waiters.clear();
    };
    image.onerror = () => {
      entry.state = 'failed';
      entry.waiters.clear();
    };
    image.src = url;
  }
  if (entry.state === 'loading' && onLoad) entry.waiters.add(onLoad);
  return entry;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** `text` in at most `lines` lines of `width`, the last cut with an ellipsis. */
export function wrapLines(ctx, text, width, lines) {
  const words = String(text || '')
    .split(/\s+/)
    .filter(Boolean);
  const out = [];
  let line = '';
  for (let i = 0; i < words.length; i++) {
    const next = line ? `${line} ${words[i]}` : words[i];
    if (ctx.measureText(next).width <= width || !line) {
      line = next;
      continue;
    }
    out.push(line);
    line = words[i];
    if (out.length === lines - 1) {
      line = words.slice(i).join(' ');
      break;
    }
  }
  if (line) out.push(line);
  const last = out.length - 1;
  if (last >= 0 && ctx.measureText(out[last]).width > width) {
    let cut = out[last];
    while (cut && ctx.measureText(`${cut}…`).width > width)
      cut = cut.slice(0, -1);
    out[last] = `${cut.trimEnd()}…`;
  }
  return out.slice(0, lines);
}

/** Cover-fit an image into a box. */
function drawCover(ctx, image, x, y, w, h) {
  const iw = image.naturalWidth || image.width;
  const ih = image.naturalHeight || image.height;
  if (!iw || !ih) return;
  const s = Math.max(w / iw, h / ih);
  const sw = w / s;
  const sh = h / s;
  ctx.drawImage(image, (iw - sw) / 2, (ih - sh) / 2, sw, sh, x, y, w, h);
}

function paint(canvas, view, look, pic) {
  const ctx = canvas.getContext('2d');
  ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0);
  ctx.clearRect(0, 0, CARD_W, CARD_H);
  const color = (NEWS_SEVERITY[look.severity] || NEWS_SEVERITY[0]).color;

  roundRect(ctx, 0.5, 0.5, CARD_W - 1, CARD_H - 1, WORLD_OVERLAY_STYLE.radius);
  ctx.fillStyle = WORLD_OVERLAY_STYLE.selectedBackground;
  ctx.fill();
  ctx.strokeStyle = WORLD_OVERLAY_STYLE.border;
  ctx.lineWidth = 1;
  ctx.stroke();
  // Severity down the left edge.
  ctx.save();
  roundRect(ctx, 0.5, 0.5, CARD_W - 1, CARD_H - 1, WORLD_OVERLAY_STYLE.radius);
  ctx.clip();
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, EDGE, CARD_H);
  ctx.restore();

  const px = PAD + EDGE;
  const pw = CARD_W - px - PAD;
  ctx.save();
  roundRect(ctx, px, PAD, pw, PIC_H, 3);
  ctx.clip();
  if (pic?.state === 'ok') {
    try {
      drawCover(ctx, pic.image, px, PAD, pw, PIC_H);
    } catch {
      pic.state = 'failed';
    }
  }
  if (pic?.state !== 'ok') {
    // No picture: a plain glass tile with the event's marker.
    ctx.fillStyle = WORLD_OVERLAY_STYLE.background;
    ctx.fillRect(px, PAD, pw, PIC_H);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.04)';
    ctx.fillRect(px, PAD, pw, PIC_H);
    paintMarker(ctx, look, px + pw / 2, PAD + PIC_H / 2, 34);
  }
  ctx.restore();
  // The event's marker as a badge, so the card reads with the map.
  if (pic?.state === 'ok') paintMarker(ctx, look, px + 13, PAD + 13, 18);
  // The picture's publisher, always named on it.
  if (pic?.state === 'ok' && view.credit) {
    ctx.font = CREDIT_FONT;
    const w = Math.min(pw - 30, ctx.measureText(view.credit).width + 8);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.fillRect(px + pw - w, PAD + PIC_H - 12, w, 12);
    ctx.fillStyle = WORLD_OVERLAY_STYLE.title;
    ctx.textBaseline = 'middle';
    ctx.fillText(
      wrapLines(ctx, view.credit, w - 8, 1)[0] || '',
      px + pw - w + 4,
      PAD + PIC_H - 6,
    );
  }

  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = WORLD_OVERLAY_STYLE.title;
  ctx.font = TITLE_FONT;
  wrapLines(ctx, view.title, pw, 2).forEach((line, i) =>
    ctx.fillText(line, px, PAD + PIC_H + 14 + i * 13),
  );
  ctx.fillStyle = WORLD_OVERLAY_STYLE.detail;
  ctx.font = META_FONT;
  ctx.fillText(wrapLines(ctx, view.meta, pw, 1)[0] || '', px, CARD_H - PAD - 2);
}

/**
 * The canvas of an event's card, one per event: a change in what it shows
 * (the age in its meta line ticks by the minute) repaints the same canvas.
 * `onChange` runs when its picture arrives and the canvas has been repainted
 * (ask the scene for a frame).
 * @returns {HTMLCanvasElement|null} null where there is no canvas
 */
export function eventCard(id, view, look, onChange) {
  const key = `${look.severity}|${look.category}|${look.rim}|${view.image || ''}|${view.credit || ''}|${view.title}|${view.meta}`;
  let card = cards.get(id);
  if (card) {
    // Most recently drawn last.
    cards.delete(id);
    cards.set(id, card);
    if (card.key === key) return card.canvas;
  } else {
    const canvas = globalThis.document?.createElement?.('canvas');
    if (
      !canvas?.getContext?.('2d') ||
      typeof globalThis.Path2D !== 'function' ||
      typeof globalThis.Image !== 'function'
    )
      return null;
    canvas.width = CARD_W * SCALE;
    canvas.height = CARD_H * SCALE;
    card = { canvas, key: null, view: {}, look, pic: null };
    cards.set(id, card);
    while (cards.size > MAX_CARDS) {
      const [oldest, gone] = cards.entries().next().value;
      cards.delete(oldest);
      releasePicture(gone.view.image);
    }
  }
  const previous = card.view.image;
  card.key = key;
  card.view = view;
  card.look = look;
  const shown = card;
  card.pic = view.image
    ? picture(view.image, () => {
        if (cards.get(id) !== shown || shown.view.image !== view.image) return;
        paint(shown.canvas, shown.view, shown.look, shown.pic);
        onChange?.();
      })
    : null;
  if (previous && previous !== view.image) releasePicture(previous);
  paint(card.canvas, view, look, card.pic);
  return card.canvas;
}
