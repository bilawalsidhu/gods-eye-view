import {
  allocatePanelStackHeights,
  panelStackAutoCollapseIndices,
} from '../panelStackLayout.js';
import {
  resolveHudRailLayout,
  shouldHideCollapsedRightPanels,
} from './panelRailGeometry.js';

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

  const panels = [...stack.children].filter((panel) =>
    panel.matches('[data-panel-id]'),
  );
  if (!hud.visible || hud.variant !== 'tactical') {
    for (const panel of panels.filter((item) =>
      item.classList.contains('layout-auto-collapsed'),
    )) {
      panel.classList.remove('collapsed', 'layout-auto-collapsed');
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

  const visiblePanels = panels.filter(
    (panel) => !exclusive || !panel.classList.contains('collapsed'),
  );

  const displayScrollTop = readDisplayScrollTop();
  // Measure intrinsic content, not the allocation written by the previous
  // layout pass. Display is the exception: its own scrollHeight already
  // exposes every control, and removing its live allocation can reset the
  // user's scroll position while HUD or preset content is settling.
  for (const panel of visiblePanels) {
    if (!panel.classList.contains('collapsed') && panel !== displayPanel) {
      panel.style.removeProperty('--right-panel-allocated-height');
    }
  }
  const gap = parseFloat(getComputedStyle(stack).rowGap) || 0;
  const naturalHeight =
    visiblePanels.reduce(
      (total, panel) =>
        total +
        Math.max(
          panel.getBoundingClientRect().height,
          panel.scrollHeight || 0,
          panel.classList.contains('collapsed') ? 42 : 0,
        ),
      0,
    ) +
    gap * Math.max(0, visiblePanels.length - 1);
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
  const stabilityBand = viewportHeight * 0.01;
  const wasFocused = stack.classList.contains('layout-focus');
  const shouldFocus = wasFocused
    ? naturalHeight > availableHeight - stabilityBand * 2
    : naturalHeight > availableHeight - stabilityBand;
  const layoutTop = shouldFocus ? safeTop : layout.top;
  const collapsedHeight = visiblePanels.reduce(
    (total, panel) =>
      panel.classList.contains('collapsed')
        ? total + panel.getBoundingClientRect().height
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
    naturalHeights: expandedPanels.map((panel) =>
      Math.max(panel.getBoundingClientRect().height, panel.scrollHeight || 0),
    ),
    availableHeight: expandedAvailableHeight,
  });
  const autoCollapseIndices = hud.visible
    ? panelStackAutoCollapseIndices({
        naturalHeights: expandedPanels.map((panel) =>
          Math.max(
            panel.getBoundingClientRect().height,
            panel.scrollHeight || 0,
          ),
        ),
        allocatedHeights: expandedHeights,
        collapseLaterPanels: shouldFocus && hud.variant === 'tactical',
      })
    : [];
  if (autoCollapseIndices.length) {
    for (const index of autoCollapseIndices) {
      const panel = expandedPanels[index];
      panel.classList.add('collapsed', 'layout-auto-collapsed');
      onCollapse(panel);
    }
    onRetry();
    return;
  }
  // Write-if-changed. This pass runs on the 500 ms stats cadence, and an
  // unconditional REMOVE-then-SET of an unchanged allocation is two style
  // mutations per tick on `#pp-toggles` (the one panel the measure-strip
  // above deliberately skips) — churn that reads as a genuine panel move to
  // the world-overlay host's occluder observer and defeats parked-idle
  // render savings. Only a real allocation change may touch the attribute.
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
    const maxScrollTop = Math.max(
      0,
      displayPanel.scrollHeight - displayPanel.clientHeight,
    );
    displayPanel.scrollTop = Math.min(displayScrollTop, maxScrollTop);
  }
}
