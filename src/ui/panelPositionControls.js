/** Own panel position preferences, viewport clamping and drag listeners. */
import { t } from '../i18n/index.js';
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
 * Lowest z for a promoted panel: above every docked rail panel (#pp-toggles is
 * 110). Keep in step with `#right-context-rail > .panel-floating` in controls.css.
 */
const PANEL_Z_FLOATING_FLOOR = PANEL_Z_BASE + 11;
/** Pointer travel before a press becomes a drag or resize. */
const DRAG_THRESHOLD_PX = 4;
/**
 * Double press that snaps a floating panel back. Detected from pointerdown
 * because the drag's preventDefault() suppresses a native dblclick.
 */
const DOUBLE_PRESS_MS = 400;
const DOUBLE_PRESS_SLOP_PX = 6;
const VIEWPORT_MARGIN_PX = 6;
/**
 * Fixed chrome that paints over the rail's stacking context; a floating
 * window keeps its header clear of it so it can always be grabbed again.
 */
const PANEL_OBSTACLE_IDS = ['command-dock', 'gev-voice-control'];
const PANEL_FLOAT_HINT_STORAGE_KEY = `godsEyeView.${PANEL_POSITION_STORAGE_VERSION}.panelFloatHintShown`;
const PANEL_FLOAT_HINT = 'Double-click the header to snap the panel back';
/** Header children whose own interaction wins over a drag or a snap-back. */
const INTERACTIVE_SELECTOR =
  'input, select, option, textarea, button, a, [role="button"]';
const FLOATING_STYLE_PROPERTIES = [
  'left',
  'top',
  'right',
  'bottom',
  'width',
  'height',
  'z-index',
];

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function fitWindowExtent(value, minimum, viewportExtent) {
  return clamp(
    Math.round(value),
    minimum,
    Math.max(minimum, viewportExtent - 2 * VIEWPORT_MARGIN_PX),
  );
}

function placeAt(panelEl, left, top) {
  panelEl.style.left = `${left}px`;
  panelEl.style.top = `${top}px`;
  panelEl.style.right = 'auto';
  panelEl.style.bottom = 'auto';
}

/** On a phone the rail scrolls, so a finger on a header is a swipe, not a drag. */
function isPrecisePointer(event) {
  const pointerType = event.pointerType || 'mouse';
  return pointerType === 'mouse' || pointerType === 'pen';
}

function geometryOf(panelEl) {
  const { left, top, width, height } = panelEl.style;
  return { left, top, width, height };
}

export class PanelPositionControls {
  /** `onPanelResized(panelId)` runs after a portable panel moves, resizes or docks. */
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
    for (const entry of this._portablePanels.values()) {
      const { classList } = entry.panel;
      if (!classList.contains('panel-floating')) continue;
      // A live gesture owns the box; it re-clamps when it ends.
      if (classList.contains('panel-dragging')) continue;
      if (classList.contains('panel-resizing')) continue;
      this._reclampPortablePanel(entry);
    }
  }

  /** Bring a floating window on-screen; shrink it only if it exceeds the viewport. */
  _reclampPortablePanel(entry) {
    const { panel, min } = entry;
    const left = parseInt(panel.style.left, 10);
    const top = parseInt(panel.style.top, 10);
    if (!Number.isFinite(left) || !Number.isFinite(top)) return;
    for (const [property, viewportExtent] of [
      ['width', window.innerWidth],
      ['height', window.innerHeight],
    ]) {
      const extent = parseFloat(panel.style[property]);
      if (!Number.isFinite(extent)) continue;
      const fitted = fitWindowExtent(extent, min[property], viewportExtent);
      if (fitted < extent) panel.style[property] = `${fitted}px`;
    }
    const next = this._clampPortableWindow(entry, left, top);
    panel.style.left = `${next.left}px`;
    panel.style.top = `${next.top}px`;
  }

  /**
   * Clamp a floating window inside the viewport margin with its header above
   * the command dock and voice pill, measured each time since the dock resizes.
   */
  _clampPortableWindow(
    entry,
    left,
    top,
    geometry = this._windowGeometry(entry),
  ) {
    const { width, height, header } = geometry;
    const maxLeft = Math.max(
      VIEWPORT_MARGIN_PX,
      window.innerWidth - width - VIEWPORT_MARGIN_PX,
    );
    const maxTop = Math.max(
      VIEWPORT_MARGIN_PX,
      window.innerHeight - height - VIEWPORT_MARGIN_PX,
    );
    const x = clamp(left, VIEWPORT_MARGIN_PX, maxLeft);
    let y = clamp(top, VIEWPORT_MARGIN_PX, maxTop);
    const obstacles = this._panelObstacles();
    for (let pass = 0; pass < obstacles.length; pass++) {
      const hit = obstacles.find(
        (rect) =>
          rect.left < x + width &&
          rect.right > x &&
          rect.top < y + header &&
          rect.bottom > y,
      );
      if (!hit) break;
      const above = hit.top - header - VIEWPORT_MARGIN_PX;
      y =
        above >= VIEWPORT_MARGIN_PX
          ? above
          : Math.min(maxTop, hit.bottom + VIEWPORT_MARGIN_PX);
    }
    return { left: x, top: y };
  }

  _windowGeometry({ panel, handle }, rect = panel.getBoundingClientRect()) {
    const handleRect = handle?.getBoundingClientRect();
    const header = handleRect ? handleRect.bottom - rect.top : 0;
    return {
      width: rect.width,
      height: rect.height,
      // Without a measurable header, keep the whole window clear.
      header: header > 0 ? Math.min(header, rect.height) : rect.height,
    };
  }

  _panelObstacles() {
    const rects = [];
    for (const id of PANEL_OBSTACLE_IDS) {
      const rect = document.getElementById(id)?.getBoundingClientRect();
      // A hidden dock, or a voice UI switched off, measures empty.
      if (rect && rect.width > 0 && rect.height > 0) rects.push(rect);
    }
    return rects;
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
        this._showToast(t('cockpit.panel.layoutResetToast'));
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
    // A `portable` panel lifts out of its rail on a header drag, resizes from
    // every edge and remembers its window; the others only reposition.
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
          handle: spec.handle,
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
    // the panel could still hang off the bottom (audit U2). Re-clamp on every size change. Floating
    // windows grow the same way when their content does.
    const observed = [
      this._ppToggles,
      ...[...this._portablePanels.values()].map(({ panel }) => panel),
    ].filter(Boolean);
    if (observed.length && typeof ResizeObserver !== 'undefined') {
      this._draggableResizeObserver = new ResizeObserver(() =>
        this._reclampDraggablePanels(),
      );
      for (const panel of observed)
        this._draggableResizeObserver.observe(panel);
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
      // Only portable panels store, and accept, floating records.
      const portable = this._portablePanels.get(panelId);
      if (Boolean(pos.floating) !== Boolean(portable)) return;
      if (portable) {
        panelEl.classList.add('panel-floating', 'panel-draggable');
        // A restored window must stack above the docked rail panels too.
        this._promotePanelZ(panelEl);
        if (Number.isFinite(pos.width)) {
          panelEl.style.width = `${fitWindowExtent(
            pos.width,
            portable.min.width,
            window.innerWidth,
          )}px`;
        }
        if (Number.isFinite(pos.height)) {
          panelEl.style.height = `${fitWindowExtent(
            pos.height,
            portable.min.height,
            window.innerHeight,
          )}px`;
        }
      }
      // Clamp to the viewport: a position saved at one window size would otherwise land off-screen at
      // another (audit U2 — observed a panel at x:-192). The drag handler clamps; restore must too,
      // and a window saved under the command dock must not come back there.
      const { left, top } = portable
        ? this._clampPortableWindow(
            portable,
            Math.round(pos.left),
            Math.round(pos.top),
          )
        : this._clampToViewport(
            Math.round(pos.left),
            Math.round(pos.top),
            panelEl,
          );
      placeAt(panelEl, left, top);
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
      // Only an explicitly set size is remembered, and the inline value
      // rather than the measured box: a collapsed window measures only its
      // header but keeps the size the user chose for when it expands.
      const chosen = (inline, measured) => {
        const px = parseFloat(inline);
        return Math.round(Number.isFinite(px) ? px : measured);
      };
      if (panelEl.style.width)
        record.width = chosen(panelEl.style.width, rect.width);
      if (panelEl.style.height)
        record.height = chosen(panelEl.style.height, rect.height);
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
      // storage unavailable: still show it once this session
      if (this._floatHintShown) return;
      this._floatHintShown = true;
    }
    this._showToast(PANEL_FLOAT_HINT);
  }

  /**
   * Turn a rail panel into a fixed window in place. Width is frozen so a
   * `width: 100%` panel keeps its size; height stays natural until a resize.
   */
  _liftPanelOut(panelId, panelEl, rect = panelEl.getBoundingClientRect()) {
    if (panelEl.classList.contains('panel-floating')) return false;
    placeAt(panelEl, Math.round(rect.left), Math.round(rect.top));
    if (!panelEl.classList.contains('collapsed')) {
      panelEl.style.width = `${Math.round(rect.width)}px`;
    }
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
      const offsetX = event.clientX - rect.left;
      const offsetY = event.clientY - rect.top;

      placeAt(panelEl, rect.left, rect.top);
      panelEl.classList.add('panel-dragging');
      this._promotePanelZ(panelEl);

      this._trackPointerGesture(event, {
        onMove: (moveEvent) => {
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
        },
        onStop: () => panelEl.classList.remove('panel-dragging'),
        // A cancelled press keeps the place too: there is no rail to revert to.
        onEnd: () => {
          if (panelId === 'pp-toggles') {
            this._pinPanelToRight(panelEl);
          }
          this._savePanelPosition(panelId, panelEl);
          if (panelId === 'cctv-panel') {
            this._syncCctvPanelViewport();
          }
        },
      });
    });
  }

  /**
   * Track one pointer gesture. With a `threshold`, `onStart` and `onMove` wait
   * until the pointer has travelled that far; `onEnd`/`onCancel` get whether
   * it started. Stopping through `_cancelDrag` calls neither.
   */
  _trackPointerGesture(
    event,
    { threshold = 0, onStart, onMove, onStop, onEnd, onCancel = onEnd },
  ) {
    const startX = event.clientX;
    const startY = event.clientY;
    let started = threshold <= 0;
    const move = (moveEvent) => {
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;
      if (!started) {
        if (Math.hypot(dx, dy) < threshold) return;
        started = true;
        onStart?.();
      }
      onMove(moveEvent, dx, dy);
    };
    const stop = () => {
      onStop?.();
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      if (this._cancelDrag === stop) this._cancelDrag = null;
    };
    const up = () => {
      stop();
      onEnd?.(started);
    };
    const cancel = () => {
      stop();
      onCancel?.(started);
    };
    this._cancelDrag = stop;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
  }

  /** @returns {boolean} Whether the panel was floating and is now docked. */
  dockPanel(panelId) {
    const portable = this._portablePanels.get(panelId);
    if (!portable?.panel.classList.contains('panel-floating')) return false;
    this._resetPanelPosition(panelId);
    return true;
  }

  /** A `dockOnCollapse` panel returns to its rail when collapsed while floating. */
  onPanelCollapsed(panelId, collapsed) {
    if (!collapsed || !this._portablePanels.get(panelId)?.dockOnCollapse)
      return;
    this.dockPanel(panelId);
  }

  /**
   * The collapse button still toggles on a plain click; the click that ends a
   * real drag is swallowed so it cannot toggle by accident.
   */
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
      if (event.button !== 0 || !isPrecisePointer(event)) return;
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
      const entry = this._portablePanels.get(panelId);
      let lifted = false;
      let before = null;
      let offsetX = 0;
      let offsetY = 0;
      let geometry = null;

      this._trackPointerGesture(event, {
        threshold: DRAG_THRESHOLD_PX,
        onStart: () => {
          // A drag between two presses is not a double-click.
          lastPress = null;
          const rect = panelEl.getBoundingClientRect();
          offsetX = event.clientX - rect.left;
          offsetY = event.clientY - rect.top;
          geometry = this._windowGeometry(entry, rect);
          before = geometryOf(panelEl);
          lifted = this._liftPanelOut(panelId, panelEl, rect);
          panelEl.classList.add('panel-dragging');
          this._promotePanelZ(panelEl);
        },
        onMove: (moveEvent) => {
          moveEvent.preventDefault();
          const next = this._clampPortableWindow(
            entry,
            moveEvent.clientX - offsetX,
            moveEvent.clientY - offsetY,
            geometry,
          );
          panelEl.style.left = `${next.left}px`;
          panelEl.style.top = `${next.top}px`;
        },
        onStop: () => panelEl.classList.remove('panel-dragging'),
        onEnd: (dragged) => {
          if (!dragged) return;
          swallowNextClick = true;
          setTimeout(() => {
            swallowNextClick = false;
          }, 0);
          this._savePanelPosition(panelId, panelEl);
          this._onPanelResized?.(panelId);
        },
        onCancel: (dragged) => {
          if (dragged)
            this._revertPanelGesture(panelId, panelEl, lifted, before);
        },
      });
    });
  }

  /** On pointercancel, restore the panel as the gesture found it; save nothing. */
  _revertPanelGesture(panelId, panelEl, lifted, before) {
    if (lifted) {
      this._resetPanelPosition(panelId);
      return;
    }
    Object.assign(panelEl.style, before);
    this._onPanelResized?.(panelId);
  }

  /** Resizing a docked panel lifts it out first, so handles work in both states. */
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
    if (event.button !== 0 || !isPrecisePointer(event)) return;
    event.preventDefault();
    this._cancelDrag?.();
    // Set once the pointer has travelled: a plain click on an edge must not
    // lift the panel out.
    let startBox = null;
    let lifted = false;
    let before = null;
    const apply = ({ left, top, width, height }) => {
      panelEl.style.left = `${left}px`;
      panelEl.style.top = `${top}px`;
      panelEl.style.width = `${width}px`;
      panelEl.style.height = `${height}px`;
    };

    this._trackPointerGesture(event, {
      threshold: DRAG_THRESHOLD_PX,
      onStart: () => {
        const rect = panelEl.getBoundingClientRect();
        before = geometryOf(panelEl);
        lifted = this._liftPanelOut(panelId, panelEl, rect);
        startBox = {
          left: Math.round(rect.left),
          top: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
        panelEl.classList.add('panel-resizing');
        this._promotePanelZ(panelEl);
        apply(startBox);
      },
      onMove: (moveEvent, dx, dy) => {
        moveEvent.preventDefault();
        apply(
          resizeBox(startBox, dir, dx, dy, {
            minWidth: limits.width,
            minHeight: limits.height,
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight,
          }),
        );
      },
      onStop: () => panelEl.classList.remove('panel-resizing'),
      onEnd: (resized) => {
        if (!resized) return;
        // Re-clamping skipped the live gesture; a north edge may have moved
        // the header under the command dock.
        const entry = this._portablePanels.get(panelId);
        if (entry) this._reclampPortablePanel(entry);
        this._savePanelPosition(panelId, panelEl);
        this._onPanelResized?.(panelId);
      },
      onCancel: (resized) => {
        if (resized) this._revertPanelGesture(panelId, panelEl, lifted, before);
      },
    });
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
