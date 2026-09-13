/** Own panel position preferences, viewport clamping and drag listeners. */
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
export class PanelPositionControls {
  constructor({
    syncPanelCollapseButton,
    layoutRightPanels,
    syncCctvPanelViewport,
    showToast,
  }) {
    this._syncPanelCollapseButton = syncPanelCollapseButton;
    this._layoutRightPanels = layoutRightPanels;
    this._syncCctvPanelViewport = syncCctvPanelViewport;
    this._showToast = showToast;
    this._ppToggles = document.getElementById('pp-toggles');
    this._panelZCounter = PANEL_Z_BASE + 10;
    this._draggableResizeObserver = null;
    this._cancelDrag = null;
    this.removers = [];
    this.destroyed = false;
  }
  listen(target, type, callback) {
    if (this.destroyed || !target) return;
    const listener = (event) => {
      if (!this.destroyed) callback(event);
    };
    target.addEventListener(type, listener);
    this.removers.push(() => target.removeEventListener(type, listener));
  }
  _reclampDraggablePanels() {
    if (this.destroyed) return;
    const el = this._ppToggles;
    if (!el || !el.style.top || el.style.top === 'auto') return;
    const top = parseInt(el.style.top, 10);
    if (!Number.isFinite(top)) return;
    el.style.top = `${this._clampToViewport(0, top, el).top}px`;
    this._pinPanelToRight(el);
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
    if (this.destroyed) return;
    const dragSpecs = [
      {
        id: 'pp-toggles',
        panel: this._ppToggles,
        handle: this._ppToggles?.querySelector('.panel-drag-handle.compact'),
      },
    ].filter(Boolean);

    for (const spec of dragSpecs) {
      if (!spec.panel || !spec.handle) continue;
      this._restorePanelPosition(spec.id, spec.panel);
      this._makePanelDraggable(spec.id, spec.panel, spec.handle);
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
    try {
      localStorage.setItem(
        this._panelStorageKey(panelId),
        JSON.stringify({
          left: Math.round(rect.left),
          top: Math.round(rect.top),
        }),
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
      let z = PANEL_Z_BASE + 1;
      for (const el of promoted) {
        el.style.zIndex = String(z);
        z += 1;
      }
      this._panelZCounter = z;
    }
    panelEl.style.zIndex = String(this._panelZCounter);
  }

  _makePanelDraggable(panelId, panelEl, handleEl) {
    // Z-order promotion: bring clicked panel to front of the stacking context
    this.listen(panelEl, 'pointerdown', () => {
      this._promotePanelZ(panelEl);
    });

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
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this._cancelDrag?.();
    for (const remove of this.removers.splice(0)) remove();
    this._draggableResizeObserver?.disconnect();
    this._draggableResizeObserver = null;
  }
}
