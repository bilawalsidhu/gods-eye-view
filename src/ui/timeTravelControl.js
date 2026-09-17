import { REWIND_RATES, DEFAULT_REWIND_MS } from '../history/timeTravel.js';

/** Format a negative offset as −MM:SS (hours only when needed). */
export function formatOffset(offsetMs) {
  if (!Number.isFinite(offsetMs)) return 'LIVE';
  const total = Math.round(Math.abs(offsetMs) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  const sign = offsetMs > 0 ? '+' : '−';
  return h ? `LIVE ${sign}${h}:${mm}:${ss}` : `LIVE ${sign}${mm}:${ss}`;
}
/** Local wall-clock HH:MM:SS for an absolute timestamp. */
export function formatClock(timestampMs) {
  if (!Number.isFinite(timestampMs)) return '--:--:--';
  const date = new Date(timestampMs);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

const SLIDER_STEPS = 1000;

/**
 * Mount the rewind button in the command dock and the scrubber strip above it.
 * @param {object} options
 * @param {object} options.timeTravel Controller from `createTimeTravel`.
 * @param {Document} [options.documentRef]
 * @param {(message: string) => void} [options.notify] Toast for refusals.
 * @param {number} [options.rewindMs] Offset applied by the dock button.
 * @returns {{root: HTMLElement, scrubber: HTMLElement, update: Function, destroy: Function}}
 */
export function createTimeTravelControl({
  timeTravel,
  documentRef = globalThis.document,
  notify = null,
  rewindMs = DEFAULT_REWIND_MS,
} = {}) {
  const doc = documentRef;
  const el = (tag, className, props = {}) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    Object.assign(node, props);
    return node;
  };
  const button = (className, label, title) => {
    const node = el('button', className, { type: 'button', title });
    node.textContent = label;
    return node;
  };

  doc.getElementById('gev-time-travel')?.remove();
  doc.getElementById('gev-time-travel-scrubber')?.remove();

  // Dock entry: always visible, one press rewinds ten minutes.
  const root = el('div', 'gev-time-travel-dock', { id: 'gev-time-travel' });
  const rewindButton = el('button', 'gev-tt-rewind-btn', {
    id: 'gev-time-travel-rewind',
    type: 'button',
    title: 'Rewind 10 minutes ( [ )',
  });
  rewindButton.setAttribute('aria-label', 'Rewind the last ten minutes');
  const icon = el('span', 'gev-tt-icon');
  icon.textContent = '⏪';
  icon.setAttribute('aria-hidden', 'true');
  const label = el('span', 'gev-tt-label');
  label.textContent = '10 MIN';
  rewindButton.appendChild(icon);
  rewindButton.appendChild(label);
  root.appendChild(rewindButton);
  const dock = doc.getElementById('command-dock');
  (dock || doc.body).appendChild(root);

  // Scrubber strip: only while rewound.
  const scrubber = el('div', 'gev-time-travel-scrubber', {
    id: 'gev-time-travel-scrubber',
    hidden: true,
  });
  scrubber.setAttribute('role', 'group');
  scrubber.setAttribute('aria-label', 'Time travel');
  const readout = el('div', 'gev-tt-readout');
  const kicker = el('span', 'gev-tt-kicker');
  kicker.textContent = 'REWIND';
  const offsetOut = el('output', 'gev-slider-value gev-tt-offset', {
    id: 'gev-tt-offset',
  });
  offsetOut.setAttribute('aria-live', 'polite');
  const clock = el('span', 'gev-tt-clock', { id: 'gev-tt-clock' });
  readout.appendChild(kicker);
  readout.appendChild(offsetOut);
  readout.appendChild(clock);
  const range = el('input', 'gev-quantitative-slider gev-tt-range', {
    id: 'gev-tt-range',
    type: 'range',
    min: '0',
    max: String(SLIDER_STEPS),
    step: '1',
    value: String(SLIDER_STEPS),
  });
  range.setAttribute('aria-label', 'Rewind position');
  const transport = el('div', 'gev-tt-transport');
  const playButton = button('gev-tt-btn gev-tt-play', '⏸', 'Pause');
  playButton.id = 'gev-tt-play';
  playButton.setAttribute('aria-label', 'Pause replay');
  transport.appendChild(playButton);
  const rateButtons = new Map();
  for (const rate of REWIND_RATES) {
    if (rate === 0) continue;
    const node = button(
      'gev-tt-btn gev-tt-rate',
      `×${rate}`,
      `Replay at ${rate}x`,
    );
    node.dataset.rate = String(rate);
    node.setAttribute('aria-pressed', 'false');
    rateButtons.set(rate, node);
    transport.appendChild(node);
  }
  const liveButton = button(
    'gev-tt-btn gev-tt-live',
    'LIVE',
    'Return to live ( ] )',
  );
  liveButton.id = 'gev-tt-live';
  transport.appendChild(liveButton);
  scrubber.appendChild(readout);
  scrubber.appendChild(range);
  scrubber.appendChild(transport);
  doc.body.appendChild(scrubber);

  let destroyed = false;
  let scrubbing = false;
  let lastState = timeTravel.state();

  function update(state = timeTravel.state()) {
    if (destroyed) return;
    lastState = state;
    const rewound = state.mode === 'rewind';
    scrubber.hidden = !rewound;
    root.dataset.mode = state.mode;
    rewindButton.setAttribute('aria-pressed', rewound ? 'true' : 'false');
    if (!rewound) return;
    offsetOut.textContent = formatOffset(state.offsetMs);
    clock.textContent = formatClock(state.displayTimeMs);
    const span = state.newestT - state.oldestT;
    if (!scrubbing && Number.isFinite(span) && span > 0) {
      const fraction = (state.displayTimeMs - state.oldestT) / span;
      range.value = String(
        Math.round(Math.min(1, Math.max(0, fraction)) * SLIDER_STEPS),
      );
    }
    const paused = state.rate === 0;
    playButton.textContent = paused ? '▶' : '⏸';
    playButton.title = paused ? 'Play' : 'Pause';
    playButton.setAttribute(
      'aria-label',
      paused ? 'Play replay' : 'Pause replay',
    );
    for (const [rate, node] of rateButtons)
      node.setAttribute('aria-pressed', state.rate === rate ? 'true' : 'false');
  }

  const onRewind = () => {
    if (destroyed) return;
    if (lastState.mode === 'rewind') {
      const target = lastState.displayTimeMs + rewindMs;
      if (!timeTravel.seekTo(target)) notify?.('No earlier history recorded');
      return;
    }
    if (!timeTravel.rewind(rewindMs))
      notify?.('No position history yet — keep a live layer on for a minute');
  };
  const onPlay = () => {
    if (destroyed) return;
    timeTravel.setRate(lastState.rate === 0 ? 1 : 0);
  };
  const onRate = (event) => {
    const rate = Number(event.currentTarget?.dataset?.rate);
    if (Number.isFinite(rate) && rate > 0) timeTravel.setRate(rate);
  };
  const onLive = () => timeTravel.resumeLive();
  const onScrubStart = () => {
    scrubbing = true;
  };
  const onScrubInput = () => {
    if (destroyed) return;
    const state = lastState;
    const span = state.newestT - state.oldestT;
    if (!Number.isFinite(span) || span <= 0) return;
    const fraction = Number(range.value) / SLIDER_STEPS;
    if (state.rate !== 0) timeTravel.setRate(0);
    timeTravel.seekTo(state.oldestT + fraction * span);
  };
  const onScrubEnd = () => {
    scrubbing = false;
  };

  rewindButton.addEventListener('click', onRewind);
  playButton.addEventListener('click', onPlay);
  for (const node of rateButtons.values())
    node.addEventListener('click', onRate);
  liveButton.addEventListener('click', onLive);
  range.addEventListener('pointerdown', onScrubStart);
  range.addEventListener('input', onScrubInput);
  range.addEventListener('pointerup', onScrubEnd);
  range.addEventListener('change', onScrubEnd);
  const unsubscribe = timeTravel.subscribe((state) => update(state));
  update(lastState);

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    unsubscribe();
    rewindButton.removeEventListener('click', onRewind);
    playButton.removeEventListener('click', onPlay);
    for (const node of rateButtons.values())
      node.removeEventListener('click', onRate);
    liveButton.removeEventListener('click', onLive);
    range.removeEventListener('pointerdown', onScrubStart);
    range.removeEventListener('input', onScrubInput);
    range.removeEventListener('pointerup', onScrubEnd);
    range.removeEventListener('change', onScrubEnd);
    root.remove();
    scrubber.remove();
  }

  return {
    root,
    scrubber,
    rewindButton,
    playButton,
    liveButton,
    range,
    rateButtons,
    offsetOut,
    clock,
    update,
    destroy,
  };
}
