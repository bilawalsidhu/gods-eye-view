import { nextTick } from 'vue';
import { presentStreetLevel } from './streetLevelPresentation.js';
import { streetLevelRowControls } from './streetLevelRowControls.js';
import { useStreetLevelStore } from './stores/streetLevel.js';
import { placeStreetLevelViewer } from './streetLevelViewerPlacement.js';
import { applicationPinia } from './vueRuntime.js';
import {
  isContextRailCovered,
  isContextSurfaceVisible,
} from './mobileSheets.js';
import { onLocaleChange, t, translateKnown } from '../i18n/index.js';

const RENDER_MODE_KEY = 'gev:street-level:render-mode';
/** <body> classes of the modes that hide every panel; an expanded photo leaves with them. */
const PANEL_HIDING_MODES = ['ui-clean-view', 'recording-mode', 'cockpit-mode'];

/** True on an embedded page (`?embed=1` or the inline panel). */
function isEmbedPage() {
  return globalThis.document?.body?.classList?.contains('ui-embed') === true;
}

/**
 * Drives Street Level's UI: the photo viewer on its card in Context
 * (StreetLevelViewer.vue, `gev-street-level` store) and the provider chips
 * and filters on its Data Layers row (streetLevelRowControls.js). An open
 * photo, and each image the viewer moves on to, is announced through
 * `actions.showPhoto`, so Context can show its card.
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
      setRenderMode: (mode) => {
        this.layer.setViewerRenderMode?.(mode);
        try {
          localStorage.setItem(RENDER_MODE_KEY, mode);
        } catch {
          /* storage unavailable */
        }
      },
      cancelDockedPhoto: () => this.layer.cancelDockedPhoto?.(),
      /** Close the photo whose card went away, unless another took over. */
      closePhoto: (id, options) => this.layer.closePhoto?.(id, options),
      closeViewer: () => this.layer.closeViewer?.(),
      /** Close any photo, loading or not: something else was picked. */
      withdrawPhoto: () => this.layer.withdrawPhoto?.(),
      /** Stop a playing sequence: the photo is out of sight. */
      stopPlayback: () => this.layer.stopPlayback?.(),
      /** Open a remembered photo again (its card was picked from a list). */
      openPhoto: (id) => this.layer.openPhoto?.(id, { frame: false }),
    });
    this.destroyed = false;
    this.listeners = new AbortController();
    this._unsubscribe = null;
    this._state = null;
    this._view = null;
    this._wasOpen = false;
    this._photoRequests = 0;
    this._photoCover = null;
    this._publishedPhotoRevision = 0;
    this._rowOpen = null;
    this._revealingPaidPhoto = false;
    this._resizeQueued = false;
    this._elements = this._collect();
    this._bind();
    // The presentation holds translated text; present it again in a new locale.
    this._offLocale = onLocaleChange(() => {
      if (this._state) this.render(this._state);
    });
  }

  _collect() {
    // Context moves the viewer out of this root onto a photo's card
    // (streetLevelViewerPlacement.js), possibly before the controls start,
    // so an element missing from the root is looked up on the page.
    const byId = (id) =>
      this.root?.querySelector(`#${id}`) ||
      this.root?.ownerDocument?.getElementById(id) ||
      null;
    return {
      viewerWrap: byId('sl-viewer-wrap'),
      viewerExpand: byId('sl-viewer-expand'),
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
    this.layer.presentRowControls?.(() =>
      streetLevelRowControls(this._view, {
        toggleProvider: (id) => this._toggleProvider(id),
        openNearest: el.viewer ? () => this._openNearest() : null,
      }),
    );
    if (!el.viewer) return;
    this.layer.attachViewerHost?.(el.viewer, {
      prepare: (requestId) => this._preparePaidPhoto(requestId),
      isVisible: () => this._paidPhotoVisible(),
    });
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
      // Esc shrinks the photo before Context's own Esc can close its card,
      // in a browser that hands the key to the page while full screen too.
      this.listen(el.viewerWrap, 'keydown', (event) => {
        if (event.key !== 'Escape' || !this.isViewerExpanded()) return;
        event.preventDefault();
        event.stopPropagation();
        this._exitExpanded();
      });
    }
    this.store.setExpandAvailable(Boolean(this._expandMode));
    // Embed mode: Esc closes an open photo, since the rail it would go back to
    // is hidden. Full screen keeps its own Esc (above), which leaves it first.
    this.listen(document, 'keydown', (event) => {
      if (event.key !== 'Escape' || !this._embedHome || this.isViewerExpanded())
        return;
      event.preventDefault();
      event.stopPropagation();
      this.layer.closeViewer?.();
    });
    try {
      const stored = localStorage.getItem(RENDER_MODE_KEY);
      if (stored === 'fill' || stored === 'letterbox')
        this.layer.setViewerRenderMode?.(stored);
    } catch {
      /* storage unavailable */
    }
    // MapillaryJS only tracks window resizes; the card resizes on its own.
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

  /**
   * OPEN on the Data Layers row: the nearest image under the screen centre,
   * for keyboard users. Its photo reveals Context with the photo's card (on
   * a phone, the Context sheet), unless the person moved Context or the
   * sheet while it loaded, or a mode hides the panels.
   */
  async _openNearest() {
    const nearest = this._view?.nearest;
    if (!this._elements.viewer || !nearest?.visible || nearest.disabled) return;
    const options = {
      providerIds: nearest.providerIds,
      frame: false,
      aim: 'screen-centre',
    };
    this._endRowOpen();
    if (isEmbedPage()) return this.layer.openNearest?.(undefined, options);
    const body = this.root.ownerDocument.body;
    const request = {
      count:
        (this.layer.getUIState?.()?.photoRequests ?? this._photoRequests) + 1,
      surfaceChanged: false,
    };
    const billed = this._state?.providers?.some(
      (provider) =>
        provider.billed && nearest.providerIds.includes(provider.id),
    );
    if (billed) {
      request.controller = new AbortController();
      options.signal = request.controller.signal;
    }
    this._rowOpen = request;
    try {
      request.stopWatching = this.actions.watchContextSurface?.(() => {
        if (this._revealingPaidPhoto) return;
        request.surfaceChanged = true;
        request.controller?.abort();
      });
      const opened = await this.layer.openNearest?.(undefined, options);
      const state = this.layer.getUIState?.() ?? this._state;
      const photo = state?.acceptedPhoto;
      if (
        opened !== true ||
        this.destroyed ||
        this._rowOpen !== request ||
        state?.photoRequests !== request.count ||
        state.enabled !== true ||
        photo?.requestId !== request.count
      )
        return opened;
      this._publishedPhotoRevision = photo.revision;
      // A selection switches the current Context tab to Inspect.
      if (!request.surfaceChanged || this.actions.isInspectorTab?.() !== false)
        this.actions.showPhoto?.(photo, {
          revealFromOpen:
            !request.surfaceChanged && !body.classList.contains('cockpit-mode'),
        });
      return opened;
    } finally {
      this._endRowOpen(request, false);
    }
  }

  async _preparePaidPhoto(requestId) {
    const body = this.root.ownerDocument.body;
    if (!isEmbedPage()) {
      if (requestId != null && requestId !== this._photoRequests) return false;
      if (
        this._rowOpen?.surfaceChanged ||
        (isContextRailCovered(body) && !this.actions.revealPaidPhoto) ||
        body.classList.contains('cockpit-mode')
      )
        return false;
      this._revealingPaidPhoto = true;
      try {
        if (this.actions.revealPaidPhoto?.(this._photoCover) === false)
          return false;
      } finally {
        this._revealingPaidPhoto = false;
      }
    }
    // The layer queues its opening snapshot before Vue mounts the loading slot.
    await Promise.resolve();
    await nextTick();
    placeStreetLevelViewer();
    return this._paidPhotoVisible(false, true);
  }

  _paidPhotoVisible(allowDock = true, scrollToViewer = false) {
    const wrap = this._elements.viewerWrap;
    const { ownerDocument: doc } = this.root;
    if (
      this.destroyed ||
      doc.visibilityState === 'hidden' ||
      !wrap?.isConnected
    )
      return false;
    for (let node = wrap; node; node = node.parentElement)
      if (
        node.hidden ||
        node.hasAttribute('inert') ||
        node.style.display === 'none'
      )
        return false;
    const body = doc.body;
    const embedded = isEmbedPage();
    if (
      PANEL_HIDING_MODES.some(
        (mode) =>
          body.classList.contains(mode) &&
          !(embedded && mode === 'ui-clean-view'),
      )
    )
      return false;
    // A settled panorama can report user navigation from its visible dock.
    // Starting a paid open still requires the explicit Inspector or embed path.
    if (
      allowDock &&
      !embedded &&
      this._view?.viewer?.openingPaidPhoto === false &&
      wrap.closest('#sl-docked-slot')
    )
      return true;
    if (embedded)
      return (
        wrap.parentElement === body &&
        wrap.classList.contains('sl-viewer-wrap-embed') &&
        !body.classList.contains('scene-playback-mode')
      );
    if (
      this._rowOpen?.surfaceChanged ||
      this.actions.isInspectorTab?.() === false ||
      this.actions.isContextExpanded?.() === false ||
      !isContextSurfaceVisible(body) ||
      !wrap.closest('#context-tab-view')
    )
      return false;
    const scroller =
      wrap.closest('body.mobile-shell #right-context-rail') ??
      wrap.closest('.global-context-panel-inner');
    if (!scroller) return true;
    if (scrollToViewer)
      wrap.scrollIntoView?.({
        block: 'nearest',
        inline: 'nearest',
        behavior: 'instant',
      });
    const photo = wrap.getBoundingClientRect();
    const rail = scroller.getBoundingClientRect();
    return (
      Math.max(photo.top, rail.top) < Math.min(photo.bottom, rail.bottom) &&
      Math.max(photo.left, rail.left) < Math.min(photo.right, rail.right)
    );
  }

  _endRowOpen(request = this._rowOpen, abort = true) {
    if (!request || this._rowOpen !== request) return;
    this._rowOpen = null;
    request.stopWatching?.();
    if (abort) request.controller?.abort();
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
   * A chip whose source lacks its key says how to add it instead.
   */
  async _toggleProvider(providerId) {
    const chip = this._view?.providers.find((entry) => entry.id === providerId);
    if (!chip) return;
    if (chip.state === 'error') {
      if (chip.title) this.actions.showToast?.(chip.title);
      return;
    }
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
      else if (this._view?.viewer.openingPaidPhoto) return;
      else if (this._expandMode === 'fullscreen')
        await wrap.requestFullscreen();
      else {
        // Only while open: a closed popover is hidden even inside the card.
        wrap.popover = 'auto';
        wrap.showPopover();
      }
    } catch {
      /* refused (no user gesture, policy): the card view stays */
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
    // Embed mode keeps Clean View on for its globe while the photo is lifted
    // over it: there only recording and the cockpit end EXPAND.
    const leaveIfHiding = () => {
      if (
        PANEL_HIDING_MODES.some(
          (mode) =>
            body.classList.contains(mode) &&
            !(mode === 'ui-clean-view' && isEmbedPage()),
        )
      )
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

  /**
   * Embed mode hides the right rail: an open photo moves to <body> as an
   * overlay on the globe (`sl-viewer-wrap-embed`, embed.css) and goes back
   * when it closes. Vue keeps patching the wrap there: its siblings are static.
   */
  _syncEmbedOverlay(open) {
    const wrap = this._elements.viewerWrap;
    if (!wrap || !document.body) return;
    const lift = open === true && isEmbedPage();
    this.store.setEmbedOverlay(lift);
    if (lift && !this._embedHome) {
      this._embedHome = { parent: wrap.parentNode, next: wrap.nextSibling };
      document.body.appendChild(wrap);
      wrap.classList.add('sl-viewer-wrap-embed');
      this._requestResize();
    } else if (!lift && this._embedHome) {
      wrap.classList.remove('sl-viewer-wrap-embed');
      const { parent, next } = this._embedHome;
      this._embedHome = null;
      if (parent?.isConnected)
        parent.insertBefore(wrap, next?.parentNode === parent ? next : null);
      // Then wherever it belongs now: a photo's card, the dock or home.
      placeStreetLevelViewer();
      this._requestResize();
    }
  }

  connect() {
    this._unsubscribe?.();
    this._unsubscribe = null;
    if (this.destroyed) return;
    if (this.actions.dockedPhoto)
      this.layer.attachDockedPhoto?.(
        this.actions.dockedPhoto,
        this.actions.dockedPhotoCanPresent,
      );
    this._unsubscribe = this.layer.subscribe?.((state) => this.render(state));
    if (this.layer.getUIState) this.render(this.layer.getUIState());
  }

  render(state) {
    if (this.destroyed || !state) return;
    this._state = state;
    const view = presentStreetLevel(state);
    this._view = view;
    if (!this._elements.viewer) return;
    this._leaveClosedViewer(view);
    this.store.publish(view);
    this._reactToTransitions(view, state);
  }

  /** A closed image leaves EXPAND, and focus stays in Context. */
  _leaveClosedViewer(view) {
    if (view.viewer.open) return;
    this._exitExpanded();
    // A closing image hides the wrap: move focus out first, or it drops to
    // <body>.
    const wrap = this._elements.viewerWrap;
    if (wrap && !wrap.hidden && wrap.contains(document.activeElement))
      this.actions.focusContext?.();
  }

  /** Report the request and its settled photo to the current surface owner. */
  _reactToTransitions(view, state) {
    // Other size changes reach the viewer through the ResizeObserver; opening
    // asks for one resize because the element may not have a size yet.
    const open = view.viewer.open;
    if (open && !this._wasOpen) this._requestResize();
    this._wasOpen = open;
    // A new request first, so a card picked after it can keep its place.
    const requests = state.photoRequests ?? 0;
    if (this._rowOpen && requests > this._rowOpen.count) this._endRowOpen();
    if (requests !== this._photoRequests) {
      this._photoRequests = requests;
      this._photoCover = this.actions.contextSelectionCover?.() ?? null;
      if (requests > 0)
        this.actions.photoRequested?.(requests, this._photoCover);
    }
    const photo = state.acceptedPhoto;
    // The row OPEN reports its own accepted photo with the reveal intent.
    const awaitingRowOpen =
      this._rowOpen && photo?.requestId === this._rowOpen.count;
    if (
      photo &&
      photo.revision !== this._publishedPhotoRevision &&
      !awaitingRowOpen
    ) {
      this._publishedPhotoRevision = photo.revision;
      this.actions.showPhoto?.(photo);
    }
    this._syncEmbedOverlay(open);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this._endRowOpen();
    this._offLocale();
    this._exitExpanded();
    // Its `toggle` is not heard once destroyed: a popover left on the wrap
    // would hide the viewer even inside the card.
    if (this._expandMode === 'popover')
      this._elements.viewerWrap?.removeAttribute('popover');
    this._watchPanelHidingModes(false);
    this._syncEmbedOverlay(false);
    this.listeners.abort();
    this._resizeObserver?.disconnect();
    this._resizeObserver = null;
    this._unsubscribe?.();
    this._unsubscribe = null;
    if (this.actions.dockedPhoto) this.layer.attachDockedPhoto?.(null);
    this.layer.presentRowControls?.(null);
    if (this._elements.viewer) this.layer.attachViewerHost?.(null);
    this.store.detach(this._storeToken);
  }
}
