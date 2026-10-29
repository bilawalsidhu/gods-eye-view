import { t, msg } from '../i18n/index.js';
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
    const directory = this._radioPanel?.querySelector('.radio-directory-row');
    const transport = this._radioPanel?.querySelector('.radio-transport');
    if (!directory || !transport || !this._radioState?.enabled) return false;
    return this._revealInsideContext(
      directory,
      transport,
      () => this._radioState?.enabled && trigger?.isConnected,
    );
  }

  /**
   * Scroll Context so `top` through `bottom` show, preferring `bottom` when
   * both do not fit, once the rail has laid out the opened panels.
   * @param {HTMLElement} top
   * @param {HTMLElement} bottom
   * @param {() => boolean} stillWanted Rechecked after the layout frames.
   * @returns {Promise<boolean>} Whether the internal scroller moved.
   */
  async _revealInsideContext(top, bottom, stillWanted) {
    const contextPanel = document.getElementById('global-context-panel');
    const scroller =
      (document.documentElement?.dataset.uiTheme === 'cyber' &&
        contextPanel?.querySelector('.cyber-panel-body')) ||
      contextPanel?.querySelector('.global-context-panel-inner');
    if (
      !contextPanel ||
      contextPanel.classList.contains('collapsed') ||
      !scroller
    )
      return false;

    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
    if (this.destroyed || !stillWanted()) return false;

    const viewport = scroller.getBoundingClientRect();
    const topRect = top.getBoundingClientRect();
    const bottomRect = bottom.getBoundingClientRect();
    const margin = 10;
    const minimum =
      scroller.scrollTop + bottomRect.bottom - (viewport.bottom - margin);
    const maximum = scroller.scrollTop + topRect.top - (viewport.top + margin);
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
    // A rail layout pass that measures the panels mid-scroll puts the scroll
    // offset back where it was, which cancels the smooth scroll: land it when
    // the scroll ends short, unless the user took the scroll over meanwhile.
    if (!reducedMotion) {
      const landing = new AbortController();
      const signal = AbortSignal.any([
        this.listeners.signal,
        landing.signal,
        AbortSignal.timeout(2000),
      ]);
      const cancel = () => landing.abort();
      for (const type of ['keydown', 'wheel', 'pointerdown', 'touchstart'])
        scroller.addEventListener(type, cancel, { signal, passive: true });
      scroller.addEventListener(
        'scrollend',
        () => {
          cancel();
          if (Math.abs(scroller.scrollTop - next) >= 1)
            scroller.scrollTop = next;
        },
        { signal },
      );
    }
    return true;
  }

  /** Keep the launcher's ARIA state matched to the compact player. */
  _syncContextRadioLauncherState() {
    if (this.destroyed || !this._contextRadioToggleBtn) return;
    const compactOpen = Boolean(
      this._contextRadioDock?.classList.contains('disclosure-open'),
    );
    this._contextRadioToggleBtn.setAttribute(
      'aria-expanded',
      String(compactOpen),
    );
    const launcherLabel = t(
      compactOpen
        ? msg('Close compact Radio controls')
        : msg('Open compact Radio controls'),
    );
    this._contextRadioToggleBtn.setAttribute('aria-label', launcherLabel);
    this._contextRadioToggleBtn.title = launcherLabel;
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
