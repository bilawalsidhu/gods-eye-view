/**
 * Fits expanded panels into a shared vertical corridor. Natural heights are
 * retained when they fit; constrained panels keep a usable floor and share
 * the remaining room in proportion to their unmet height.
 *
 * @param {object} input Layout measurements.
 * @param {number[]} input.naturalHeights Expanded-panel natural heights.
 * @param {number} input.availableHeight Height available to expanded panels.
 * @param {number} [input.minimumHeight=96] Preferred usable floor per panel.
 * @returns {number[]} One allocated height per expanded panel.
 */
export function allocatePanelStackHeights({
  naturalHeights,
  availableHeight,
  minimumHeight = 96,
}) {
  const natural = naturalHeights.map((height) => Math.max(0, Number(height) || 0));
  if (!natural.length) return [];

  const available = Math.max(0, Number(availableHeight) || 0);
  const naturalTotal = natural.reduce((sum, height) => sum + height, 0);
  if (naturalTotal <= available) return natural;
  if (available === 0) return natural.map(() => 0);

  const preferredFloor = Math.max(0, Number(minimumHeight) || 0);
  const base = natural.map((height) => Math.min(height, preferredFloor));
  const baseTotal = base.reduce((sum, height) => sum + height, 0);
  if (baseTotal >= available) {
    const scale = baseTotal > 0 ? available / baseTotal : 0;
    return base.map((height) => height * scale);
  }

  const remaining = available - baseTotal;
  const unmet = natural.map((height, index) => Math.max(0, height - base[index]));
  const unmetTotal = unmet.reduce((sum, height) => sum + height, 0);
  if (unmetTotal <= 0) return base;
  return base.map((height, index) => height + remaining * (unmet[index] / unmetTotal));
}

/**
 * Solves the accordion corridor's bottom boundary against the obstacles that
 * still limit it.
 *
 * Every painted obstacle limits the corridor. This includes Cockpit CONTACT
 * and peripheral HUD surfaces, so reopening a map panel cannot cover them.
 *
 * @param {object} input Corridor measurements.
 * @param {number} input.baseBottom Viewport-inset bottom boundary, in px.
 * @param {Array<{top: number}>} [input.obstacles] Live obstacle tops.
 * @param {number} [input.safeGap=0] Clearance kept above each obstacle, in px.
 * @returns {number} Bottom boundary in px.
 */
export function resolveLeftStackBottomBoundary({
  baseBottom,
  obstacles = [],
  safeGap = 0,
}) {
  let bottom = Number(baseBottom) || 0;
  const gap = Number(safeGap) || 0;
  for (const obstacle of obstacles) {
    const top = Number(obstacle?.top);
    if (!Number.isFinite(top)) continue;
    bottom = Math.min(bottom, top - gap);
  }
  return bottom;
}

/**
 * Returns later expanded panels whose allocation would expose less than the
 * requested share of their intrinsic height. The first panel always remains
 * expanded so every lane keeps one useful primary surface.
 *
 * @param {object} input Panel height measurements.
 * @param {number[]} input.naturalHeights Intrinsic expanded heights.
 * @param {number[]} input.allocatedHeights Allocated expanded heights.
 * @param {number} [input.minimumVisibleRatio=0.5] Minimum useful height share.
 * @param {boolean} [input.collapseLaterPanels=false] Collapse every competitor after the primary panel.
 * @returns {number[]} Candidate indices to present as collapsed controls.
 */
export function panelStackAutoCollapseIndices({
  naturalHeights,
  allocatedHeights,
  minimumVisibleRatio = 0.5,
  collapseLaterPanels = false,
}) {
  const threshold = Math.max(0, Number(minimumVisibleRatio) || 0);
  const collapsed = [];
  for (let index = 1; index < naturalHeights.length; index += 1) {
    if (collapseLaterPanels) {
      collapsed.push(index);
      continue;
    }
    const natural = Math.max(0, Number(naturalHeights[index]) || 0);
    const allocated = Math.max(0, Number(allocatedHeights[index]) || 0);
    if (natural > 0 && allocated / natural < threshold) collapsed.push(index);
  }
  return collapsed;
}

/**
 * Balance a desktop panel corridor around the viewport midpoint without
 * crossing its measured obstacle boundaries. If centering would shrink the
 * lane below its usable minimum, retain the original aligned corridor.
 *
 * @param {object} input Corridor measurements.
 * @param {number} input.viewportHeight Current viewport height.
 * @param {number} input.safeTop Proposed corridor top.
 * @param {number} input.safeBottom Proposed corridor bottom.
 * @param {number} input.obstacleSafeTop Highest obstacle-safe top boundary.
 * @param {number} input.obstacleSafeBottom Lowest obstacle-safe bottom boundary.
 * @param {number} input.minimumHeight Minimum useful lane height.
 * @returns {{ safeTop: number, safeBottom: number }} Bounded corridor.
 */
export function resolvePanelStackCorridor({
  viewportHeight,
  safeTop,
  safeBottom,
  obstacleSafeTop,
  obstacleSafeBottom,
  minimumHeight,
}) {
  const height = Math.max(1, Number(viewportHeight) || 1);
  const boundaryTop = Math.max(0, Number(obstacleSafeTop) || 0);
  const boundaryBottom = Math.max(
    boundaryTop,
    Math.min(height, Number(obstacleSafeBottom) || 0),
  );
  let top = Math.max(boundaryTop, Math.min(boundaryBottom, Number(safeTop) || 0));
  let bottom = Math.max(top, Math.min(boundaryBottom, Number(safeBottom) || 0));
  const minimum = Math.max(0, Number(minimumHeight) || 0);
  const midpoint = height * 0.5;

  if (top < midpoint && bottom > midpoint) {
    const centeredHalfHeight = Math.min(midpoint - top, bottom - midpoint);
    const centeredTop = midpoint - centeredHalfHeight;
    const centeredBottom = midpoint + centeredHalfHeight;
    if (centeredBottom - centeredTop >= minimum) {
      top = centeredTop;
      bottom = centeredBottom;
    }
  }

  if (bottom - top < minimum) {
    top = Math.max(boundaryTop, bottom - minimum);
    bottom = Math.min(boundaryBottom, Math.max(bottom, top + minimum));
  }

  return { safeTop: top, safeBottom: bottom };
}

/**
 * Clamps a panel's left/top coordinate so it remains safely bounded inside the
 * viewport corridor, with fallback dimensions when measurements are 0 or unrendered.
 *
 * @param {object} input Coordinate and dimension parameters.
 * @param {number} input.left Desired left position in px.
 * @param {number} input.top Desired top position in px.
 * @param {number} [input.width] Measured panel width in px.
 * @param {number} [input.height] Measured panel height in px.
 * @param {number} input.viewportWidth Current window/viewport inner width.
 * @param {number} input.viewportHeight Current window/viewport inner height.
 * @param {number} [input.inset=6] Minimum distance from viewport edge in px.
 * @param {number} [input.fallbackWidth=320] Default width when measurement is unavailable or 0.
 * @param {number} [input.fallbackHeight=200] Default height when measurement is unavailable or 0.
 * @returns {{ left: number, top: number }} Safe bounded coordinates.
 */
export function clampPanelToViewport({
  left,
  top,
  width,
  height,
  viewportWidth,
  viewportHeight,
  inset = 6,
  fallbackWidth = 320,
  fallbackHeight = 200,
}) {
  const safeInset = Math.max(0, Number(inset) || 0);
  const vw = Math.max(1, Number(viewportWidth) || 1);
  const vh = Math.max(1, Number(viewportHeight) || 1);

  const rawWidth = Number(width);
  const w = (Number.isFinite(rawWidth) && rawWidth > 0) ? rawWidth : fallbackWidth;

  const rawHeight = Number(height);
  const h = (Number.isFinite(rawHeight) && rawHeight > 0) ? rawHeight : fallbackHeight;

  const maxLeft = Math.max(safeInset, vw - w - safeInset);
  const maxTop = Math.max(safeInset, vh - h - safeInset);

  const targetLeft = Number.isFinite(Number(left)) ? Number(left) : safeInset;
  const targetTop = Number.isFinite(Number(top)) ? Number(top) : safeInset;

  return {
    left: Math.round(Math.max(safeInset, Math.min(maxLeft, targetLeft))),
    top: Math.round(Math.max(safeInset, Math.min(maxTop, targetTop))),
  };
}

