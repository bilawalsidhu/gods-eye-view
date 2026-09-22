/** Own rail measurement, layout scheduling and dock tray observation. */
import { layoutLeftPanelRail, layoutRightPanelRail } from './panelRails.js';
const COCKPIT_LAYOUT_SETTLE_MS = 240;
/**
 * Fixed UI regions that can occupy the left accordion's vertical lane.
 * Rectangles are filtered at runtime for visibility and horizontal overlap,
 * so right-side/center controls do not reduce the lane unless they actually
 * intersect it at the current viewport size.
 */
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
  '#cesium-credits .cesium-credit-logoContainer',
  '#cesium-credits .cesium-credit-textContainer',
  '#location-bar',
  '#control-panel',
  '#gev-voice-control',
  '#pp-toggles',
  '#param-slider-panel',
].join(', ');
/**
 * Fixed UI regions that can occupy the right control lane. Runtime rectangle
 * filtering keeps the rail clear of whichever HUD variant is currently
 * visible without tying the layout to one screen height.
 */
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
  '#cesium-credits .cesium-credit-logoContainer',
  '#cesium-credits .cesium-credit-textContainer',
  '#command-dock',
  '#gev-voice-control',
].join(', ');
export class PanelLayoutController {
  constructor({
    readHud,
    scheduleCockpitLayout,
    syncPanelCollapseButton,
    readDisplayScrollTop,
  }) {
    this.readHud = readHud;
    this.scheduleCockpitLayout = scheduleCockpitLayout;
    this._syncPanelCollapseButton = syncPanelCollapseButton;
    this.readDisplayScrollTop = readDisplayScrollTop;
    this.destroyed = false;
    this._adaptivePanelSettleTimer = null;
    this._commandDockTrayObserver = null;
    this._leftStackCockpitModeHandler = null;
    this._leftStackCollapsedHeights = new Map();
    this._leftStackHudTransitionHandler = null;
    this._leftStackLayoutFrame = null;
    this._leftStackMutationObserver = null;
    this._leftStackPreferredPanelId = null;
    this._leftStackReconsiderAutoCollapse = false;
    this._leftStackResizeObserver = null;
    this._rightStackHudTransitionHandler = null;
    this._rightStackLayoutFrame = null;
    this._rightStackMutationObserver = null;
    this._rightStackPreferredPanelId = null;
    this._rightStackReconsiderAutoCollapse = false;
    this._rightStackResizeObserver = null;
    this._cockpitLayoutFrame = null;
    this._cockpitLayoutTimer = null;
    this._leftPanelStack = document.getElementById('left-panel-stack');
    this._rightPanelStack = document.getElementById('right-context-rail');
    this._ppToggles = document.getElementById('pp-toggles');
    this._cctvPanel = document.getElementById('cctv-panel');
    this._weatherPanel = document.getElementById('weather-panel');
    this._recentImageryPanel = document.getElementById('recent-imagery-panel');
    this._sliderPanel = document.getElementById('param-slider-panel');
    this._detectionBtn = document.getElementById('detection-toggle');
  }
  _scheduleAdaptivePanelLayout({ settle = false } = {}) {
    if (this.destroyed) return;
    this._scheduleLeftPanelLayout({ reconsiderAutoCollapse: true });
    this._scheduleRightPanelLayout({ reconsiderAutoCollapse: true });
    this.scheduleCockpitLayout();
    if (!settle) return;
    clearTimeout(this._adaptivePanelSettleTimer);
    this._adaptivePanelSettleTimer = setTimeout(() => {
      if (this.destroyed) return;
      this._adaptivePanelSettleTimer = null;
      this._scheduleLeftPanelLayout({ reconsiderAutoCollapse: true });
      this._scheduleRightPanelLayout({ reconsiderAutoCollapse: true });
      this.scheduleCockpitLayout();
    }, COCKPIT_LAYOUT_SETTLE_MS);
  }

  _initCommandDockTrayMetrics() {
    if (this.destroyed) return;
    const dock = document.getElementById('command-dock');
    if (!dock) return;
    this._commandDockTrayObserver?.disconnect?.();
    if (typeof ResizeObserver === 'function') {
      this._commandDockTrayObserver = new ResizeObserver(() =>
        this._updateCommandDockTrayStack(),
      );
      dock.querySelectorAll('.dock-popover-content').forEach((tray) => {
        this._commandDockTrayObserver.observe(tray);
      });
    }
    this._updateCommandDockTrayStack();
  }

  _updateCommandDockTrayStack() {
    if (this.destroyed) return;
    const dock = document.getElementById('command-dock');
    if (!dock) return;
    const locationPanel = dock.querySelector(
      '#location-bar.dock-pinned:not(.collapsed)',
    );
    const presetsPanel = dock.querySelector(
      '#control-panel.dock-pinned:not(.collapsed)',
    );
    const locationHeight =
      locationPanel
        ?.querySelector('.dock-popover-content')
        ?.getBoundingClientRect().height || 0;
    const presetsHeight =
      presetsPanel
        ?.querySelector('.dock-popover-content')
        ?.getBoundingClientRect().height || 0;
    const pinnedCount = Number(locationHeight > 0) + Number(presetsHeight > 0);
    const locationHeightPx = Math.ceil(locationHeight);
    const presetsHeightPx = Math.ceil(presetsHeight);
    const topPinnedPanel = dock.querySelector(
      '.dock-pinned-top.dock-pinned:not(.collapsed)',
    );
    const lowerPinnedPanel =
      topPinnedPanel?.id === 'location-bar' ? presetsPanel : locationPanel;
    const lowerPinnedHeight =
      lowerPinnedPanel
        ?.querySelector('.dock-popover-content')
        ?.getBoundingClientRect().height || 0;
    const stackHeight =
      pinnedCount > 1
        ? `calc(${locationHeightPx}px + ${presetsHeightPx}px + 1.2rem)`
        : `${locationHeightPx + presetsHeightPx}px`;
    dock.style.setProperty(
      '--dock-location-pinned-height',
      `${locationHeightPx}px`,
    );
    dock.style.setProperty(
      '--dock-presets-pinned-height',
      `${presetsHeightPx}px`,
    );
    dock.style.setProperty(
      '--dock-lower-pinned-height',
      `${Math.ceil(lowerPinnedHeight)}px`,
    );
    dock.style.setProperty('--dock-pinned-stack-height', stackHeight);
    dock.classList.toggle('dock-has-pinned-tray', pinnedCount > 0);
    dock.classList.toggle('dock-has-two-pinned-trays', pinnedCount > 1);
  }

  _initRightPanelAdaptiveLayout() {
    if (this.destroyed) return;
    const stack = this._rightPanelStack;
    if (!stack || !this._ppToggles) return;

    this._ppToggles.style.removeProperty('top');
    this._ppToggles.style.removeProperty('right');
    this._ppToggles.style.removeProperty('bottom');
    this._ppToggles.style.removeProperty('left');
    this._ppToggles.style.removeProperty('z-index');
    this._ppToggles.classList.remove('panel-draggable', 'panel-dragging');
    this._ppToggles.querySelector('.pp-header-row')?.removeAttribute('title');
    stack.prepend(this._ppToggles);
    const globalContextPanel = document.getElementById('global-context-panel');
    for (const panel of [
      this._cctvPanel,
      this._weatherPanel,
      this._recentImageryPanel,
    ]) {
      if (!panel) continue;
      for (const property of ['top', 'right', 'bottom', 'left', 'z-index'])
        panel.style.removeProperty(property);
      panel.classList.remove('panel-draggable', 'panel-dragging');
      stack.insertBefore(panel, globalContextPanel);
      this._syncPanelCollapseButton(panel);
    }
    if (this._sliderPanel) {
      this._sliderPanel.style.removeProperty('top');
      this._sliderPanel.style.removeProperty('right');
      this._sliderPanel.style.removeProperty('bottom');
      this._sliderPanel.style.removeProperty('left');
      this._sliderPanel.style.removeProperty('max-height');
      const detectionGroup = this._detectionBtn?.closest('.pp-toggle-group');
      if (detectionGroup) detectionGroup.after(this._sliderPanel);
      else this._ppToggles.append(this._sliderPanel);
    }
    if (typeof ResizeObserver !== 'undefined') {
      this._rightStackResizeObserver = new ResizeObserver(() => {
        this._scheduleRightPanelLayout();
      });
      this._rightStackResizeObserver.observe(stack);
      for (const panel of [
        this._ppToggles,
        this._cctvPanel,
        this._weatherPanel,
        this._recentImageryPanel,
        globalContextPanel,
      ]) {
        if (panel) this._rightStackResizeObserver.observe(panel);
      }
      document
        .querySelectorAll(RIGHT_STACK_OBSTACLE_SELECTOR)
        .forEach((element) => {
          this._rightStackResizeObserver.observe(element);
        });
    }

    if (typeof MutationObserver !== 'undefined') {
      this._rightStackMutationObserver = new MutationObserver(() => {
        this._scheduleRightPanelLayout();
      });
      this._rightStackMutationObserver.observe(stack, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['class', 'hidden', 'data-variant'],
      });
      const hud = document.getElementById('intel-hud');
      if (hud) {
        this._rightStackMutationObserver.observe(hud, {
          subtree: true,
          attributes: true,
          attributeFilter: ['class', 'hidden', 'data-variant'],
        });
      }
    }

    const transitionHud = document.getElementById('intel-hud');
    if (transitionHud) {
      this._rightStackHudTransitionHandler = (event) => {
        if (
          event.propertyName === 'opacity' ||
          event.propertyName === 'visibility'
        ) {
          this._scheduleRightPanelLayout({ reconsiderAutoCollapse: true });
        }
      };
      transitionHud.addEventListener(
        'transitionend',
        this._rightStackHudTransitionHandler,
      );
    }

    this._scheduleRightPanelLayout();
  }

  _scheduleRightPanelLayout({ reconsiderAutoCollapse = false } = {}) {
    if (this.destroyed) return;
    if (reconsiderAutoCollapse) this._rightStackReconsiderAutoCollapse = true;
    if (!this._rightPanelStack || this._rightStackLayoutFrame !== null) return;
    this._rightStackLayoutFrame = requestAnimationFrame(() => {
      if (this.destroyed) return;
      this._rightStackLayoutFrame = null;
      if (this._rightStackReconsiderAutoCollapse) {
        this._rightStackReconsiderAutoCollapse = false;
        for (const panel of this._rightPanelStack.querySelectorAll(
          '.layout-auto-collapsed',
        )) {
          panel.classList.remove('collapsed', 'layout-auto-collapsed');
          this._syncPanelCollapseButton(panel);
        }
      }
      this._syncRightPanelAdaptiveLayout();
    });
  }

  _syncRightPanelAdaptiveLayout() {
    if (this.destroyed) return;
    layoutRightPanelRail({
      stack: this._rightPanelStack,
      obstacles: document.querySelectorAll(RIGHT_STACK_OBSTACLE_SELECTOR),
      windowRef: window,
      hud: this.readHud(),
      preferredPanelId: this._rightStackPreferredPanelId,
      onCollapse: (panel) => this._syncPanelCollapseButton(panel),
      onRetry: () => this._scheduleRightPanelLayout(),
      leftStack: this._leftPanelStack,
      displayPanel: this._ppToggles,
      readDisplayScrollTop: this.readDisplayScrollTop,
    });
  }

  _initLeftPanelAdaptiveLayout() {
    if (this.destroyed) return;
    const stack = this._leftPanelStack;
    if (!stack) return;

    if (typeof ResizeObserver !== 'undefined') {
      this._leftStackResizeObserver = new ResizeObserver(() => {
        this._scheduleLeftPanelLayout();
      });
      this._leftStackResizeObserver.observe(stack);
      stack.querySelectorAll(':scope > [data-panel-id]').forEach((panel) => {
        this._leftStackResizeObserver.observe(panel);
        const inner = [...panel.children].find(
          (child) => !child.classList.contains('panel-glow'),
        );
        if (inner) this._leftStackResizeObserver.observe(inner);
      });
      document
        .querySelectorAll(LEFT_STACK_OBSTACLE_SELECTOR)
        .forEach((element) => {
          this._leftStackResizeObserver.observe(element);
        });
    }

    if (typeof MutationObserver !== 'undefined') {
      this._leftStackMutationObserver = new MutationObserver(() => {
        this._scheduleLeftPanelLayout();
      });
      this._leftStackMutationObserver.observe(stack, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['class'],
      });
      const hud = document.getElementById('intel-hud');
      if (hud) {
        this._leftStackMutationObserver.observe(hud, {
          attributes: true,
          attributeFilter: ['class', 'data-variant'],
        });
      }
      const credits = document.getElementById('cesium-credits');
      if (credits) {
        this._leftStackMutationObserver.observe(credits, {
          subtree: true,
          childList: true,
        });
      }
    }

    const transitionHud = document.getElementById('intel-hud');
    if (transitionHud) {
      this._leftStackHudTransitionHandler = (event) => {
        if (
          event.propertyName === 'opacity' ||
          event.propertyName === 'visibility'
        ) {
          this._scheduleLeftPanelLayout({ reconsiderAutoCollapse: true });
          // The Cockpit strip hangs off the HUD's REC readout, so it has to
          // remeasure on the same event: the readout keeps its rect through
          // the whole fade and only stops counting once the HUD has retired.
          this.scheduleCockpitLayout();
        }
      };
      transitionHud.addEventListener(
        'transitionend',
        this._leftStackHudTransitionHandler,
      );
    }

    this._leftStackCockpitModeHandler = () => {
      if (this.destroyed) return;
      // Cockpit mode repositions the peripheral HUD and reveals its own
      // bottom-left context card. Measure after those styles have committed so
      // the accordion remains in the same obstacle-safe lane instead of
      // jumping to a cockpit-specific top anchor.
      this._scheduleLeftPanelLayout();
      if (this._cockpitLayoutFrame !== null)
        cancelAnimationFrame(this._cockpitLayoutFrame);
      this._cockpitLayoutFrame = requestAnimationFrame(() => {
        this._cockpitLayoutFrame = null;
        this._scheduleLeftPanelLayout();
      });
      clearTimeout(this._cockpitLayoutTimer);
      this._cockpitLayoutTimer = setTimeout(() => {
        this._cockpitLayoutTimer = null;
        this._scheduleLeftPanelLayout();
      }, 300);
    };
    window.addEventListener(
      'gev:cockpit-mode-changed',
      this._leftStackCockpitModeHandler,
    );

    this._scheduleLeftPanelLayout();
  }

  _scheduleLeftPanelLayout({ reconsiderAutoCollapse = false } = {}) {
    if (this.destroyed) return;
    if (reconsiderAutoCollapse) this._leftStackReconsiderAutoCollapse = true;
    if (!this._leftPanelStack || this._leftStackLayoutFrame !== null) return;
    this._leftStackLayoutFrame = requestAnimationFrame(() => {
      if (this.destroyed) return;
      this._leftStackLayoutFrame = null;
      if (this._leftStackReconsiderAutoCollapse) {
        this._leftStackReconsiderAutoCollapse = false;
        for (const panel of this._leftPanelStack.querySelectorAll(
          '.layout-auto-collapsed',
        )) {
          panel.classList.remove('collapsed', 'layout-auto-collapsed');
          this._syncPanelCollapseButton(panel);
        }
      }
      this._syncLeftPanelAdaptiveLayout();
    });
  }

  _syncLeftPanelAdaptiveLayout() {
    if (this.destroyed) return;
    layoutLeftPanelRail({
      stack: this._leftPanelStack,
      obstacles: document.querySelectorAll(LEFT_STACK_OBSTACLE_SELECTOR),
      windowRef: window,
      hud: this.readHud(),
      preferredPanelId: this._leftStackPreferredPanelId,
      onCollapse: (panel) => this._syncPanelCollapseButton(panel),
      onRetry: () => this._scheduleLeftPanelLayout(),
      collapsedHeights: this._leftStackCollapsedHeights,
      onAligned: () => this._scheduleRightPanelLayout(),
    });
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const field of [
      '_leftStackLayoutFrame',
      '_rightStackLayoutFrame',
      '_cockpitLayoutFrame',
    ]) {
      if (this[field] !== null) cancelAnimationFrame(this[field]);
      this[field] = null;
    }
    clearTimeout(this._adaptivePanelSettleTimer);
    clearTimeout(this._cockpitLayoutTimer);
    this._adaptivePanelSettleTimer = this._cockpitLayoutTimer = null;
    for (const field of [
      '_commandDockTrayObserver',
      '_leftStackResizeObserver',
      '_leftStackMutationObserver',
      '_rightStackResizeObserver',
      '_rightStackMutationObserver',
    ]) {
      this[field]?.disconnect();
      this[field] = null;
    }
    for (const field of [
      '_leftStackHudTransitionHandler',
      '_rightStackHudTransitionHandler',
    ]) {
      if (this[field])
        document
          .getElementById('intel-hud')
          ?.removeEventListener('transitionend', this[field]);
      this[field] = null;
    }
    if (this._leftStackCockpitModeHandler)
      window.removeEventListener(
        'gev:cockpit-mode-changed',
        this._leftStackCockpitModeHandler,
      );
    this._leftStackCockpitModeHandler = null;
  }
}
