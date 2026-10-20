import { syncChipGroup } from './chipGroup.js';
import {
  presentStreetLevelPanel,
  SINCE_STOPS,
} from './streetLevelPresentation.js';
import { t, translateKnown } from '../i18n/index.js';

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
    this._wasOpen = false;
    /** The error last shown: the same one never reopens the panel. */
    this._streetError = null;
    /** The SINCE option for a day count between the stops, while one is set. */
    this._customSince = null;
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
      since: byId('sl-since'),
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
    for (const button of el.panoButtons) {
      this.listen(button, 'click', () =>
        this._setParams({ pano: button.dataset.slPano }),
      );
    }
    // The stops, in the UI language (a language change reloads the page).
    for (const stop of SINCE_STOPS) {
      const option = document.createElement('option');
      option.value = String(stop.days);
      option.textContent = t(stop.label);
      el.since?.appendChild(option);
    }
    this.listen(el.since, 'change', () =>
      this._setParams({ sinceDays: Number(el.since.value) || 0 }),
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
    for (const button of el.renderButtons)
      this.listen(button, 'click', () =>
        this.layer.setViewerRenderMode?.(button.dataset.slRender),
      );
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

  /**
   * Shrink an expanded photo. Clean View, recording and the cockpit hide
   * every panel and call it, so the photo does not stay full screen (or, on
   * iPhone, as a popover) over them.
   */
  shrinkViewer() {
    this._exitExpanded();
  }

  /** Mirror the expanded state on EXPAND and refit. */
  _syncExpanded() {
    const on = this.isViewerExpanded();
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

  /** A segmented control: the chosen button is pressed. */
  _renderPressed(buttons, isChosen) {
    for (const button of buttons) {
      const chosen = isChosen(button);
      button.classList.toggle('is-active', chosen);
      setAttr(button, 'aria-pressed', String(chosen));
    }
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
    this._renderPressed(
      el.panoButtons,
      (button) => button.dataset.slPano === view.filter.pano,
    );
    if (el.since) {
      // A link may carry a day count between the stops: it gets an option.
      if (!view.since.exact) {
        this._customSince ||= el.since.appendChild(
          document.createElement('option'),
        );
        setProp(this._customSince, 'value', String(view.since.days));
        setProp(this._customSince, 'textContent', view.since.window);
      } else if (this._customSince) {
        this._customSince.remove();
        this._customSince = null;
      }
      setProp(el.since, 'value', String(view.since.days));
      // The cut-off date, for the pointer and for screen readers.
      setProp(el.since, 'title', view.since.label);
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
    this._renderPressed(
      el.renderButtons,
      (button) => button.dataset.slRender === viewer.renderMode,
    );
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
   * Open the panel when an image opens, or when a click fails to open one or
   * to load its sequence (the result, or its error, would otherwise be out of
   * sight). Never persisted: the stored collapse state stays the user's own
   * choice.
   */
  _reactToTransitions(view) {
    // Other size changes reach the viewer through the ResizeObserver; opening
    // asks for one resize because the element may not have a size yet.
    const open = view.viewer.open;
    // A photo that failed to open (a line or ground click, OPEN), or a
    // Mapillary line whose sequence failed to load, says why in the panel:
    // it opens for that too, or the click would seem to do nothing.
    const error =
      this._state?.street?.error || this._state?.sequence?.error || null;
    if ((open && !this._wasOpen) || (error && error !== this._streetError))
      this.setCollapsed(false, { persist: false });
    this._wasOpen = open;
    this._streetError = error;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this._exitExpanded();
    // Its `toggle` is not heard once destroyed: a popover left on the wrap
    // would hide the viewer even inside the panel.
    if (this._expandMode === 'popover')
      this._elements.viewerWrap?.removeAttribute('popover');
    this.listeners.abort();
    this._resizeObserver?.disconnect();
    this._resizeObserver = null;
    this._unsubscribe?.();
    this._unsubscribe = null;
    this.layer.attachViewerHost?.(null);
  }
}
