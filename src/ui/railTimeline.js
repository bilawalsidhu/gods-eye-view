import { formatUtcDayMonth, t } from '../i18n/index.js';
const set = (node, key, value) => {
  if (node[key] !== value) node[key] = value;
};
/**
 * "HH:MM UTC" of a time, or '' when it is not one. Computed on its own rather
 * than cut from the dated readout: the localized day and month vary in length
 * ("3/9" in Spanish, "09-03" in English).
 */
export const utcClock = (tick) =>
  Number.isFinite(Date.parse(tick))
    ? `${new Date(tick).toISOString().slice(11, 16)} UTC`
    : '';
const utc = (tick) =>
  Number.isFinite(Date.parse(tick))
    ? `${formatUtcDayMonth(tick)} ${utcClock(tick)}`
    : '';

/** Stable native transport with local preview and a coalesced 150 ms drag commit. */
export function createRailTimeline({
  container,
  document = container?.ownerDocument,
  sliderClassName = '',
  heading = true,
  onCommit = () => {},
  onPreview = () => {},
  onStep = () => {},
  onLatest = () => {},
  onPlay = () => {},
} = {}) {
  if (!document?.createElement || !container) return null;
  const root = document.createElement('section');
  root.className = 'rail-timeline';
  const row = document.createElement('div');
  row.className = 'rail-timeline-track';
  const makeButton = (label, title, parent) => {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = 'data-toggle-chip';
    node.textContent = label;
    node.title = title;
    parent.appendChild(node);
    return node;
  };
  const previous = makeButton('‹', t('Earlier observation'), row);
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.className = `gev-quantitative-slider${sliderClassName ? ` ${sliderClassName}` : ''}`;
  slider.min = '0';
  slider.max = '0';
  slider.step = '1';
  slider.value = '0';
  slider.setAttribute('aria-label', t('Observed history'));
  row.appendChild(slider);
  const next = makeButton('›', t('Later observation'), row);
  const controls = document.createElement('div');
  controls.className = 'rail-timeline-controls';
  const latest = makeButton(
    t('Latest'),
    t('Newest frame per product'),
    controls,
  );
  const play = makeButton(t('Play'), t('Replay observed history'), controls);
  const readout = document.createElement('span');
  readout.className = 'rail-timeline-readout';
  controls.appendChild(readout);
  const label = document.createElement('div');
  label.className = 'panel-title';
  label.textContent = t('Observed history');
  const endpoints = document.createElement('div');
  endpoints.className = 'rail-timeline-endpoints';
  const oldest = document.createElement('span');
  const newest = document.createElement('span');
  endpoints.appendChild(oldest);
  endpoints.appendChild(newest);
  row.appendChild(endpoints);
  if (heading) root.appendChild(label);
  root.appendChild(row);
  root.appendChild(controls);
  container.appendChild(root);
  let props = {
    ticks: [],
    index: 0,
    mode: 'latest',
    playing: false,
    readout: '',
    disabled: true,
  };
  let ticks = [];
  let dragging = false;
  let timer = null;
  let pending = null;
  let destroyed = false;
  const cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const valueText = (tick) => {
    const value = utc(tick);
    if (slider.getAttribute('aria-valuetext') !== value)
      slider.setAttribute('aria-valuetext', value);
  };
  const commit = () => {
    cancel();
    const value = pending;
    pending = null;
    if (!destroyed && value && !props.disabled)
      onCommit(value.tick, value.index);
  };
  const update = (nextProps) => {
    if (destroyed) return;
    props = nextProps;
    if (props.disabled) {
      cancel();
      pending = null;
      dragging = false;
    }
    if (!dragging) {
      ticks = [...props.ticks];
      set(slider, 'max', String(Math.max(0, ticks.length - 1)));
      set(
        slider,
        'value',
        String(Math.max(0, Math.min(props.index, ticks.length - 1))),
      );
      valueText(ticks[Number(slider.value)]);
      set(oldest, 'textContent', utcClock(ticks[0]));
      set(newest, 'textContent', utcClock(ticks.at(-1)));
      set(readout, 'textContent', props.readout || '');
    }
    for (const node of [slider, latest, play])
      set(node, 'disabled', Boolean(props.disabled));
    set(previous, 'disabled', Boolean(props.disabled || props.index <= 0));
    set(
      next,
      'disabled',
      Boolean(props.disabled || props.index >= props.ticks.length - 1),
    );
    set(
      latest,
      'className',
      `data-toggle-chip${props.mode === 'latest' ? ' active' : ''}`,
    );
    set(play, 'className', `data-toggle-chip${props.playing ? ' active' : ''}`);
    set(play, 'textContent', props.playing ? t('Pause') : t('Play'));
    for (const [node, active] of [
      [latest, props.mode === 'latest'],
      [play, props.playing],
    ]) {
      if (node.getAttribute('aria-pressed') !== String(active))
        node.setAttribute('aria-pressed', String(active));
    }
  };
  const preview = () => {
    if (props.disabled) return;
    dragging = true;
    const index = Number(slider.value);
    const tick = ticks[index];
    if (!tick) return;
    pending = { tick, index };
    valueText(tick);
    const value = onPreview(tick, index);
    if (typeof value === 'string') set(readout, 'textContent', value);
    if (timer === null) timer = setTimeout(commit, 150);
  };
  const change = () => {
    if (props.disabled) return;
    pending = {
      tick: ticks[Number(slider.value)],
      index: Number(slider.value),
    };
    dragging = false;
    commit();
    update(props);
  };
  const reset = () => {
    cancel();
    pending = null;
    dragging = false;
    update(props);
  };
  const act = (fn) => () => {
    reset();
    if (!props.disabled) fn();
  };
  const bindings = [
    [slider, 'input', preview],
    [slider, 'change', change],
    [slider, 'pointercancel', reset],
    [
      slider,
      'blur',
      () => {
        if (dragging) change();
      },
    ],
    [previous, 'click', act(() => onStep(-1))],
    [next, 'click', act(() => onStep(1))],
    [latest, 'click', act(onLatest)],
    [play, 'click', act(onPlay)],
  ];
  for (const [node, event, handler] of bindings)
    node.addEventListener(event, handler);
  return {
    update,
    destroy() {
      destroyed = true;
      cancel();
      for (const [node, event, handler] of bindings)
        node.removeEventListener(event, handler);
      root.remove();
    },
  };
}
