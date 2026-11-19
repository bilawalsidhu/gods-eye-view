/**
 * Resolve a vertically centered panel slot inside a HUD rail while respecting
 * live rectangles that intersect that rail. A rectangle above the viewport
 * center lowers the top, one below it raises the bottom, and one across the
 * center does whichever leaves the band more room.
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
  const straddling = [];

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
    if (rect.bottom <= midpoint) safeTop = Math.max(safeTop, rect.bottom + gap);
    else if (rect.top >= midpoint)
      safeBottom = Math.min(safeBottom, rect.top - gap);
    else straddling.push(rect);
  }
  // An obstacle across the midpoint (common in short windows) still limits
  // the band: the band goes on whichever side of it leaves more room.
  for (const rect of straddling) {
    const roomAbove = rect.top - gap - safeTop;
    const roomBelow = safeBottom - (rect.bottom + gap);
    if (roomBelow > roomAbove) safeTop = Math.max(safeTop, rect.bottom + gap);
    else safeBottom = Math.min(safeBottom, rect.top - gap);
  }

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
