/**
 * Sky time control: LIVE, step back, play/pause, step
 * forward, speed (x1..x3600), reverse, date-time picker, presets and the
 * validity banners.
 *
 * The control only talks to the clock and reports what
 * happened; skyView.js owns what a time change does (one subscriber on the
 * time source applies it to the overlay, the worker, the ephemeris and
 * viewer.clock). All controls are native buttons, a select and an input, so
 * keyboard and screen readers work without extra code.
 */
import { SKY_RATES } from './skyClock.js';
import { PRESETS, presetTime } from './skyPresets.js';
import { t } from '../i18n/index.js';

/** Step size: 1 minute; Shift = 1 hour. */
export const STEP_MS = 60_000;
export const STEP_SHIFT_MS = 3_600_000;

/** `datetime-local` value in the browser's zone for a UTC instant. */
export function toLocalInputValue(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${String(d.getFullYear()).padStart(4, '0')}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** `datetime-local` value -> UTC ms (browser zone), or NaN. */
export function fromLocalInputValue(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(value))
    return NaN;
  return new Date(value).getTime();
}

const offsetText = (minutes) => {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(Math.round(minutes));
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `UTC${sign}${h}${m ? `:${String(m).padStart(2, '0')}` : ''}`;
};

/**
 * Time-zone hint: the picker is in the BROWSER's zone (its
 * offset for that instant comes from the browser); the observer's zone is
 * only estimated from longitude/15 because no time-zone service is used.
 */
export function zoneHint(ms, lonDeg) {
  const browser = offsetText(-new Date(ms).getTimezoneOffset());
  if (!Number.isFinite(lonDeg)) return `Times in your zone (${browser})`;
  const observer = offsetText(Math.round(lonDeg / 15) * 60);
  return `Times in your zone (${browser}); observer about ${observer} by longitude`;
}

export const rateLabel = (rate) => `x${Math.abs(rate)}`;

function el(doc, tag, attrs = {}, text) {
  const node = doc.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'className') node.className = value;
    else node.setAttribute(key, value);
  }
  if (text !== undefined) node.textContent = text;
  return node;
}

export function buildTimeDom(doc) {
  const root = el(doc, 'div', {
    className: 'gev-sky-time',
    role: 'group',
    'aria-label': 'Sky time',
    'data-sky': 'time-control',
  });
  // narrow screens (skyView.css, max-width 900px): the rows fold behind a
  // one-line summary button; desktop always shows them and hides the button
  const fold = el(
    doc,
    'button',
    {
      type: 'button',
      className: 'gev-sky-time-fold',
      'data-sky': 'time-fold',
      'aria-expanded': 'false',
      'aria-controls': 'gev-sky-time-body',
      title: t('Sky time controls'),
    },
    'Time',
  );
  const body = el(doc, 'div', {
    className: 'gev-sky-time-body',
    id: 'gev-sky-time-body',
    'data-sky': 'time-body',
  });
  const scrub = el(doc, 'div', {
    className: 'gev-sky-time-scrub',
    'data-sky': 'time-scrub',
  });
  const live = el(
    doc,
    'button',
    {
      type: 'button',
      'data-sky': 'live',
      'aria-pressed': 'true',
      title: t('Back to the current time'),
    },
    'Live',
  );
  const back = el(
    doc,
    'button',
    {
      type: 'button',
      'data-sky': 'step-back',
      'aria-label': t('Step back 1 minute (Shift: 1 hour)'),
      title: t('Step back 1 min (Shift: 1 h)'),
    },
    '◀',
  );
  const play = el(
    doc,
    'button',
    {
      type: 'button',
      'data-sky': 'play',
      'aria-pressed': 'false',
      'aria-label': 'Play',
      title: t('Play / pause (Space in the sky)'),
    },
    '▶ Play',
  );
  const fwd = el(
    doc,
    'button',
    {
      type: 'button',
      'data-sky': 'step-fwd',
      'aria-label': t('Step forward 1 minute (Shift: 1 hour)'),
      title: t('Step forward 1 min (Shift: 1 h)'),
    },
    '▶',
  );
  const rate = el(doc, 'select', {
    'data-sky': 'rate',
    'aria-label': 'Play speed',
  });
  for (const r of SKY_RATES) {
    const option = el(doc, 'option', { value: String(r) }, rateLabel(r));
    rate.append(option);
  }
  const reverse = el(
    doc,
    'button',
    {
      type: 'button',
      'data-sky': 'reverse',
      'aria-pressed': 'false',
      'aria-label': t('Play backwards'),
      title: t('Play backwards'),
    },
    '⇄',
  );
  const time = el(doc, 'input', {
    type: 'datetime-local',
    'data-sky': 'time',
    'aria-label': 'Sky time (your browser time zone)',
  });
  scrub.append(live, back, play, fwd, rate, reverse, time);
  const presetRow = el(doc, 'div', {
    className: 'gev-sky-presets',
    role: 'group',
    'aria-label': 'Jump to',
    'data-sky': 'presets',
  });
  const presets = {};
  for (const preset of PRESETS) {
    const button = el(
      doc,
      'button',
      {
        type: 'button',
        'data-sky': `preset-${preset.id}`,
        title: t(preset.title),
      },
      t(preset.label),
    );
    presets[preset.id] = button;
    presetRow.append(button);
  }
  const zone = el(doc, 'span', {
    className: 'gev-sky-zone',
    'data-sky': 'zone',
  });
  const status = el(doc, 'span', {
    className: 'gev-sky-time-status',
    'data-sky': 'time-status',
    role: 'status',
    'aria-live': 'polite',
  });
  const banners = el(doc, 'div', {
    className: 'gev-sky-banners',
    'data-sky': 'banners',
    role: 'status',
    'aria-live': 'polite',
  });
  body.append(scrub, presetRow, zone);
  root.append(fold, body, status, banners);
  return {
    root,
    fold,
    body,
    scrub,
    live,
    back,
    play,
    fwd,
    rate,
    reverse,
    time,
    presetRow,
    presets,
    zone,
    status,
    banners,
  };
}

const fmtLocal = (ms) => {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/**
 * @param {object} options
 *   doc, clock, source (createSkyTimeSource)
 *   getObserver() -> observer | null
 *   nextIssPass(fromMs, observer) -> Promise<preset result>
 */
export function createTimeControl({
  doc,
  clock,
  source,
  getObserver = () => null,
  nextIssPass = null,
}) {
  const dom = buildTimeDom(doc);
  const removers = [];
  const listen = (target, type, handler) => {
    if (!target?.addEventListener) return;
    target.addEventListener(type, handler);
    removers.push(() => target.removeEventListener(type, handler));
  };
  let lastTimeValue = '';
  let lastZone = '';
  let lastBanners = '';
  let presetToken = 0;
  const setText = (node, text) => {
    if (node.textContent !== text) node.textContent = text;
  };
  const setStatus = (text) => setText(dom.status, text || '');
  const pressed = (node, on) => {
    const value = on ? 'true' : 'false';
    if (node.getAttribute('aria-pressed') !== value)
      node.setAttribute('aria-pressed', value);
  };

  /** Buttons and picker follow the clock state. */
  function sync() {
    pressed(dom.live, clock.mode === 'live');
    const playing = clock.mode === 'play';
    pressed(dom.play, playing);
    dom.play.setAttribute('aria-label', playing ? t('Pause') : t('Play'));
    setText(dom.play, playing ? `❚❚ ${t('Pause')}` : `▶ ${t('Play')}`);
    const rateValue = String(Math.abs(clock.rate));
    if (dom.rate.value !== rateValue) dom.rate.value = rateValue;
    pressed(dom.reverse, clock.rate < 0);
    tick(source.getTime());
  }

  /** One-line summary for the folded control (narrow screens). */
  function summary(ms) {
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    const when = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    let state;
    if (clock.mode === 'live') state = 'Live';
    else if (clock.mode === 'play')
      state = `${clock.rate < 0 ? '◀' : '▶'} ${rateLabel(clock.rate)}`;
    else state = 'Paused';
    return `Time ${when} · ${state}`;
  }

  /** Per-applied-time update: picker value and zone hint (on change only). */
  function tick(ms) {
    if (!Number.isFinite(ms)) return;
    setText(dom.fold, summary(ms));
    const value = toLocalInputValue(ms);
    // never overwrite what the user is typing
    if (value !== lastTimeValue && doc.activeElement !== dom.time) {
      dom.time.value = value;
      lastTimeValue = value;
    }
    const zone = zoneHint(ms, getObserver()?.lonDeg);
    if (zone !== lastZone) {
      dom.zone.textContent = zone;
      lastZone = zone;
    }
  }

  /** Validity banners (skyValidity.js), rewritten only when they change. */
  function renderBanners(list = []) {
    const key = list.map((b) => `${b.level}|${b.text}`).join('\n');
    if (key === lastBanners) return;
    lastBanners = key;
    if (typeof dom.banners.replaceChildren === 'function')
      dom.banners.replaceChildren();
    else dom.banners.textContent = '';
    for (const banner of list) {
      const line = doc.createElement('div');
      line.className = `gev-sky-banner gev-sky-banner-${banner.level}`;
      line.setAttribute('data-banner', banner.id);
      line.textContent = banner.text;
      dom.banners.append(line);
    }
    dom.banners.hidden = list.length === 0;
  }

  /** Jump to `ms`; a playing clock keeps playing from there. */
  function jumpTo(ms) {
    if (clock.mode === 'play') return clock.play({ fromMs: ms });
    return clock.setFixed(ms);
  }

  async function applyPreset(id) {
    const observer = getObserver();
    const token = ++presetToken;
    const preset = PRESETS.find((p) => p.id === id);
    setStatus(id === 'iss' ? 'Searching the next ISS pass...' : '');
    const result = await presetTime(id, source.getTime(), observer, {
      nextIssPass,
    });
    if (token !== presetToken) return result; // a newer press won
    if (!result.ok) {
      setStatus(result.reason);
      return result;
    }
    if (!jumpTo(result.timeMs)) {
      setStatus('Could not move the time.');
      return { ok: false, reason: 'Could not move the time.' };
    }
    setStatus(`${preset ? t(preset.label) : id}: ${fmtLocal(result.timeMs)}`);
    return result;
  }

  listen(dom.fold, 'click', () => {
    const open = dom.fold.getAttribute('aria-expanded') !== 'true';
    dom.fold.setAttribute('aria-expanded', open ? 'true' : 'false');
    dom.root.setAttribute('data-open', open ? 'true' : 'false');
  });
  listen(dom.live, 'click', () => {
    setStatus('');
    clock.setLive();
  });
  listen(dom.play, 'click', () => {
    if (clock.mode === 'play') clock.pause();
    else clock.play();
  });
  const step = (sign) => (event) =>
    clock.step(sign * (event?.shiftKey ? STEP_SHIFT_MS : STEP_MS));
  listen(dom.back, 'click', step(-1));
  listen(dom.fwd, 'click', step(1));
  listen(dom.rate, 'change', () => {
    const abs = Number(dom.rate.value);
    clock.setRate(clock.rate < 0 ? -abs : abs);
  });
  listen(dom.reverse, 'click', () => clock.setRate(-clock.rate));
  listen(dom.time, 'change', () => {
    const ms = fromLocalInputValue(dom.time.value);
    if (!Number.isFinite(ms)) {
      setStatus('Pick a date and a time.');
      return;
    }
    setStatus('');
    lastTimeValue = dom.time.value;
    jumpTo(ms);
  });
  for (const [id, button] of Object.entries(dom.presets))
    listen(button, 'click', () => applyPreset(id));

  /** Keys in the sky canvas: Space play/pause, [ and ] step (Shift: 1 h). */
  function onKey(event) {
    if (event.key === ' ' || event.key === 'Spacebar') {
      if (clock.mode === 'play') clock.pause();
      else clock.play();
      return true;
    }
    if (event.key === '[' || event.key === '{') {
      clock.step(
        -(event.shiftKey || event.key === '{' ? STEP_SHIFT_MS : STEP_MS),
      );
      return true;
    }
    if (event.key === ']' || event.key === '}') {
      clock.step(event.shiftKey || event.key === '}' ? STEP_SHIFT_MS : STEP_MS);
      return true;
    }
    return false;
  }

  return {
    dom,
    root: dom.root,
    sync,
    tick,
    renderBanners,
    applyPreset,
    jumpTo,
    onKey,
    setStatus,
    destroy() {
      for (const remove of removers.splice(0)) remove();
      dom.root.remove?.();
    },
  };
}
