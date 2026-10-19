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

  // A floating (lifted-out) panel is not laid out by the rail. Neither is one
  // that other CSS hides, such as an event view. Exclusive presentation hides
  // collapsed panels itself; those stay in the rail so they can be restored.
  const hiddenByRail = (panel) =>
    stack.classList.contains('layout-exclusive') &&
    panel.classList.contains('collapsed');
  const panels = [...stack.children].filter(
    (panel) =>
      panel.matches('[data-panel-id]:not(.panel-floating)') &&
      !panel.hidden &&
      (hiddenByRail(panel) || getComputedStyle(panel).display !== 'none'),
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
  const applyExclusive = (exclusive) => {
    stack.classList.toggle('layout-exclusive', exclusive);
    for (const panel of panels) {
      if (exclusive && panel.classList.contains('collapsed'))
        panel.setAttribute('aria-hidden', 'true');
      else panel.removeAttribute('aria-hidden');
    }
    return exclusive;
  };

  if (isMobile) {
    applyExclusive(
      shouldHideCollapsedRightPanels({
        hudVariant: hud.variant,
        hasExpandedPanel,
      }),
    );
    // toggle(…, false) leaves an absent class alone; remove() would rewrite
    // the attribute and wake the class observer every pass.
    stack.classList.toggle('layout-focus', false);
    delete stack.dataset.launchersSqueezed;
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
    // Every panel, hidden launchers included: whether to hide them depends on
    // their height.
    for (const panel of panels) {
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
  const stackHeight = (items) =>
    items.reduce((total, panel) => total + naturalHeights.get(panel), 0) +
    gap * Math.max(0, items.length - 1);
  const corridor = resolveHudRailLayout({
    viewportHeight,
    panelHeight: 0,
    laneLeft: stackRect.left,
    laneRight: stackRect.right,
    obstacles: obstacleRects,
    baseTop: alignedTop,
    baseBottom: viewportHeight * 0.96,
    gap: safeGap,
    align: 'start',
  });
  if (!corridor) return;
  const stabilityBand = Math.max(48, viewportHeight * 0.06);
  // Launchers squeeze the expanded panels when, beside them, those panels
  // would have to scroll. Hysteresis keeps the rail from flickering as
  // content height changes by a few pixels.
  const collapsedPanels = panels.filter((panel) =>
    panel.classList.contains('collapsed'),
  );
  const expandedNeed = stackHeight(
    panels.filter((panel) => !panel.classList.contains('collapsed')),
  );
  const roomBesideLaunchers =
    corridor.maxHeight -
    stackHeight(collapsedPanels) -
    (collapsedPanels.length ? gap : 0);
  // Its own marker, not the exclusive class: Tactical sets that class
  // regardless of room, which would carry over into Operator.
  const launchersSqueezeExpanded =
    stack.dataset.launchersSqueezed === 'true'
      ? expandedNeed >= roomBesideLaunchers - stabilityBand
      : expandedNeed > roomBesideLaunchers;
  stack.dataset.launchersSqueezed = String(launchersSqueezeExpanded);
  const exclusive = applyExclusive(
    shouldHideCollapsedRightPanels({
      hudVariant: hud.variant,
      hasExpandedPanel,
      launchersSqueezeExpanded,
    }),
  );
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
  const naturalHeight = stackHeight(measuredPanels);
  const { safeTop, safeBottom, maxHeight: availableHeight } = corridor;
  const wasFocused = stack.classList.contains('layout-focus');
  const shouldFocus = wasFocused
    ? naturalHeight >= availableHeight - stabilityBand
    : naturalHeight > availableHeight;
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
      safeTop -
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

  stack.style.setProperty('--right-stack-safe-top', `${safeTop.toFixed(1)}px`);
  stack.style.setProperty(
    '--right-stack-max-height',
    `${Math.max(0, safeBottom - safeTop).toFixed(1)}px`,
  );
  stack.classList.toggle('layout-focus', shouldFocus);
  stack.dataset.layoutMode = shouldFocus ? 'focus' : 'normal';
  stack.dataset.safeTop = safeTop.toFixed(1);
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
