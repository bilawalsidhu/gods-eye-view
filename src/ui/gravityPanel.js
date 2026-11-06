/**
 * Mass change readout for the right rail (`#gravity-panel`): the shown
 * solution, a month transport with playback, and the clicked point's whole
 * record as a chart. Display choices (land only, opacity) stay on the layer
 * row and are repeated here so a replay can be watched without the picker.
 */
import { t } from '../i18n/index.js';
import {
  GRAVITY_COLORS,
  GRAVITY_CORE_CM,
  formatGravityCm,
  gravityMonthLabel,
  gravityScalePosition,
} from '../layers/gravity/display.js';

const LAYER_ID = 'gravity';

/** A legend tick: a signed whole number with a true minus sign. */
const formatGravityTick = (cm) =>
  `${cm > 0 ? '+' : cm < 0 ? '−' : ''}${Math.abs(cm)}`;
const SVG = 'http://www.w3.org/2000/svg';
const CHART = Object.freeze({ width: 300, height: 96, pad: 4 });
// Consecutive solutions further apart than this are not joined: the
// 2017-2018 gap between the missions, and the occasional skipped month.
const JOIN_DAYS = 75;
const DAY_MS = 86_400_000;
const appearedDocuments = new WeakSet();

const set = (node, key, value) => {
  if (node[key] !== value) node[key] = value;
};
const attr = (node, name, value) => {
  if (node.getAttribute(name) !== String(value))
    node.setAttribute(name, String(value));
};
// SVG elements have no `hidden` property; the attribute still hides them.
const hide = (node, hidden) => {
  if (node.hasAttribute?.('hidden') === hidden) return;
  if (hidden) node.setAttribute('hidden', '');
  else node.removeAttribute?.('hidden');
};
const dayMs = (day) => Date.parse(`${day}T00:00:00Z`);

function place(lat, lon) {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(1)}°${ns} ${Math.abs(lon).toFixed(1)}°${ew}`;
}

/**
 * Chart geometry for one cell's record: polylines broken at gaps and missing
 * values, a zero line, and the shown solution's marker. Pure, for tests.
 * @param {{start: string}[]} solutions
 * @param {(number|null)[]} values
 * @param {number} shownIndex
 */
export function gravityChartGeometry(solutions, values, shownIndex) {
  const { width, height, pad } = CHART;
  const times = solutions.map(({ start }) => dayMs(start));
  const present = values.filter((value) => Number.isFinite(value));
  if (present.length === 0 || times.length < 2) return null;
  const low = Math.min(0, ...present);
  const high = Math.max(0, ...present);
  const span = high - low || 1;
  const t0 = times[0];
  const tSpan = times.at(-1) - t0 || 1;
  const x = (time) => pad + ((time - t0) / tSpan) * (width - 2 * pad);
  const y = (value) => pad + ((high - value) / span) * (height - 2 * pad);
  const lines = [];
  let line = [];
  values.forEach((value, index) => {
    const joined =
      index > 0 && times[index] - times[index - 1] <= JOIN_DAYS * DAY_MS;
    if (!Number.isFinite(value) || !joined) {
      if (line.length > 1) lines.push(line);
      line = [];
    }
    if (Number.isFinite(value))
      line.push(`${x(times[index]).toFixed(1)},${y(value).toFixed(1)}`);
  });
  if (line.length > 1) lines.push(line);
  const shown = values[shownIndex];
  return {
    lines: lines.map((points) => points.join(' ')),
    zero: y(0),
    low,
    high,
    marker:
      shownIndex >= 0 && Number.isFinite(shown)
        ? { x: x(times[shownIndex]), y: y(shown) }
        : null,
    /** Nearest solution to a horizontal position in chart units. */
    indexAt(chartX) {
      const time = t0 + ((chartX - pad) / (width - 2 * pad)) * tSpan;
      let best = 0;
      for (let i = 1; i < times.length; i++)
        if (Math.abs(times[i] - time) < Math.abs(times[best] - time)) best = i;
      return best;
    },
  };
}

/** Build the card in `container`; `update(state)` takes layer.getCardState(). */
export function createGravityPanel({
  container,
  setLayerParams = () => {},
} = {}) {
  const document = container?.ownerDocument;
  if (!document?.createElement) return null;
  const panel = container.closest?.('#gravity-panel');
  const removers = [];
  const make = (tag, className, parent, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    parent.appendChild(node);
    return node;
  };
  const on = (node, type, handler) => {
    node.addEventListener(type, handler);
    removers.push(() => node.removeEventListener(type, handler));
  };
  const params = (value) => setLayerParams(LAYER_ID, value);
  const chip = (parent, label, title, onClick) => {
    const node = make('button', 'data-toggle-chip', parent, label);
    node.type = 'button';
    node.title = title;
    on(node, 'click', onClick);
    return node;
  };

  const root = make('section', 'gravity-readout', container);
  root.setAttribute('aria-label', t('Mass change'));

  const heading = make('div', 'gravity-month', root);
  const monthLabel = make('span', 'gravity-month-label', heading);
  const monthWindow = make('span', 'gravity-month-window', heading);

  const transport = make('div', 'rail-timeline gravity-timeline', root);
  const track = make('div', 'rail-timeline-track', transport);
  const previous = chip(track, '‹', t('Previous solution'), () =>
    params({ step: -1 }),
  );
  const slider = make('input', 'gev-quantitative-slider', track);
  slider.type = 'range';
  slider.min = '0';
  slider.step = '1';
  slider.setAttribute('aria-label', t('Solution'));
  const newer = chip(track, '›', t('Next solution'), () => params({ step: 1 }));
  const endpoints = make('div', 'rail-timeline-endpoints', track);
  const oldest = make('span', '', endpoints);
  const newest = make('span', '', endpoints);
  const controls = make('div', 'rail-timeline-controls', transport);
  const latest = chip(
    controls,
    t('Latest'),
    t('Show the most recent solution'),
    () => params({ month: null }),
  );
  const play = chip(
    controls,
    t('Play'),
    t('Replay every solution in order'),
    () => params({ playing: !state?.playing }),
  );
  const status = make('span', 'rail-timeline-readout', controls);

  let state = null;
  let dragging = false;
  on(slider, 'input', () => {
    dragging = true;
    const solution = state?.solutions[Number(slider.value)];
    if (solution)
      set(monthLabel, 'textContent', gravityMonthLabel(solution.id));
  });
  on(slider, 'change', () => {
    dragging = false;
    const list = state?.solutions || [];
    const solution = list[Number(slider.value)];
    if (solution)
      params({ month: solution === list.at(-1) ? null : solution.id });
  });

  const point = make('div', 'gravity-point', root);
  const pointHeader = make('div', 'gravity-point-header', point);
  const pointText = make('span', 'gravity-point-text', pointHeader);
  const clear = chip(pointHeader, t('Clear'), t('Clear the chosen point'), () =>
    params({ clearProbe: true }),
  );
  const chart = document.createElementNS(SVG, 'svg');
  chart.setAttribute('class', 'gravity-chart');
  chart.setAttribute('viewBox', `0 0 ${CHART.width} ${CHART.height}`);
  chart.setAttribute('preserveAspectRatio', 'none');
  chart.setAttribute('role', 'img');
  const chartWrap = make('div', 'gravity-chart-wrap', point);
  chartWrap.appendChild(chart);
  const zero = document.createElementNS(SVG, 'line');
  zero.setAttribute('class', 'gravity-chart-zero');
  zero.setAttribute('x1', '0');
  zero.setAttribute('x2', String(CHART.width));
  chart.appendChild(zero);
  const series = document.createElementNS(SVG, 'g');
  series.setAttribute('class', 'gravity-chart-series');
  chart.appendChild(series);
  const marker = document.createElementNS(SVG, 'circle');
  marker.setAttribute('class', 'gravity-chart-marker');
  marker.setAttribute('r', '3');
  chart.appendChild(marker);
  // The record's extremes, at the top and bottom of the chart they bound.
  const scale = make('div', 'gravity-chart-scale', chartWrap);
  const scaleHigh = make('span', 'gravity-chart-high', scale);
  const scaleLow = make('span', 'gravity-chart-low', scale);
  let geometry = null;
  on(chart, 'click', (event) => {
    const list = state?.solutions || [];
    const box = chart.getBoundingClientRect?.();
    if (!geometry || !box?.width) return;
    const chartX = ((event.clientX - box.left) / box.width) * CHART.width;
    const solution = list[geometry.indexAt(chartX)];
    if (solution)
      params({ month: solution === list.at(-1) ? null : solution.id });
  });

  const display = make('div', 'rail-card-chips gravity-display', root);
  const land = chip(
    display,
    t('Land'),
    t('Hide ocean cells, where the signal is mostly sea level'),
    () => params({ area: 'land' }),
  );
  const all = chip(
    display,
    t('Land + ocean'),
    t('Show every cell, oceans included'),
    () => params({ area: 'all' }),
  );
  const soft = chip(display, t('Soft'), t('Display opacity only'), () =>
    params({ opacity: 'light' }),
  );
  const vivid = chip(display, t('Vivid'), t('Display opacity only'), () =>
    params({ opacity: 'strong' }),
  );

  const legend = make('div', 'gravity-legend', root);
  const ramp = make('div', 'rail-card-ramp gravity-ramp', legend);
  const percent = (cm) => `${(gravityScalePosition(cm) * 100).toFixed(1)}%`;
  ramp.style.background = `linear-gradient(to right, ${GRAVITY_COLORS.map(
    ([value, [r, g, b]]) => `rgb(${r},${g},${b}) ${percent(value)}`,
  ).join(', ')})`;
  // Ticks sit where their values fall: the ±40 cm core is wider than the tails.
  const ticks = make('div', 'gravity-legend-ticks', legend);
  const end = GRAVITY_COLORS.at(-1)[0];
  for (const cm of [-end, -GRAVITY_CORE_CM, 0, GRAVITY_CORE_CM, end]) {
    const tick = make('span', '', ticks, formatGravityTick(cm));
    tick.style.left = percent(cm);
  }
  const legendScale = make('div', 'gravity-legend-scale', legend);
  make('span', '', legendScale, t('Loss, cm'));
  make('span', '', legendScale, t('Gain, cm'));
  make(
    'p',
    'gravity-note',
    root,
    t(
      'Centimetres of equivalent water against the 2004–2009 mean. About 300 km resolution: regional trends, not single wells or glaciers.',
    ),
  );

  const pressed = (node, active) => {
    set(node, 'className', `data-toggle-chip${active ? ' active' : ''}`);
    attr(node, 'aria-pressed', active);
  };

  function renderPoint() {
    const probe = state.probe;
    set(clear, 'hidden', !probe);
    if (!probe) {
      set(pointText, 'textContent', t('Click the map to chart a point'));
      hide(chart, true);
      set(scale, 'hidden', true);
      geometry = null;
      return;
    }
    const value =
      probe.cm === null
        ? t('No data')
        : formatGravityCm(probe.cm) +
          (probe.land === false && state.area === 'land'
            ? ` · ${t('ocean')}`
            : '');
    set(pointText, 'textContent', `${place(probe.lat, probe.lon)} · ${value}`);
    geometry = probe.history
      ? gravityChartGeometry(state.solutions, probe.history, state.shownIndex)
      : null;
    hide(chart, !geometry);
    set(scale, 'hidden', !geometry);
    if (!geometry) {
      if (probe.historyError)
        set(
          pointText,
          'textContent',
          `${pointText.textContent} · ${t(probe.historyError)}`,
        );
      return;
    }
    attr(
      chart,
      'aria-label',
      t('Monthly values at {place}', { place: place(probe.lat, probe.lon) }),
    );
    attr(zero, 'y1', geometry.zero.toFixed(1));
    attr(zero, 'y2', geometry.zero.toFixed(1));
    while (series.children.length > geometry.lines.length)
      series.children[series.children.length - 1].remove();
    geometry.lines.forEach((points, index) => {
      let line = series.children[index];
      if (!line) {
        line = document.createElementNS(SVG, 'polyline');
        series.appendChild(line);
      }
      attr(line, 'points', points);
    });
    set(marker.style, 'display', geometry.marker ? '' : 'none');
    if (geometry.marker) {
      attr(marker, 'cx', geometry.marker.x.toFixed(1));
      attr(marker, 'cy', geometry.marker.y.toFixed(1));
    }
    set(scaleLow, 'textContent', formatGravityCm(geometry.low));
    set(scaleHigh, 'textContent', formatGravityCm(geometry.high));
  }

  function update(nextState) {
    state = nextState;
    const visible = Boolean(state?.enabled);
    set(root, 'hidden', !visible);
    if (panel) set(panel, 'hidden', !visible);
    if (!visible) return;
    if (panel && !appearedDocuments.has(document)) {
      appearedDocuments.add(document);
      // First appearance opens the panel unless a stored or shared collapse
      // choice exists (marked by the panel chrome when it restored the state).
      const preference = panel.dataset?.collapsedPreference;
      if (
        panel.classList.contains('collapsed') &&
        (preference === undefined || preference === 'default')
      )
        panel.querySelector('[data-collapse-target="gravity-panel"]')?.click();
    }
    const list = state.solutions;
    const shown = list[state.shownIndex];
    if (!dragging) {
      set(monthLabel, 'textContent', shown ? gravityMonthLabel(shown.id) : '—');
      set(slider, 'max', String(Math.max(0, list.length - 1)));
      set(slider, 'value', String(Math.max(0, state.shownIndex)));
      attr(slider, 'aria-valuetext', shown ? gravityMonthLabel(shown.id) : '');
    }
    set(
      monthWindow,
      'textContent',
      shown ? `${shown.start} – ${shown.end}` : '',
    );
    set(oldest, 'textContent', list[0]?.start.slice(0, 4) || '');
    set(newest, 'textContent', list.at(-1)?.start.slice(0, 4) || '');
    const empty = list.length === 0 || state.shownIndex < 0;
    set(slider, 'disabled', empty);
    set(previous, 'disabled', empty || state.shownIndex <= 0);
    set(newer, 'disabled', empty || state.shownIndex >= list.length - 1);
    set(latest, 'disabled', empty);
    set(play, 'disabled', empty);
    pressed(latest, state.latest);
    pressed(play, state.playing);
    set(play, 'textContent', state.playing ? t('Pause') : t('Play'));
    set(status, 'textContent', state.status || '');
    pressed(land, state.area === 'land');
    pressed(all, state.area === 'all');
    pressed(soft, state.opacity === 'light');
    pressed(vivid, state.opacity === 'strong');
    renderPoint();
  }

  return {
    update,
    destroy() {
      for (const remove of removers.splice(0)) remove();
      root.remove();
      if (panel) set(panel, 'hidden', true);
    },
  };
}
