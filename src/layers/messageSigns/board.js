import {
  BOARD_WIDTH_M,
  BOARD_HEIGHT_M,
  BOARD_PIXELS_PER_M,
  BOARD_PADDING_RATIO,
  BOARD_BACKGROUND,
  BOARD_TEXT,
  BOARD_BEZEL,
  GLYPH_PX,
} from './policy.js';

/**
 * Typography for one sign face: canvas size, font size and line positions.
 *
 * Separate from the drawing so it can be tested without a DOM — overflowing or
 * illegible text still renders, so the failure is silent otherwise.
 *
 * The font is sized to whichever constraint binds first, line count (height)
 * or longest line (width), so messages of any length fill the face.
 *
 * @param {string[]} textLines - Already trimmed, non-empty lines.
 * @param {object} [options]
 * @param {number} [options.widthM] - Board width in metres.
 * @param {number} [options.heightM] - Board height in metres.
 * @param {number} [options.pixelsPerM] - Texture resolution.
 * @param {string} [options.justification] - 'LEFT' | 'CENTER' | 'RIGHT'.
 * @returns {{width:number, height:number, fontPx:number, lineHeight:number,
 *   lines:Array<{text:string, x:number, y:number}>, textAlign:string}}
 */
export function layoutBoard(textLines, options = {}) {
  const {
    widthM = BOARD_WIDTH_M,
    heightM = BOARD_HEIGHT_M,
    pixelsPerM = BOARD_PIXELS_PER_M,
    justification = 'CENTER',
  } = options;

  const width = Math.max(1, Math.round(widthM * pixelsPerM));
  const height = Math.max(1, Math.round(heightM * pixelsPerM));
  const padding = Math.round(height * BOARD_PADDING_RATIO);
  const innerWidth = Math.max(1, width - padding * 2);
  const innerHeight = Math.max(1, height - padding * 2);

  const lines = (Array.isArray(textLines) ? textLines : [])
    .map((line) => String(line ?? ''))
    .filter((line) => line.length);
  if (!lines.length) {
    return {
      width,
      height,
      fontPx: 0,
      lineHeight: 0,
      lines: [],
      textAlign: 'center',
    };
  }

  // Height constraint: N lines plus leading must fit the lit area.
  const leading = 1.25;
  const byHeight = innerHeight / (lines.length * leading);
  // 0.6 is a monospace glyph's advance width as a fraction of its em size,
  // close enough across the stacks below that the longest line never overflows.
  const longest = lines.reduce((max, line) => Math.max(max, line.length), 1);
  const byWidth = innerWidth / (longest * 0.6);
  const fontPx = Math.max(8, Math.floor(Math.min(byHeight, byWidth)));
  const lineHeight = Math.round(fontPx * leading);

  const textAlign =
    justification === 'LEFT'
      ? 'left'
      : justification === 'RIGHT'
        ? 'right'
        : 'center';
  const x =
    textAlign === 'left'
      ? padding
      : textAlign === 'right'
        ? width - padding
        : Math.round(width / 2);

  // Vertically centre the block within the lit area.
  const blockHeight = lines.length * lineHeight;
  const top = Math.round((height - blockHeight) / 2);

  return {
    width,
    height,
    fontPx,
    lineHeight,
    textAlign,
    lines: lines.map((text, index) => ({
      text,
      x,
      // Baseline is 'middle', so each line sits at its own centre.
      y: top + index * lineHeight + Math.round(lineHeight / 2),
    })),
  };
}

/** Monospace stacks, so the character grid reads like a real board. */
const BOARD_FONT_STACK =
  "'Roboto Mono', 'DejaVu Sans Mono', Menlo, Consolas, monospace";

/**
 * Paint one sign face onto a 2D context using a computed layout.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {ReturnType<typeof layoutBoard>} layout
 */
export function drawBoard(ctx, layout) {
  const { width, height } = layout;
  ctx.clearRect(0, 0, width, height);

  // Bezel, then the lit face inset within it.
  ctx.fillStyle = BOARD_BEZEL;
  ctx.fillRect(0, 0, width, height);
  const inset = Math.max(2, Math.round(height * 0.03));
  ctx.fillStyle = BOARD_BACKGROUND;
  ctx.fillRect(inset, inset, width - inset * 2, height - inset * 2);

  if (!layout.lines.length) return;
  ctx.fillStyle = BOARD_TEXT;
  ctx.textAlign = layout.textAlign;
  ctx.textBaseline = 'middle';
  ctx.font = `600 ${layout.fontPx}px ${BOARD_FONT_STACK}`;
  // Glow, as a lit board has against night terrain.
  ctx.shadowColor = BOARD_TEXT;
  ctx.shadowBlur = Math.round(layout.fontPx * 0.3);
  for (const line of layout.lines) ctx.fillText(line.text, line.x, line.y);
  ctx.shadowBlur = 0;
}

/**
 * Render one page to a canvas usable as a Cesium billboard image. Returns null
 * when no canvas or 2D context is available, so the caller falls back to a
 * marker rather than throwing.
 *
 * @param {string[]} textLines
 * @param {object} [options] - Passed to layoutBoard; also `createCanvas`.
 * @returns {?HTMLCanvasElement}
 */
export function renderBoardCanvas(textLines, options = {}) {
  const {
    createCanvas = (w, h) => {
      if (typeof document === 'undefined') return null;
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      return canvas;
    },
    ...layoutOptions
  } = options;
  const layout = layoutBoard(textLines, layoutOptions);
  const canvas = createCanvas(layout.width, layout.height);
  const ctx = canvas?.getContext?.('2d');
  if (!ctx) return null;
  drawBoard(ctx, layout);
  return canvas;
}

/**
 * Small board glyph used as the sign's marker: a dark housing with amber text
 * bars on a post, in the same visual language as the face it stands in for.
 *
 * @param {object} [options]
 * @param {number} [options.lines] - Text bars to draw (1-3).
 * @param {boolean} [options.selected] - Draw the selected treatment.
 * @param {Function} [options.createCanvas]
 * @returns {?HTMLCanvasElement}
 */
export function renderSignGlyphCanvas({
  lines = 3,
  selected = false,
  createCanvas = (w, h) => {
    if (typeof document === 'undefined') return null;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    return canvas;
  },
} = {}) {
  const W = GLYPH_PX;
  const H = GLYPH_PX;
  const canvas = createCanvas(W, H);
  const ctx = canvas?.getContext?.('2d');
  if (!ctx) return null;

  ctx.clearRect(0, 0, W, H);
  const boardW = Math.round(W * 0.78);
  const boardH = Math.round(H * 0.5);
  const x = Math.round((W - boardW) / 2);
  const y = Math.round(H * 0.1);

  // Post, so the glyph reads as a roadside structure, not a label.
  ctx.strokeStyle = selected ? '#ffffff' : BOARD_BEZEL;
  ctx.lineWidth = Math.max(2, Math.round(W * 0.07));
  ctx.beginPath();
  ctx.moveTo(Math.round(W / 2), y + boardH);
  ctx.lineTo(Math.round(W / 2), H - 1);
  ctx.stroke();

  // Housing.
  ctx.fillStyle = BOARD_BACKGROUND;
  ctx.fillRect(x, y, boardW, boardH);
  ctx.strokeStyle = selected ? '#ffffff' : BOARD_TEXT;
  ctx.lineWidth = Math.max(1.5, Math.round(W * 0.05));
  ctx.strokeRect(x, y, boardW, boardH);

  // Text bars, one per line the real board is showing.
  const count = Math.max(1, Math.min(3, Math.round(lines)));
  const barH = Math.max(1, Math.round(boardH * 0.13));
  const gap = Math.round((boardH - count * barH) / (count + 1));
  ctx.fillStyle = selected ? '#ffffff' : BOARD_TEXT;
  for (let i = 0; i < count; i++) {
    const barW = Math.round(boardW * (i === count - 1 ? 0.42 : 0.64));
    ctx.fillRect(
      Math.round(x + (boardW - barW) / 2),
      y + gap + i * (barH + gap),
      barW,
      barH,
    );
  }
  return canvas;
}
