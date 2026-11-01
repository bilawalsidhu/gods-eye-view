import { msg, t } from '../i18n/index.js';

/** Quiet time before the eye fades while clean view is on. */
export const CLEAN_VIEW_EYE_IDLE_MS = 3000;

const WAKE_EVENTS = [
  'pointerdown',
  'pointermove',
  'touchstart',
  'keydown',
  'wheel',
];
const LABELS = Object.freeze({
  off: msg('Clean view: hide the controls'),
  on: msg('Exit clean view: show the controls'),
});

/**
 * Mirror clean-view state on the corner eye button and fade it while idle.
 * The shell owns the state (`toggleCleanView`) and the button's click; this
 * controller only reflects that state on the button. While clean view is on,
 * the button fades after `idleMs` without input, and any pointer, touch,
 * wheel or key input brings it back. Wake listeners are passive and never stop an event.
 * @param {object} options
 * @param {HTMLElement} [options.button] The eye button.
 * @param {Document} [options.documentRef] Input event target.
 * @param {number} [options.idleMs] Quiet time before fading.
 * @param {{setTimeout: Function, clearTimeout: Function}} [options.timers]
 * @returns {{sync(enabled: boolean): void, destroy(): void}}
 */
export function bindCleanViewEye({
  button,
  documentRef,
  idleMs = CLEAN_VIEW_EYE_IDLE_MS,
  timers = globalThis,
} = {}) {
  if (!button || !documentRef) return { sync() {}, destroy() {} };
  let enabled = false;
  let destroyed = false;
  let timer = null;
  const cancel = () => {
    if (timer === null) return;
    timers.clearTimeout(timer);
    timer = null;
  };
  const arm = () => {
    cancel();
    if (!enabled || destroyed) return;
    timer = timers.setTimeout(() => {
      timer = null;
      if (enabled && !destroyed) button.setAttribute('data-idle', 'true');
    }, idleMs);
  };
  const wake = () => {
    if (!enabled || destroyed) return;
    button.removeAttribute('data-idle');
    arm();
  };
  const listenerOptions = { capture: true, passive: true };
  for (const type of WAKE_EVENTS)
    documentRef.addEventListener(type, wake, listenerOptions);
  return {
    sync(next) {
      if (destroyed) return;
      enabled = Boolean(next);
      const label = t(enabled ? LABELS.on : LABELS.off);
      button.setAttribute('aria-pressed', String(enabled));
      button.setAttribute('aria-label', label);
      button.setAttribute('title', t('{label} (V)', { label }));
      button.removeAttribute('data-idle');
      if (enabled) arm();
      else cancel();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      cancel();
      for (const type of WAKE_EVENTS)
        documentRef.removeEventListener(type, wake, listenerOptions);
      button.removeAttribute('data-idle');
    },
  };
}
