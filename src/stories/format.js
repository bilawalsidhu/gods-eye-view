/** Index of the chapter playing at a wall position (milliseconds). */
export function chapterAt(story, w) {
  let k = 0;
  story.chapters.forEach((c, i) => {
    if (w >= c.wallMs) k = i;
  });
  return k;
}

/**
 * Where GEV's credit line sits while Stories is open: inside the map's bottom
 * left, clear of Explore's desktop feed when that covers the map's left side
 * (on a phone the feed is a sheet below the map). Null when there is no map,
 * so GEV's own placement applies.
 * @param {{map?: DOMRect|null, feed?: DOMRect|null, width: number, height: number}} view
 * @returns {{bottom: number, left: number} | null} Pixels from the window's bottom and left.
 */
export function creditPlacement({ map, feed, width, height }) {
  if (!map?.width) return null;
  const besideFeed =
    !!feed?.width &&
    feed.left <= map.left + 1 &&
    feed.right < map.right &&
    feed.top < map.bottom - 1 &&
    feed.bottom >= map.bottom - 1;
  const gap = width <= 720 ? 10 : 24;
  return {
    bottom: Math.max(0, height - map.bottom) + 6,
    left: besideFeed ? feed.right + 14 : map.left + gap,
  };
}

/**
 * The controls in GEV's top-right corner: the ACTIVE STYLE readout
 * (`#style-indicator`) and any element marked with `data-stories-corner`.
 * @param {Document|Element} root Where to look.
 * @returns {Element[]}
 */
export function cornerControls(root) {
  return [
    root.querySelector('#style-indicator'),
    ...root.querySelectorAll('[data-stories-corner]'),
  ].filter(Boolean);
}

/**
 * Where the Stories button sits: just left of the leftmost visible control
 * in GEV's top-right corner — the ACTIVE STYLE readout, or an element marked
 * with `data-stories-corner` (with or beside the readout) — top-aligned with
 * it.
 * Where none of those shows (GEV's phone layout, whose top row of icon
 * buttons spans the corner), it goes icon-only just under the right-hand
 * column of corner actions, aligned with its right edge.
 * @param {Array<DOMRect|null|undefined>} corner The corner controls' boxes.
 * @param {number} width The window's width.
 * @param {DOMRect|null} [column] The corner-actions column's box.
 * @returns {{top: number, right: number, compact?: boolean}} Pixels from
 *   the top and right; `compact` for the icon-only button.
 */
export function entryPlacement(corner, width, column = null) {
  const shown = corner.filter((r) => r && r.width > 0 && r.height > 0);
  if (shown.length) {
    const left = shown.reduce((a, b) => (b.left < a.left ? b : a));
    return { top: left.top, right: width - left.left + 10 };
  }
  if (column && column.width > 0 && column.height > 0)
    return {
      top: Math.round(column.bottom + 8),
      right: Math.round(width - column.right),
      compact: true,
    };
  return { top: 14, right: 14 };
}
