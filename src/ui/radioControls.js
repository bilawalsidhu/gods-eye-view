import { bindRadioControls } from './radioBindings.js';
import { renderRadioState } from './radioPresentation.js';

/** Own Radio DOM, tuner interaction and subscription; receive playback and application actions. */
export class RadioControls {
  constructor({ elements, radio, actions, canvas }) {
    Object.assign(this, elements);
    this.radio = radio;
    this.actions = actions;
    this.canvas = canvas;
    this.destroyed = false;
    this.listeners = new AbortController();
    this._radioUnsubscribe = null;
    this._radioState = null;
    this._radioCategorySignature = '';
    this._radioTunerStations = [];
    this._radioTunerPool = [];
    this._radioTunerDragging = false;
    this._radioTunerDragStartSlot = 0;
    this._radioTunerDragSnapshot = null;
    this._radioTunerLastSlot = 0;
    this._radioTunerDragDirection = 0;
    this._radioTunerCoordinate = 0;
    this._radioTunerPointerId = null;
    this._radioTunerKeyboardKey = null;
    this._radioTunerBandSignature = '';
    this._radioTunerSelectedId = null;
    this._radioTunerBandPinnedForNavigation = false;
    this._refreshRadioTunerBand = null;
    bindRadioControls.call(this);
  }

  listen(target, type, handler, options = {}) {
    target?.addEventListener(type, handler, {
      ...options,
      signal: this.listeners.signal,
    });
  }

  connect() {
    this._radioUnsubscribe?.();
    this._radioUnsubscribe = null;
    if (this.destroyed) return;
    this._radioUnsubscribe = this.radio.subscribe?.((state) =>
      this._renderRadioState(state),
    );
  }

  _renderRadioState(state) {
    renderRadioState.call(this, state);
  }

  /**
   * Reveal the newly enabled directory and transport inside Context without
   * moving focus, the page, or the globe. Only the expanded Enable path calls
   * this helper.
   * @param {HTMLElement} trigger Initiating Radio Enable button.
   * @returns {Promise<boolean>} Whether the internal scroller moved.
   */
  async _revealRadioControlsAfterExplicitEnable(trigger) {
    const contextPanel = document.getElementById('global-context-panel');
    const scroller = contextPanel?.querySelector('.global-context-panel-inner');
    const directory = this._radioPanel?.querySelector('.radio-directory-row');
    const transport = this._radioPanel?.querySelector('.radio-transport');
    if (
      !contextPanel ||
      contextPanel.classList.contains('collapsed') ||
      !scroller ||
      !directory ||
      !transport ||
      !this._radioState?.enabled
    )
      return false;

    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
    if (this.destroyed || !this._radioState?.enabled || !trigger?.isConnected)
      return false;

    const viewport = scroller.getBoundingClientRect();
    const directoryRect = directory.getBoundingClientRect();
    const transportRect = transport.getBoundingClientRect();
    const margin = 10;
    const minimum =
      scroller.scrollTop + transportRect.bottom - (viewport.bottom - margin);
    const maximum =
      scroller.scrollTop + directoryRect.top - (viewport.top + margin);
    const desired =
      minimum <= maximum
        ? Math.min(Math.max(scroller.scrollTop, minimum), maximum)
        : minimum;
    const next = Math.min(
      Math.max(0, scroller.scrollHeight - scroller.clientHeight),
      Math.max(0, desired),
    );
    if (Math.abs(next - scroller.scrollTop) < 1) return false;
    const reducedMotion = window.matchMedia?.(
      '(prefers-reduced-motion: reduce)',
    )?.matches;
    scroller.scrollTo({
      top: next,
      behavior: reducedMotion ? 'auto' : 'smooth',
    });
    return true;
  }

  /**
   * Bring the embedded Radio section into the expanded Context scroller.
   * This never changes Radio power, playback, selection, or Context mode.
   * @param {{focusTarget?: HTMLElement|null}} [options]
   * @returns {Promise<boolean>} Whether the internal scroller moved.
   */
  async _revealRadioPanelInsideContext({ focusTarget = null } = {}) {
    const contextPanel = document.getElementById('global-context-panel');
    const scroller = contextPanel?.querySelector('.global-context-panel-inner');
    if (
      !contextPanel ||
      contextPanel.classList.contains('collapsed') ||
      !scroller ||
      !this._radioPanel ||
      this._radioPanel.classList.contains('collapsed')
    )
      return false;

    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
    if (
      this.destroyed ||
      contextPanel.classList.contains('collapsed') ||
      this._radioPanel.classList.contains('collapsed')
    )
      return false;

    const viewport = scroller.getBoundingClientRect();
    const radioRect = this._radioPanel.getBoundingClientRect();
    const desired = scroller.scrollTop + radioRect.top - viewport.top - 10;
    const next = Math.min(
      Math.max(0, scroller.scrollHeight - scroller.clientHeight),
      Math.max(0, desired),
    );
    const moved = Math.abs(next - scroller.scrollTop) >= 1;
    if (moved) {
      const reducedMotion = window.matchMedia?.(
        '(prefers-reduced-motion: reduce)',
      )?.matches;
      scroller.scrollTo({
        top: next,
        behavior: reducedMotion ? 'auto' : 'smooth',
      });
    }
    focusTarget?.focus?.({ preventScroll: true });
    return moved;
  }

  /** Keep the Context header Radio shortcut truthful for its current route. */
  _syncContextRadioLauncherState() {
    if (this.destroyed || !this._contextRadioToggleBtn) return;
    const contextPanel = document.getElementById('global-context-panel');
    const contextExpanded = Boolean(
      contextPanel && !contextPanel.classList.contains('collapsed'),
    );
    if (contextExpanded) {
      const radioExpanded = Boolean(
        this._radioPanel && !this._radioPanel.classList.contains('collapsed'),
      );
      this._contextRadioToggleBtn.setAttribute('aria-controls', 'radio-panel');
      this._contextRadioToggleBtn.setAttribute(
        'aria-expanded',
        String(radioExpanded),
      );
      const label = radioExpanded
        ? 'Go to expanded Radio section'
        : 'Expand Radio section in Context';
      this._contextRadioToggleBtn.setAttribute('aria-label', label);
      this._contextRadioToggleBtn.title = label;
      return;
    }
    const compactOpen = Boolean(
      this._contextRadioDock?.classList.contains('disclosure-open'),
    );
    this._contextRadioToggleBtn.setAttribute(
      'aria-controls',
      'context-radio-mini',
    );
    this._contextRadioToggleBtn.setAttribute(
      'aria-expanded',
      String(compactOpen),
    );
    const action = compactOpen ? 'Close' : 'Open';
    this._contextRadioToggleBtn.setAttribute(
      'aria-label',
      `${action} compact Radio controls`,
    );
    this._contextRadioToggleBtn.title = `${action} compact Radio controls`;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.listeners.abort();
    this._radioUnsubscribe?.();
    this._radioUnsubscribe = null;
    const pointer = this._radioTunerPointerId;
    this._radioTunerPointerId = null;
    this._radioTunerDragging = false;
    this._radioTunerKeyboardKey = null;
    this._radioTunerDragSnapshot = null;
    this._radioTunerPool = [];
    this._radioTunerStations = [];
    this._radioTunerBandPinnedForNavigation = false;
    try {
      if (pointer !== null)
        this._radioTunerSlider?.releasePointerCapture(pointer);
    } catch {
      /* capture already released */
    }
    this._radioTuner?.classList.remove('is-dragging', 'is-static');
    document
      .getElementById('title-bar')
      ?.classList.remove('radio-broadcasting');
    this.radio.endTuning();
  }
}
