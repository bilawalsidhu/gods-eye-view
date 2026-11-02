import { isExplicitLayerStateOrigin } from '../data/layerState.js';
import {
  presentStreetLevelPanel,
  SINCE_STOPS,
} from './streetLevelPresentation.js';
import { useStreetLevelStore } from './stores/streetLevel.js';
import { applicationPinia } from './vueRuntime.js';
import { onLocaleChange, t, translateKnown } from '../i18n/index.js';

const RENDER_MODE_KEY = 'gev:street-level:render-mode';
/** <body> classes of the modes that hide every panel; an expanded photo leaves with them. */
const PANEL_HIDING_MODES = ['ui-clean-view', 'recording-mode', 'cockpit-mode'];

/**
 * Drives the Street Level panel body: provider chips, filters and viewer.
 * The panel view renders what this presents (`gev-street-level` store); the
 * panel chrome itself belongs to the application shell.
 */
export class StreetLevelControls {
  constructor({
    root,
    layer,
    actions,
    store = useStreetLevelStore(applicationPinia()),
  }) {
    this.root = root;
    this.layer = layer;
    this.actions = actions;
    this.store = store;
    this._storeToken = store.attach({
      // The readout follows the thumb; coverage is rebuilt once, on release.
      setSinceStop: (stop) =>
        this._setParams({ sinceDays: SINCE_STOPS[stop]?.days ?? 0 }),
      describeSinceStop: (stop) => t(SINCE_STOPS[stop]?.label ?? ''),
      setPano: (pano) => this._setParams({ pano }),
      setRenderMode: (mode) => {
        this.layer.setViewerRenderMode?.(mode);
        try {
          localStorage.setItem(RENDER_MODE_KEY, mode);
        } catch {
          /* storage unavailable */
        }
      },
    });
    this.destroyed = false;
    this.listeners = new AbortController();
    this._unsubscribe = null;
    this._state = null;
    this._view = null;
    this._wasEnabled = null;
    this._wasOpen = false;
    // Whether the last switch-on was explicit (user, voice, tool), not a restore.
    this._explicitEnable = false;
    this._unsubscribeEnableRequests = null;
    this._resizeQueued = false;
    this._elements = this._collect();
    this._bind();
    // The presentation holds translated text; present it again in a new locale.
    this._offLocale = onLocaleChange(() => {
      if (this._state) this.render(this._state);
    });
  }

  _collect() {
    const byId = (id) => this.root?.querySelector(`#${id}`) || null;
    return {
      status: byId('sl-status'),
      providerChips: byId('sl-provider-chips'),
      nearestBtn: byId('sl-nearest-btn'),
      viewerWrap: byId('sl-viewer-wrap'),
      viewerExpand: byId('sl-viewer-expand'),
      viewerClose: byId('sl-viewer-close'),
      viewer: byId('sl-viewer'),
    };
  }

  listen(target, type, handler, options = {}) {
    target?.addEventListener(type, handler, {
      ...options,
      signal: this.listeners.signal,
    });
  }

  _bind() {
    const el = this._elements;
    if (!this.root) return;
    this.layer.attachViewerHost?.(el.viewer);

    this.listen(el.status, 'click', () => this._toggleEnabled());
    this.listen(el.providerChips, 'click', (event) => {
      const button = event.target?.closest?.('.data-toggle-chip');
      if (!button || button.disabled) return;
      // A keyless chip shows its tooltip instead of switching; others switch.
      const chip = this._view?.providers.find(
        (entry) => entry.id === button.dataset.chipId,
      );
      if (chip?.state === 'error') {
        if (button.title) this.actions.showToast?.(button.title);
        return;
      }
      this._toggleProvider(button.dataset.chipId);
    });
    this.listen(el.nearestBtn, 'click', () => {
      const nearest = this._view?.nearest;
      if (!nearest?.visible || nearest.disabled) return;
      this.layer.openNearest?.(undefined, {
        providerIds: nearest.providerIds,
        frame: false,
        aim: 'screen-centre',
      });
    });
    this.listen(el.viewerClose, 'click', () => this.layer.closeViewer?.());
    // EXPAND is the browser's fullscreen. iPhone Safari has no element
    // fullscreen, so there it is a top-layer popover; with neither, no button.
    this._expandMode =
      typeof el.viewerWrap?.requestFullscreen === 'function'
        ? 'fullscreen'
        : typeof el.viewerWrap?.showPopover === 'function'
          ? 'popover'
          : null;
    this._popoverOpen = false;
    if (this._expandMode) {
      this.listen(el.viewerExpand, 'click', () => this._toggleExpanded());
      if (this._expandMode === 'fullscreen')
        this.listen(document, 'fullscreenchange', () => this._syncExpanded());
      else
        this.listen(el.viewerWrap, 'toggle', (event) =>
          this._onPopoverToggle(event),
        );
      // Esc shrinks the photo before the panel's own Esc can collapse it, in
      // a browser that hands the key to the page while full screen too.
      this.listen(el.viewerWrap, 'keydown', (event) => {
        if (event.key !== 'Escape' || !this.isViewerExpanded()) return;
        event.preventDefault();
        event.stopPropagation();
        this._exitExpanded();
      });
    }
    this.store.setExpandAvailable(Boolean(this._expandMode));
    try {
      const stored = localStorage.getItem(RENDER_MODE_KEY);
      if (stored === 'fill' || stored === 'letterbox')
        this.layer.setViewerRenderMode?.(stored);
    } catch {
      /* storage unavailable */
    }
    // MapillaryJS only tracks window resizes; the panel resizes on its own.
    if (typeof ResizeObserver === 'function' && el.viewer) {
      this._resizeObserver = new ResizeObserver(() => this._requestResize());
      this._resizeObserver.observe(el.viewer);
    }
  }

  /**
   * Refit the viewer once per frame. Skips a hidden (0×0) viewer, which would
   * ask for tiles at z=NaN; the observer fires again once it has a size.
   */
  _requestResize() {
    if (this._resizeQueued) return;
    this._resizeQueued = true;
    requestAnimationFrame(() => {
      this._resizeQueued = false;
      const viewer = this._elements.viewer;
      if (this.destroyed) return;
      if (viewer && (viewer.clientWidth === 0 || viewer.clientHeight === 0))
        return;
      this.layer.resizeViewer?.();
    });
  }

  async _toggleEnabled() {
    const enabled = this.actions.isEnabled?.() === true;
    try {
      await this.actions.setEnabled?.(!enabled);
    } catch (error) {
      this.actions.showToast?.(
        translateKnown(error?.message || '') || t('Street Level toggle failed'),
      );
    }
  }

  async _ensureEnabled() {
    if (this.actions.isEnabled?.()) return true;
    try {
      await this.actions.setEnabled?.(true);
    } catch (error) {
      this.actions.showToast?.(
        translateKnown(error?.message || '') ||
          t('Street Level could not start'),
      );
      return false;
    }
    return this.actions.isEnabled?.() === true;
  }

  /**
   * Lighting a chip turns the layer on and darkens the others (one source at
   * a time); darkening the lit one turns the layer off, keeping the provider.
   */
  async _toggleProvider(providerId) {
    const chip = this._view?.providers.find((entry) => entry.id === providerId);
    if (!chip) return;
    if (!chip.active) {
      // Every registered provider in one update (those hidden on this map
      // too), so the share link records the swap.
      const ids =
        this.layer.providerIds || this._view.providers.map((entry) => entry.id);
      this._setParams(
        Object.fromEntries(ids.map((id) => [id, id === providerId])),
      );
      await this._ensureEnabled();
      return;
    }
    try {
      await this.actions.setEnabled?.(false);
    } catch (error) {
      this.actions.showToast?.(
        translateKnown(error?.message || '') || t('Street Level toggle failed'),
      );
    }
  }

  /** Through the data manager, so saved state and share links record it. */
  _setParams(params) {
    this.actions.setParams(params, { origin: 'user' });
  }

  /** Whether EXPAND has the viewer full screen (or, on iPhone, open over the page). */
  isViewerExpanded() {
    const wrap = this._elements.viewerWrap;
    if (!wrap) return false;
    return this._expandMode === 'popover'
      ? this._popoverOpen
      : document.fullscreenElement === wrap;
  }

  async _toggleExpanded() {
    const wrap = this._elements.viewerWrap;
    try {
      if (this.isViewerExpanded()) this._exitExpanded();
      else if (this._expandMode === 'fullscreen')
        await wrap.requestFullscreen();
      else {
        // Only while open: a closed popover is hidden even inside the panel.
        wrap.popover = 'auto';
        wrap.showPopover();
      }
    } catch {
      /* refused (no user gesture, policy): the panel view stays */
    }
  }

  _exitExpanded() {
    if (!this.isViewerExpanded()) return;
    if (this._expandMode === 'popover') this._elements.viewerWrap.hidePopover();
    else document.exitFullscreen().catch(() => {});
  }

  _onPopoverToggle(event) {
    this._popoverOpen = event.newState === 'open';
    if (!this._popoverOpen)
      this._elements.viewerWrap.removeAttribute('popover');
    this._syncExpanded();
  }

  /** Clean View, recording and the cockpit hide every panel, so they end EXPAND too. */
  _watchPanelHidingModes(on) {
    const body = document.body;
    if (!on || !body) {
      this._modesObserver?.disconnect();
      this._modesObserver = null;
      return;
    }
    const leaveIfHiding = () => {
      if (PANEL_HIDING_MODES.some((mode) => body.classList.contains(mode)))
        this._exitExpanded();
    };
    if (!this._modesObserver && typeof MutationObserver === 'function') {
      this._modesObserver = new MutationObserver(leaveIfHiding);
      this._modesObserver.observe(body, {
        attributes: true,
        attributeFilter: ['class'],
      });
    }
    leaveIfHiding();
  }

  /** Mirror the expanded state on EXPAND, watch the panel-hiding modes, refit. */
  _syncExpanded() {
    const on = this.isViewerExpanded();
    this._watchPanelHidingModes(on);
    this.store.setExpanded(on);
    this._requestResize();
  }

  connect() {
    this._unsubscribe?.();
    this._unsubscribe = null;
    if (this.destroyed || !this.root) return;
    this._unsubscribeEnableRequests?.();
    this._unsubscribeEnableRequests = this.actions.subscribeEnableRequests(
      (origin) => {
        this._explicitEnable = isExplicitLayerStateOrigin(origin);
      },
    );
    this._unsubscribe = this.layer.subscribe?.((state) => this.render(state));
    if (this.layer.getUIState) this.render(this.layer.getUIState());
  }

  setCollapsed(collapsed, options = {}) {
    this.actions.setPanelCollapsed?.(collapsed, options);
    if (!collapsed) this._requestResize();
  }

  render(state) {
    if (this.destroyed || !state || !this.root) return;
    this._state = state;
    const view = presentStreetLevelPanel(state);
    this._view = view;
    this._leaveClosedViewer(view);
    this.store.publish(view);
    this._reactToTransitions(view);
  }

  /** A closed image leaves EXPAND, and focus stays in the panel. */
  _leaveClosedViewer(view) {
    if (view.viewer.open) return;
    this._exitExpanded();
    // Closing the image (its × button) hides the wrap: move focus out
    // first, or it drops to <body>.
    const wrap = this._elements.viewerWrap;
    if (wrap && !wrap.hidden && wrap.contains(document.activeElement))
      this._elements.status?.focus?.({ preventScroll: true });
  }

  /**
   * Open the panel on a switch-on or when an image opens. Never persisted:
   * the stored collapse state stays the user's own choice.
   */
  _reactToTransitions(view) {
    const enabled = view.enabled;
    if (enabled && this._wasEnabled === false) {
      // A restore must not reopen a panel the user or a share link kept collapsed.
      if (this._explicitEnable) this.setCollapsed(false, { persist: false });
      this._explicitEnable = false;
    }
    this._wasEnabled = enabled;
    // Other size changes reach the viewer through the ResizeObserver; opening
    // asks for one resize because the element may not have a size yet.
    const open = view.viewer.open;
    if (open && !this._wasOpen) this.setCollapsed(false, { persist: false });
    this._wasOpen = open;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this._offLocale();
    this._exitExpanded();
    // Its `toggle` is not heard once destroyed: a popover left on the wrap
    // would hide the viewer even inside the panel.
    if (this._expandMode === 'popover')
      this._elements.viewerWrap?.removeAttribute('popover');
    this._watchPanelHidingModes(false);
    this.listeners.abort();
    this._resizeObserver?.disconnect();
    this._resizeObserver = null;
    this._unsubscribe?.();
    this._unsubscribe = null;
    this._unsubscribeEnableRequests?.();
    this._unsubscribeEnableRequests = null;
    this.layer.attachViewerHost?.(null);
    this.store.detach(this._storeToken);
  }
}
