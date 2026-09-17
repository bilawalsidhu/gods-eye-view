import { UiLifetime } from './uiLifetime.js';
import { PanelPositionControls } from './panelPositionControls.js';
import { PanelLayoutController } from './panelLayoutController.js';
import {
  bindPanelDisclosure,
  collapsePanelOnEscape,
  createHoverDisclosure,
} from './panelDisclosure.js';
const SHARE_PANEL_STATE_SPECS = Object.freeze([
  { id: 'control-panel', pinnable: true },
  { id: 'location-bar', pinnable: true },
  { id: 'data-panel' },
  { id: 'cctv-panel' },
  { id: 'radio-panel' },
  { id: 'scene-panel' },
  { id: 'global-context-panel' },
  { id: 'weather-panel' },
  { id: 'pp-toggles' },
  { id: 'param-slider-panel' },
]);
/** Standard map-view panels cleared out of the way on a fresh Cockpit entry. */
const COCKPIT_ENTRY_COLLAPSE_PANEL_IDS = Object.freeze([
  'data-panel',
  'cctv-panel',
  'scene-panel',
  'pp-toggles',
  'global-context-panel',
  'radio-panel',
  'weather-panel',
]);

/** Own panel disclosure, docking, persistence and Cockpit rail restoration. */
export class PanelChrome {
  constructor({
    elements,
    operations,
    readHud,
    readCockpit,
    readShareLinks,
    readInitialShare,
    readScrollRestoreOwner,
    readDisplayScrollTop,
  }) {
    Object.assign(this, elements, operations, {
      readHud,
      readCockpit,
      readShareLinks,
      readInitialShare,
      readScrollRestoreOwner,
      readDisplayScrollTop,
    });
    this._disposed = false;
    this._lifetime = new UiLifetime();
    this._cockpitPanelRestore = null;
    this._cockpitContextCollapsedForDataPanel = false;
    this._panelPosition = new PanelPositionControls({
      syncPanelCollapseButton: (panel) => this._syncPanelCollapseButton(panel),
      layoutRightPanels: () => this._layoutRightPanels(),
      syncCctvPanelViewport: () => this._syncCctvPanelViewport(),
      showToast: (message) => this._showToast(message),
    });
    this._panelLayout = new PanelLayoutController({
      readHud: () => ({
        visible: this.hud.visible,
        variant: this.hud.getVariant(),
      }),
      scheduleCockpitLayout: () => this.cockpitView?.scheduleContextLayout(),
      syncPanelCollapseButton: (panel) => this._syncPanelCollapseButton(panel),
      readDisplayScrollTop: () =>
        this._displayPortalScrollRestoreOwner === 'standard'
          ? this._standardDisplayScrollTop
          : this._ppToggles?.scrollTop || 0,
    });
  }
  get hud() {
    return this.readHud();
  }
  get cockpitView() {
    return this.readCockpit();
  }
  get shareLinkManager() {
    return this.readShareLinks();
  }
  get _initialShareState() {
    return this.readInitialShare();
  }
  get _displayPortalScrollRestoreOwner() {
    return this.readScrollRestoreOwner();
  }
  get _standardDisplayScrollTop() {
    return this.readDisplayScrollTop();
  }

  _initPanelChrome() {
    for (const control of this._panelDisclosureControls || [])
      control.destroy();
    this._panelDisclosureControls = [];
    const targets = new Map();
    document
      .querySelectorAll('.panel-collapse-btn[data-collapse-target]')
      .forEach((button) => {
        const targetId = button.dataset.collapseTarget;
        if (!targetId) return;
        if (!targets.has(targetId)) targets.set(targetId, []);
        targets.get(targetId).push(button);
      });
    for (const [targetId, buttons] of targets) {
      const panel = document.getElementById(targetId);
      if (!panel) continue;
      this._panelDisclosureControls.push(
        bindPanelDisclosure({
          panel,
          buttons,
          onChange: (collapsed, options) =>
            this.setPanelCollapsed(targetId, collapsed, options),
          onEscape: (event) => this._collapsePanelOnEscape(event, targetId),
        }),
      );
      this._restorePanelCollapsedState(targetId, {
        allowStored: !this._initialShareState,
      });
    }
    // The command dock always starts compact; either wing reveals on hover,
    // focus, or click and collapses again after the interaction moves away.
    this.setPanelCollapsed('control-panel', true, {
      syncShare: false,
      persist: false,
    });
    this.setPanelCollapsed('location-bar', true, {
      syncShare: false,
      persist: false,
    });
    this._initAutoHoverPanel('control-panel', {
      openDelayMs: 140,
      closeDelayMs: 420,
    });
    this._initAutoHoverPanel('location-bar', {
      openDelayMs: 140,
      closeDelayMs: 420,
    });
    this._initCommandDockPins();
    this._initCommandDockTrayMetrics();
    this._maybeNotifyLayoutReset();
  }

  _collapsePanelOnEscape(event, panelId) {
    return collapsePanelOnEscape(event, {
      panel: document.getElementById(panelId),
      onChange: (collapsed, options) =>
        this.setPanelCollapsed(panelId, collapsed, options),
      beforeCollapse: () => {
        if (panelId !== 'location-bar' || !this._locationSearch) return;
        this._locationSearch.classList.remove('expanded');
        this._locationSearch.value = '';
        this._locationSearch.blur();
      },
    });
  }

  _initCommandDockPins() {
    document
      .querySelectorAll('.dock-pin-btn[data-pin-target]')
      .forEach((button) => {
        this._lifetime.listen(button, 'click', (event) => {
          event.stopPropagation();
          const panelId = button.dataset.pinTarget;
          this._setCommandDockPanelPinState(panelId);
        });
      });
  }

  _setCommandDockPanelPinState(
    panelId,
    pin,
    { restore = false, persist = true, syncShare = true } = {},
  ) {
    const panelEl = document.getElementById(panelId);
    const button = document.querySelector(
      `.dock-pin-btn[data-pin-target="${panelId}"]`,
    );
    if (!panelEl || !button) return undefined;
    const shouldPin =
      typeof pin === 'boolean'
        ? pin
        : !panelEl.classList.contains('dock-pinned');
    panelEl.classList.toggle('dock-pinned', shouldPin);
    button.setAttribute('aria-pressed', String(shouldPin));
    document
      .querySelectorAll('#command-dock .dock-pinned-top')
      .forEach((pinnedPanel) => {
        pinnedPanel.classList.remove('dock-pinned-top');
      });
    if (shouldPin) {
      panelEl.classList.add('dock-pinned-top');
      this.setPanelCollapsed(panelId, false, {
        explicit: !restore,
        restore,
        persist,
        syncShare: false,
      });
    } else {
      const remainingPinnedPanel = document.querySelector(
        '#command-dock .dock-pinned',
      );
      remainingPinnedPanel?.classList.add('dock-pinned-top');
      if (!restore && !panelEl.matches(':hover')) {
        this.setPanelCollapsed(panelId, true, {
          explicit: true,
          persist,
          syncShare: false,
        });
      }
    }
    this._updateCommandDockTrayStack();
    if (syncShare) {
      if (!restore) this.shareLinkManager?.claimRestoreLane?.('panel', panelId);
      this.shareLinkManager?.onPanelStateChange?.();
    }
    return shouldPin;
  }

  _initCommandDockTrayMetrics() {
    return this._panelLayout._initCommandDockTrayMetrics();
  }

  _updateCommandDockTrayStack() {
    return this._panelLayout._updateCommandDockTrayStack();
  }

  _maybeNotifyLayoutReset() {
    return this._panelPosition._maybeNotifyLayoutReset();
  }

  _initAutoHoverPanel(
    panelId,
    { openDelayMs = 850, closeDelayMs = 1000 } = {},
  ) {
    const panel = document.getElementById(panelId);
    if (!panel) return;
    this._hoverPanelControls ??= new Map();
    this._hoverPanelControls.get(panelId)?.destroy();
    const controller = createHoverDisclosure({
      panel,
      documentRef: document,
      disclosure: panel.querySelector(`[data-dock-toggle-target="${panelId}"]`),
      openDelayMs,
      closeDelayMs,
      isActive: () => !this._disposed,
      onChange: (collapsed, options) =>
        this.setPanelCollapsed(panelId, collapsed, options),
      onEscape: (event) => this._collapsePanelOnEscape(event, panelId),
      focusTarget:
        panelId === 'control-panel'
          ? () =>
              panel.querySelector('.map-stack-chip.active') ||
              panel.querySelector('.map-stack-chip')
          : null,
    });
    this._hoverPanelControls.set(panelId, controller);
    if (panelId === 'control-panel') {
      this._cancelMapSourceFocus?.();
      this._cancelMapSourceFocus = controller.cancelPendingFocus;
    }
  }

  _restorePanelCollapsedState(panelId, options1) {
    return this._panelPosition._restorePanelCollapsedState(panelId, options1);
  }

  _savePanelCollapsedState(panelId, collapsed) {
    return this._panelPosition._savePanelCollapsedState(panelId, collapsed);
  }

  _scheduleRightPanelLayout(options0) {
    return this._panelLayout._scheduleRightPanelLayout(options0);
  }

  _scheduleLeftPanelLayout(options0) {
    return this._panelLayout._scheduleLeftPanelLayout(options0);
  }

  _syncPanelCollapseButton(panelEl) {
    const isRightRail = [
      'pp-toggles',
      'cctv-panel',
      'global-context-panel',
      'weather-panel',
    ].includes(panelEl?.id);
    const collapsed = panelEl.classList.contains('collapsed');
    panelEl
      .querySelectorAll('.panel-collapse-btn[data-collapse-target]')
      .forEach((btn) => {
        const owner = btn.closest('[data-panel-id], #param-slider-panel');
        if (owner !== panelEl) return;
        if (isRightRail) {
          btn.textContent = collapsed ? '◀' : '▶';
        } else {
          btn.textContent = collapsed ? '+' : '−';
        }
        btn.setAttribute('aria-expanded', String(!collapsed));
        const panelName =
          panelEl
            .querySelector('.panel-title, .pp-header-label')
            ?.textContent?.trim() || 'panel';
        const action = collapsed ? 'Expand' : 'Collapse';
        btn.title = `${action} ${panelName}`;
        btn.setAttribute('aria-label', `${action} ${panelName}`);
        if (panelEl.id === 'radio-panel') {
          const action = collapsed ? 'Expand' : 'Collapse';
          btn.title = `${action} Radio`;
          btn.setAttribute('aria-label', `${action} Radio section`);
        }
      });
    const dockToggle = panelEl.querySelector(
      `[data-dock-toggle-target="${panelEl.id}"]`,
    );
    if (dockToggle) {
      const panelName =
        panelEl
          .querySelector('.panel-title, .location-toolbar-label')
          ?.textContent?.trim() || 'panel';
      const action = collapsed ? 'Expand' : 'Collapse';
      dockToggle.setAttribute('aria-expanded', String(!collapsed));
      dockToggle.setAttribute('aria-label', `${action} ${panelName}`);
      dockToggle.title = `${action} ${panelName}`;
    }
    if (panelEl.id === 'radio-panel' && this._contextRadioDetailsBtn) {
      this._contextRadioDetailsBtn.setAttribute(
        'aria-expanded',
        String(!collapsed),
      );
    }
    if (panelEl.id === 'radio-panel' || panelEl.id === 'global-context-panel') {
      this._syncContextRadioLauncherState();
    }
  }

  _buildSharePanelState() {
    const specs = [];
    for (const spec of SHARE_PANEL_STATE_SPECS) {
      const panelEl = document.getElementById(spec.id);
      if (!panelEl) continue;
      // Responsive auto-collapse is presentation only; the recipient should
      // restore the user's explicit expanded preference at its own viewport.
      const collapsed = panelEl.classList.contains('layout-auto-collapsed')
        ? false
        : panelEl.classList.contains('collapsed');
      const entry = { id: spec.id, collapsed };
      if (spec.pinnable)
        entry.pinned = panelEl.classList.contains('dock-pinned');
      specs.push(entry);
    }
    return specs.length ? { specs } : null;
  }

  _restorePanelState(panelState) {
    if (!panelState || !Array.isArray(panelState.specs)) return;
    const specsById = new Map(panelState.specs.map((spec) => [spec.id, spec]));
    for (const spec of SHARE_PANEL_STATE_SPECS) {
      const state = specsById.get(spec.id);
      if (!state || typeof state.collapsed !== 'boolean') continue;
      if (spec.pinnable && typeof state.pinned === 'boolean') {
        this._setCommandDockPanelPinState(spec.id, state.pinned, {
          restore: true,
          persist: false,
          syncShare: false,
        });
      }
      const nextCollapsed =
        state.pinned && spec.pinnable ? false : state.collapsed;
      this.setPanelCollapsed(spec.id, nextCollapsed, {
        restore: true,
        persist: false,
        syncShare: false,
      });
    }
    this.shareLinkManager?.onPanelStateChange?.();
  }

  setPanelCollapsed(
    panelId,
    collapsed,
    {
      explicit = false,
      restore = false,
      persist = true,
      syncShare = true,
    } = {},
  ) {
    if (panelId === 'control-panel' && collapsed)
      this._cancelMapSourceFocus?.();
    const panelEl = document.getElementById(panelId);
    if (!panelEl) return;
    if (explicit && !restore)
      this.shareLinkManager?.claimRestoreLane?.('panel', panelId);
    const nextCollapsed = Boolean(collapsed);
    const wasAutoCollapsed = panelEl.classList.contains(
      'layout-auto-collapsed',
    );
    const leftOwnerPanel = this._leftPanelStack?.contains(panelEl)
      ? panelEl
      : null;
    const rightOwnerPanel =
      panelId === 'radio-panel'
        ? document.getElementById('global-context-panel')
        : this._rightPanelStack?.contains(panelEl)
          ? panelEl
          : null;
    // Opening the Weather panel is when its readout is worth having: the
    // spend is read here rather than on a timer, since a polling readout
    // would itself be traffic on a panel built to keep traffic deliberate.
    if (!nextCollapsed && panelId === 'weather-panel') this._syncWeatherPanel();
    const priorLeftOwner = this._panelLayout._leftStackPreferredPanelId;
    const priorRightOwner = this._panelLayout._rightStackPreferredPanelId;
    if (explicit && !restore && !nextCollapsed && leftOwnerPanel) {
      this._panelLayout._leftStackPreferredPanelId = leftOwnerPanel.id;
    } else if (
      explicit &&
      !restore &&
      nextCollapsed &&
      leftOwnerPanel?.id === this._panelLayout._leftStackPreferredPanelId
    ) {
      this._panelLayout._leftStackPreferredPanelId = null;
    }
    if (explicit && !restore && !nextCollapsed && rightOwnerPanel) {
      this._panelLayout._rightStackPreferredPanelId = rightOwnerPanel.id;
    } else if (
      explicit &&
      !restore &&
      nextCollapsed &&
      rightOwnerPanel?.id === this._panelLayout._rightStackPreferredPanelId
    ) {
      this._panelLayout._rightStackPreferredPanelId = null;
    }
    if (
      panelEl.classList.contains('collapsed') === nextCollapsed &&
      !wasAutoCollapsed
    ) {
      this._syncPanelCollapseButton(panelEl);
      if (priorLeftOwner !== this._panelLayout._leftStackPreferredPanelId) {
        this._scheduleLeftPanelLayout({ reconsiderAutoCollapse: true });
      }
      if (priorRightOwner !== this._panelLayout._rightStackPreferredPanelId) {
        this._scheduleRightPanelLayout({ reconsiderAutoCollapse: true });
      }
      return;
    }
    panelEl.classList.remove('layout-auto-collapsed');
    if (
      !nextCollapsed &&
      this.cockpitView?.active &&
      panelId === 'data-panel'
    ) {
      this._cockpitContextCollapsedForDataPanel =
        !this.cockpitView.contextCollapsed;
      if (this._cockpitContextCollapsedForDataPanel) {
        this.cockpitView.setContextCollapsed(true);
      }
    }
    if (
      !nextCollapsed &&
      panelId === 'global-context-panel' &&
      this._contextRadioDock?.classList.contains('disclosure-open')
    ) {
      this._setRadioDisclosure?.(false);
    }
    if (
      !nextCollapsed &&
      panelId === 'radio-panel' &&
      document
        .getElementById('global-context-panel')
        ?.classList.contains('collapsed')
    ) {
      this.setPanelCollapsed('global-context-panel', false, {
        restore,
        persist,
        syncShare,
      });
    }
    if (!nextCollapsed && !restore && panelId === 'location-bar') {
      const otherPanel = document.getElementById('control-panel');
      if (otherPanel && !otherPanel.classList.contains('dock-pinned')) {
        this.setPanelCollapsed('control-panel', true, {
          restore,
          persist,
          syncShare,
        });
      }
    } else if (!nextCollapsed && !restore && panelId === 'control-panel') {
      const otherPanel = document.getElementById('location-bar');
      if (otherPanel && !otherPanel.classList.contains('dock-pinned')) {
        this.setPanelCollapsed('location-bar', true, {
          restore,
          persist,
          syncShare,
        });
      }
    }
    panelEl.classList.toggle('collapsed', nextCollapsed);
    if (
      nextCollapsed &&
      this.cockpitView?.active &&
      panelId === 'data-panel' &&
      this._cockpitContextCollapsedForDataPanel
    ) {
      this._cockpitContextCollapsedForDataPanel = false;
      this.cockpitView.setContextCollapsed(false);
    }
    this._syncPanelCollapseButton(panelEl);
    if (persist !== false)
      this._savePanelCollapsedState(panelId, nextCollapsed);
    if (panelId === 'pp-toggles') {
      this._layoutRightPanels();
    }
    if (this._rightPanelStack?.contains(panelEl)) {
      this._scheduleRightPanelLayout({ reconsiderAutoCollapse: true });
    }
    if (panelId === 'cctv-panel') {
      this._syncCctvPanelViewport();
    }
    this._lifetime.frame(() => this._updateCommandDockTrayStack());
    this._scheduleLeftPanelLayout({
      reconsiderAutoCollapse: this._leftPanelStack?.contains(panelEl) === true,
    });
    if (syncShare) this.shareLinkManager?.onPanelStateChange?.();
  }

  _layoutRightPanels() {
    this._scheduleRightPanelLayout();
  }
  enterCockpit() {
    // A new Cockpit session owns both side rails. Clear standard map-view
    // panels once on entry; NEXT/PREVIOUS never reaches this callback, so
    // panels the operator opens while already inside remain untouched.
    this._cockpitPanelRestore = new Map();
    this._cockpitContextCollapsedForDataPanel = false;
    for (const panelId of COCKPIT_ENTRY_COLLAPSE_PANEL_IDS) {
      const panel = document.getElementById(panelId);
      if (panel) {
        this._cockpitPanelRestore.set(
          panelId,
          panel.classList.contains('collapsed'),
        );
      }
      this.setPanelCollapsed(panelId, true, {
        persist: false,
        syncShare: false,
      });
    }
    this.cockpitView?.setContextCollapsed(false);
    this.cockpitView?.setSignalCollapsed(false, { user: true });
  }
  exitCockpit() {
    const restore = this._cockpitPanelRestore;
    this._cockpitPanelRestore = null;
    this._cockpitContextCollapsedForDataPanel = false;
    if (!restore) return;
    for (const [panelId, wasCollapsed] of restore) {
      this.setPanelCollapsed(panelId, wasCollapsed, {
        persist: false,
        syncShare: false,
      });
    }
  }
  destroy() {
    if (this._disposed) return;
    this._disposed = true;
    this._lifetime.destroy();
    this._panelPosition.destroy();
    this._panelLayout.destroy();
    for (const control of this._panelDisclosureControls || [])
      control.destroy();
    this._panelDisclosureControls = [];
    this._hoverPanelControls?.forEach((control) => control.destroy());
    this._hoverPanelControls?.clear();
    this._cancelMapSourceFocus?.();
  }
}
