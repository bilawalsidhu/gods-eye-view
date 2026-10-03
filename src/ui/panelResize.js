/**
 * Pure geometry for resizing a floating panel from any edge or corner. The
 * DOM wiring lives in PanelPositionControls; this module only decides boxes.
 */

/** Viewport margin a resized panel keeps clear on every side. */
const EDGE_MARGIN_PX = 6;
/** Resize directions: compass edges first, then corners. */
export const RESIZE_DIRECTIONS = ['n', 's', 'e', 'w', 'ne', 'nw', 'sw', 'se'];

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * Work out the box a resize gesture produces. Edges named in `dir` move with
 * the pointer; the opposite edge stays put, so growing from the left keeps
 * the right side pinned. Minimum size and the viewport margin win over the
 * pointer.
 * @param {{left: number, top: number, width: number, height: number}} box Box at gesture start.
 * @param {string} dir One of RESIZE_DIRECTIONS.
 * @param {number} dx Pointer travel since gesture start.
 * @param {number} dy Pointer travel since gesture start.
 * @param {object} [limits]
 * @param {number} limits.minWidth
 * @param {number} limits.minHeight
 * @param {number} [limits.viewportWidth=Infinity]
 * @param {number} [limits.viewportHeight=Infinity]
 * @param {number} [limits.margin=6]
 * @returns {{left: number, top: number, width: number, height: number}}
 */
export function resizeBox(
  box,
  dir,
  dx,
  dy,
  {
    minWidth,
    minHeight,
    viewportWidth = Infinity,
    viewportHeight = Infinity,
    margin = EDGE_MARGIN_PX,
  } = {},
) {
  let { left, top, width, height } = box;
  const right = box.left + box.width;
  const bottom = box.top + box.height;
  if (dir.includes('e'))
    width = clamp(box.width + dx, minWidth, viewportWidth - margin - box.left);
  if (dir.includes('s'))
    height = clamp(
      box.height + dy,
      minHeight,
      viewportHeight - margin - box.top,
    );
  if (dir.includes('w')) {
    width = clamp(box.width - dx, minWidth, right - margin);
    left = right - width;
  }
  if (dir.includes('n')) {
    height = clamp(box.height - dy, minHeight, bottom - margin);
    top = bottom - height;
  }
  return { left, top, width, height };
}
