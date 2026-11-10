import { UiLifetime } from './uiLifetime.js';
import { prefersCollapsed, readPanelState } from './rail/panelState.js';
import { usePanelChromeStore } from './stores/panelChrome.js';
import { applicationPinia } from './vueRuntime.js';
import { displayPanelScroller } from './displayPanelScroll.js';
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
  { id: 'weather-panel' },
  { id: 'recent-imagery-panel' },
  { id: 'street-level-panel' },
  { id: 'radio-panel' },
  { id: 'scene-panel' },
  { id: 'global-context-panel' },
  { id: 'pp-toggles' },
  { id: 'param-slider-panel' },
]);
/**
 * The left panels Cockpit keeps (Data Layers, and Utilities for Directions):
 * opening one there folds the Cockpit context rail away until it closes.
 */
const COCKPIT_LEFT_PANEL_IDS = new Set(['data-panel', 'utilities-panel']);
/** The command dock trays with a pin button. */
const PINNABLE_PANEL_IDS = new Set(
  SHARE_PANEL_STATE_SPECS.filter((spec) => spec.pinnable).map(
    (spec) => spec.id,
  ),
);
/** Standard map-view panels cleared out of the way on a fresh Cockpit entry. */
const COCKPIT_ENTRY_COLLAPSE_PANEL_IDS = Object.freeze([
  'data-panel',
  'cctv-panel',
  'weather-panel',
  'recent-imagery-panel',
  'street-level-panel',
  'scene-panel',
  'utilities-panel',
  'pp-toggles',
  'global-context-panel',
  'radio-panel',
]);

/** Own panel disclosure, docking, persistence and Cockpit rail restoration. */
export class PanelChrome {
  /**
   * Whether another left panel Cockpit keeps is open, or only folded aside
   * for this one and coming back when it closes.
   * @param {string} panelId The panel closing.
   */
  _otherCockpitLeftPanelOpen(panelId) {
    return [...COCKPIT_LEFT_PANEL_IDS].some((id) => {
      if (id === panelId) return false;
      const panel = document.getElementById(id);
      return (
        !!panel &&
        (!panel.classList.contains('collapsed') ||
          panel.classList.contains('layout-auto-collapsed'))
      );
    });
  }

  constructor({
    elements,
    operations,
    readHud,
    readCockpit,
    readShareLinks,
    readInitialShare,
    readScrollRestoreOwner,
    readDisplayScrollTop,
    readSharedCollapsed = () => undefined,
    store = usePanelChromeStore(applicationPinia()),
  }) {
    Object.assign(this, elements, operations, {
      readHud,
      readCockpit,
      readShareLinks,
      readInitialShare,
      readScrollRestoreOwner,
      readDisplayScrollTop,
      readSharedCollapsed,
    });
    this._disposed = false;
    this._lifetime = new UiLifetime();
    // The collapse, dock and pin buttons render each panel's state from the
    // store; their clicks take effect only once the chrome is initialized.
    this._chromeStore = store;
    this._chromeToken = store.connect({
      toggle: (panelId) => this._togglePanel(panelId),
      pin: (panelId) => {
        if (this._disclosurePanelIds)
          this._setCommandDockPanelPinState(panelId);
      },
    });
    this._cockpitPanelRestore = null;
    this._cockpitContextCollapsedForDataPanel = false;
    this._panelPosition = new PanelPositionControls({
      presentPanel: (panel, patch) => this._presentPanel(panel, patch),
      shownPanel: (panel) => this._shownPanel(panel),
      showToast: (message) => this._showToast(message),
    });
    this._panelLayout = new PanelLayoutController({
      readHud: () => ({
        visible: this.hud.visible,
        variant: this.hud.getVariant(),
      }),
      scheduleCockpitLayout: () => this.cockpitView?.scheduleContextLayout(),
      presentPanel: (panel, patch) => this._presentPanel(panel, patch),
      readDisplayScrollTop: () =>
        this._displayPortalScrollRestoreOwner === 'standard'
          ? this._standardDisplayScrollTop
          : displayPanelScroller(this._ppToggles)?.scrollTop || 0,
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
    this._disclosurePanelIds = new Set();
    const targets = new Set(
      [
        ...document.querySelectorAll(
          '.panel-collapse-btn[data-collapse-target]',
        ),
      ]
        .map((button) => button.dataset.collapseTarget)
        .filter(Boolean),
    );
    for (const targetId of targets) {
      const panel = document.getElementById(targetId);
      if (!panel) continue;
      this._disclosurePanelIds.add(targetId);
      this._panelDisclosureControls.push(
        bindPanelDisclosure({
          panel,
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
    this._initCommandDockTrayMetrics();
    this._maybeNotifyLayoutReset();
  }

  _collapsePanelOnEscape(event, panelId) {
    // In a phone sheet, Escape closes the sheet (mobileShell.js), not a panel.
    if (globalThis.document?.body?.hasAttribute?.('data-mobile-sheet'))
      return false;
    return collapsePanelOnEscape(event, {
      panel: document.getElementById(panelId),
      onChange: (collapsed, options) =>
        this.setPanelCollapsed(panelId, collapsed, options),
      beforeCollapse: () => {
        if (panelId === 'location-bar') this._closeLocationSearch?.();
      },
      // A desktop side panel hides entirely once collapsed; its rail item
      // takes the focus its own disclosure can no longer hold.
      returnFocusTo: () => {
        const panel = document.getElementById(panelId);
        if (!panel?.getClientRects || panel.getClientRects().length > 0)
          return null;
        const item = document.querySelector?.(
          `.ui-rail [data-rail-item="${panelId}"]`,
        );
        return item &&
          !item.disabled &&
          item.getClientRects().length > 0 &&
          getComputedStyle(item).visibility === 'visible'
          ? item
          : null;
      },
    });
  }

  /** A collapse button's click: flip its panel. */
  _togglePanel(panelId) {
    if (this._disposed || !this._disclosurePanelIds?.has(panelId)) return;
    const panel = document.getElementById(panelId);
    if (!panel) return;
    this.setPanelCollapsed(panelId, !this._shownPanel(panel).collapsed, {
      explicit: true,
    });
  }

  _setCommandDockPanelPinState(
    panelId,
    pin,
    { restore = false, persist = true, syncShare = true } = {},
  ) {
    if (this._disposed || !PINNABLE_PANEL_IDS.has(panelId)) return undefined;
    const panelEl = document.getElementById(panelId);
    if (!panelEl) return undefined;
    const shouldPin =
      typeof pin === 'boolean' ? pin : !this._shownPanel(panelEl).pinned;
    // The tray pinned last draws on top; unpinning hands the top to the
    // other tray if it is pinned.
    this._presentPanel(panelEl, { pinned: shouldPin, pinnedTop: shouldPin });
    for (const otherId of PINNABLE_PANEL_IDS) {
      if (otherId === panelId) continue;
      const other = document.getElementById(otherId);
      if (!other) continue;
      this._presentPanel(other, {
        pinnedTop: !shouldPin && this._shownPanel(other).pinned,
      });
    }
    if (shouldPin) {
      this.setPanelCollapsed(panelId, false, {
        explicit: !restore,
        restore,
        persist,
        syncShare: false,
      });
    } else {
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
      // A phone sheet holds its trays open; the tab bar closes them.
      isActive: () =>
        !this._disposed &&
        !globalThis.document?.body?.hasAttribute?.('data-mobile-sheet'),
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

  /**
   * Present a panel's state, merged over what it shows now, to the panel
   * chrome store; its root and buttons draw it from there.
   * @param {Element|string} panelOrId
   * @param {Partial<import('./stores/panelChrome.js').PanelState>} [patch]
   */
  _presentPanel(panelOrId, patch = {}) {
    const panelEl =
      typeof panelOrId === 'string'
        ? document.getElementById(panelOrId)
        : panelOrId;
    if (!panelEl?.id) return;
    this._chromeStore.publish(this._chromeToken, panelEl.id, {
      ...this._shownPanel(panelEl),
      ...patch,
    });
  }

  /**
   * A panel's state as PanelChrome presented it, or its markup's before the
   * first presentation.
   * @param {Element} panelEl
   * @returns {import('./stores/panelChrome.js').PanelState}
   */
  _shownPanel(panelEl) {
    return this._chromeStore.panels[panelEl.id] ?? readPanelState(panelEl);
  }

  _buildSharePanelState() {
    const specs = [];
    for (const spec of SHARE_PANEL_STATE_SPECS) {
      const panelEl = document.getElementById(spec.id);
      if (!panelEl) continue;
      // Responsive auto-collapse is presentation only; the recipient should
      // restore the user's explicit expanded preference at its own viewport.
      const shown = this._shownPanel(panelEl);
      const collapsed = prefersCollapsed(shown);
      // A panel the phone shell only borrowed for a sheet shares its own state.
      const entry = {
        id: spec.id,
        collapsed: this.readSharedCollapsed(spec.id) ?? collapsed,
      };
      if (spec.pinnable) entry.pinned = shown.pinned;
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
    const wasAutoCollapsed = Boolean(this._shownPanel(panelEl).auto);
    // One panel is open per desktop side: opening a side panel, whether the
    // user asked or a feature revealed it (Street Level's viewer, a selected
    // radio station), owns the whole accordion, including peers that were
    // only presentation-collapsed during a saved-state restore.
    const sideStack = [this._leftPanelStack, this._rightPanelStack].find(
      (stack) => stack && panelEl.parentElement === stack,
    );
    if (
      !restore &&
      !nextCollapsed &&
      sideStack &&
      // Phone sheets show several rail panels at once.
      !document.body?.classList?.contains('mobile-shell')
    ) {
      for (const peer of sideStack.children) {
        if (
          peer !== panelEl &&
          peer.matches('[data-panel-id]') &&
          !peer.hidden
        ) {
          this.setPanelCollapsed(peer.id, true, {
            explicit,
            persist,
            syncShare: false,
          });
        }
      }
    }
    const leftOwnerPanel = this._leftPanelStack?.contains(panelEl)
      ? panelEl
      : null;
    const rightOwnerPanel =
      panelId === 'radio-panel'
        ? document.getElementById('global-context-panel')
        : this._rightPanelStack?.contains(panelEl)
          ? panelEl
          : null;
    const priorLeftOwner = this._panelLayout._leftStackPreferredPanelId;
    const priorRightOwner = this._panelLayout._rightStackPreferredPanelId;
    if (!restore && !nextCollapsed && leftOwnerPanel) {
      this._panelLayout._leftStackPreferredPanelId = leftOwnerPanel.id;
    } else if (
      explicit &&
      !restore &&
      nextCollapsed &&
      leftOwnerPanel?.id === this._panelLayout._leftStackPreferredPanelId
    ) {
      this._panelLayout._leftStackPreferredPanelId = null;
    }
    if (!restore && !nextCollapsed && rightOwnerPanel) {
      this._panelLayout._rightStackPreferredPanelId = rightOwnerPanel.id;
    } else if (
      explicit &&
      !restore &&
      nextCollapsed &&
      rightOwnerPanel?.id === this._panelLayout._rightStackPreferredPanelId
    ) {
      this._panelLayout._rightStackPreferredPanelId = null;
    }
    // Reveal Radio's owner before the no-op check: the nested section may
    // already be expanded while its Context parent is closed.
    const contextPanel = document.getElementById('global-context-panel');
    if (
      !nextCollapsed &&
      panelId === 'radio-panel' &&
      contextPanel &&
      this._shownPanel(contextPanel).collapsed
    ) {
      this.setPanelCollapsed('global-context-panel', false, {
        explicit,
        restore,
        persist,
        syncShare,
      });
    }
    if (
      this._shownPanel(panelEl).collapsed === nextCollapsed &&
      !wasAutoCollapsed
    ) {
      if (priorLeftOwner !== this._panelLayout._leftStackPreferredPanelId) {
        this._scheduleLeftPanelLayout({ reconsiderAutoCollapse: true });
      }
      if (priorRightOwner !== this._panelLayout._rightStackPreferredPanelId) {
        this._scheduleRightPanelLayout({ reconsiderAutoCollapse: true });
      }
      return;
    }
    if (
      !nextCollapsed &&
      this.cockpitView?.active &&
      COCKPIT_LEFT_PANEL_IDS.has(panelId)
    ) {
      // Record the fold once: opening the other left panel after the first
      // must not forget that Contact was folded for them.
      if (!this._cockpitContextCollapsedForDataPanel)
        this._cockpitContextCollapsedForDataPanel =
          !this.cockpitView.contextCollapsed;
      if (this._cockpitContextCollapsedForDataPanel) {
        this.cockpitView.setContextCollapsed(true);
      }
    }
    if (!nextCollapsed && !restore && panelId === 'location-bar') {
      const otherPanel = document.getElementById('control-panel');
      if (otherPanel && !this._shownPanel(otherPanel).pinned) {
        this.setPanelCollapsed('control-panel', true, {
          restore,
          persist,
          syncShare,
        });
      }
    } else if (!nextCollapsed && !restore && panelId === 'control-panel') {
      const otherPanel = document.getElementById('location-bar');
      if (otherPanel && !this._shownPanel(otherPanel).pinned) {
        this.setPanelCollapsed('location-bar', true, {
          restore,
          persist,
          syncShare,
        });
      }
    }
    this._presentPanel(panelEl, { collapsed: nextCollapsed, auto: null });
    if (
      nextCollapsed &&
      this.cockpitView?.active &&
      COCKPIT_LEFT_PANEL_IDS.has(panelId) &&
      this._cockpitContextCollapsedForDataPanel &&
      !this._otherCockpitLeftPanelOpen(panelId)
    ) {
      this._cockpitContextCollapsedForDataPanel = false;
      this.cockpitView.setContextCollapsed(false);
    }
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
          this._shownPanel(panel).collapsed,
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
    // Cockpit's own teardown follows the chrome's: put back the panels its
    // entry closed while this owner can still present them.
    this.exitCockpit();
    this._disposed = true;
    this._lifetime.destroy();
    this._chromeStore.detach(this._chromeToken);
    this._panelLayout.destroy();
    for (const control of this._panelDisclosureControls || [])
      control.destroy();
    this._panelDisclosureControls = [];
    this._hoverPanelControls?.forEach((control) => control.destroy());
    this._hoverPanelControls?.clear();
    this._cancelMapSourceFocus?.();
  }
}
