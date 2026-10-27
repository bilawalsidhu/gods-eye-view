import { isExplicitLayerStateOrigin } from '../data/layerState.js';
import { syncChipGroup } from './chipGroup.js';
import {
  createSegmentedControl,
  syncSegmentedControl,
} from './segmentedControl.js';
import {
  presentStreetLevelPanel,
  SINCE_STOPS,
} from './streetLevelPresentation.js';
import { t, translateKnown } from '../i18n/index.js';

const RENDER_MODE_KEY = 'gev:street-level:render-mode';
/** <body> classes of the modes that hide every panel; an expanded photo leaves with them. */
const PANEL_HIDING_MODES = ['ui-clean-view', 'recording-mode', 'cockpit-mode'];

// Renders run on every layer notification, and the rail's MutationObserver
// relays out on each attribute write: write only what changed.
const setProp = (node, key, value) => {
  if (node && node[key] !== value) node[key] = value;
};
const setAttr = (node, key, value) => {
  if (node && node.getAttribute(key) !== value) node.setAttribute(key, value);
};

/**
 * Fills the Street Level panel body: provider chips, filters and viewer. The
 * panel chrome itself belongs to the application shell.
 */
export class StreetLevelControls {
  constructor({ root, layer, actions }) {
    this.root = root;
    this.layer = layer;
    this.actions = actions;
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
  }

  _collect() {
    const byId = (id) => this.root?.querySelector(`#${id}`) || null;
    const all = (selector) => [
      ...(this.root?.querySelectorAll(selector) || []),
    ];
    return {
      status: byId('sl-status'),
      providerChips: byId('sl-provider-chips'),
      nearestBtn: byId('sl-nearest-btn'),
      controls: byId('sl-controls'),
      error: byId('sl-error'),
      errorText: byId('sl-error-text'),
      panoRow: byId('sl-pano-row'),
      sinceRow: byId('sl-since-row'),
      sinceRange: byId('sl-since'),
      sinceLabel: byId('sl-since-label'),
      sinceNote: byId('sl-since-note'),
      viewerWrap: byId('sl-viewer-wrap'),
      viewerExpand: byId('sl-viewer-expand'),
      viewerClose: byId('sl-viewer-close'),
      viewerPlaceholder: byId('sl-viewer-placeholder'),
      viewer: byId('sl-viewer'),
      imageBy: byId('sl-image-by'),
      imageWhen: byId('sl-image-when'),
      imageLink: byId('sl-image-link'),
      coverageMeta: byId('sl-coverage-meta'),
      panoButtons: all('[data-sl-pano]'),
      renderButtons: all('[data-sl-render]'),
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
    createSegmentedControl({
      buttons: el.panoButtons,
      valueOf: (button) => button.dataset.slPano,
      onChange: (pano) => this._setParams({ pano }),
      keyboard: 'radio',
      listen: (target, type, handler) => this.listen(target, type, handler),
    });
    // The readout follows the thumb; coverage is rebuilt once, on release.
    const sinceDays = () =>
      SINCE_STOPS[Number(el.sinceRange?.value) || 0]?.days ?? 0;
    this.listen(el.sinceRange, 'input', () => {
      const label = t(SINCE_STOPS[Number(el.sinceRange.value) || 0].label);
      if (el.sinceLabel) el.sinceLabel.textContent = label;
      el.sinceRange.setAttribute('aria-valuetext', label);
    });
    this.listen(el.sinceRange, 'change', () =>
      this._setParams({ sinceDays: sinceDays() }),
    );
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
    } else setProp(el.viewerExpand, 'hidden', true);
    createSegmentedControl({
      buttons: el.renderButtons,
      valueOf: (button) => button.dataset.slRender,
      keyboard: 'radio',
      listen: (target, type, handler) => this.listen(target, type, handler),
      onChange: (mode) => {
        this.layer.setViewerRenderMode?.(mode);
        try {
          localStorage.setItem(RENDER_MODE_KEY, mode);
        } catch {
          /* storage unavailable */
        }
      },
    });
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
    const button = this._elements.viewerExpand;
    if (button) {
      setProp(
        button.querySelector('.sl-btn-icon'),
        'textContent',
        on ? '⤡' : '⤢',
      );
      setProp(
        button.querySelector('.sl-btn-text'),
        'textContent',
        on ? t('SHRINK') : t('EXPAND'),
      );
      setAttr(button, 'aria-pressed', String(on));
      setAttr(button, 'aria-label', on ? t('Shrink') : t('Expand'));
    }
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
    this._renderHeader(view);
    setProp(this._elements.controls, 'disabled', view.controlsDisabled);
    syncChipGroup(this._elements.providerChips, view.providers);
    this._renderError(view);
    this._renderFilters(view);
    this._renderViewer(view);
    setProp(this._elements.coverageMeta, 'textContent', view.meta);
    this._renderNearest(view);
    this._reactToTransitions(view);
  }

  _renderHeader(view) {
    const el = this._elements;
    setProp(this.root.dataset, 'slEnabled', String(view.enabled));
    if (el.status) {
      setProp(el.status, 'textContent', view.status.text);
      setProp(
        el.status,
        'className',
        `sl-status${view.status.tone ? ` is-${view.status.tone}` : ''}`,
      );
      setAttr(el.status, 'aria-pressed', String(view.status.pressed));
      setProp(el.status, 'title', view.status.title);
    }
  }

  _renderError(view) {
    const el = this._elements;
    if (!el.error) return;
    setProp(el.error, 'hidden', !view.error);
    setProp(el.errorText, 'textContent', view.error || '');
  }

  _renderFilters(view) {
    const el = this._elements;
    const shows = view.filterControls || { pano: true, since: true };
    setProp(el.panoRow, 'hidden', !shows.pano);
    setProp(el.sinceRow, 'hidden', !shows.since);
    // A lit source that dates by upload says so under the slider.
    setProp(el.sinceNote, 'textContent', view.sinceNote || '');
    setProp(el.sinceNote, 'hidden', !view.sinceNote);
    setProp(el.controls, 'hidden', !shows.pano && !shows.since);
    syncSegmentedControl(el.panoButtons, view.filter.pano, {
      valueOf: (button) => button.dataset.slPano,
      activeClass: 'is-active',
      rovingFocus: true,
    });
    if (el.sinceRange) {
      // Never move the thumb under the user's hand; once the committed value
      // matches the thumb, show the full readout with its cut-off date.
      const index = String(view.since.index);
      if (
        document.activeElement !== el.sinceRange &&
        el.sinceRange.value !== index
      )
        el.sinceRange.value = index;
      if (el.sinceRange.value === index) {
        setProp(el.sinceLabel, 'textContent', view.since.label);
        setAttr(el.sinceRange, 'aria-valuetext', view.since.label);
      }
    }
  }

  _renderViewer(view) {
    const el = this._elements;
    const { viewer } = view;
    const wrap = el.viewerWrap;
    if (!viewer.open) this._exitExpanded();
    if (wrap) {
      // Closing the image (its × button) hides the wrap: move focus out
      // first, or it drops to <body>.
      if (!viewer.open && !wrap.hidden && wrap.contains(document.activeElement))
        el.status?.focus?.({ preventScroll: true });
      setProp(wrap, 'hidden', !viewer.open);
    }
    setProp(el.viewerPlaceholder, 'hidden', !viewer.loading);
    syncSegmentedControl(el.renderButtons, viewer.renderMode, {
      valueOf: (button) => button.dataset.slRender,
      activeClass: 'is-active',
      rovingFocus: true,
    });
    // Google's viewer always fills its frame: no FIT/FILL to offer.
    const renderGroup = el.renderButtons[0]?.parentElement;
    if (renderGroup) setProp(renderGroup, 'hidden', !viewer.renderModes);
    if (!viewer.open) return;
    setProp(el.imageBy, 'textContent', viewer.captionLeft);
    setProp(el.imageWhen, 'textContent', viewer.captionRight);
    if (el.imageLink) {
      setProp(el.imageLink, 'hidden', !viewer.link);
      if (viewer.link) setAttr(el.imageLink, 'href', viewer.link);
      if (viewer.linkLabel)
        setProp(el.imageLink, 'textContent', viewer.linkLabel);
    }
  }

  _renderNearest(view) {
    const button = this._elements.nearestBtn;
    if (!button) return;
    const { nearest } = view;
    setProp(button, 'hidden', !nearest.visible);
    if (!nearest.visible) return;
    setProp(button, 'textContent', nearest.label);
    setProp(button, 'title', nearest.title);
    setProp(button, 'disabled', nearest.disabled);
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
  }
}
