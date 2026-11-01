/**
 * Greedy label collision for the Sky view overlay.
 * Candidates are placed in priority order (higher first, ties keep input
 * order); a candidate whose box overlaps an already placed box, a reserved
 * box (horizon cardinal labels, compass strip, panels) or leaves the canvas
 * is dropped. Pure; a uniform grid keeps it O(n) for the few hundred labels
 * a sky can carry.
 */

const CELL = 64;

/** Box of a label anchored at (x, y) with an alignment. */
export function labelBox({ x, y, width, height, align = 'left', pad = 2 }) {
  const left =
    align === 'center' ? x - width / 2 : align === 'right' ? x - width : x;
  return {
    x0: left - pad,
    y0: y - height / 2 - pad,
    x1: left + width + pad,
    y1: y + height / 2 + pad,
  };
}

export const boxesOverlap = (a, b) =>
  a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

/**
 * @param {Array<{text, x, y, width, height, priority, align?}>} candidates
 * @param {{width:number, height:number, reserved?:Array<{x0,y0,x1,y1}>}} area
 * @returns {Array} placed candidates, each with its `box`
 */
export function placeLabels(candidates, { width, height, reserved = [] }) {
  const grid = new Map();
  const cellsOf = (box) => {
    const keys = [];
    for (
      let cx = Math.floor(box.x0 / CELL);
      cx <= Math.floor(box.x1 / CELL);
      cx++
    )
      for (
        let cy = Math.floor(box.y0 / CELL);
        cy <= Math.floor(box.y1 / CELL);
        cy++
      )
        keys.push(`${cx},${cy}`);
    return keys;
  };
  const add = (box) => {
    for (const key of cellsOf(box)) {
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(box);
    }
  };
  const hits = (box) =>
    cellsOf(box).some((key) =>
      (grid.get(key) || []).some((other) => boxesOverlap(box, other)),
    );
  for (const box of reserved) add(box);
  const order = candidates
    .map((candidate, i) => ({ candidate, i }))
    .sort(
      (a, b) =>
        (b.candidate.priority || 0) - (a.candidate.priority || 0) || a.i - b.i,
    );
  const placed = [];
  for (const { candidate } of order) {
    const box = labelBox(candidate);
    if (box.x0 < 0 || box.y0 < 0 || box.x1 > width || box.y1 > height) continue;
    if (hits(box)) continue;
    add(box);
    placed.push({ ...candidate, box });
  }
  return placed;
}

// Measured widths per (font, text). Labels repeat every frame and setting
// ctx.font + measureText per label per frame showed up in the redraw profile.
const widthCache = new Map();
const WIDTH_CACHE_MAX = 4000;

/** Text width: the canvas measure when there is one, else an estimate. */
export function textWidth(ctx, text, font) {
  if (ctx?.measureText) {
    // only cache with an explicit font (otherwise the width depends on
    // whatever font the context last had)
    const key = font ? `${font}\n${text}` : null;
    const cached = key === null ? undefined : widthCache.get(key);
    if (cached !== undefined) return cached;
    if (font) ctx.font = font;
    const width = ctx.measureText(text)?.width;
    if (Number.isFinite(width) && width > 0) {
      if (key !== null) {
        if (widthCache.size >= WIDTH_CACHE_MAX) widthCache.clear();
        widthCache.set(key, width);
      }
      return width;
    }
  }
  const size = Number(/(\d+(?:\.\d+)?)px/.exec(font || '')?.[1]) || 12;
  return text.length * size * 0.58;
}
