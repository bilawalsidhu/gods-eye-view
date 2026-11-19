/**
 * Resolve a vertically centered panel slot inside a HUD rail while respecting
 * live rectangles that intersect that rail. A rectangle above the viewport
 * center lowers the top and one below it raises the bottom. Rectangles across
 * the center put the band beside them (bandBesideMidpointObstacles); with no
 * room on either side they are left out, as before.
 */
export function resolveHudRailLayout({
  viewportHeight,
  panelHeight,
  laneLeft,
  laneRight,
  obstacles = [],
  baseTop,
  baseBottom,
  gap = 12,
  align = 'center',
}) {
  if (
    ![
      viewportHeight,
      panelHeight,
      laneLeft,
      laneRight,
      baseTop,
      baseBottom,
    ].every(Number.isFinite) ||
    viewportHeight <= 0 ||
    laneRight <= laneLeft
  )
    return null;
  const midpoint = viewportHeight * 0.5;
  let safeTop = Math.max(0, baseTop);
  let safeBottom = Math.min(viewportHeight, baseBottom);
  const inLane = [];

  for (const rect of obstacles) {
    if (
      ![rect?.left, rect?.right, rect?.top, rect?.bottom].every(Number.isFinite)
    )
      continue;
    if (
      rect.right <= laneLeft ||
      rect.left >= laneRight ||
      rect.bottom <= rect.top
    )
      continue;
    inLane.push(rect);
    if (rect.bottom <= midpoint) safeTop = Math.max(safeTop, rect.bottom + gap);
    else if (rect.top >= midpoint)
      safeBottom = Math.min(safeBottom, rect.top - gap);
  }
  const beside = bandBesideMidpointObstacles({
    midpoint,
    top: Math.max(0, baseTop),
    bottom: Math.min(viewportHeight, baseBottom),
    obstacles: inLane,
    gap,
    // A side thinner than this holds no usable panel.
    minimum: viewportHeight * 0.08,
  });
  if (beside) ({ top: safeTop, bottom: safeBottom } = beside);

  safeBottom = Math.max(safeTop, safeBottom);
  const availableHeight = Math.max(0, safeBottom - safeTop);
  const renderedHeight = Math.min(Math.max(0, panelHeight), availableHeight);
  return {
    top:
      align === 'start'
        ? safeTop
        : safeTop + Math.max(0, (availableHeight - renderedHeight) * 0.5),
    maxHeight: availableHeight,
    safeTop,
    safeBottom,
    constrained: panelHeight > availableHeight,
  };
}

/**
 * Where a rail's band goes when obstacles cross the viewport midpoint, as in
 * short windows. Those obstacles, and any other that leaves no band between
 * itself and them, form one block; the band takes whichever side of the block
 * has more room between it and the next obstacle or the band's own edge,
 * above on a tie.
 * @param {object} input
 * @param {number} input.midpoint The viewport's vertical midpoint.
 * @param {number} input.top The band's highest top.
 * @param {number} input.bottom The band's lowest bottom.
 * @param {Array<{top: number, bottom: number}>} input.obstacles Rectangles that reach the rail.
 * @param {number} input.gap Space kept between the band and an obstacle.
 * @param {number} [input.minimum=0] The least room a side needs to count;
 *   a thinner side is no room at all.
 * @returns {{side: 'above' | 'below', top: number, bottom: number} | null}
 *   Null when nothing crosses the midpoint or neither side has room.
 */
export function bandBesideMidpointObstacles({
  midpoint,
  top,
  bottom,
  obstacles,
  gap,
  minimum = 0,
}) {
  const crossing = obstacles.filter(
    (rect) => rect.top < midpoint && rect.bottom > midpoint,
  );
  if (!crossing.length) return null;
  let blockTop = Math.min(...crossing.map((rect) => rect.top));
  let blockBottom = Math.max(...crossing.map((rect) => rect.bottom));
  for (let grown = true; grown;) {
    grown = false;
    for (const rect of obstacles) {
      const touches =
        rect.top <= blockBottom + 2 * gap && rect.bottom >= blockTop - 2 * gap;
      if (touches && (rect.top < blockTop || rect.bottom > blockBottom)) {
        blockTop = Math.min(blockTop, rect.top);
        blockBottom = Math.max(blockBottom, rect.bottom);
        grown = true;
      }
    }
  }
  let aboveTop = top;
  let belowBottom = bottom;
  for (const rect of obstacles) {
    if (rect.bottom <= blockTop)
      aboveTop = Math.max(aboveTop, rect.bottom + gap);
    else if (rect.top >= blockBottom)
      belowBottom = Math.min(belowBottom, rect.top - gap);
  }
  const above = {
    side: 'above',
    top: aboveTop,
    bottom: Math.min(bottom, blockTop - gap),
  };
  const below = {
    side: 'below',
    top: Math.max(top, blockBottom + gap),
    bottom: belowBottom,
  };
  const roomAbove = above.bottom - above.top;
  const roomBelow = below.bottom - below.top;
  const fits = (room) => room > 0 && room >= minimum;
  if (roomBelow > roomAbove && fits(roomBelow)) return below;
  return fits(roomAbove) ? above : null;
}

/**
 * Whether the Tactical layout hid collapsed right panels beside an expanded
 * one. The rail now enforces one open panel per side in every layout; this
 * stays exported from `./ui/layout` for hosts that imported it.
 * @deprecated
 */
export function shouldHideCollapsedRightPanels({
  hudVariant,
  hasExpandedPanel,
}) {
  return hudVariant === 'tactical' && Boolean(hasExpandedPanel);
}
