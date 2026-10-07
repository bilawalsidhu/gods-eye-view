import { isExplicitLayerStateOrigin } from '../data/layerState.js';
import {
  presentStreetLevelPanel,
  SINCE_STOPS,
} from './streetLevelPresentation.js';

const RENDER_MODE_KEY = 'gev:street-level:render-mode';
const RADIO_STEPS = Object.freeze({
  ArrowRight: 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
});

// Renders run on every layer notification, and the rail's MutationObserver
// relays out on each attribute write: write only what changed.
const setProp = (node, key, value) => {
  if (node && node[key] !== value) node[key] = value;
};
const setAttr = (node, key, value) => {
  if (node && node.getAttribute(key) !== value) node.setAttribute(key, value);
};

/**
 * Fills the Street Level panel body: filters, legend and viewer. The panel
 * chrome itself belongs to the application shell.
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
    this._wasEnabled = null;
    this._wasOpen = false;
    // Until the user first touches the app, an off → on is the saved layer
    // state being restored, not a user switching the layer on.
    this._restoreWindow = true;
    // Whether the last switch-on was explicit (user, voice, tool) rather than
    // a restore; null when the shell does not report request origins.
    this._explicitEnable = null;
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
      controls: byId('sl-controls'),
      error: byId('sl-error'),
      errorText: byId('sl-error-text'),
      sinceRange: byId('sl-since'),
      sinceLabel: byId('sl-since-label'),
      legend: byId('sl-legend'),
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
    for (const button of el.panoButtons) {
      this.listen(button, 'click', () =>
        this._setParams({ pano: button.dataset.slPano }),
      );
    }
    this._bindRadioGroup(el.panoButtons);
    this._bindRadioGroup(el.renderButtons);
    // The readout follows the thumb; coverage is rebuilt once, on release.
    const sinceDays = () =>
      SINCE_STOPS[Number(el.sinceRange?.value) || 0]?.days ?? 0;
    this.listen(el.sinceRange, 'input', () => {
      const label = SINCE_STOPS[Number(el.sinceRange.value) || 0].label;
      if (el.sinceLabel) el.sinceLabel.textContent = label;
      el.sinceRange.setAttribute('aria-valuetext', label);
    });
    this.listen(el.sinceRange, 'change', () =>
      this._setParams({ sinceDays: sinceDays() }),
    );
    this.listen(el.viewerClose, 'click', () => this.layer.closeViewer?.());
    // EXPAND is the browser's own fullscreen: it handles Esc, focus and the
    // rest of the page. Without the API the button is simply not offered.
    if (typeof el.viewerWrap?.requestFullscreen === 'function') {
      this.listen(el.viewerExpand, 'click', () => this._toggleFullscreen());
      this.listen(document, 'fullscreenchange', () => this._syncFullscreen());
    } else setProp(el.viewerExpand, 'hidden', true);
    for (const button of el.renderButtons) {
      this.listen(button, 'click', () => {
        const mode = button.dataset.slRender;
        this.layer.setViewerRenderMode?.(mode);
        try {
          localStorage.setItem(RENDER_MODE_KEY, mode);
        } catch {
          /* storage unavailable */
        }
      });
    }
    try {
      const stored = localStorage.getItem(RENDER_MODE_KEY);
      if (stored === 'fill' || stored === 'letterbox')
        this.layer.setViewerRenderMode?.(stored);
    } catch {
      /* storage unavailable */
    }
    const endRestoreWindow = () => {
      this._restoreWindow = false;
    };
    for (const type of ['pointerdown', 'keydown'])
      this.listen(document, type, endRestoreWindow, { capture: true });
    // MapillaryJS only tracks window resizes; the panel resizes on its own.
    if (typeof ResizeObserver === 'function' && el.viewer) {
      this._resizeObserver = new ResizeObserver(() => this._requestResize());
      this._resizeObserver.observe(el.viewer);
    }
  }

  /** ARIA radio keys. Selecting clicks the radio, so keys and pointer share a path. */
  _bindRadioGroup(buttons) {
    buttons.forEach((button, index) => {
      this.listen(button, 'keydown', (event) => {
        let next = null;
        if (event.key in RADIO_STEPS) {
          const count = buttons.length;
          next = buttons[(index + RADIO_STEPS[event.key] + count) % count];
        } else if (event.key === 'Home') next = buttons[0];
        else if (event.key === 'End') next = buttons[buttons.length - 1];
        if (!next) return;
        event.preventDefault();
        next.focus();
        if (next !== button) next.click();
      });
    });
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
    // The pill is the only switch: switching on also brings back Mapillary
    // if a share link or a tool turned it off, or the layer would draw nothing.
    if (!enabled && this._state?.providerOn === false)
      this._setParams({ mapillary: true });
    try {
      await this.actions.setEnabled?.(!enabled);
    } catch (error) {
      this.actions.showToast?.(error?.message || 'Street Level toggle failed');
    }
  }

  /** Through the data manager, so saved state and share links record it. */
  _setParams(params) {
    if (this.actions.setParams)
      this.actions.setParams(params, { origin: 'user' });
    else this.layer.setParams?.(params);
  }

  isViewerFullscreen() {
    const wrap = this._elements.viewerWrap;
    return Boolean(wrap) && document.fullscreenElement === wrap;
  }

  async _toggleFullscreen() {
    try {
      if (this.isViewerFullscreen()) await document.exitFullscreen();
      else await this._elements.viewerWrap.requestFullscreen();
    } catch {
      /* refused (no user gesture, policy): the panel view stays */
    }
  }

  _exitFullscreen() {
    if (this.isViewerFullscreen()) document.exitFullscreen().catch(() => {});
  }

  /** Mirror the browser's fullscreen state on EXPAND and refit the viewer. */
  _syncFullscreen() {
    const on = this.isViewerFullscreen();
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
        on ? 'SHRINK' : 'EXPAND',
      );
      setAttr(button, 'aria-pressed', String(on));
      setAttr(button, 'aria-label', on ? 'Shrink' : 'Expand');
    }
    this._requestResize();
  }

  connect() {
    this._unsubscribe?.();
    this._unsubscribe = null;
    if (this.destroyed || !this.root) return;
    this._unsubscribeEnableRequests?.();
    this._unsubscribeEnableRequests =
      this.actions.subscribeEnableRequests?.((origin) => {
        this._explicitEnable = isExplicitLayerStateOrigin(origin);
      }) || null;
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
    this._renderHeader(view);
    setProp(this._elements.controls, 'disabled', view.controlsDisabled);
    this._renderError(view);
    this._renderFilters(view);
    this._renderViewer(view);
    setProp(this._elements.coverageMeta, 'textContent', view.meta);
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

  _renderRadios(buttons, isChecked) {
    for (const button of buttons) {
      const checked = isChecked(button);
      button.classList.toggle('is-active', checked);
      setAttr(button, 'aria-checked', String(checked));
      setAttr(button, 'tabindex', checked ? '0' : '-1');
    }
  }

  _renderFilters(view) {
    const el = this._elements;
    this._renderRadios(
      el.panoButtons,
      (button) => button.dataset.slPano === view.filter.pano,
    );
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
    // Rebuild when the swatches change, not only their count.
    const legendKey = view.legend
      .map((entry) => `${entry.key}:${entry.color}:${entry.label}`)
      .join('|');
    if (el.legend && this._legendKey !== legendKey) {
      this._legendKey = legendKey;
      el.legend.replaceChildren(
        ...view.legend.map((entry) => {
          const item = document.createElement('li');
          const swatch = document.createElement('i');
          swatch.className = 'sl-legend-swatch';
          swatch.style.background = entry.color;
          const label = document.createElement('span');
          label.textContent = entry.label;
          item.append(swatch, label);
          return item;
        }),
      );
    }
  }

  _renderViewer(view) {
    const el = this._elements;
    const { viewer } = view;
    const wrap = el.viewerWrap;
    if (!viewer.open) this._exitFullscreen();
    if (wrap) {
      // Closing the image (its × button) hides the wrap: move focus out
      // first, or it drops to <body>.
      if (!viewer.open && !wrap.hidden && wrap.contains(document.activeElement))
        el.status?.focus?.({ preventScroll: true });
      setProp(wrap, 'hidden', !viewer.open);
    }
    setProp(el.viewerPlaceholder, 'hidden', !viewer.loading);
    this._renderRadios(
      el.renderButtons,
      (button) => button.dataset.slRender === viewer.renderMode,
    );
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

  /**
   * Open the panel on a switch-on or when an image opens. Never persisted:
   * the stored collapse state stays the user's own choice.
   */
  _reactToTransitions(view) {
    const enabled = view.enabled;
    if (enabled && this._wasEnabled === false) {
      // A restore must not reopen a panel the user or a share link kept
      // collapsed. Without request origins, the restore window decides.
      const preference = this.root.dataset?.collapsedPreference;
      const restoring =
        this._explicitEnable === null
          ? this._restoreWindow &&
            (preference === 'stored' || preference === 'share')
          : !this._explicitEnable;
      if (!restoring) this.setCollapsed(false, { persist: false });
      this._restoreWindow = false;
      this._explicitEnable = this._explicitEnable === null ? null : false;
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
    this._exitFullscreen();
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
