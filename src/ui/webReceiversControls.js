import { parseFrequencyHz } from '../sources/webReceivers.js';
import { renderWebReceiversState } from './webReceiversPresentation.js';

/** How long GEV keeps reclaiming keyboard focus after a receiver page loads. */
const FOCUS_GUARD_MS = 8000;
const FOCUS_GUARD_TICK_MS = 250;

/**
 * Own the Web Receivers panel DOM, the tune and spectrum rows and the receiver
 * dock; receive the layer and application actions. Layer lifecycle, catalog
 * acquisition and marker rendering stay with the layer.
 */
export class WebReceiversControls {
  constructor({ elements, layer, actions }) {
    Object.assign(this, elements);
    this.layer = layer;
    this.actions = actions;
    this.destroyed = false;
    this.listeners = new AbortController();
    this._unsubscribe = null;
    this._state = null;
    this._dockUserFocused = false;
    this._focusGuardUntil = 0;
    this._focusGuardTimer = null;
    this._bind();
  }

  listen(target, type, handler, options = {}) {
    target?.addEventListener(type, handler, {
      ...options,
      signal: this.listeners.signal,
    });
  }

  connect() {
    this._unsubscribe?.();
    this._unsubscribe = null;
    if (this.destroyed) return;
    this._unsubscribe = this.layer.subscribe?.((state) =>
      this._renderState(state),
    );
  }

  _renderState(state) {
    renderWebReceiversState.call(this, state);
  }

  _setStatus(text) {
    if (this._webReceiversStatus) this._webReceiversStatus.textContent = text;
  }

  _selectedReceiver() {
    return this.layer.getUIState?.().selected || null;
  }

  _bind() {
    if (!this._webReceiversPanel) return;
    const toggle = async () => {
      if (this.destroyed || !this.actions.isRegistered()) return;
      const enabling = !this.actions.isEnabled();
      const trigger = this._webReceiversEnableBtn;
      if (trigger) trigger.disabled = true;
      try {
        await this.actions.runUserAction(
          (notificationToken) =>
            this.actions.setEnabled(enabling, {
              origin: 'user',
              notificationToken,
            }),
          `Web Receivers could not ${enabling ? 'start' : 'stop'} cleanly`,
        );
      } finally {
        if (trigger && !this.destroyed) trigger.disabled = false;
      }
    };
    this.listen(this._webReceiversEnableBtn, 'click', () => void toggle());
    this.listen(this._webReceiversType, 'change', () => {
      this.layer.setFilter({ type: this._webReceiversType.value });
    });
    this.listen(this._webReceiversBand, 'change', () => {
      this.layer.setFilter({ band: this._webReceiversBand.value });
    });
    this.listen(this._webReceiversTuneBtn, 'click', () => this._tuneSelected());
    this.listen(this._webReceiversFreq, 'keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        this._tuneSelected();
      }
    });
    this.listen(this._webReceiversOpenBtn, 'click', () => {
      const receiver = this._selectedReceiver();
      if (receiver) window.open(receiver.url, '_blank', 'noopener');
    });
    this.listen(this._webReceiversSpecBtn, 'click', () =>
      this._showSpectrumSelected(),
    );
    for (const input of [
      this._webReceiversSpecFrom,
      this._webReceiversSpecTo,
    ]) {
      this.listen(input, 'keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          this._showSpectrumSelected();
        }
      });
    }
    // A receiver page (OpenWebRX in particular) grabs keyboard focus while it
    // boots inside the dock, which silently takes the space bar away from
    // voice push-to-talk. Reclaim focus for GEV during that load phase; a
    // deliberate click into the dock afterwards is left alone.
    this.listen(
      this._webReceiversDock,
      'pointerdown',
      () => {
        this._dockUserFocused = true;
      },
      { capture: true },
    );
    this.listen(this._webReceiversDock, 'focusin', () => {
      this._dockUserFocused = true;
    });
    this.listen(window, 'blur', () => {
      if (
        !this._webReceiversFrame ||
        document.activeElement !== this._webReceiversFrame
      )
        return;
      if (this._dockUserFocused || !this._focusGuardUntil) return;
      if (Date.now() > this._focusGuardUntil) return;
      setTimeout(() => this._reclaimFocusFromDock(), 0);
    });
    this.listen(this._webReceiversDockClose, 'click', () => this._closeDock());
    this.listen(this._webReceiversDockMin, 'click', () => {
      const minimized = !this._webReceiversDock.classList.contains('minimized');
      this._setDockMinimized(minimized);
    });
    this.listen(document, 'gev:web-receiver-selected', () => {
      this.actions.setPanelCollapsed('web-receivers-panel', false, {
        explicit: true,
      });
    });
    this.listen(document, 'gev:web-receiver-tune', (event) => {
      const detail = event?.detail || {};
      if (!detail.url) return;
      const last = this.layer.getUIState?.().lastTune;
      const label = last
        ? last.kind === 'spectrum'
          ? `${last.receiverName} · spectrum ${last.frequencyLabel}${last.muted ? ' · muted' : ' · audio on'}`
          : `${last.receiverName} · ${last.frequencyLabel} ${String(last.mode).toUpperCase()}`
        : detail.url;
      if (detail.openIn === 'tab') {
        this.actions.setPanelCollapsed('web-receivers-panel', false, {
          explicit: true,
        });
        this._setStatus(`Opened ${label} in a new tab`);
        return;
      }
      this._openDock(detail.url, label);
    });
  }

  _tuneSelected() {
    const receiver = this._selectedReceiver();
    if (!receiver) return;
    const hz = parseFrequencyHz(this._webReceiversFreq?.value || '', 'khz');
    if (hz === null) {
      this._setStatus('Enter a frequency in kHz, e.g. 14233');
      this._webReceiversFreq?.focus({ preventScroll: true });
      return;
    }
    const result = this.layer.tune({
      receiverId: receiver.id,
      hz,
      mode: this._webReceiversMode?.value || null,
    });
    if (!result.ok) {
      this._setStatus(result.error);
      return;
    }
    this._openDock(
      result.url,
      `${receiver.name} · ${result.frequencyLabel} ${result.mode.toUpperCase()}`,
    );
  }

  _showSpectrumSelected() {
    const receiver = this._selectedReceiver();
    if (!receiver) return;
    const lowHz = parseFrequencyHz(
      this._webReceiversSpecFrom?.value || '',
      'khz',
    );
    const highHz = parseFrequencyHz(
      this._webReceiversSpecTo?.value || '',
      'khz',
    );
    if (lowHz === null || highHz === null || highHz <= lowHz) {
      this._setStatus('Enter a range in kHz, e.g. 10000 to 15000');
      (lowHz === null
        ? this._webReceiversSpecFrom
        : this._webReceiversSpecTo
      )?.focus({ preventScroll: true });
      return;
    }
    const result = this.layer.showSpectrum({
      receiverId: receiver.id,
      lowHz,
      highHz,
    });
    if (!result.ok) {
      this._setStatus(result.error);
      return;
    }
    this._openDock(
      result.url,
      `${receiver.name} · spectrum ${result.rangeLabel}${result.muted ? ' · muted' : ' · audio on'}`,
    );
  }

  /** Load the tuned receiver page in the dock; plain-http pages cannot embed on https. */
  _openDock(url, label) {
    if (this.destroyed || !this._webReceiversDock || !this._webReceiversFrame)
      return;
    this.actions.setPanelCollapsed('web-receivers-panel', false, {
      explicit: true,
    });
    this._webReceiversDock.hidden = false;
    this._setDockMinimized(false);
    if (this._webReceiversDockLabel)
      this._webReceiversDockLabel.textContent = label || url;
    if (this._webReceiversDockLink) this._webReceiversDockLink.href = url;
    const mixedContent =
      window.location?.protocol === 'https:' && /^http:/i.test(url);
    if (mixedContent) {
      this._webReceiversFrame.removeAttribute('src');
      this._webReceiversFrame.hidden = true;
      if (this._webReceiversDockNote) {
        this._webReceiversDockNote.hidden = false;
        this._webReceiversDockNote.textContent =
          'This receiver is served over plain http, which an https page cannot embed. Use NEW TAB to open it.';
      }
      this._setStatus(`Tuned ${label} — open it in a new tab`);
      return;
    }
    this._webReceiversFrame.hidden = false;
    if (this._webReceiversDockNote) this._webReceiversDockNote.hidden = true;
    if (this._webReceiversFrame.getAttribute('src') !== url) {
      this._webReceiversFrame.src = url;
      this._armFocusGuard();
    }
    this._setStatus(`Tuned ${label}`);
  }

  /** Keep keyboard focus with GEV for a few seconds after a receiver page loads. */
  _armFocusGuard() {
    this._dockUserFocused = false;
    this._focusGuardUntil = Date.now() + FOCUS_GUARD_MS;
    if (this._focusGuardTimer) clearInterval(this._focusGuardTimer);
    this._focusGuardTimer = setInterval(() => {
      if (
        this.destroyed ||
        Date.now() > this._focusGuardUntil ||
        this._dockUserFocused
      ) {
        clearInterval(this._focusGuardTimer);
        this._focusGuardTimer = null;
        return;
      }
      if (document.activeElement === this._webReceiversFrame)
        this._reclaimFocusFromDock();
    }, FOCUS_GUARD_TICK_MS);
  }

  _reclaimFocusFromDock() {
    const frame = this._webReceiversFrame;
    if (!frame || document.activeElement !== frame) return;
    try {
      frame.blur();
    } catch {
      /* cross-origin frames still blur */
    }
    const home = document.getElementById('cesiumContainer') || document.body;
    if (home && !home.hasAttribute('tabindex'))
      home.setAttribute('tabindex', '-1');
    try {
      window.focus();
      home?.focus({ preventScroll: true });
    } catch {
      /* focus is best effort */
    }
  }

  /** Hide the receiver frame but keep it loaded (a muted waterfall keeps streaming). */
  _setDockMinimized(minimized) {
    if (!this._webReceiversDock) return;
    this._webReceiversDock.classList.toggle('minimized', Boolean(minimized));
    if (this._webReceiversDockMin) {
      this._webReceiversDockMin.textContent = minimized ? '▴' : '▾';
      this._webReceiversDockMin.setAttribute(
        'aria-pressed',
        String(Boolean(minimized)),
      );
      const action = minimized ? 'Restore' : 'Minimize';
      this._webReceiversDockMin.setAttribute(
        'aria-label',
        `${action} the receiver dock`,
      );
      this._webReceiversDockMin.title = action;
    }
    this.actions.scheduleLayout?.({ reconsiderAutoCollapse: true });
  }

  _closeDock({ silent = false } = {}) {
    if (!this._webReceiversDock) return;
    this._setDockMinimized(false);
    this._webReceiversDock.hidden = true;
    this._webReceiversFrame?.removeAttribute('src');
    if (this._focusGuardTimer) clearInterval(this._focusGuardTimer);
    this._focusGuardTimer = null;
    this._focusGuardUntil = 0;
    if (!silent) this._setStatus('Receiver dock closed');
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.listeners.abort();
    this._unsubscribe?.();
    this._unsubscribe = null;
    if (this._focusGuardTimer) clearInterval(this._focusGuardTimer);
    this._focusGuardTimer = null;
    this._focusGuardUntil = 0;
  }
}
