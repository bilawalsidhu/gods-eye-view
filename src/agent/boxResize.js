/**
 * Pure resize geometry for the typed console's window.
 *
 * This was `src/ui/panelResize.js`, shared with the floating rail panels until
 * those were removed (fbbc4cda). The console is a dialog that owns its own
 * window rather than a panel lifted out of a rail, so it keeps the geometry
 * and leaves the rail panels docked.
 */

const EDGE_MARGIN_PX = 6;

/** The eight edges and corners a window can be dragged by. */
export const RESIZE_DIRECTIONS = ['n', 's', 'e', 'w', 'ne', 'nw', 'sw', 'se'];

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * Edges named in `dir` follow the pointer (dx, dy since gesture start) and the
 * opposite edge stays put. Minimum size and the viewport margin win.
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
