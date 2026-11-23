/**
 * Sky view "Clear view": one tap hides every menu, panel, HUD
 * and map widget so only the sky is left (stars, planets, Sun/Moon,
 * satellites, the enabled lines/labels and the horizon, all drawn by Cesium
 * and the Sky overlay canvas). A small eye button in a corner (bottom right;
 * top right on short landscape phones) toggles it and stays as the only control while the view is clear; it
 * fades after DIM_MS and comes back on any touch, click or key. Double-tap
 * on the sky, the H key and Escape (restore) are wired by skyView.js.
 *
 * Hiding is pure CSS (skyView.css, body.gev-sky-clear): every element gets
 * `visibility: hidden`, the two canvases, the centre circle, this button and
 * the message line get `visibility: visible`. Hidden elements keep their
 * boxes, so nothing reflows, no ResizeObserver fires and the camera, the
 * view and the overlay are not touched by a toggle.
 *
 * The choice lives in sessionStorage (this tab, this session only):
 * '1' = clear, '0' = the user brought the controls back, absent = never
 * chosen. Phone pointing enters Clear view by itself once the phone is
 * followed, unless the user said '0' earlier in the session.
 */

import { t } from '../i18n/index.js';
import { msg } from '../i18n/marker.js';

export const CLEAR_KEY = 'gev.sky.clearView';
export const CLEAR_HINT_KEY = 'gev.sky.clearHint';
/** The handle fades to low opacity after this long without input. */
export const DIM_MS = 3000;
/** The one-off "Double-tap to show controls" hint stays this long. */
export const HINT_MS = 5000;
/** Two taps closer than this in time and space are a double-tap. */
export const DOUBLE_TAP_MS = 350;
export const DOUBLE_TAP_PX = 30;
/** Orientation states whose message stays on screen in Clear view. */
export const CLEAR_MESSAGE_STATES = Object.freeze([
  'asking',
  'calibrating',
  'unsupported',
  'denied',
  'insecure',
]);

/** sessionStorage, or an in-memory stand-in where it is blocked. */
export function sessionStore(win = globalThis) {
  try {
    const store = win?.sessionStorage;
    if (store) {
      const probe = '__gev_sky_probe__';
      store.setItem(probe, '1');
      store.removeItem(probe);
      return store;
    }
  } catch {
    // Safari private mode / sandboxed frames throw: fall through
  }
  const memory = new Map();
  return {
    getItem: (k) => (memory.has(k) ? memory.get(k) : null),
    setItem: (k, v) => memory.set(k, String(v)),
    removeItem: (k) => memory.delete(k),
  };
}

function read(storage, key) {
  try {
    return storage?.getItem?.(key) ?? null;
  } catch {
    return null;
  }
}
function write(storage, key, value) {
  try {
    storage?.setItem?.(key, value);
  } catch {
    // storage full or blocked: the choice just is not remembered
  }
}

/**
 * True when `tap` (a finished tap: {t, x, y}) is the second tap of a
 * double-tap after `previous` (or null).
 */
export function isDoubleTap(previous, tap) {
  if (!previous || !tap) return false;
  const dt = tap.t - previous.t;
  if (!(dt >= 0 && dt <= DOUBLE_TAP_MS)) return false;
  return Math.hypot(tap.x - previous.x, tap.y - previous.y) <= DOUBLE_TAP_PX;
}

/**
 * What a key does to Clear view while the sky is shown:
 * 'toggle' (H), 'restore' (Escape while clear), 'consume' (a held-down H
 * repeat: still ours, so the app H = HUD shortcut must not see it, but it
 * must not toggle Clear view again) or null (not ours: typing in a field, a
 * modifier held, or Escape with controls on, which keeps leaving the sky).
 */
export function clearKeyAction(event, { clear = false } = {}) {
  if (!event || event.defaultPrevented) return null;
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  const target = event.target;
  const typing =
    target?.isContentEditable ||
    Boolean(target?.matches?.('input, select, textarea'));
  if (event.key === 'Escape') return clear ? 'restore' : null;
  if (typing) return null;
  if (event.key === 'h' || event.key === 'H')
    return event.repeat ? 'consume' : 'toggle';
  return null;
}

/** Messages that end in an action on a hidden control get the way back. */
const NEEDS_CONTROLS = /\b(tap|Tap) (Point at the sky|Align)\b/;

/**
 * The one line shown over the sky in Clear view: the one-off hint, the
 * pointing note (drag took over, Align result) and the orientation message
 * when the state needs the user (permission, denied, insecure, calibrating).
 */
export function clearNoteText({ hint = '', note = '', message = '' } = {}) {
  const parts = [hint, note, message].filter(Boolean);
  let text = parts.join(' · ');
  if (!hint && NEEDS_CONTROLS.test(text))
    text = `${text} Double-tap to show controls.`;
  return text;
}

function el(doc, tag, attrs = {}, text) {
  const node = doc.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'className') node.className = value;
    else node.setAttribute(key, value);
  }
  if (text != null) node.textContent = text;
  return node;
}

const LABEL_OFF = msg('Clear view: show only the sky');
const LABEL_ON = msg('Show the Sky controls');

/**
 * The Clear view controller. `coarse()` says whether this is a touch device
 * (hint wording); `onEnter()` runs when the view becomes clear (skyView.js
 * moves keyboard focus to the sky so H/Escape keep working).
 */
export function createClearView({
  doc,
  timers = globalThis,
  storage = sessionStore(),
  coarse = () => false,
  onEnter = () => {},
} = {}) {
  const button = el(doc, 'button', {
    type: 'button',
    className: 'gev-sky-clear-btn',
    'data-sky': 'clear',
    'aria-pressed': 'false',
    'aria-label': t(LABEL_OFF),
    title: t('{label} (double-tap the sky or press H)', {
      label: t(LABEL_OFF),
    }),
  });
  button.append(
    el(doc, 'span', { className: 'gev-sky-clear-icon', 'aria-hidden': 'true' }),
  );
  button.hidden = true;
  const note = el(doc, 'div', {
    className: 'gev-sky-clear-note',
    'data-sky': 'clear-note',
    role: 'status',
    'aria-live': 'polite',
  });
  const figure8 = el(
    doc,
    'span',
    {
      className: 'gev-sky-figure8',
      'data-sky': 'clear-figure8',
      'aria-hidden': 'true',
    },
    '∞',
  );
  figure8.hidden = true;
  const text = el(doc, 'span', { 'data-sky': 'clear-text' });
  note.append(figure8, text);
  note.hidden = true;

  let active = false;
  let on = read(storage, CLEAR_KEY) === '1';
  let autoArmed = false;
  let dimTimer = null;
  let hintTimer = null;
  let hint = '';
  let message = { note: '', message: '', figure8: false };
  let destroyed = false;

  const shown = () => active && on;

  function applyDom() {
    const clear = shown();
    if (clear) doc.body?.classList?.add('gev-sky-clear');
    else doc.body?.classList?.remove('gev-sky-clear');
    button.hidden = !active;
    button.setAttribute('aria-pressed', clear ? 'true' : 'false');
    const label = t(clear ? LABEL_ON : LABEL_OFF);
    button.setAttribute('aria-label', label);
    button.setAttribute(
      'title',
      clear
        ? t('{label} (double-tap the sky or press H, Esc)', { label })
        : t('{label} (double-tap the sky or press H)', { label }),
    );
    if (!clear) {
      timers.clearTimeout?.(dimTimer);
      dimTimer = null;
      button.setAttribute('data-dim', 'false');
    }
    syncNote();
  }

  function syncNote() {
    const line = shown()
      ? clearNoteText({ hint, note: message.note, message: message.message })
      : '';
    if (text.textContent !== line) text.textContent = line;
    const showFigure = shown() && message.figure8;
    if (figure8.hidden !== !showFigure) figure8.hidden = !showFigure;
    const hidden = !(line || showFigure);
    if (note.hidden !== hidden) note.hidden = hidden;
  }

  /** Full opacity now, faded again after DIM_MS without input. */
  function wake() {
    if (!shown()) return;
    button.setAttribute('data-dim', 'false');
    timers.clearTimeout?.(dimTimer);
    dimTimer = timers.setTimeout?.(() => {
      dimTimer = null;
      if (shown()) button.setAttribute('data-dim', 'true');
    }, DIM_MS);
  }

  function showHintOnce() {
    if (read(storage, CLEAR_HINT_KEY) === '1') return;
    write(storage, CLEAR_HINT_KEY, '1');
    hint = coarse()
      ? 'Double-tap to show controls'
      : 'Double-click the sky or press H to show controls';
    timers.clearTimeout?.(hintTimer);
    hintTimer = timers.setTimeout?.(() => {
      hintTimer = null;
      hint = '';
      syncNote();
    }, HINT_MS);
  }

  /** Clear view on/off; remembered for this session unless remember=false. */
  function set(next, { remember = true } = {}) {
    if (destroyed) return false;
    const want = Boolean(next);
    if (want && !active) return false;
    const changed = want !== on;
    on = want;
    if (remember) write(storage, CLEAR_KEY, on ? '1' : '0');
    if (on && changed) {
      showHintOnce();
      onEnter();
    }
    applyDom();
    if (on) wake();
    return changed;
  }

  return {
    button,
    note,
    get on() {
      return shown();
    },
    get preference() {
      return read(storage, CLEAR_KEY);
    },
    get dimmed() {
      return button.getAttribute('data-dim') === 'true';
    },
    get hint() {
      return hint;
    },
    set,
    toggle: () => set(!shown()),
    wake,
    /**
     * The sky was entered (true) or left (false): the handle shows only in
     * the sky, and the session's choice comes back on the next entry.
     */
    setActive(next) {
      active = Boolean(next);
      if (!active) autoArmed = false;
      else {
        const pref = read(storage, CLEAR_KEY);
        if (pref != null) on = pref === '1';
      }
      applyDom();
      if (shown()) {
        onEnter();
        wake();
      }
    },
    /** Pointing was started on a touch device: clear once the phone leads. */
    armAuto() {
      autoArmed = true;
    },
    disarmAuto() {
      autoArmed = false;
    },
    /** The phone now drives the view: enter Clear view unless told not to. */
    fireAuto() {
      if (!autoArmed) return false;
      autoArmed = false;
      if (read(storage, CLEAR_KEY) === '0' || shown()) return false;
      return set(true);
    },
    get autoArmed() {
      return autoArmed;
    },
    /** The pointing note/message and the figure-8 hint (shown when clear). */
    setMessage(next = {}) {
      message = {
        note: next.note || '',
        message: next.message || '',
        figure8: Boolean(next.figure8),
      };
      syncNote();
    },
    destroy() {
      if (destroyed) return;
      timers.clearTimeout?.(dimTimer);
      timers.clearTimeout?.(hintTimer);
      active = false;
      applyDom();
      destroyed = true;
      button.remove?.();
      note.remove?.();
    },
  };
}
