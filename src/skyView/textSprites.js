/**
 * Pre-rendered text for the Sky view overlay.
 *
 * Setting ctx.font costs a CSS font resolution every time the string changes
 * (and the first time in every frame); with eight or so font switches per
 * redraw it was the largest single canvas cost of the throttled mid-phone
 * profile (~4 ms of a ~12 ms redraw). The labels repeat from frame to frame,
 * so each (text, font, colours, alignment, pixel ratio) is rasterised once
 * into a small canvas and blitted with drawImage afterwards: a steady redraw
 * sets no font and draws no glyphs.
 *
 * The blit is snapped to the device-pixel grid so the copy is 1:1 (no
 * resampling blur); the text moves by at most half a device pixel.
 * Without a canvas factory (or a 2-D context) draw() falls back to plain
 * strokeText/fillText, so tests with fake contexts keep working.
 */

export const TEXT_SPRITES_MAX = 512;

/**
 * @param {(w: number, h: number) => ?HTMLCanvasElement} createCanvas
 */
export function createTextSprites(
  createCanvas,
  { max = TEXT_SPRITES_MAX } = {},
) {
  const cache = new Map();
  let usable = typeof createCanvas === 'function';
  let created = 0;
  let probe = null;

  function render(text, style, ratio) {
    const {
      font,
      fill,
      stroke = null,
      strokeWidth = 0,
      align = 'left',
      baseline = 'alphabetic',
      maxWidth,
    } = style;
    // measure with a scratch context in the label's own font/alignment
    probe ??= createCanvas(1, 1)?.getContext?.('2d') ?? null;
    const pctx = probe;
    if (!pctx || typeof pctx.measureText !== 'function') return null;
    pctx.font = font;
    pctx.textAlign = align;
    pctx.textBaseline = baseline;
    const m = pctx.measureText(text);
    // fillText's maxWidth squeezes the glyphs: the sprite is never wider
    const fit =
      Number.isFinite(maxWidth) && maxWidth > 0 ? maxWidth : undefined;
    if (!m || !Number.isFinite(m.width)) return null;
    const pad = Math.ceil(strokeWidth / 2) + 2;
    // actualBoundingBox* are relative to the anchor for this align/baseline
    const left = Number.isFinite(m.actualBoundingBoxLeft)
      ? m.actualBoundingBoxLeft
      : align === 'center'
        ? m.width / 2
        : align === 'right'
          ? m.width
          : 0;
    const right = Number.isFinite(m.actualBoundingBoxRight)
      ? m.actualBoundingBoxRight
      : m.width - left;
    const size = Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1]) || 12;
    const ascent = Number.isFinite(m.actualBoundingBoxAscent)
      ? m.actualBoundingBoxAscent
      : size;
    const descent = Number.isFinite(m.actualBoundingBoxDescent)
      ? m.actualBoundingBoxDescent
      : size / 2;
    // anchor inside the sprite, on the device-pixel grid
    const ax = Math.ceil((pad + Math.max(0, left)) * ratio) / ratio;
    const ay = Math.ceil((pad + Math.max(0, ascent)) * ratio) / ratio;
    const w = Math.max(1, Math.ceil((ax + Math.max(0, right) + pad) * ratio));
    const h = Math.max(1, Math.ceil((ay + Math.max(0, descent) + pad) * ratio));
    const canvas = createCanvas(w, h);
    const ctx = canvas?.getContext?.('2d');
    if (!ctx) return null;
    ctx.setTransform?.(ratio, 0, 0, ratio, 0, 0);
    ctx.font = font;
    ctx.textAlign = align;
    ctx.textBaseline = baseline;
    if (stroke && strokeWidth > 0) {
      ctx.lineWidth = strokeWidth;
      ctx.strokeStyle = stroke;
      ctx.lineJoin = 'miter';
      if (fit === undefined) ctx.strokeText(text, ax, ay);
      else ctx.strokeText(text, ax, ay, fit);
    }
    ctx.fillStyle = fill;
    if (fit === undefined) ctx.fillText(text, ax, ay);
    else ctx.fillText(text, ax, ay, fit);
    created++;
    return { canvas, w, h, ax, ay, ratio };
  }

  function sprite(text, style, ratio) {
    const key = `${ratio}\n${style.font}\n${style.fill}\n${style.stroke ?? ''}\n${style.strokeWidth ?? 0}\n${style.align ?? 'left'}\n${style.baseline ?? 'alphabetic'}\n${style.maxWidth ?? ''}\n${text}`;
    let entry = cache.get(key);
    if (entry === undefined) {
      entry = render(text, style, ratio);
      if (cache.size >= max) cache.clear();
      cache.set(key, entry);
      if (entry === null && created === 0) usable = false;
    }
    return entry;
  }

  /** Draw `text` anchored at (x, y) like fillText with the given style. */
  function draw(ctx, text, x, y, style, ratio = 1) {
    if (!text) return;
    const s = usable ? sprite(text, style, ratio) : null;
    if (s && typeof ctx.drawImage === 'function') {
      // snap the sprite's top-left to the device-pixel grid: a 1:1 copy
      const dx = Math.round((x - s.ax) * ratio) / ratio;
      const dy = Math.round((y - s.ay) * ratio) / ratio;
      ctx.drawImage(s.canvas, dx, dy, s.w / ratio, s.h / ratio);
      return;
    }
    ctx.font = style.font;
    ctx.textAlign = style.align ?? 'left';
    ctx.textBaseline = style.baseline ?? 'alphabetic';
    if (style.stroke && style.strokeWidth > 0) {
      ctx.lineWidth = style.strokeWidth;
      ctx.strokeStyle = style.stroke;
      if (style.maxWidth > 0) ctx.strokeText?.(text, x, y, style.maxWidth);
      else ctx.strokeText?.(text, x, y);
    }
    ctx.fillStyle = style.fill;
    if (style.maxWidth > 0) ctx.fillText(text, x, y, style.maxWidth);
    else ctx.fillText(text, x, y);
  }

  return {
    draw,
    get size() {
      return cache.size;
    },
    get rendered() {
      return created;
    },
    get usable() {
      return usable;
    },
  };
}
