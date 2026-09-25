import {
  allocatePanelStackHeights,
  panelStackAutoCollapseIndices,
} from '../panelStackLayout.js';
import {
  resolveHudRailLayout,
  shouldHideCollapsedRightPanels,
} from './panelRailGeometry.js';

import { displayPanelScroller } from './displayPanelScroll.js';

const pendingCollapseRetries = new WeakSet();

/**
 * Measure and place the right panel rail for one synchronous layout pass.
 * The caller owns scheduling, obstacle selection, disclosure preferences and
 * persistence. Auto-collapse is presentation only and reports through callbacks.
 * @param {object} options Live DOM and caller policy.
 * @param {HTMLElement} options.stack Rail element.
 * @param {Iterable<HTMLElement>} options.obstacles Caller-selected obstacle nodes.
 * @param {Window} options.windowRef Viewport and style reader.
 * @param {{visible: boolean, variant: string}} options.hud Current HUD presentation.
 * @param {string} options.preferredPanelId Most recently opened panel.
 * @param {Function} options.onCollapse Update a panel's disclosure chrome.
 * @param {Function} options.onRetry Request another pass after automatic collapse.
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
  hud,
  preferredPanelId,
  onCollapse,
  onRetry,
  leftStack,
  displayPanel,
  readDisplayScrollTop,
  documentRef = stack?.ownerDocument,
  getComputedStyle = (element) => windowRef.getComputedStyle(element),
}) {
  if (!stack) return;
  // A collapse may schedule one follow-up, which only measures and allocates.
  const isCollapseRetry = pendingCollapseRetries.delete(stack);

  const panels = [...stack.children].filter(
    (panel) => panel.matches('[data-panel-id]') && !panel.hidden,
  );
  if (!hud.visible || hud.variant !== 'tactical') {
    for (const panel of panels.filter((item) =>
      item.classList.contains('layout-auto-collapsed'),
    )) {
      panel.classList.remove('collapsed', 'layout-auto-collapsed');
      onCollapse(panel);
    }
  }
  // Normalize restored state and theme entry without overwriting saved panel
  // preferences. This marker is distinct from Tactical's space-based collapse.
  if (hud.variant === 'cyber') {
    const expanded = panels.filter(
      (panel) => !panel.classList.contains('collapsed'),
    );
    const owner =
      expanded.find((panel) => panel.id === preferredPanelId) ||
      expanded.find((panel) => panel.contains(documentRef?.activeElement)) ||
      expanded[0];
    for (const panel of expanded) {
      if (panel === owner) continue;
      panel.classList.add('collapsed', 'cyber-accordion-collapsed');
      onCollapse(panel);
    }
  } else {
    for (const panel of panels) {
      if (!panel.classList.contains('cyber-accordion-collapsed')) continue;
      panel.classList.remove('collapsed', 'cyber-accordion-collapsed');
      onCollapse(panel);
    }
  }
  const isMobile = windowRef.matchMedia('(max-width: 720px)').matches;
  const hasExpandedPanel = panels.some(
    (panel) =>
      !panel.classList.contains('collapsed') &&
      (!isMobile || panel.id !== 'pp-toggles'),
  );
  const exclusive = shouldHideCollapsedRightPanels({
    hudVariant: hud.variant,
    hasExpandedPanel,
  });
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
  const leftStackTop = leftStack?.getBoundingClientRect().top;
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

  // Auto-collapsed headers contribute the same need even when exclusive
  // presentation hides them. Manually collapsed launchers keep their policy.
  const measuredPanels = panels.filter(
    (panel) =>
      !exclusive ||
      !panel.classList.contains('collapsed') ||
      panel.classList.contains('layout-auto-collapsed'),
  );
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
  // Remove live height allocations through a synchronous CSS override. Keeping
  // the stored properties intact avoids REMOVE/SET churn on unchanged panels.
  // Do not toggle layout classes here: the class observer schedules new passes.
  stack.setAttribute('data-rail-measuring', '');
  try {
    for (const panel of measuredPanels) {
      naturalHeights.set(
        panel,
        Math.max(
          panel.getBoundingClientRect().height,
          panel.scrollHeight || 0,
          panel.classList.contains('collapsed') ? 42 : 0,
        ),
      );
    }
  } finally {
    stack.removeAttribute('data-rail-measuring');
    for (const [node, top] of scrollers)
      if (node.scrollTop !== top) node.scrollTop = top;
  }
  const gap = parseFloat(getComputedStyle(stack).rowGap) || 0;
  const naturalHeight =
    measuredPanels.reduce(
      (total, panel) => total + naturalHeights.get(panel),
      0,
    ) +
    gap * Math.max(0, measuredPanels.length - 1);
  const layout = resolveHudRailLayout({
    viewportHeight,
    panelHeight: naturalHeight,
    laneLeft: stackRect.left,
    laneRight: stackRect.right,
    obstacles: obstacleRects,
    baseTop: alignedTop,
    baseBottom: viewportHeight * 0.96,
    gap: safeGap,
    align: 'start',
  });
  if (!layout) return;
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
  const expandedPanelsInDomOrder = visiblePanels.filter(
    (panel) => !panel.classList.contains('collapsed'),
  );
  const focusedExpandedPanel = expandedPanelsInDomOrder.find((panel) =>
    panel.contains(documentRef.activeElement),
  );
  const preferredExpandedPanel =
    expandedPanelsInDomOrder.find((panel) => panel.id === preferredPanelId) ||
    focusedExpandedPanel;
  // Match the left lane: allocation order follows the latest explicit
  // disclosure, not DOM order. A focused panel is the fallback owner so
  // temporary presentation collapse never strands keyboard focus.
  const expandedPanels = preferredExpandedPanel
    ? [
        preferredExpandedPanel,
        ...expandedPanelsInDomOrder.filter(
          (panel) => panel !== preferredExpandedPanel,
        ),
      ]
    : expandedPanelsInDomOrder;
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
  // Other HUD variants restore automatic collapse at the start of each pass.
  // Do not immediately collapse those panels again and schedule a loop.
  const autoCollapseIndices =
    hud.visible && hud.variant === 'tactical'
      ? panelStackAutoCollapseIndices({
          naturalHeights: expandedPanels.map((panel) =>
            naturalHeights.get(panel),
          ),
          allocatedHeights: expandedHeights,
          collapseLaterPanels: shouldFocus && hud.variant === 'tactical',
        })
      : [];
  if (!isCollapseRetry && autoCollapseIndices.length) {
    for (const index of autoCollapseIndices) {
      const panel = expandedPanels[index];
      panel.classList.add('collapsed', 'layout-auto-collapsed');
      onCollapse(panel);
    }
    pendingCollapseRetries.add(stack);
    onRetry();
    return;
  }
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
