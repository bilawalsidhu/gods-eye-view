/**
 * Resolve a vertically centered panel slot inside a HUD rail while respecting
 * live rectangles that intersect that rail. A rectangle above the viewport
 * center lowers the top, one below it raises the bottom, and one across the
 * center puts the band on whichever side of it has more room, or leaves the
 * band as it is when neither side has any.
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
  // Every obstacle across the midpoint covers it, so together they cover one
  // span: from the highest top to the lowest bottom.
  let spanTop = Infinity;
  let spanBottom = -Infinity;

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
    else {
      spanTop = Math.min(spanTop, rect.top);
      spanBottom = Math.max(spanBottom, rect.bottom);
    }
  }
  // The band goes on whichever side of that span leaves more room, above it
  // on a tie. With no room on either side the band stays as it is.
  if (spanBottom > spanTop) {
    const roomAbove = spanTop - gap - safeTop;
    const roomBelow = safeBottom - (spanBottom + gap);
    if (roomBelow > roomAbove && roomBelow > 0) safeTop = spanBottom + gap;
    else if (roomAbove > 0) safeBottom = spanTop - gap;
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
