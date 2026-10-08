import { syncChipGroup } from './chipGroup.js';
import { isExplicitLayerStateOrigin } from '../data/layerState.js';
import {
  presentStreetLevelPanel,
  SINCE_STOPS,
} from './streetLevelPresentation.js';

const RENDER_MODE_KEY = 'gev:street-level:render-mode';
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
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
 * Fills the Street Level panel body: provider chips, filters, legend and
 * viewer. The panel chrome itself belongs to the application shell.
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
    // Until the user first touches the app, an off → on is the saved layer
    // state being restored, not a user switching the layer on.
    this._restoreWindow = true;
    // Whether the last switch-on was explicit (user, voice, tool) rather than
    // a restore; null when the shell does not report request origins.
    this._explicitEnable = null;
    this._unsubscribeEnableRequests = null;
    this._resizeQueued = false;
    this._wrapHome = null;
    this._expandReturnFocus = null;
    // Only the <body> children this class made inert are released again.
    this._inerted = new Set();
    this._modalObserver = null;
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
      providerChips: byId('sl-provider-chips'),
      nearestBtn: byId('sl-nearest-btn'),
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
      panoButtons: all('[data-sl-pano]'),
      // Held, not re-queried: EXPAND moves them to <body> with the viewer.
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
      // A chip without a usable key stays focusable for its tooltip; a click
      // that would light it, or switch the layer off through it, says the
      // same thing instead. Other chips still switch (a refused Street View
      // key cannot lock Mapillary out), and it darkens beside a lit one.
      const providers = this._view?.providers || [];
      const chip = providers.find(
        (entry) => entry.id === button.dataset.chipId,
      );
      const othersLit = providers.some(
        (entry) => entry.id !== chip?.id && entry.active,
      );
      if (chip?.state === 'error' && (!chip.active || !othersLit)) {
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
    // The keyboard path to Street View: its nearest image at the view centre,
    // without moving the camera.
    this.listen(el.nearestBtn, 'click', () => {
      const nearest = this._view?.nearest;
      if (!nearest?.visible || nearest.disabled) return;
      this.layer.openNearest?.(undefined, {
        providerIds: nearest.providerIds,
        frame: false,
        aim: 'screen-centre',
      });
    });
    this.listen(el.followBtn, 'click', () => {
      this.layer.setFollow?.(!(this._state?.street?.follow === true));
    });
    this.listen(el.viewerClose, 'click', () => this.layer.closeViewer?.());
    this.listen(el.viewerExpand, 'click', () =>
      this.setViewerExpanded(!this.isViewerExpanded(), { dock: true }),
    );
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
    // The expanded viewer is a dialog: Esc shrinks it, Tab stays inside.
    // Listen on the document, ahead of everything else, so both still hold
    // once focus has left it (a click on the globe) and Esc never reaches
    // the map's own handler, which would clear the selected sequence.
    this.listen(document, 'keydown', (event) => this._onDialogKey(event), {
      capture: true,
    });
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

  /** Through the data manager, so saved state and share links record it. */
  _setParams(params) {
    if (this.actions.setParams)
      this.actions.setParams(params, { origin: 'user' });
    else this.layer.setParams?.(params);
  }

  /**
   * Lighting a chip turns the layer on; darkening the last lit one turns the
   * layer off but keeps the provider on, so the layer comes back with it.
   */
  async _toggleProvider(providerId) {
    const chip = this._view?.providers.find((entry) => entry.id === providerId);
    if (!chip) return;
    if (!chip.active) {
      this._setParams({ [providerId]: true });
      await this._ensureEnabled();
      return;
    }
    const othersLit = this._view.providers.some(
      (entry) => entry.id !== providerId && entry.active,
    );
    if (othersLit) {
      this._setParams({ [providerId]: false });
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
    this._unsubscribeEnableRequests?.();
    this._unsubscribeEnableRequests =
      this.actions.subscribeEnableRequests?.((origin) => {
        this._explicitEnable = isExplicitLayerStateOrigin(origin);
      }) || null;
    this._unsubscribe = this.layer.subscribe?.((state) => this.render(state));
    if (this.layer.getUIState) this.render(this.layer.getUIState());
  }

  onPanelResized() {
    this._requestResize();
  }

  setCollapsed(collapsed, options = {}) {
    this.actions.setPanelCollapsed?.(collapsed, options);
    if (!collapsed) this._requestResize();
  }

  isViewerExpanded() {
    return (
      this._elements.viewerWrap?.classList.contains(
        'sl-viewer-wrap-expanded',
      ) === true
    );
  }

  /**
   * A user's shrink (`dock`) also returns a floating panel to its rail, so the
   * viewer does not land in a window over the globe.
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
      this._watchModal(true);
    } else {
      // Release the application first: the focus returned below may be in it.
      this._watchModal(false);
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
      // A closed image hides the wrap: focus inside it would drop to <body>.
      const reachable = (node) =>
        node?.isConnected &&
        typeof node.focus === 'function' &&
        !(wrap.hidden && wrap.contains(node));
      if (reachable(target)) target.focus({ preventScroll: true });
      else if (reachable(this._elements.viewerExpand))
        this._elements.viewerExpand.focus({ preventScroll: true });
      else this._focusPanelControl();
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
    this._requestResize();
  }

  /** Park focus on a control that stays on screen while the viewer is hidden. */
  _focusPanelControl() {
    const el = this._elements;
    const target =
      el.status || el.providerChips?.querySelector('.data-toggle-chip');
    target?.focus?.({ preventScroll: true });
  }

  /** Clean View, recording and the cockpit hide the expanded viewer with CSS. */
  _isDialogShown() {
    if (!this.isViewerExpanded()) return false;
    const wrap = this._elements.viewerWrap;
    return (
      typeof wrap.checkVisibility !== 'function' ||
      // `checkVisibilityCSS` is the option's name before Chrome 121.
      wrap.checkVisibility({
        visibilityProperty: true,
        checkVisibilityCSS: true,
      })
    );
  }

  /**
   * Make every other <body> child inert while the expanded viewer is shown.
   * A CSS-hidden viewer releases them so a hidden modal never leaves the app
   * dead. Returns whether the dialog is shown.
   */
  _syncModal() {
    if (this.destroyed || !this._isDialogShown()) {
      this._releaseModal();
      return false;
    }
    const wrap = this._elements.viewerWrap;
    for (const node of [...(document.body?.children || [])]) {
      if (node === wrap || node.inert) continue;
      node.inert = true;
      this._inerted.add(node);
    }
    return true;
  }

  _releaseModal() {
    for (const node of this._inerted) node.inert = false;
    this._inerted.clear();
  }

  /** Re-check the modal when <body> changes class or gains a child. */
  _watchModal(on) {
    this._modalObserver?.disconnect();
    this._modalObserver = null;
    if (!on) return this._releaseModal();
    if (typeof MutationObserver === 'function' && document.body) {
      this._modalObserver = new MutationObserver(() => this._syncModal());
      this._modalObserver.observe(document.body, {
        attributes: true,
        attributeFilter: ['class'],
        childList: true,
      });
    }
    this._syncModal();
  }

  _onDialogKey(event) {
    if (event.key !== 'Escape' && event.key !== 'Tab') return;
    if (!this._syncModal()) return;
    // Only keys meant for the viewer: from inside it, from nowhere (<body>)
    // or from the globe. A field elsewhere (search) keeps its Esc and Tab.
    const target = event.target;
    const wrap = this._elements.viewerWrap;
    if (
      !wrap.contains(target) &&
      target !== document.body &&
      target !== document.documentElement &&
      !target?.closest?.('#cesiumContainer')
    )
      return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.setViewerExpanded(false, { dock: true });
      return;
    }
    // A radio off the roving tab stop (tabindex -1) is not a stop either.
    const focusable = [...wrap.querySelectorAll(FOCUSABLE)].filter(
      (node) =>
        node.getAttribute('tabindex') !== '-1' &&
        (node.offsetParent !== null || node === document.activeElement),
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
    this._renderViewer(view);
    this._renderMeta(view);
    this._renderNearest(view);
    this._reactToTransitions(view, state);
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

  _renderGate(view) {
    setProp(this._elements.controls, 'disabled', view.controlsDisabled);
  }

  _renderProviders(view) {
    syncChipGroup(this._elements.providerChips, view.providers);
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
    // Rebuild when the swatches change, not only their count: one provider
    // can replace another with the same number of entries.
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
    if (wrap) {
      // Closing the image (its × button) hides the wrap: move focus out
      // first, or it drops to <body>. A shrink below returns it itself.
      if (
        !viewer.open &&
        !wrap.hidden &&
        !this.isViewerExpanded() &&
        wrap.contains(document.activeElement)
      )
        this._focusPanelControl();
      setProp(wrap, 'hidden', !viewer.open);
    }
    if (!viewer.open && this.isViewerExpanded()) this.setViewerExpanded(false);
    setProp(el.viewerPlaceholder, 'hidden', !viewer.loading);
    if (el.followBtn) {
      setAttr(el.followBtn, 'aria-pressed', String(viewer.follow.pressed));
      setProp(el.followBtn, 'disabled', viewer.follow.disabled);
      setProp(el.followBtn, 'title', viewer.follow.title);
    }
    this._renderRadios(
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

  _renderMeta(view) {
    setProp(this._elements.coverageMeta, 'textContent', view.meta);
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
  _reactToTransitions(view, state) {
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
    const open = state.street.open === true;
    if (open && !this._wasStreetOpen)
      this.setCollapsed(false, { persist: false });
    this._wasStreetOpen = open;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.setViewerExpanded(false);
    this._watchModal(false);
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
