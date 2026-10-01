import {
  TIDE_WINDOW_AFTER_MS,
  TIDE_WINDOW_BEFORE_MS,
  formatFeet,
  formatSignedMetres,
  formatStationTime,
} from './model.js';
import { TIDE_STATIONS } from './stations.js';

const HOUR = 3600_000;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * The tide control card: readout, time scrubber, playback and the two
 * adjustment sliders. It only reports intent through `handlers`; the layer
 * owns the state and calls `render(view)` with what to show.
 */
export function createTidePanel({ handlers, parent = document.body }) {
  const root = el('section', 'tides-card');
  root.setAttribute('aria-label', 'Coastal tides');
  root.hidden = true;

  const head = el('div', 'tides-card__head');
  const title = el('div', 'tides-card__title', 'Tides');
  const station = el('div', 'tides-card__station', '');
  head.append(title, station);

  const readout = el('div', 'tides-card__readout');
  const level = el('div', 'tides-card__level', '—');
  const trend = el('div', 'tides-card__trend', '');
  readout.append(level, trend);

  const when = el('div', 'tides-card__when');
  const whenText = el('span', 'tides-card__time', '');
  const live = el('button', 'tides-card__btn', 'Live');
  live.type = 'button';
  const play = el('button', 'tides-card__btn', 'Play');
  play.type = 'button';
  when.append(whenText, live, play);

  const scrub = el('input', 'tides-card__scrub');
  scrub.type = 'range';
  scrub.id = 'tides-scrub';
  scrub.min = String(-TIDE_WINDOW_BEFORE_MS / HOUR);
  scrub.max = String(TIDE_WINDOW_AFTER_MS / HOUR);
  scrub.step = '0.25';
  scrub.value = '0';
  scrub.setAttribute('aria-label', 'Hours from now');
  const scale = el('div', 'tides-card__scale');
  scale.append(
    el('span', '', `−${TIDE_WINDOW_BEFORE_MS / HOUR}h`),
    el('span', '', 'now'),
    el('span', '', `+${TIDE_WINDOW_AFTER_MS / HOUR}h`),
  );

  function slider(id, label, min, max, step) {
    const wrap = el('label', 'tides-card__ctl');
    wrap.htmlFor = id;
    const row = el('span', 'tides-card__ctl-row');
    const name = el('span', '', label);
    const value = el('span', 'tides-card__ctl-value', '');
    row.append(name, value);
    const input = el('input');
    input.type = 'range';
    input.id = id;
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = '0';
    wrap.append(row, input);
    return { wrap, input, value };
  }
  const extra = slider('tides-extra', 'Waves / surge', 0, 3, 0.1);
  const calibration = slider('tides-calibration', 'Calibrate', -2, 2, 0.05);

  const stationRow = el('label', 'tides-card__ctl');
  stationRow.htmlFor = 'tides-station';
  stationRow.append(el('span', 'tides-card__ctl-row', 'Go to station'));
  const select = el('select', 'tides-card__select');
  select.id = 'tides-station';
  select.append(el('option', '', 'Choose…'));
  select.options[0].value = '';
  for (const s of TIDE_STATIONS) {
    const option = el('option', '', s.name);
    option.value = s.id;
    select.append(option);
  }
  stationRow.append(select);

  const status = el('div', 'tides-card__status', '');
  status.setAttribute('role', 'status');

  root.append(
    head,
    readout,
    when,
    scrub,
    scale,
    extra.wrap,
    calibration.wrap,
    stationRow,
    status,
  );
  parent.append(root);

  scrub.addEventListener('input', () =>
    handlers.onScrub(Number(scrub.value) * HOUR),
  );
  live.addEventListener('click', () => handlers.onLive());
  play.addEventListener('click', () => handlers.onTogglePlay());
  extra.input.addEventListener('input', () =>
    handlers.onExtra(Number(extra.input.value)),
  );
  calibration.input.addEventListener('input', () =>
    handlers.onCalibration(Number(calibration.input.value)),
  );
  select.addEventListener('change', () => {
    if (select.value) handlers.onGoToStation(select.value);
    select.value = '';
  });

  return {
    setVisible(visible) {
      root.hidden = !visible;
    },
    /**
     * @param {object} view
     * @param {object|null} view.station
     * @param {number|null} view.tideM
     * @param {{rising: boolean, next: object}|null} view.trend
     * @param {number} view.timeMs
     * @param {number} view.offsetMs time from now
     * @param {'live'|'paused'|'playing'} view.mode
     * @param {number} view.extraM
     * @param {number} view.calibrationM
     * @param {string} view.status
     */
    render(view) {
      const zone = view.station?.timeZone ?? 'America/Los_Angeles';
      station.textContent = view.station
        ? `${view.station.name} · NOAA ${view.station.id}`
        : 'No station in view';
      level.textContent = Number.isFinite(view.tideM)
        ? `${formatFeet(view.tideM)} MLLW`
        : '—';
      trend.textContent = view.trend
        ? `${view.trend.rising ? 'Rising' : 'Falling'} · ${
            view.trend.next.type === 'H' ? 'High' : 'Low'
          } ${formatFeet(view.trend.next.height)} at ${formatStationTime(
            view.trend.next.timeMs,
            zone,
          )}`
        : '';
      whenText.textContent = formatStationTime(view.timeMs, zone);
      live.setAttribute('aria-pressed', String(view.mode === 'live'));
      play.textContent = view.mode === 'playing' ? 'Pause' : 'Play';
      if (document.activeElement !== scrub)
        scrub.value = String(Math.round((view.offsetMs / HOUR) * 4) / 4);
      extra.input.value = String(view.extraM);
      extra.value.textContent = formatSignedMetres(view.extraM);
      calibration.input.value = String(view.calibrationM);
      calibration.value.textContent = formatSignedMetres(view.calibrationM);
      status.textContent = view.status;
    },
    destroy() {
      root.remove();
    },
  };
}
