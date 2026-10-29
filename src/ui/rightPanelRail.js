import { allocatePanelStackHeights } from '../panelStackLayout.js';
import { resolveHudRailLayout } from './panelRailGeometry.js';

import { displayPanelScroller } from './displayPanelScroll.js';
import { MOBILE_SHELL_MEDIA_QUERY } from './mobileShellContract.js';

/**
 * Where the left rail's top will settle, not where it is mid-transition:
 * nothing re-runs this pass when the `top` animation ends (ResizeObserver
 * ignores moves). Returns NaN when there is no left rail.
 */
function settledLeftRailTop(leftStack, viewportHeight, getComputedStyle) {
  const top = leftStack?.getBoundingClientRect().top;
  if (!Number.isFinite(top)) return NaN;
  const transition = leftStack
    .getAnimations?.()
    .find((animation) => animation.transitionProperty === 'top');
  if (!transition) return top;
  const keyframes = transition.effect?.getKeyframes?.() || [];
  const targetTop = parseFloat(keyframes.at(-1)?.top);
  const currentTop = parseFloat(getComputedStyle(leftStack).top);
  // The rect and the computed `top` move together; keep any offset between them.
  if (Number.isFinite(targetTop) && Number.isFinite(currentTop))
    return top + targetTop - currentTop;
  const targetPct = parseFloat(leftStack.dataset?.safeTopPct);
  return Number.isFinite(targetPct) ? (targetPct * viewportHeight) / 100 : top;
}

/**
 * Measure and place the right panel rail for one synchronous layout pass.
 * The caller owns scheduling, obstacle selection, disclosure preferences and
 * persistence. The rail presents its panels as vertical tabs
 * (rightRailTabs.js): one owner stays expanded, its peers are
 * presentation-collapsed and hidden, and the owner takes the whole lane. The
 * lane's top follows the left rail's, lifted toward the HUD above when the tab
 * strip's column (rightRailTabs.js) is taller than the lane.
 * @param {object} options Live DOM and caller policy.
 * @param {HTMLElement} options.stack Rail element.
 * @param {Iterable<HTMLElement>} options.obstacles Caller-selected obstacle nodes.
 * @param {Window} options.windowRef Viewport and style reader.
 * @param {string} options.preferredPanelId Most recently opened panel.
 * @param {Function} options.onCollapse Update a panel's disclosure chrome.
 * @param {Function} [options.getComputedStyle] Optional DOM style reader override.
 * @param {HTMLElement} options.leftStack Rail supplying the shared top baseline.
 * @param {HTMLElement} options.displayPanel Panel whose allocation owns its scroll.
 * @param {Function} options.readDisplayScrollTop Read the caller's scroll restoration value.
 * @param {Document} [options.documentRef] Document supplying current keyboard focus.
 */
export function layoutRightPanelRail({
  stack,
  obstacles,
  windowRef,
  preferredPanelId,
  onCollapse,
  leftStack,
  displayPanel,
  readDisplayScrollTop,
  documentRef = stack?.ownerDocument,
  getComputedStyle = (element) => windowRef.getComputedStyle(element),
}) {
  if (!stack) return;

  // Other CSS may hide a panel, such as an event view: it is not laid out.
  // Exclusive presentation hides collapsed panels itself; those stay in the
  // rail so they can be restored.
  const hiddenByRail = (panel) =>
    stack.classList.contains('layout-exclusive') &&
    panel.classList.contains('collapsed');
  const panels = [...stack.children].filter(
    (panel) =>
      panel.matches('[data-panel-id]') &&
      !panel.hidden &&
      (hiddenByRail(panel) || getComputedStyle(panel).display !== 'none'),
  );
  // One expanded owner: the latest explicit disclosure, else the focused
  // panel, else one the visitor or a share link chose over one open only by
  // default (panelPositionControls.js marks each), else the first. Peers are
  // presentation-collapsed; the marker is distinct from the left rail's
  // space-based collapse. Phone sheets show several panels at once, so phones
  // get every panel back.
  const isMobile = windowRef.matchMedia(MOBILE_SHELL_MEDIA_QUERY).matches;
  if (!isMobile) {
    const expanded = panels.filter(
      (panel) => !panel.classList.contains('collapsed'),
    );
    const owner =
      expanded.find((panel) => panel.id === preferredPanelId) ||
      expanded.find((panel) => panel.contains(documentRef?.activeElement)) ||
      expanded.find(
        (panel) => panel.dataset?.collapsedPreference !== 'default',
      ) ||
      expanded[0];
    for (const panel of expanded) {
      if (panel === owner) continue;
      panel.classList.add('collapsed', 'rail-owner-collapsed');
      onCollapse(panel);
    }
  } else {
    for (const panel of panels) {
      if (!panel.classList.contains('rail-owner-collapsed')) continue;
      panel.classList.remove('collapsed', 'rail-owner-collapsed');
      onCollapse(panel);
    }
  }
  // The tab strip is the launcher, so collapsed panels hide. Phones present
  // the rail as tab sheets (mobileShell.js), which choose what shows; hiding
  // collapsed siblings would empty a sheet and its a11y tree.
  const exclusive = !isMobile;
  stack.classList.toggle('layout-exclusive', exclusive);
  for (const panel of panels) {
    if (exclusive && panel.classList.contains('collapsed'))
      panel.setAttribute('aria-hidden', 'true');
    else panel.removeAttribute('aria-hidden');
  }

  if (isMobile) {
    stack.classList.remove('layout-focus');
    stack.style.removeProperty('--right-stack-safe-top');
    stack.style.removeProperty('--right-stack-max-height');
    for (const panel of panels)
      panel.style.removeProperty('--right-panel-allocated-height');
    stack.dataset.layoutMode = 'mobile';
    return;
  }

  const viewportHeight = Math.max(1, windowRef.innerHeight);
  const safeGap = Math.max(8, viewportHeight * 0.012);
  const stackRect = stack.getBoundingClientRect();
  const leftStackTop = settledLeftRailTop(
    leftStack,
    viewportHeight,
    getComputedStyle,
  );
  const alignedTop = Number.isFinite(leftStackTop)
    ? leftStackTop
    : viewportHeight * 0.26;
  const obstacleRects = [];

  for (const obstacle of obstacles) {
    if (stack.contains(obstacle)) continue;
    let hiddenByAncestor = false;
    for (let element = obstacle; element; element = element.parentElement) {
      const style = getComputedStyle(element);
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        Number(style.opacity) === 0
      ) {
        hiddenByAncestor = true;
        break;
      }
    }
    if (hiddenByAncestor) continue;
    const rect = obstacle.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    obstacleRects.push({
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
    });
  }

  // Exclusive presentation hides collapsed panels, so only visible panels
  // take room in the lane.
  const visiblePanels = panels.filter(
    (panel) => !exclusive || !panel.classList.contains('collapsed'),
  );
  const displayScrollTop = readDisplayScrollTop();
  // Measuring lifts each opted-in scroller's max-height, which clamps its
  // scroll offset; remember the offsets to put back afterwards.
  const scrollers = [
    ...(stack.querySelectorAll?.('[data-rail-scroller]') || []),
  ]
    .map((node) => [node, node.scrollTop || 0])
    .filter(([, top]) => top > 0);
  const naturalHeights = new Map();
  // The tab strip's column stands beside the panels at its natural height.
  const column = stack.querySelector?.(':scope > #right-rail-column');
  let columnHeight = 0;
  // Remove live height allocations through a synchronous CSS override. Keeping
  // the stored properties intact avoids REMOVE/SET churn on unchanged panels.
  // Do not toggle layout classes here: the class observer schedules new passes.
  stack.setAttribute('data-rail-measuring', '');
  try {
    for (const panel of visiblePanels) {
      naturalHeights.set(
        panel,
        Math.max(
          panel.getBoundingClientRect().height,
          panel.scrollHeight || 0,
          panel.classList.contains('collapsed') ? 42 : 0,
        ),
      );
    }
    columnHeight = column?.getBoundingClientRect().height || 0;
  } finally {
    stack.removeAttribute('data-rail-measuring');
    for (const [node, top] of scrollers)
      if (node.scrollTop !== top) node.scrollTop = top;
  }
  const gap = parseFloat(getComputedStyle(stack).rowGap) || 0;
  const naturalHeight =
    visiblePanels.reduce(
      (total, panel) => total + naturalHeights.get(panel),
      0,
    ) +
    gap * Math.max(0, visiblePanels.length - 1);
  const resolve = (baseTop) =>
    resolveHudRailLayout({
      viewportHeight,
      panelHeight: naturalHeight,
      laneLeft: stackRect.left,
      laneRight: stackRect.right,
      obstacles: obstacleRects,
      baseTop,
      baseBottom: viewportHeight * 0.96,
      gap: safeGap,
      align: 'start',
    });
  let layout = resolve(alignedTop);
  if (!layout) return;
  // A lane too short for the strip's column: the rail climbs toward the HUD
  // above, as far as the strip needs and the obstacles allow. A lane still
  // shorter leaves the strip running past the lane's end.
  const shortfall = columnHeight - (layout.safeBottom - layout.safeTop);
  if (shortfall > 0) layout = resolve(alignedTop - shortfall) || layout;
  const { safeTop, safeBottom, maxHeight: availableHeight } = layout;
  const stabilityBand = Math.max(48, viewportHeight * 0.06);
  const wasFocused = stack.classList.contains('layout-focus');
  const shouldFocus = wasFocused
    ? naturalHeight >= availableHeight - stabilityBand
    : naturalHeight > availableHeight;
  const layoutTop = shouldFocus ? safeTop : layout.top;
  const collapsedHeight = visiblePanels.reduce(
    (total, panel) =>
      panel.classList.contains('collapsed')
        ? total + naturalHeights.get(panel)
        : total,
    0,
  );
  const expandedPanels = visiblePanels.filter(
    (panel) => !panel.classList.contains('collapsed'),
  );
  const expandedAvailableHeight = Math.max(
    0,
    safeBottom -
      layoutTop -
      collapsedHeight -
      gap * Math.max(0, visiblePanels.length - 1),
  );
  const expandedHeights = allocatePanelStackHeights({
    naturalHeights: expandedPanels.map((panel) => naturalHeights.get(panel)),
    availableHeight: expandedAvailableHeight,
  });
  // Write-if-changed. This pass runs on the 500 ms stats cadence. Rewriting
  // an unchanged allocation wakes the world-overlay occluder observer and
  // defeats parked-idle render savings. Measurement leaves these values intact.
  expandedPanels.forEach((panel, index) => {
    const next = `${expandedHeights[index].toFixed(1)}px`;
    if (
      panel.style.getPropertyValue('--right-panel-allocated-height') !== next
    ) {
      panel.style.setProperty('--right-panel-allocated-height', next);
    }
  });
  for (const panel of panels) {
    if (expandedPanels.includes(panel)) continue;
    panel.style.removeProperty('--right-panel-allocated-height');
  }

  stack.style.setProperty(
    '--right-stack-safe-top',
    `${layoutTop.toFixed(1)}px`,
  );
  stack.style.setProperty(
    '--right-stack-max-height',
    `${Math.max(0, safeBottom - layoutTop).toFixed(1)}px`,
  );
  stack.classList.toggle('layout-focus', shouldFocus);
  stack.dataset.layoutMode = shouldFocus ? 'focus' : 'normal';
  stack.dataset.safeTop = layoutTop.toFixed(1);
  stack.dataset.safeBottom = safeBottom.toFixed(1);
  stack.dataset.availableHeight = availableHeight.toFixed(1);
  stack.dataset.requiredHeight = naturalHeight.toFixed(1);
  stack.dataset.expandedCount = String(expandedPanels.length);

  if (displayPanel && expandedPanels.includes(displayPanel)) {
    const scroller = displayPanelScroller(displayPanel);
    const maxScrollTop = Math.max(
      0,
      scroller.scrollHeight - scroller.clientHeight,
    );
    scroller.scrollTop = Math.min(displayScrollTop, maxScrollTop);
  }
}
