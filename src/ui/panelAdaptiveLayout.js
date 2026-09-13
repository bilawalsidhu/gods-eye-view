/**
 * Adaptive panel-stack layout — the left accordion and right rail measure the
 * live HUD chrome at runtime so panels stay aligned and inside the available
 * vertical corridor, extracted from src/ui.js (Batch 5 seam 4). StyleManager
 * keeps the public method surface as thin delegates; this module owns the
 * measurement and allocation loop, receiving the manager as its first
 * parameter. The pure allocation math lives in src/panelStackLayout.js.
 */


import {
  allocatePanelStackHeights,
  panelStackAutoCollapseIndices,
  resolveLeftStackBottomBoundary,
  resolvePanelStackCorridor,
} from '../panelStackLayout.js';
import { resolveHudRailLayout } from '../cockpitMath.js';
import { shouldHideCollapsedLanePanels } from '../rightRailPolicy.js';

const LEFT_STACK_OBSTACLE_SELECTOR = [
  '#cockpit-hud .cockpit-topline',
  '#cockpit-hud .cockpit-topline > div',
  '#title-bar',
  '#style-indicator',
  '#top-center-actions',
  '#traffic-sync-chip',
  '#cctv-sync-chip',
  '#intel-hud .hud-top-left',
  '#intel-hud .hud-top-right',
  '#intel-hud .hud-bottom-left',
  '#intel-hud .hud-bottom-right',
  '#intel-hud .hud-top-bar',
  '#intel-hud .hud-bottom-bar',
  '#intel-hud .hud-left-edge',
  '#intel-hud .hud-right-edge',
  '#cockpit-context',
  '#location-bar',
  '#control-panel',
  '#gev-voice-control',
  '#pp-toggles',
  '#param-slider-panel',
].join(', ');

const RIGHT_STACK_OBSTACLE_SELECTOR = [
  '#cockpit-hud .cockpit-topline',
  '#cockpit-hud .cockpit-topline > div',
  '#title-bar',
  '#style-indicator',
  '#top-center-actions',
  '#traffic-sync-chip',
  '#cctv-sync-chip',
  '#intel-hud .hud-top-left',
  '#intel-hud .hud-top-right',
  '#intel-hud .hud-bottom-left',
  '#intel-hud .hud-bottom-right',
  '#intel-hud .hud-top-bar',
  '#intel-hud .hud-bottom-bar',
  '#intel-hud .hud-left-edge',
  '#intel-hud .hud-right-edge',
  '#cockpit-context',
  '#cockpit-signal-stream',
  '#command-dock',
  '#gev-voice-control',
].join(', ');


/**
 * Builds one fixed right-side rail from Display, CCTV, its parameter
 * controls, and Global Context (which owns the nested Radio companion).
 * The rail then measures the live HUD chrome at runtime so it can stay
 * aligned and within the available vertical corridor.
 * @returns {void}
 */
export function initRightPanelAdaptiveLayout(mgr) {
    const stack = mgr._rightPanelStack;
    if (!stack || !mgr._ppToggles) return;

    mgr._ppToggles.style.removeProperty('top');
    mgr._ppToggles.style.removeProperty('right');
    mgr._ppToggles.style.removeProperty('bottom');
    mgr._ppToggles.style.removeProperty('left');
    mgr._ppToggles.style.removeProperty('z-index');
    mgr._ppToggles.classList.remove('panel-draggable', 'panel-dragging');
    mgr._ppToggles.querySelector('.pp-header-row')?.removeAttribute('title');
    stack.prepend(mgr._ppToggles);
    const globalContextPanel = document.getElementById('global-context-panel');
    if (mgr._cctvPanel) {
      mgr._cctvPanel.style.removeProperty('top');
      mgr._cctvPanel.style.removeProperty('right');
      mgr._cctvPanel.style.removeProperty('bottom');
      mgr._cctvPanel.style.removeProperty('left');
      mgr._cctvPanel.style.removeProperty('z-index');
      mgr._cctvPanel.classList.remove('panel-draggable', 'panel-dragging');
      stack.insertBefore(mgr._cctvPanel, globalContextPanel);
      mgr._syncPanelCollapseButton(mgr._cctvPanel);
    }
    if (mgr._sliderPanel) {
      mgr._sliderPanel.style.removeProperty('top');
      mgr._sliderPanel.style.removeProperty('right');
      mgr._sliderPanel.style.removeProperty('bottom');
      mgr._sliderPanel.style.removeProperty('left');
      mgr._sliderPanel.style.removeProperty('max-height');
      const detectionGroup = mgr._detectionBtn?.closest('.pp-toggle-group');
      if (detectionGroup) detectionGroup.after(mgr._sliderPanel);
      else mgr._ppToggles.append(mgr._sliderPanel);
    }
    if (typeof ResizeObserver !== 'undefined') {
      mgr._rightStackResizeObserver = new ResizeObserver(() => {
        scheduleRightPanelLayout(mgr);
      });
      mgr._rightStackResizeObserver.observe(stack);
      for (const panel of [mgr._ppToggles, mgr._cctvPanel, globalContextPanel]) {
        if (panel) mgr._rightStackResizeObserver.observe(panel);
      }
      document.querySelectorAll(RIGHT_STACK_OBSTACLE_SELECTOR).forEach((element) => {
        mgr._rightStackResizeObserver.observe(element);
      });
    }

    if (typeof MutationObserver !== 'undefined') {
      mgr._rightStackMutationObserver = new MutationObserver(() => {
        scheduleRightPanelLayout(mgr);
      });
      mgr._rightStackMutationObserver.observe(stack, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['class', 'hidden', 'data-variant'],
      });
      const hud = document.getElementById('intel-hud');
      if (hud) {
        mgr._rightStackMutationObserver.observe(hud, {
          subtree: true,
          attributes: true,
          attributeFilter: ['class', 'hidden', 'data-variant'],
        });
      }
    }

    const transitionHud = document.getElementById('intel-hud');
    if (transitionHud) {
      mgr._rightStackHudTransitionHandler = (event) => {
        if (event.propertyName === 'opacity' || event.propertyName === 'visibility') {
          scheduleRightPanelLayout(mgr, { reconsiderAutoCollapse: true });
        }
      };
      transitionHud.addEventListener('transitionend', mgr._rightStackHudTransitionHandler);
    }

    scheduleRightPanelLayout(mgr);
  }

export function scheduleRightPanelLayout(mgr, { reconsiderAutoCollapse = false } = {}) {
    if (reconsiderAutoCollapse) mgr._rightStackReconsiderAutoCollapse = true;
    if (!mgr._rightPanelStack || mgr._rightStackLayoutFrame !== null) return;
    mgr._rightStackLayoutFrame = requestAnimationFrame(() => {
      mgr._rightStackLayoutFrame = null;
      if (mgr._rightStackReconsiderAutoCollapse) {
        mgr._rightStackReconsiderAutoCollapse = false;
        for (const panel of mgr._rightPanelStack.querySelectorAll('.layout-auto-collapsed')) {
          panel.classList.remove('collapsed', 'layout-auto-collapsed');
          mgr._syncPanelCollapseButton(panel);
        }
      }
      syncRightPanelAdaptiveLayout(mgr);
    });
}

/**
 * Places the right rail inside the visible HUD-safe corridor. When the
 * corridor is too short, the expanded panel receives the remaining height
 * with internal scrolling. Tactical HUD hides collapsed sibling launchers
 * while a panel is expanded; other HUD layouts keep them visible.
 * @returns {void}
 */
export function syncRightPanelAdaptiveLayout(mgr) {
    const stack = mgr._rightPanelStack;
    if (!stack) return;

    const panels = [...stack.children].filter((panel) => panel.matches('[data-panel-id]'));
    if (!mgr.hud.visible || mgr.hud.getVariant() !== 'tactical') {
      for (const panel of panels.filter((item) => item.classList.contains('layout-auto-collapsed'))) {
        panel.classList.remove('collapsed', 'layout-auto-collapsed');
        mgr._syncPanelCollapseButton(panel);
      }
    }
    const isMobile = window.matchMedia('(max-width: 720px)').matches;
    const hasExpandedPanel = panels.some((panel) => (
      !panel.classList.contains('collapsed') && (!isMobile || panel.id !== 'pp-toggles')
    ));
    const exclusive = shouldHideCollapsedLanePanels({
      hudVariant: mgr.hud.getVariant(),
      hasExpandedPanel,
    });
    stack.classList.toggle('layout-exclusive', exclusive);
    for (const panel of panels) {
      if (exclusive && panel.classList.contains('collapsed')) panel.setAttribute('aria-hidden', 'true');
      else panel.removeAttribute('aria-hidden');
    }

    if (isMobile) {
      stack.classList.remove('layout-focus');
      stack.style.removeProperty('--right-stack-safe-top');
      stack.style.removeProperty('--right-stack-max-height');
      for (const panel of panels) panel.style.removeProperty('--right-panel-allocated-height');
      stack.dataset.layoutMode = 'mobile';
      return;
    }

    const viewportHeight = Math.max(1, window.innerHeight);
    const safeGap = Math.max(8, viewportHeight * 0.012);
    const stackRect = stack.getBoundingClientRect();
    const leftStackTop = mgr._leftPanelStack?.getBoundingClientRect().top;
    const alignedTop = Number.isFinite(leftStackTop)
      ? leftStackTop
      : viewportHeight * 0.26;
    const obstacleRects = [];

    for (const obstacle of document.querySelectorAll(RIGHT_STACK_OBSTACLE_SELECTOR)) {
      if (stack.contains(obstacle)) continue;
      let hiddenByAncestor = false;
      for (let element = obstacle; element; element = element.parentElement) {
        const style = getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
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

    const visiblePanels = panels.filter((panel) => (
      !exclusive || !panel.classList.contains('collapsed')
    ));
    const displayScrollTop = mgr._displayPortalScrollRestoreOwner === 'standard'
      ? mgr._standardDisplayScrollTop
      : (mgr._ppToggles?.scrollTop || 0);
    // Measure intrinsic content, not the allocation written by the previous
    // layout pass. Display is the exception: its own scrollHeight already
    // exposes every control, and removing its live allocation can reset the
    // user's scroll position while HUD or preset content is settling.
    for (const panel of visiblePanels) {
      if (!panel.classList.contains('collapsed') && panel !== mgr._ppToggles) {
        panel.style.removeProperty('--right-panel-allocated-height');
      }
    }
    const gap = parseFloat(getComputedStyle(stack).rowGap) || 0;
    const naturalHeight = visiblePanels.reduce((total, panel) => (
      total + Math.max(
        panel.getBoundingClientRect().height,
        panel.scrollHeight || 0,
        panel.classList.contains('collapsed') ? 42 : 0,
      )
    ), 0) + gap * Math.max(0, visiblePanels.length - 1);
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
    const collapsedHeight = visiblePanels.reduce((total, panel) => (
      panel.classList.contains('collapsed')
        ? total + panel.getBoundingClientRect().height
        : total
    ), 0);
    const expandedPanelsInDomOrder = visiblePanels.filter((panel) => !panel.classList.contains('collapsed'));
    const focusedExpandedPanel = expandedPanelsInDomOrder.find((panel) => panel.contains(document.activeElement));
    const preferredExpandedPanel = expandedPanelsInDomOrder.find(
      (panel) => panel.id === mgr._rightStackPreferredPanelId,
    ) || focusedExpandedPanel;
    // Match the left lane: allocation order follows the latest explicit
    // disclosure, not DOM order. A focused panel is the fallback owner so
    // temporary presentation collapse never strands keyboard focus.
    const expandedPanels = preferredExpandedPanel
      ? [preferredExpandedPanel, ...expandedPanelsInDomOrder.filter((panel) => panel !== preferredExpandedPanel)]
      : expandedPanelsInDomOrder;
    const expandedAvailableHeight = Math.max(
      0,
      safeBottom - layoutTop - collapsedHeight - gap * Math.max(0, visiblePanels.length - 1),
    );
    const expandedHeights = allocatePanelStackHeights({
      naturalHeights: expandedPanels.map((panel) => Math.max(
        panel.getBoundingClientRect().height,
        panel.scrollHeight || 0,
      )),
      availableHeight: expandedAvailableHeight,
    });
    const autoCollapseIndices = mgr.hud.visible ? panelStackAutoCollapseIndices({
      naturalHeights: expandedPanels.map((panel) => Math.max(
        panel.getBoundingClientRect().height,
        panel.scrollHeight || 0,
      )),
      allocatedHeights: expandedHeights,
      collapseLaterPanels: shouldFocus && mgr.hud.getVariant() === 'tactical',
    }) : [];
    if (autoCollapseIndices.length) {
      for (const index of autoCollapseIndices) {
        const panel = expandedPanels[index];
        panel.classList.add('collapsed', 'layout-auto-collapsed');
        mgr._syncPanelCollapseButton(panel);
      }
      // Commit the lane's exclusive hiding in the SAME pass as the collapse.
      // The exclusive toggle at the top ran while these panels were still
      // expanded, and deferring aria-hidden/display to the rescheduled frame
      // left freshly collapsed siblings visible — and screen-reader
      // reachable — for a frame (or far longer when frames are scarce).
      const collapsedExclusive = shouldHideCollapsedLanePanels({
        hudVariant: mgr.hud.getVariant(),
        hasExpandedPanel: panels.some((panel) => !panel.classList.contains('collapsed')),
      });
      stack.classList.toggle('layout-exclusive', collapsedExclusive);
      for (const panel of panels) {
        if (collapsedExclusive && panel.classList.contains('collapsed')) {
          panel.setAttribute('aria-hidden', 'true');
        } else {
          panel.removeAttribute('aria-hidden');
        }
      }
      scheduleRightPanelLayout(mgr);
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
      if (panel.style.getPropertyValue('--right-panel-allocated-height') !== next) {
        panel.style.setProperty('--right-panel-allocated-height', next);
      }
    });
    for (const panel of panels) {
      if (expandedPanels.includes(panel)) continue;
      panel.style.removeProperty('--right-panel-allocated-height');
    }

    stack.style.setProperty('--right-stack-safe-top', `${layoutTop.toFixed(1)}px`);
    stack.style.setProperty('--right-stack-max-height', `${Math.max(0, safeBottom - layoutTop).toFixed(1)}px`);
    stack.classList.toggle('layout-focus', shouldFocus);
    stack.dataset.layoutMode = shouldFocus ? 'focus' : 'normal';
    stack.dataset.safeTop = layoutTop.toFixed(1);
    stack.dataset.safeBottom = safeBottom.toFixed(1);
    stack.dataset.availableHeight = availableHeight.toFixed(1);
    stack.dataset.requiredHeight = naturalHeight.toFixed(1);
    stack.dataset.expandedCount = String(expandedPanels.length);

    if (mgr._ppToggles && expandedPanels.includes(mgr._ppToggles)) {
      const maxScrollTop = Math.max(0, mgr._ppToggles.scrollHeight - mgr._ppToggles.clientHeight);
      mgr._ppToggles.scrollTop = Math.min(displayScrollTop, maxScrollTop);
    }

}

/**
 * Initializes the adaptive left accordion. The layout engine measures the
 * actual HUD/chrome rectangles that intersect the left lane, then decides
 * whether collapsed sibling labels can remain visible beside the expanded
 * panel. No decision is keyed to a specific panel or HUD variant.
 * @returns {void}
 */
export function initLeftPanelAdaptiveLayout(mgr) {
    const stack = mgr._leftPanelStack;
    if (!stack) return;

    if (typeof ResizeObserver !== 'undefined') {
      mgr._leftStackResizeObserver = new ResizeObserver(() => {
        scheduleLeftPanelLayout(mgr);
      });
      mgr._leftStackResizeObserver.observe(stack);
      stack.querySelectorAll(':scope > [data-panel-id]').forEach((panel) => {
        mgr._leftStackResizeObserver.observe(panel);
        const inner = [...panel.children].find((child) => !child.classList.contains('panel-glow'));
        if (inner) mgr._leftStackResizeObserver.observe(inner);
      });
      document.querySelectorAll(LEFT_STACK_OBSTACLE_SELECTOR).forEach((element) => {
        mgr._leftStackResizeObserver.observe(element);
      });
    }

    if (typeof MutationObserver !== 'undefined') {
      mgr._leftStackMutationObserver = new MutationObserver(() => {
        scheduleLeftPanelLayout(mgr);
      });
      mgr._leftStackMutationObserver.observe(stack, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['class'],
      });
      const hud = document.getElementById('intel-hud');
      if (hud) {
        mgr._leftStackMutationObserver.observe(hud, {
          attributes: true,
          attributeFilter: ['class', 'data-variant'],
        });
      }
    }

    const transitionHud = document.getElementById('intel-hud');
    if (transitionHud) {
      mgr._leftStackHudTransitionHandler = (event) => {
        if (event.propertyName === 'opacity' || event.propertyName === 'visibility') {
          scheduleLeftPanelLayout(mgr, { reconsiderAutoCollapse: true });
          // The Cockpit strip hangs off the HUD's REC readout, so it has to
          // remeasure on the same event: the readout keeps its rect through
          // the whole fade and only stops counting once the HUD has retired.
          mgr.cockpitView?.scheduleContextLayout();
        }
      };
      transitionHud.addEventListener('transitionend', mgr._leftStackHudTransitionHandler);
    }

    mgr._leftStackCockpitModeHandler = () => {
      // Cockpit mode repositions the peripheral HUD and reveals its own
      // bottom-left context card. Measure after those styles have committed so
      // the accordion remains in the same obstacle-safe lane instead of
      // jumping to a cockpit-specific top anchor.
      scheduleLeftPanelLayout(mgr);
      requestAnimationFrame(() => scheduleLeftPanelLayout(mgr));
      setTimeout(() => scheduleLeftPanelLayout(mgr), 300);
    };
    window.addEventListener('gev:cockpit-mode-changed', mgr._leftStackCockpitModeHandler);

    scheduleLeftPanelLayout(mgr);
}

/**
 * Batches adaptive accordion work into one animation frame.
 * @returns {void}
 */
export function scheduleLeftPanelLayout(mgr, { reconsiderAutoCollapse = false } = {}) {
    if (reconsiderAutoCollapse) mgr._leftStackReconsiderAutoCollapse = true;
    if (!mgr._leftPanelStack || mgr._leftStackLayoutFrame !== null) return;
    mgr._leftStackLayoutFrame = requestAnimationFrame(() => {
      mgr._leftStackLayoutFrame = null;
      if (mgr._leftStackReconsiderAutoCollapse) {
        mgr._leftStackReconsiderAutoCollapse = false;
        for (const panel of mgr._leftPanelStack.querySelectorAll('.layout-auto-collapsed')) {
          panel.classList.remove('collapsed', 'layout-auto-collapsed');
          mgr._syncPanelCollapseButton(panel);
        }
      }
      syncLeftPanelAdaptiveLayout(mgr);
    });
}

/**
 * Estimates an expanded panel's unconstrained content height from its
 * visible direct children and their scroll extents. This avoids treating a
 * flex-grown panel as naturally tall while still accounting for nested lists.
 * @param {HTMLElement} panel - Expanded accordion panel.
 * @returns {number} Natural height in rendered CSS pixels.
 */
function measureLeftPanelNaturalHeight(mgr, panel) {
    const inner = [...panel.children].find((child) => !child.classList.contains('panel-glow'));
    if (!inner) return Math.ceil(panel.scrollHeight || panel.getBoundingClientRect().height);

    const innerRect = inner.getBoundingClientRect();
    const panelStyle = getComputedStyle(panel);
    const innerStyle = getComputedStyle(inner);
    const paddingBottom = parseFloat(innerStyle.paddingBottom) || 0;
    let contentBottom = parseFloat(innerStyle.paddingTop) || 0;

    for (const child of inner.children) {
      const childStyle = getComputedStyle(child);
      if (childStyle.display === 'none' || childStyle.visibility === 'hidden') continue;
      const childRect = child.getBoundingClientRect();
      const marginBottom = parseFloat(childStyle.marginBottom) || 0;
      const naturalChildHeight = Math.max(childRect.height, child.scrollHeight || 0);
      const childBottom = childRect.top - innerRect.top + naturalChildHeight + marginBottom;
      contentBottom = Math.max(contentBottom, childBottom);
    }

    const wrapperChrome = (parseFloat(panelStyle.borderTopWidth) || 0)
      + (parseFloat(panelStyle.borderBottomWidth) || 0)
      + (parseFloat(panelStyle.paddingTop) || 0)
      + (parseFloat(panelStyle.paddingBottom) || 0);
    return Math.ceil(contentBottom + paddingBottom + wrapperChrome);
}

/**
 * Measures a live obstacle-free corridor for the left accordion and toggles
 * focus mode only when the expanded panel plus sibling labels cannot fit.
 * Safe boundaries are written as viewport-relative CSS values.
 * @returns {void}
 */
export function syncLeftPanelAdaptiveLayout(mgr) {
    const stack = mgr._leftPanelStack;
    if (!stack) return;

    const panels = [...stack.querySelectorAll(':scope > [data-panel-id]')];
    if (!panels.length) return;
    if (!mgr.hud.visible || mgr.hud.getVariant() !== 'tactical') {
      for (const panel of panels.filter((item) => item.classList.contains('layout-auto-collapsed'))) {
        panel.classList.remove('collapsed', 'layout-auto-collapsed');
        mgr._syncPanelCollapseButton(panel);
      }
    }
    // Same lane contract as the right rail: under a tactical HUD an expanded
    // panel owns the lane and collapsed sibling launchers are hidden. The
    // commitment must also be re-stated in the same pass that auto-collapses a
    // competitor (see the early return below) so aria state never lags.
    const exclusive = shouldHideCollapsedLanePanels({
      hudVariant: mgr.hud.getVariant(),
      hasExpandedPanel: panels.some((panel) => !panel.classList.contains('collapsed')),
    });
    stack.classList.toggle('layout-exclusive', exclusive);

    // The existing narrow-screen composition has its own full-width stack.
    // Keep this desktop lane engine from fighting those dedicated rules.
    if (window.matchMedia('(max-width: 720px)').matches) {
      stack.classList.remove('layout-focus');
      stack.classList.remove('layout-tail');
      stack.style.removeProperty('--left-stack-safe-top');
      stack.style.removeProperty('--left-stack-safe-bottom');
      stack.style.removeProperty('--left-stack-centered-height');
      stack.dataset.layoutMode = 'mobile';
      for (const panel of panels) {
        // Mobile keeps the tactical lane contract: a collapsed sibling the
        // exclusive rule hides is still aria-hidden, not merely invisible.
        if (exclusive && panel.classList.contains('collapsed')) {
          panel.setAttribute('aria-hidden', 'true');
        } else {
          panel.removeAttribute('aria-hidden');
        }
        panel.style.removeProperty('--left-panel-allocated-height');
      }
      return;
    }

    const viewportHeight = Math.max(1, window.innerHeight);
    const stackRect = stack.getBoundingClientRect();
    const baseTop = viewportHeight * 0.26;
    const baseBottomInset = viewportHeight * 0.04;
    const safeGap = viewportHeight * 0.012;
    let obstacleSafeTop = viewportHeight * 0.04;
    let safeTop = baseTop;
    let safeBottom = viewportHeight - baseBottomInset;
    const bottomObstacles = [];

    for (const obstacle of document.querySelectorAll(LEFT_STACK_OBSTACLE_SELECTOR)) {
      if (stack.contains(obstacle)) continue;
      let hiddenByAncestor = false;
      for (let element = obstacle; element; element = element.parentElement) {
        const style = getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
          hiddenByAncestor = true;
          break;
        }
      }
      if (hiddenByAncestor) continue;
      const rect = obstacle.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      const overlapsHorizontally = rect.right > stackRect.left && rect.left < stackRect.right;
      if (!overlapsHorizontally) continue;

      if (rect.top < baseTop && rect.bottom <= viewportHeight * 0.5) {
        const obstacleBottom = rect.bottom + safeGap;
        obstacleSafeTop = Math.max(obstacleSafeTop, obstacleBottom);
        safeTop = Math.max(safeTop, obstacleBottom);
      } else if (rect.top >= baseTop) {
        bottomObstacles.push({ top: rect.top });
      }
    }
    safeBottom = resolveLeftStackBottomBoundary({
      baseBottom: safeBottom,
      obstacles: bottomObstacles,
      safeGap,
    });

    const obstacleSafeBottom = safeBottom;

    // Keep the accordion visually centered when the balanced corridor remains
    // useful. During live viewport-height changes, retain the aligned lane
    // instead of extending a tiny midpoint corridor through a lower obstacle.
    const minimumLaneHeight = viewportHeight * 0.16;
    ({ safeTop, safeBottom } = resolvePanelStackCorridor({
      viewportHeight,
      safeTop,
      safeBottom,
      obstacleSafeTop,
      obstacleSafeBottom,
      minimumHeight: minimumLaneHeight,
    }));
    const viewportMidpoint = viewportHeight * 0.5;
    for (const panel of panels) {
      const rect = panel.getBoundingClientRect();
      if (panel.classList.contains('collapsed') && rect.height > 0) {
        mgr._leftStackCollapsedHeights.set(panel.id, rect.height);
      }
    }

    const expandedPanelsInDomOrder = panels.filter((panel) => !panel.classList.contains('collapsed'));
    const preferredExpandedPanel = expandedPanelsInDomOrder.find(
      (panel) => panel.id === mgr._leftStackPreferredPanelId,
    );
    // Auto-collapse is a presentation fallback, not permission to undo the
    // user's newest disclosure. Measure and allocate that explicitly opened
    // panel first so an older expanded sibling yields when the corridor cannot
    // usefully present both (for example Map Stack followed by Scenes).
    const expandedPanels = preferredExpandedPanel
      ? [preferredExpandedPanel, ...expandedPanelsInDomOrder.filter((panel) => panel !== preferredExpandedPanel)]
      : expandedPanelsInDomOrder;
    // Clear the prior pass before reading intrinsic heights. The allocated
    // outer height and the inner scroller otherwise feed their constrained
    // size back into the next HUD-mode calculation.
    for (const panel of expandedPanels) {
      panel.style.removeProperty('--left-panel-allocated-height');
    }
    const availableHeight = Math.max(0, safeBottom - safeTop);
    const naturalExpandedHeights = expandedPanels.map((panel) => measureLeftPanelNaturalHeight(mgr, panel));
    const naturalExpandedHeight = naturalExpandedHeights.reduce((sum, height) => sum + height, 0);
    const siblingHeight = panels.reduce((total, panel) => {
      if (!panel.classList.contains('collapsed')) return total;
      const measured = mgr._leftStackCollapsedHeights.get(panel.id);
      return total + (measured || panel.getBoundingClientRect().height || 0);
    }, 0);
    let requiredHeight = siblingHeight;

    const rowGap = parseFloat(getComputedStyle(stack).rowGap) || 0;
    if (expandedPanels.length) {
      requiredHeight += naturalExpandedHeight;
      requiredHeight += rowGap * Math.max(0, panels.length - 1);
    } else {
      requiredHeight += rowGap * Math.max(0, panels.length - 1);
    }

    const wasFocused = stack.classList.contains('layout-focus');
    const wasTail = stack.classList.contains('layout-tail');
    const wasConstrained = wasFocused || wasTail;
    const stabilityBand = viewportHeight * 0.01;
    const exceedsCenteredCorridor = expandedPanels.length > 0 && (wasConstrained
      ? requiredHeight > availableHeight - stabilityBand * 2
      : requiredHeight > availableHeight - stabilityBand);
    const tailRequiredHeight = naturalExpandedHeight
      + siblingHeight
      + rowGap * Math.max(0, panels.length - 1);
    // A compact expansion should not make the whole control stack jump down
    // merely to center a few short rows. Preserve the normal top anchor when
    // the centered stack would begin below it; tall stacks can still grow
    // upward around the viewport midpoint as their content requires.
    const centeredTailTop = viewportMidpoint - tailRequiredHeight * 0.5;
    const tailLayoutTop = Math.min(centeredTailTop, safeTop);
    const tailLayoutBottom = tailLayoutTop + tailRequiredHeight;
    const tailAvailableHeight = Math.max(0, obstacleSafeBottom - obstacleSafeTop);
    const tailTolerance = wasTail ? stabilityBand : -stabilityBand;
    const shouldTail = expandedPanels.length > 0
      && tailLayoutTop >= obstacleSafeTop - tailTolerance
      && tailLayoutBottom <= obstacleSafeBottom + tailTolerance;
    const shouldFocus = exceedsCenteredCorridor && !shouldTail;
    // Focus mode owns the lane, so let every expanded panel share the full
    // obstacle-safe corridor. Tail/normal layouts keep the balanced
    // viewport centering used for compact accordion stacks.
    const layoutTop = shouldFocus
      ? obstacleSafeTop
      : shouldTail ? tailLayoutTop : safeTop;
    const layoutBottom = shouldFocus
      ? obstacleSafeBottom
      : shouldTail ? tailLayoutBottom : safeBottom;
    const topPct = (layoutTop / viewportHeight) * 100;
    const bottomPct = ((viewportHeight - layoutBottom) / viewportHeight) * 100;
    const topValue = `${topPct.toFixed(3)}vh`;
    const bottomValue = `${bottomPct.toFixed(3)}vh`;
    const expandedAvailableHeight = shouldFocus
      ? Math.max(0, layoutBottom - layoutTop
        - rowGap * Math.max(0, expandedPanels.length - 1))
      : naturalExpandedHeight;
    const allocatedExpandedHeights = allocatePanelStackHeights({
      naturalHeights: naturalExpandedHeights,
      availableHeight: expandedAvailableHeight,
    });
    const autoCollapseIndices = mgr.hud.visible ? panelStackAutoCollapseIndices({
      naturalHeights: naturalExpandedHeights,
      allocatedHeights: allocatedExpandedHeights,
      collapseLaterPanels: shouldFocus && mgr.hud.getVariant() === 'tactical',
    }) : [];
    if (autoCollapseIndices.length) {
      for (const index of autoCollapseIndices) {
        const panel = expandedPanels[index];
        panel.classList.add('collapsed', 'layout-auto-collapsed');
        mgr._syncPanelCollapseButton(panel);
      }
      // Restate the lane's exclusive hiding for the panels this pass just
      // collapsed — the top-of-pass toggle ran while they were still
      // expanded, and waiting for the rescheduled frame would leave them
      // visible and screen-reader reachable until it lands.
      const collapsedExclusive = shouldHideCollapsedLanePanels({
        hudVariant: mgr.hud.getVariant(),
        hasExpandedPanel: panels.some((panel) => !panel.classList.contains('collapsed')),
      });
      stack.classList.toggle('layout-exclusive', collapsedExclusive);
      for (const panel of panels) {
        if (collapsedExclusive && panel.classList.contains('collapsed')) {
          panel.setAttribute('aria-hidden', 'true');
        } else if (!stack.classList.contains('layout-focus')) {
          panel.removeAttribute('aria-hidden');
        }
      }
      scheduleLeftPanelLayout(mgr);
      return;
    }
    if (stack.style.getPropertyValue('--left-stack-safe-top') !== topValue) {
      stack.style.setProperty('--left-stack-safe-top', topValue);
    }
    if (stack.style.getPropertyValue('--left-stack-safe-bottom') !== bottomValue) {
      stack.style.setProperty('--left-stack-safe-bottom', bottomValue);
    }
    stack.style.removeProperty('--left-stack-centered-height');
    for (const panel of panels) panel.style.removeProperty('--left-panel-allocated-height');
    expandedPanels.forEach((panel, index) => {
      panel.style.setProperty('--left-panel-allocated-height', `${allocatedExpandedHeights[index].toFixed(1)}px`);
    });

    stack.classList.toggle('layout-focus', shouldFocus);
    stack.classList.toggle('layout-tail', shouldTail);
    stack.dataset.layoutMode = shouldFocus ? 'focus' : shouldTail ? 'tail' : 'normal';
    stack.dataset.safeTopPct = topPct.toFixed(2);
    stack.dataset.safeBottomPct = (100 - bottomPct).toFixed(2);
    stack.dataset.availableHeightPct = ((availableHeight / viewportHeight) * 100).toFixed(2);
    stack.dataset.requiredHeightPct = ((requiredHeight / viewportHeight) * 100).toFixed(2);
    stack.dataset.tailAvailableHeightPct = ((tailAvailableHeight / viewportHeight) * 100).toFixed(2);
    stack.dataset.expandedCount = String(expandedPanels.length);

    // Cockpit Display/Radio live in the opposite margin and no longer borrow
    // this corridor: the left accordion's top is solved against left-lane
    // obstacles, which put the strip straight through the briefing card.
    // CockpitView.syncSignalLayout() owns `--cockpit-utility-top` instead.

    for (const panel of panels) {
      // Focus mode hides collapsed siblings through the corridor engine's own
      // `layout-focus` rule; the tactical lane contract hides them through
      // `layout-exclusive`. Either way the hidden launcher is aria-hidden.
      const hiddenSibling = (shouldFocus || exclusive) && panel.classList.contains('collapsed');
      if (hiddenSibling) panel.setAttribute('aria-hidden', 'true');
      else panel.removeAttribute('aria-hidden');
    }
    // The right controls share this top baseline; update them after the left
    // accordion commits an HUD-variant or obstacle-driven position change.
    scheduleRightPanelLayout(mgr);
}

