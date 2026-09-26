import { syncChipGroup } from './chipGroup.js';
import {
  presentStreetLevelPanel,
  SINCE_STOPS,
} from './streetLevelPresentation.js';

const RENDER_MODE_KEY = 'gev:street-level:render-mode';
/** Key the panel used before it became provider-neutral. */
const LEGACY_RENDER_MODE_KEY = 'gev:mapillary:render-mode';
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Own the Street Level panel: the provider chips, the imagery filters, the
 * legend and the embedded street-level viewer. The panel itself is
 * ordinary GEV chrome (collapse button, rail layout, persistence) driven by
 * the application shell; this class only fills the body and asks the shell
 * to open the panel when something worth seeing arrives.
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
    this._wasStreetOpen = false;
    this._wrapHome = null;
    this._expandReturnFocus = null;
    this._elements = this._collect();
    this._bind();
  }

  _collect() {
    const byId = (id) => this.root?.querySelector(`#${id}`) || null;
    return {
      status: byId('sl-status'),
      controls: byId('sl-controls'),
      providerChips: byId('sl-provider-chips'),
      error: byId('sl-error'),
      errorText: byId('sl-error-text'),
      sinceRange: byId('sl-since'),
      sinceLabel: byId('sl-since-label'),
      legend: byId('sl-legend'),
      followBtn: byId('sl-follow-btn'),
      viewerWrap: byId('sl-viewer-wrap'),
      viewerExpand: byId('sl-viewer-expand'),
      viewerClose: byId('sl-viewer-close'),
      viewerPlaceholder: byId('sl-viewer-placeholder'),
      viewer: byId('sl-viewer'),
      imageBy: byId('sl-image-by'),
      imageWhen: byId('sl-image-when'),
      imageLink: byId('sl-image-link'),
      coverageMeta: byId('sl-coverage-meta'),
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
    // One delegated listener; chips are re-synced in place on every render.
    this.listen(el.providerChips, 'click', (event) => {
      const button = event.target?.closest?.('.data-toggle-chip');
      if (!button || button.disabled) return;
      this._toggleProvider(button.dataset.chipId);
    });
    for (const button of this.root.querySelectorAll('[data-sl-pano]')) {
      this.listen(button, 'click', () =>
        this.layer.setCoverageFilter?.({ pano: button.dataset.slPano }),
      );
    }
    // The readout follows the thumb; coverage is rebuilt once, on release.
    const sinceDays = () =>
      SINCE_STOPS[Number(el.sinceRange?.value) || 0]?.days ?? 0;
    this.listen(el.sinceRange, 'input', () => {
      const label = SINCE_STOPS[Number(el.sinceRange.value) || 0].label;
      if (el.sinceLabel) el.sinceLabel.textContent = label;
      el.sinceRange.setAttribute('aria-valuetext', label);
    });
    this.listen(el.sinceRange, 'change', () =>
      this.layer.setCoverageFilter?.({ sinceDays: sinceDays() }),
    );
    this.listen(el.followBtn, 'click', () => {
      this.layer.setFollow?.(!(this._state?.street?.follow === true));
    });
    this.listen(el.viewerClose, 'click', () => this.layer.closeViewer?.());
    this.listen(el.viewerExpand, 'click', () =>
      this.setViewerExpanded(!this.isViewerExpanded(), { dock: true }),
    );
    for (const button of this.root.querySelectorAll('[data-sl-render]')) {
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
      const stored =
        localStorage.getItem(RENDER_MODE_KEY) ??
        localStorage.getItem(LEGACY_RENDER_MODE_KEY);
      if (stored === 'fill' || stored === 'letterbox')
        this.layer.setViewerRenderMode?.(stored);
    } catch {
      /* storage unavailable */
    }
    // The expanded viewer is a dialog: Esc closes it, Tab stays inside.
    this.listen(el.viewerWrap, 'keydown', (event) => this._onDialogKey(event));
    // MapillaryJS only tracks window resizes; the panel resizes on its own.
    if (typeof ResizeObserver === 'function' && el.viewer) {
      let queued = false;
      this._resizeObserver = new ResizeObserver(() => {
        if (queued) return;
        queued = true;
        requestAnimationFrame(() => {
          queued = false;
          this.layer.resizeViewer?.();
        });
      });
      this._resizeObserver.observe(el.viewer);
    }
  }

  async _ensureEnabled() {
    if (this.actions.isEnabled?.()) return true;
    try {
      await this.actions.setEnabled?.(true);
    } catch (error) {
      this.actions.showToast?.(
        error?.message || 'Street Level could not start',
      );
      return false;
    }
    return this.actions.isEnabled?.() === true;
  }

  async _toggleEnabled() {
    const enabled = this.actions.isEnabled?.() === true;
    try {
      await this.actions.setEnabled?.(!enabled);
    } catch (error) {
      this.actions.showToast?.(error?.message || 'Street Level toggle failed');
    }
  }

  /**
   * A provider chip is the layer's switch: lighting one turns the layer on
   * with that provider; darkening the last lit one turns the layer off (the
   * provider stays switched on, so the layer comes back with it).
   */
  async _toggleProvider(providerId) {
    const chip = this._view?.providers.find((entry) => entry.id === providerId);
    if (!chip) return;
    if (!chip.active) {
      this.layer.setProviderEnabled?.(providerId, true);
      await this._ensureEnabled();
      return;
    }
    const othersLit = this._view.providers.some(
      (entry) => entry.id !== providerId && entry.active,
    );
    if (othersLit) {
      this.layer.setProviderEnabled?.(providerId, false);
      return;
    }
    try {
      await this.actions.setEnabled?.(false);
    } catch (error) {
      this.actions.showToast?.(error?.message || 'Street Level toggle failed');
    }
  }

  connect() {
    this._unsubscribe?.();
    this._unsubscribe = null;
    if (this.destroyed || !this.root) return;
    this._unsubscribe = this.layer.subscribe?.((state) => this.render(state));
    if (this.layer.getUIState) this.render(this.layer.getUIState());
  }

  /** The panel window was resized or docked again: refit the viewer. */
  onPanelResized() {
    requestAnimationFrame(() => this.layer.resizeViewer?.());
  }

  /** Ask the shell to open (or close) the rail panel. */
  setCollapsed(collapsed, options = {}) {
    this.actions.setPanelCollapsed?.(collapsed, options);
    if (!collapsed) requestAnimationFrame(() => this.layer.resizeViewer?.());
  }

  isViewerExpanded() {
    return (
      this._elements.viewerWrap?.classList.contains(
        'sl-viewer-wrap-expanded',
      ) === true
    );
  }

  /**
   * Grow the street-level viewer to most of the screen, or shrink it back.
   * A user's shrink (`dock`) also returns a floating panel to its rail at its
   * default size, so the viewer does not land in a window over the globe.
   */
  setViewerExpanded(expanded, { dock = false } = {}) {
    const wrap = this._elements.viewerWrap;
    if (!wrap) return;
    const on = expanded === true;
    if (on === this.isViewerExpanded()) return;
    if (on) {
      // Lift the viewer out of the panel: the panel's backdrop-filter would
      // otherwise pin a fixed-position child inside it.
      this._wrapHome = { parent: wrap.parentNode, next: wrap.nextSibling };
      this._expandReturnFocus = document.activeElement;
      document.body.appendChild(wrap);
      wrap.classList.add('sl-viewer-wrap-expanded');
      wrap.setAttribute('role', 'dialog');
      wrap.setAttribute('aria-modal', 'true');
      wrap.setAttribute('aria-label', 'Street-level image');
      wrap.tabIndex = -1;
      wrap.focus({ preventScroll: true });
    } else {
      wrap.classList.remove('sl-viewer-wrap-expanded');
      wrap.removeAttribute('role');
      wrap.removeAttribute('aria-modal');
      wrap.removeAttribute('aria-label');
      wrap.removeAttribute('tabindex');
      if (this._wrapHome?.parent)
        this._wrapHome.parent.insertBefore(wrap, this._wrapHome.next);
      this._wrapHome = null;
      const target = this._expandReturnFocus;
      this._expandReturnFocus = null;
      if (target?.isConnected && typeof target.focus === 'function')
        target.focus({ preventScroll: true });
      else this._elements.viewerExpand?.focus?.({ preventScroll: true });
    }
    const button = this._elements.viewerExpand;
    if (button) {
      const icon = button.querySelector('.sl-btn-icon');
      const text = button.querySelector('.sl-btn-text');
      if (icon) icon.textContent = on ? '⤡' : '⤢';
      if (text) text.textContent = on ? 'SHRINK' : 'EXPAND';
      button.setAttribute('aria-pressed', String(on));
      button.setAttribute('aria-label', on ? 'Shrink' : 'Expand');
    }
    if (!on && dock) this.actions.dockPanel?.();
    requestAnimationFrame(() => this.layer.resizeViewer?.());
  }

  _onDialogKey(event) {
    if (!this.isViewerExpanded()) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.setViewerExpanded(false, { dock: true });
      return;
    }
    if (event.key !== 'Tab') return;
    const wrap = this._elements.viewerWrap;
    const focusable = [...wrap.querySelectorAll(FOCUSABLE)].filter(
      (node) => node.offsetParent !== null || node === document.activeElement,
    );
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    } else if (!wrap.contains(document.activeElement)) {
      event.preventDefault();
      first.focus();
    }
  }

  render(state) {
    if (this.destroyed || !state || !this.root) return;
    this._state = state;
    const view = presentStreetLevelPanel(state);
    this._view = view;
    this._renderHeader(view);
    this._renderGate(view);
    this._renderProviders(view);
    this._renderError(view);
    this._renderFilters(view);
    this._renderViewer(view, state);
    this._renderMeta(view);
    this._reactToTransitions(view, state);
  }

  _renderHeader(view) {
    const el = this._elements;
    this.root.dataset.slEnabled = String(view.enabled);
    if (el.status) {
      el.status.textContent = view.status.text;
      el.status.className = `sl-status${view.status.tone ? ` is-${view.status.tone}` : ''}`;
      el.status.setAttribute('aria-pressed', String(view.status.pressed));
      el.status.title = view.status.title;
    }
  }

  _renderGate(view) {
    const el = this._elements;
    if (el.controls) el.controls.disabled = view.controlsDisabled;
  }

  _renderProviders(view) {
    syncChipGroup(this._elements.providerChips, view.providers);
  }

  _renderError(view) {
    const el = this._elements;
    if (!el.error) return;
    el.error.hidden = !view.error;
    if (el.errorText) el.errorText.textContent = view.error || '';
  }

  _renderFilters(view) {
    const el = this._elements;
    for (const button of this.root.querySelectorAll('[data-sl-pano]')) {
      const active = button.dataset.slPano === view.filter.pano;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-checked', String(active));
    }
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
        if (el.sinceLabel) el.sinceLabel.textContent = view.since.label;
        el.sinceRange.setAttribute('aria-valuetext', view.since.label);
      }
    }
    if (el.legend && el.legend.childElementCount !== view.legend.length) {
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

  _renderViewer(view, state) {
    const el = this._elements;
    const { viewer } = view;
    if (el.viewerWrap) el.viewerWrap.hidden = !viewer.open;
    if (!viewer.open && this.isViewerExpanded()) this.setViewerExpanded(false);
    if (el.viewerPlaceholder) el.viewerPlaceholder.hidden = !viewer.loading;
    if (el.followBtn) {
      el.followBtn.setAttribute('aria-pressed', String(viewer.follow.pressed));
      el.followBtn.disabled = viewer.follow.disabled;
      el.followBtn.title = viewer.follow.title;
    }
    for (const button of this.root.querySelectorAll('[data-sl-render]')) {
      const active = button.dataset.slRender === viewer.renderMode;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-checked', String(active));
    }
    if (!viewer.open) return;
    if (el.imageBy) el.imageBy.textContent = viewer.captionLeft;
    if (el.imageWhen) el.imageWhen.textContent = viewer.captionRight;
    if (el.imageLink) {
      el.imageLink.hidden = !viewer.link;
      if (viewer.link) el.imageLink.href = viewer.link;
      if (viewer.linkLabel) el.imageLink.textContent = viewer.linkLabel;
    }
    if (state.street.open) this.layer.resizeViewer?.();
  }

  _renderMeta(view) {
    const el = this._elements;
    if (el.coverageMeta) el.coverageMeta.textContent = view.meta;
  }

  /** Open the panel at the moments a user would look for it. */
  _reactToTransitions(view, state) {
    const enabled = view.enabled;
    if (enabled && this._wasEnabled === false) this.setCollapsed(false);
    this._wasEnabled = enabled;
    if (state.street.open && !this._wasStreetOpen) this.setCollapsed(false);
    this._wasStreetOpen = state.street.open === true;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.setViewerExpanded(false);
    this.listeners.abort();
    this._resizeObserver?.disconnect();
    this._resizeObserver = null;
    this._unsubscribe?.();
    this._unsubscribe = null;
    this.layer.attachViewerHost?.(null);
  }
}
