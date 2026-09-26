/** Own panel position preferences, viewport clamping and drag listeners. */
import { RESIZE_DIRECTIONS, resizeBox } from './panelResize.js';

/** Versioned localStorage namespace prefix to invalidate stale panel layouts. */
const PANEL_LAYOUT_STORAGE_VERSION = 'v6';
/**
 * Position keys are versioned separately from collapsed-state keys so layout
 * default changes (e.g. right-rail origin) can reset positions without also
 * resetting every panel's open/closed preference.
 */
const PANEL_POSITION_STORAGE_VERSION = 'v8';
/** Z ladder: panels promote within [100, 139]; voice pill 150, toast 200, clean-view-exit 300. */
const PANEL_Z_BASE = 100;
const PANEL_Z_MAX = 139;
/**
 * Lowest z a promoted (dragged or floating) panel may take: above every panel
 * docked in a rail, the highest of which is #pp-toggles at 110 (controls.css).
 * Renumbering restarts here, so a floating window never slips under DISPLAY.
 * Keep in step with `#right-context-rail > .panel-floating` in controls.css.
 */
const PANEL_Z_FLOATING_FLOOR = PANEL_Z_BASE + 11;
/** Pointer travel before a header press becomes a drag that lifts a portable panel out. */
const DRAG_THRESHOLD_PX = 4;
/**
 * Two header presses this close in time and space snap a floating panel
 * back. Detected from pointerdown because the drag handler's
 * preventDefault() suppresses the mouse events a native dblclick needs.
 */
const DOUBLE_PRESS_MS = 400;
const DOUBLE_PRESS_SLOP_PX = 6;
/** Viewport margin every positioned panel keeps clear. */
const VIEWPORT_MARGIN_PX = 6;
/** One-time hint shown the first time a portable panel leaves its rail. */
const PANEL_FLOAT_HINT_STORAGE_KEY = `godsEyeView.${PANEL_POSITION_STORAGE_VERSION}.panelFloatHintShown`;
const PANEL_FLOAT_HINT = 'Double-click the header to snap the panel back';
/** Header children whose own interaction wins over a drag or a snap-back. */
const INTERACTIVE_SELECTOR =
  'input, select, option, textarea, button, a, [role="button"]';
/** Inline geometry a snap-back clears so the rail owns placement again. */
const FLOATING_STYLE_PROPERTIES = [
  'left',
  'top',
  'right',
  'bottom',
  'width',
  'height',
  // A docked panel takes the rail's stacking, not a floating window's.
  'z-index',
];

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export class PanelPositionControls {
  /**
   * @param {object} options
   * @param {Function} options.syncPanelCollapseButton
   * @param {Function} options.layoutRightPanels
   * @param {Function} options.syncCctvPanelViewport
   * @param {Function} options.showToast
   * @param {(panelId: string) => void} [options.onPanelResized] Fires after a
   *   portable panel's resize gesture ends or the panel snaps back to its rail.
   */
  constructor({
    syncPanelCollapseButton,
    layoutRightPanels,
    syncCctvPanelViewport,
    showToast,
    onPanelResized = null,
  }) {
    this._syncPanelCollapseButton = syncPanelCollapseButton;
    this._layoutRightPanels = layoutRightPanels;
    this._syncCctvPanelViewport = syncCctvPanelViewport;
    this._showToast = showToast;
    this._onPanelResized = onPanelResized;
    this._ppToggles = document.getElementById('pp-toggles');
    this._panelZCounter = PANEL_Z_BASE + 10;
    this._draggableResizeObserver = null;
    this._cancelDrag = null;
    /** Portable panels by id: `{ panel, min: { width, height } }`. */
    this._portablePanels = new Map();
    this._resizeHandles = [];
    this._dragInitialized = false;
    this.removers = [];
    this.destroyed = false;
  }
  listen(target, type, callback, options) {
    if (this.destroyed || !target) return;
    const listener = (event) => {
      if (!this.destroyed) callback(event);
    };
    target.addEventListener(type, listener, options);
    this.removers.push(() =>
      target.removeEventListener(type, listener, options),
    );
  }
  _reclampDraggablePanels() {
    if (this.destroyed) return;
    const el = this._ppToggles;
    if (el && el.style.top && el.style.top !== 'auto') {
      const top = parseInt(el.style.top, 10);
      if (Number.isFinite(top)) {
        el.style.top = `${this._clampToViewport(0, top, el).top}px`;
        this._pinPanelToRight(el);
      }
    }
    // Floating panels only move back on-screen; their size is the user's.
    for (const { panel } of this._portablePanels.values()) {
      if (!panel.classList.contains('panel-floating')) continue;
      const left = parseInt(panel.style.left, 10);
      const top = parseInt(panel.style.top, 10);
      if (!Number.isFinite(left) || !Number.isFinite(top)) continue;
      const next = this._clampToViewport(left, top, panel);
      panel.style.left = `${next.left}px`;
      panel.style.top = `${next.top}px`;
    }
  }

  _maybeNotifyLayoutReset() {
    try {
      const marker = `godsEyeView.${PANEL_POSITION_STORAGE_VERSION}.layoutResetNotified`;
      if (localStorage.getItem(marker)) return;
      localStorage.setItem(marker, '1');
      const hadOldPositions = Object.keys(localStorage).some((key) =>
        key.startsWith('godsEyeView.v6.panelPos.'),
      );
      if (hadOldPositions) {
        this._showToast(
          'Panel layout updated — positions reset to new defaults',
        );
      }
    } catch {
      // storage unavailable
    }
  }

  _initPanelDrag() {
    if (this.destroyed || this._dragInitialized) return;
    this._dragInitialized = true;
    const cctvPanel = document.getElementById('cctv-panel');
    const streetLevelPanel = document.getElementById('street-level-panel');
    // A `portable` spec lifts out of its rail on a header drag, resizes from
    // every edge and remembers its window; the others only reposition in
    // place. Another panel opts in by adding a spec here.
    const dragSpecs = [
      {
        id: 'pp-toggles',
        panel: this._ppToggles,
        handle: this._ppToggles?.querySelector('.panel-drag-handle.compact'),
      },
      {
        id: 'cctv-panel',
        panel: cctvPanel,
        handle: cctvPanel?.querySelector('.panel-header'),
        portable: true,
        min: { width: 300, height: 160 },
      },
      {
        id: 'street-level-panel',
        panel: streetLevelPanel,
        handle: streetLevelPanel?.querySelector('.panel-header'),
        portable: true,
        min: { width: 320, height: 280 },
        // Shrinking the window to its strip docks it, so it never sits
        // over the globe as a stray header.
        dockOnCollapse: true,
      },
    ].filter(Boolean);

    for (const spec of dragSpecs) {
      if (!spec.panel || !spec.handle) continue;
      if (spec.portable) {
        this._portablePanels.set(spec.id, {
          panel: spec.panel,
          min: { width: 300, height: 160, ...spec.min },
          dockOnCollapse: spec.dockOnCollapse === true,
        });
        spec.panel.classList.add('panel-portable');
      }
      this._restorePanelPosition(spec.id, spec.panel);
      this._makePanelDraggable(spec.id, spec.panel, spec.handle);
      if (spec.portable) {
        this._makePanelResizable(spec.id, spec.panel, spec.min);
      }
    }
    // Keep a positioned panel on-screen when its HEIGHT changes after restore — it expands to its
    // full row set a frame or two later, so the restore-time clamp used a stale (shorter) height and
    // the panel could still hang off the bottom (audit U2). Re-clamp on every size change.
    if (this._ppToggles && typeof ResizeObserver !== 'undefined') {
      this._draggableResizeObserver = new ResizeObserver(() =>
        this._reclampDraggablePanels(),
      );
      this._draggableResizeObserver.observe(this._ppToggles);
    }
    if (this._portablePanels.size) {
      this.listen(window, 'resize', () => this._reclampDraggablePanels());
    }
  }

  _panelStorageKey(panelId) {
    return `godsEyeView.${PANEL_POSITION_STORAGE_VERSION}.panelPos.${panelId}`;
  }

  _panelCollapseStorageKey(panelId) {
    return `godsEyeView.${PANEL_LAYOUT_STORAGE_VERSION}.panelCollapsed.${panelId}`;
  }

  _restorePanelCollapsedState(panelId, { allowStored = true } = {}) {
    const panelEl = document.getElementById(panelId);
    if (!panelEl) return;
    let collapsed = panelEl.classList.contains('collapsed');
    let stored = null;
    if (allowStored) {
      try {
        stored = localStorage.getItem(this._panelCollapseStorageKey(panelId));
        if (stored === '1') collapsed = true;
        if (stored === '0') collapsed = false;
      } catch {
        // storage unavailable
      }
    }
    // DISPLAY starts COLLAPSED for a first-time visitor, then respects the
    // user's persisted choice like every other panel.
    //
    // It used to start expanded, to advertise the HUD / DETECT / 3D toggles.
    // That reason expired when those became ON by default: the rail now opens
    // to offer controls for things already happening, while competing with the
    // first-run mission card for the one first impression there is. A stored
    // choice still wins in both directions, so anyone who opens it keeps it.
    if (panelId === 'pp-toggles' && stored === null) collapsed = true;
    panelEl.classList.toggle('collapsed', collapsed);
    // Bodies that expand themselves on first appearance must not override a
    // choice the user (or a share link) already made.
    if (panelEl.dataset)
      panelEl.dataset.collapsedPreference = !allowStored
        ? 'share'
        : stored === null
          ? 'default'
          : 'stored';
    this._syncPanelCollapseButton(panelEl);
  }

  _savePanelCollapsedState(panelId, collapsed) {
    try {
      localStorage.setItem(
        this._panelCollapseStorageKey(panelId),
        collapsed ? '1' : '0',
      );
    } catch {
      // storage unavailable
    }
  }

  _pinPanelToRight(panelEl) {
    if (!panelEl) return;
    const rect = panelEl.getBoundingClientRect();
    const rightOffset = Math.max(6, Math.round(window.innerWidth - rect.right));
    panelEl.style.right = `${rightOffset}px`;
    panelEl.style.left = 'auto';
  }

  _restorePanelPosition(panelId, panelEl) {
    try {
      const raw = localStorage.getItem(this._panelStorageKey(panelId));
      if (!raw) return;
      const pos = JSON.parse(raw);
      if (!pos || typeof pos.left !== 'number' || typeof pos.top !== 'number')
        return;
      // A floating record only means something to a panel that can float; a
      // portable panel in turn only ever stores floating records.
      const portable = this._portablePanels.get(panelId);
      if (Boolean(pos.floating) !== Boolean(portable)) return;
      if (portable) {
        panelEl.classList.add('panel-floating', 'panel-draggable');
        // A restored window must stack above the docked rail panels too, not
        // only one that was lifted or clicked this session.
        this._promotePanelZ(panelEl);
        if (Number.isFinite(pos.width)) {
          panelEl.style.width = `${clamp(
            Math.round(pos.width),
            portable.min.width,
            Math.max(portable.min.width, window.innerWidth - 12),
          )}px`;
        }
        if (Number.isFinite(pos.height)) {
          panelEl.style.height = `${clamp(
            Math.round(pos.height),
            portable.min.height,
            Math.max(portable.min.height, window.innerHeight - 12),
          )}px`;
        }
      }
      // Clamp to the viewport: a position saved at one window size would otherwise land off-screen at
      // another (audit U2 — observed a panel at x:-192). The drag handler clamps; restore must too.
      const { left, top } = this._clampToViewport(
        Math.round(pos.left),
        Math.round(pos.top),
        panelEl,
      );
      panelEl.style.left = `${left}px`;
      panelEl.style.top = `${top}px`;
      panelEl.style.right = 'auto';
      panelEl.style.bottom = 'auto';
      if (panelId === 'pp-toggles') {
        this._pinPanelToRight(panelEl);
      }
    } catch {
      // ignore malformed saved panel position
    }
  }

  _clampToViewport(left, top, panelEl) {
    const rect = panelEl.getBoundingClientRect();
    const maxLeft = Math.max(6, window.innerWidth - rect.width - 6);
    const maxTop = Math.max(6, window.innerHeight - rect.height - 6);
    return {
      left: Math.max(6, Math.min(maxLeft, left)),
      top: Math.max(6, Math.min(maxTop, top)),
    };
  }

  _savePanelPosition(panelId, panelEl) {
    const rect = panelEl.getBoundingClientRect();
    const record = {
      left: Math.round(rect.left),
      top: Math.round(rect.top),
    };
    if (this._portablePanels.has(panelId)) {
      // Only an explicitly set size is remembered: freezing a collapsed
      // panel's measured height would stop it from ever expanding again.
      if (panelEl.style.width) record.width = Math.round(rect.width);
      if (panelEl.style.height) record.height = Math.round(rect.height);
      record.floating = true;
    }
    try {
      localStorage.setItem(
        this._panelStorageKey(panelId),
        JSON.stringify(record),
      );
    } catch {
      // storage unavailable
    }
  }

  _promotePanelZ(panelEl) {
    this._panelZCounter += 1;
    if (this._panelZCounter > PANEL_Z_MAX) {
      const promoted = [...document.querySelectorAll('.panel-draggable')]
        .filter((el) => el.style.zIndex)
        .sort((a, b) => Number(a.style.zIndex) - Number(b.style.zIndex));
      let z = PANEL_Z_FLOATING_FLOOR;
      for (const el of promoted) {
        el.style.zIndex = String(z);
        z += 1;
      }
      this._panelZCounter = z;
    }
    panelEl.style.zIndex = String(this._panelZCounter);
  }

  _maybeShowFloatHint() {
    try {
      if (localStorage.getItem(PANEL_FLOAT_HINT_STORAGE_KEY)) return;
      localStorage.setItem(PANEL_FLOAT_HINT_STORAGE_KEY, '1');
    } catch {
      // storage unavailable: still worth saying once this session
      if (this._floatHintShown) return;
      this._floatHintShown = true;
    }
    this._showToast(PANEL_FLOAT_HINT);
  }

  /**
   * Switch a portable panel from rail flow to a fixed window at the place it
   * currently occupies. Width is frozen so a `width: 100%` rail panel keeps
   * its size once fixed-positioned; height stays natural until a resize.
   */
  _liftPanelOut(panelId, panelEl, rect = panelEl.getBoundingClientRect()) {
    if (panelEl.classList.contains('panel-floating')) return false;
    panelEl.style.left = `${Math.round(rect.left)}px`;
    panelEl.style.top = `${Math.round(rect.top)}px`;
    panelEl.style.right = 'auto';
    panelEl.style.bottom = 'auto';
    if (!panelEl.classList.contains('collapsed')) {
      panelEl.style.width = `${Math.round(rect.width)}px`;
    }
    // Rail bookkeeping no longer applies to a window the rail does not allocate.
    panelEl.style.removeProperty('--right-panel-allocated-height');
    panelEl.removeAttribute('aria-hidden');
    panelEl.classList.add('panel-floating', 'panel-draggable');
    this._promotePanelZ(panelEl);
    this._layoutRightPanels();
    this._maybeShowFloatHint();
    return true;
  }

  /** Snap a floating panel back into its rail and forget its window. */
  _resetPanelPosition(panelId) {
    const portable = this._portablePanels.get(panelId);
    if (!portable) return;
    const panelEl = portable.panel;
    this._cancelDrag?.();
    panelEl.classList.remove(
      'panel-floating',
      'panel-draggable',
      'panel-dragging',
      'panel-resizing',
    );
    for (const property of FLOATING_STYLE_PROPERTIES) {
      panelEl.style.removeProperty(property);
    }
    try {
      localStorage.removeItem(this._panelStorageKey(panelId));
    } catch {
      // storage unavailable
    }
    this._layoutRightPanels();
    if (panelId === 'cctv-panel') {
      this._syncCctvPanelViewport();
    }
    this._onPanelResized?.(panelId);
  }

  _makePanelDraggable(panelId, panelEl, handleEl) {
    // Z-order promotion: bring clicked panel to front of the stacking context
    this.listen(panelEl, 'pointerdown', () => {
      this._promotePanelZ(panelEl);
    });
    if (this._portablePanels.has(panelId)) {
      this._makePortablePanelDraggable(panelId, panelEl, handleEl);
      return;
    }

    this.listen(handleEl, 'pointerdown', (event) => {
      if (event.button !== 0) return;
      if (event.target.closest('.panel-collapse-btn')) return;
      if (
        event.target.closest(
          'input, select, option, button:not(.panel-collapse-btn)',
        )
      )
        return;

      this._cancelDrag?.();
      event.preventDefault();
      const rect = panelEl.getBoundingClientRect();
      const startX = event.clientX;
      const startY = event.clientY;
      const offsetX = startX - rect.left;
      const offsetY = startY - rect.top;

      panelEl.style.left = `${rect.left}px`;
      panelEl.style.top = `${rect.top}px`;
      panelEl.style.right = 'auto';
      panelEl.style.bottom = 'auto';
      panelEl.classList.add('panel-dragging');
      this._promotePanelZ(panelEl);

      const onMove = (moveEvent) => {
        const nextLeftRaw = moveEvent.clientX - offsetX;
        const nextTopRaw = moveEvent.clientY - offsetY;
        const maxLeft = Math.max(6, window.innerWidth - rect.width - 6);
        const maxTop = Math.max(6, window.innerHeight - rect.height - 6);
        const nextLeft = Math.max(6, Math.min(maxLeft, nextLeftRaw));
        const nextTop = Math.max(6, Math.min(maxTop, nextTopRaw));
        panelEl.style.left = `${nextLeft}px`;
        panelEl.style.top = `${nextTop}px`;
        if (panelId === 'pp-toggles') {
          this._layoutRightPanels();
        }
        if (panelId === 'cctv-panel') {
          this._syncCctvPanelViewport();
        }
      };

      const cancel = () => {
        panelEl.classList.remove('panel-dragging');
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        this._cancelDrag = null;
      };
      const onUp = () => {
        cancel();
        if (panelId === 'pp-toggles') {
          this._pinPanelToRight(panelEl);
        }
        this._savePanelPosition(panelId, panelEl);
        if (panelId === 'cctv-panel') {
          this._syncCctvPanelViewport();
        }
      };

      this._cancelDrag = cancel;
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    });
  }

  /**
   * Portable drag: a press on the header only becomes a drag after a few
   * pixels of travel, at which point the panel lifts out of its rail. The
   * collapse button still toggles on a plain click, and the click that ends
   * a real drag is swallowed so it cannot toggle by accident. Double-clicking
   * the header snaps the panel back.
   */
  /**
   * Put a floating portable panel back in its rail at its default size.
   * @param {string} panelId
   * @returns {boolean} Whether the panel was floating.
   */
  dockPanel(panelId) {
    const portable = this._portablePanels.get(panelId);
    if (!portable?.panel.classList.contains('panel-floating')) return false;
    this._resetPanelPosition(panelId);
    return true;
  }

  /**
   * A panel was collapsed or expanded. A portable panel that opted into
   * `dockOnCollapse` returns to its rail when collapsed while floating.
   * @param {string} panelId
   * @param {boolean} collapsed
   */
  onPanelCollapsed(panelId, collapsed) {
    if (!collapsed || !this._portablePanels.get(panelId)?.dockOnCollapse)
      return;
    this.dockPanel(panelId);
  }

  _makePortablePanelDraggable(panelId, panelEl, handleEl) {
    let swallowNextClick = false;
    this.listen(
      handleEl,
      'click',
      (event) => {
        if (!swallowNextClick) return;
        swallowNextClick = false;
        event.stopImmediatePropagation();
        event.preventDefault();
      },
      { capture: true },
    );
    this.listen(handleEl, 'dblclick', (event) => {
      if (event.target.closest?.(INTERACTIVE_SELECTOR)) return;
      if (!panelEl.classList.contains('panel-floating')) return;
      event.preventDefault();
      this._resetPanelPosition(panelId);
    });
    let lastPress = null;
    this.listen(handleEl, 'pointerdown', (event) => {
      if (event.button !== 0) return;
      const interactive = event.target.closest?.(INTERACTIVE_SELECTOR);
      if (interactive && !interactive.matches('.panel-collapse-btn')) return;

      const now = event.timeStamp || performance.now();
      const doublePress =
        !interactive &&
        lastPress &&
        now - lastPress.time <= DOUBLE_PRESS_MS &&
        Math.hypot(event.clientX - lastPress.x, event.clientY - lastPress.y) <=
          DOUBLE_PRESS_SLOP_PX;
      lastPress = doublePress
        ? null
        : { time: now, x: event.clientX, y: event.clientY };
      if (doublePress && panelEl.classList.contains('panel-floating')) {
        event.preventDefault();
        this._resetPanelPosition(panelId);
        return;
      }

      this._cancelDrag?.();
      // A header press must not start a text selection across the page.
      event.preventDefault();
      const startX = event.clientX;
      const startY = event.clientY;
      let dragging = false;
      let offsetX = 0;
      let offsetY = 0;
      let width = 0;
      let height = 0;

      const onMove = (moveEvent) => {
        if (!dragging) {
          if (
            Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) <
            DRAG_THRESHOLD_PX
          )
            return;
          dragging = true;
          // A drag between two presses is not a double-click.
          lastPress = null;
          const rect = panelEl.getBoundingClientRect();
          offsetX = startX - rect.left;
          offsetY = startY - rect.top;
          width = rect.width;
          height = rect.height;
          this._liftPanelOut(panelId, panelEl, rect);
          panelEl.classList.add('panel-dragging');
          this._promotePanelZ(panelEl);
        }
        moveEvent.preventDefault();
        const maxLeft = Math.max(
          VIEWPORT_MARGIN_PX,
          window.innerWidth - width - VIEWPORT_MARGIN_PX,
        );
        const maxTop = Math.max(
          VIEWPORT_MARGIN_PX,
          window.innerHeight - height - VIEWPORT_MARGIN_PX,
        );
        panelEl.style.left = `${clamp(moveEvent.clientX - offsetX, VIEWPORT_MARGIN_PX, maxLeft)}px`;
        panelEl.style.top = `${clamp(moveEvent.clientY - offsetY, VIEWPORT_MARGIN_PX, maxTop)}px`;
      };

      const cancel = () => {
        panelEl.classList.remove('panel-dragging');
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        this._cancelDrag = null;
      };
      const onUp = () => {
        cancel();
        if (!dragging) return;
        swallowNextClick = true;
        setTimeout(() => {
          swallowNextClick = false;
        }, 0);
        this._savePanelPosition(panelId, panelEl);
        if (panelId === 'cctv-panel') {
          this._syncCctvPanelViewport();
        }
      };

      this._cancelDrag = cancel;
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    });
  }

  /**
   * Append a resize handle for every edge and corner. Seven are invisible
   * strips; the bottom-right corner shows a grip. Resizing a docked panel
   * lifts it out first, so the handles work in both states.
   */
  _makePanelResizable(panelId, panelEl, min = {}) {
    const limits = { width: 300, height: 160, ...min };
    for (const dir of RESIZE_DIRECTIONS) {
      const handle = document.createElement('div');
      handle.className =
        dir === 'se' ? 'panel-resize-grip' : 'panel-resize-edge';
      handle.dataset.dir = dir;
      handle.setAttribute('aria-hidden', 'true');
      if (dir === 'se') {
        handle.title = 'Drag to resize · double-click the header to snap back';
      }
      panelEl.appendChild(handle);
      this._resizeHandles.push(handle);
      this.listen(handle, 'pointerdown', (event) =>
        this._startPanelResize(event, panelId, panelEl, dir, limits),
      );
    }
  }

  _startPanelResize(event, panelId, panelEl, dir, limits) {
    if (event.button !== 0) return;
    event.preventDefault();
    this._cancelDrag?.();
    const rect = panelEl.getBoundingClientRect();
    this._liftPanelOut(panelId, panelEl, rect);
    const startBox = {
      left: Math.round(rect.left),
      top: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
    const startX = event.clientX;
    const startY = event.clientY;
    const apply = ({ left, top, width, height }) => {
      panelEl.style.left = `${left}px`;
      panelEl.style.top = `${top}px`;
      panelEl.style.width = `${width}px`;
      panelEl.style.height = `${height}px`;
    };
    panelEl.classList.add('panel-resizing');
    this._promotePanelZ(panelEl);
    apply(startBox);

    const onMove = (moveEvent) => {
      moveEvent.preventDefault();
      apply(
        resizeBox(
          startBox,
          dir,
          moveEvent.clientX - startX,
          moveEvent.clientY - startY,
          {
            minWidth: limits.width,
            minHeight: limits.height,
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight,
          },
        ),
      );
    };
    const cancel = () => {
      panelEl.classList.remove('panel-resizing');
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      this._cancelDrag = null;
    };
    const onUp = () => {
      cancel();
      this._savePanelPosition(panelId, panelEl);
      if (panelId === 'cctv-panel') {
        this._syncCctvPanelViewport();
      }
      this._onPanelResized?.(panelId);
    };

    this._cancelDrag = cancel;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this._cancelDrag?.();
    for (const remove of this.removers.splice(0)) remove();
    for (const handle of this._resizeHandles.splice(0)) handle.remove();
    this._draggableResizeObserver?.disconnect();
    this._draggableResizeObserver = null;
  }
}
