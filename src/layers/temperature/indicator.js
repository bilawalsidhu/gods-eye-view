import { monthIndex, monthName } from './dates.js';
import { scaleGradient, scaleTicks } from './scale.js';

const MONTH_INITIALS = [
  'J',
  'F',
  'M',
  'A',
  'M',
  'J',
  'J',
  'A',
  'S',
  'O',
  'N',
  'D',
];

/** Years labelled on the year scale besides the selected one. */
const YEAR_LABEL_EVERY = 5;

/**
 * Where the month playhead sits, in months from January.
 *
 * Moves continuously with the blend between two frames, so it glides across
 * the scale rather than hopping tick to tick.
 * @param {Array<string>} dates Frame time keys, oldest first.
 * @param {number} position Playhead in frames.
 * @returns {number} Months from the start of January, fractional.
 */
export function monthPlayhead(dates, position) {
  const count = dates.length;
  const wrapped = ((position % count) + count) % count;
  const from = Math.floor(wrapped);
  const to = (from + 1) % count;
  const start = monthIndex(dates[from]);
  const span = to > from ? monthIndex(dates[to]) - start : 1;
  return start + (wrapped - from) * span;
}

/**
 * On-map playback panel: the month in large type, a year scale to choose the
 * year, a month scale with a playhead that moves as frames blend, and the one
 * play/pause control the layer has.
 *
 * The month is the one fact a moving heat map cannot convey by itself, so it
 * sits on the map rather than in the layer row. Every year and month is a
 * button: a year loads that year, a month glides to it.
 * @param {{container:HTMLElement, onYear:Function, onMonth:Function, onToggle:Function}} options
 * @returns {{render:Function, hide:Function, destroy:Function}}
 */
export function createMonthIndicator({ container, onYear, onMonth, onToggle }) {
  const document = container.ownerDocument;
  const element = (tag, className) => {
    const node = document.createElement(tag);
    node.className = className;
    return node;
  };

  const root = element('div', 'temperature-timeline');
  root.hidden = true;
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', 'Surface temperature playback');

  const kicker = element('div', 'temperature-timeline-kicker');
  kicker.textContent = 'Land surface temperature · monthly mean';

  const head = element('div', 'temperature-timeline-head');
  const toggle = element('button', 'temperature-timeline-toggle');
  toggle.type = 'button';
  const month = element('div', 'temperature-timeline-month');
  month.setAttribute('aria-live', 'polite');
  const status = element('div', 'temperature-timeline-status');
  head.append(toggle, month, status);

  // NASA's colour scale, as one bar: the key to every frame, placed between
  // the month it describes and the scales that choose it.
  const scale = element('div', 'temperature-timeline-scale');
  scale.title = 'NASA MODIS land surface temperature scale, °C';
  const bar = element('div', 'temperature-timeline-scale-bar');
  bar.style.background = scaleGradient();
  const marker = element('span', 'temperature-timeline-scale-marker');
  marker.hidden = true;
  marker.setAttribute('aria-hidden', 'true');
  const scaleTickRow = element('div', 'temperature-timeline-scale-ticks');
  for (const { label, position } of scaleTicks()) {
    const tick = element('span', 'temperature-timeline-scale-tick');
    tick.textContent = label;
    tick.style.left = `${position * 100}%`;
    scaleTickRow.appendChild(tick);
  }
  const unit = element('span', 'temperature-timeline-scale-unit');
  unit.textContent = '°C';
  scaleTickRow.appendChild(unit);
  bar.appendChild(marker);
  scale.append(bar, scaleTickRow);

  const yearTrack = element('div', 'temperature-timeline-track is-years');
  yearTrack.setAttribute('aria-label', 'Year');
  const monthTrack = element('div', 'temperature-timeline-track is-months');
  monthTrack.setAttribute('aria-label', 'Month');
  const playhead = element('span', 'temperature-timeline-playhead');
  playhead.setAttribute('aria-hidden', 'true');

  const monthTicks = MONTH_INITIALS.map((initial, index) => {
    const tick = element('button', 'temperature-timeline-tick');
    tick.type = 'button';
    tick.dataset.month = String(index);
    tick.textContent = initial;
    monthTrack.appendChild(tick);
    return tick;
  });
  monthTrack.appendChild(playhead);

  root.append(kicker, head, scale, yearTrack, monthTrack);
  container.appendChild(root);

  toggle.addEventListener('click', () => onToggle());
  yearTrack.addEventListener('click', (event) => {
    const tick = event.target?.closest?.('.temperature-timeline-tick');
    if (tick && !tick.disabled) onYear(Number(tick.dataset.year));
  });
  monthTrack.addEventListener('click', (event) => {
    const tick = event.target?.closest?.('.temperature-timeline-tick');
    if (tick && !tick.disabled) onMonth(Number(tick.dataset.month));
  });

  let yearTicks = new Map();
  let yearsKey = '';
  let datesKey = '';
  let shownDate = null;

  function syncYears(years) {
    const key = years.join(',');
    if (key === yearsKey) return;
    yearsKey = key;
    for (const tick of yearTicks.values()) tick.remove();
    yearTicks = new Map(
      years.map((year) => {
        const tick = element('button', 'temperature-timeline-tick');
        tick.type = 'button';
        tick.dataset.year = String(year);
        tick.title = String(year);
        tick.setAttribute('aria-label', String(year));
        // Labels sit five years apart; the newest year gets one only when it
        // is far enough from the last fifth year not to collide with it.
        if (
          year % YEAR_LABEL_EVERY === 0 ||
          (year === years.at(-1) && year % YEAR_LABEL_EVERY >= 3)
        )
          tick.dataset.label = String(year);
        yearTrack.appendChild(tick);
        return [year, tick];
      }),
    );
    root.style.setProperty('--timeline-years', String(years.length));
  }

  function syncMonths(dates) {
    const key = dates.join(',');
    if (key === datesKey) return;
    datesKey = key;
    const published = new Set(dates.map(monthIndex));
    monthTicks.forEach((tick, index) => {
      tick.disabled = !published.has(index);
      tick.title = tick.disabled
        ? 'Not published'
        : monthName(dates.find((date) => monthIndex(date) === index));
    });
  }

  return {
    /**
     * @param {{years:Array<number>, year:?number, loadingYear:?number, dates:Array<string>,
     *   position:number, dominant:number, playing:boolean, error:?string,
     *   reading:?{position:number, color:string}}} view
     */
    render(view) {
      syncYears(view.years);
      for (const [year, tick] of yearTicks) {
        tick.classList.toggle('is-current', year === view.year);
        tick.classList.toggle('is-loading', year === view.loadingYear);
      }
      status.textContent = view.error
        ? view.error
        : view.loadingYear
          ? `Loading ${view.loadingYear}…`
          : '';
      if (view.dates.length) {
        syncMonths(view.dates);
        const date = view.dates[view.dominant];
        monthTicks.forEach((tick, index) =>
          tick.classList.toggle('is-current', index === monthIndex(date)),
        );
        playhead.style.left = `${((monthPlayhead(view.dates, view.position) + 0.5) / 12) * 100}%`;
        if (date !== shownDate) {
          month.textContent = monthName(date);
          // Restart the fade so each new month arrives rather than snaps.
          month.classList.remove('is-changing');
          void month.offsetWidth;
          month.classList.add('is-changing');
          shownDate = date;
        }
      }
      const label = view.playing ? 'Pause' : 'Play';
      if (toggle.title !== label) {
        toggle.title = label;
        toggle.setAttribute('aria-label', label);
        toggle.textContent = view.playing ? '❚❚' : '▶';
      }
      toggle.disabled = view.dates.length < 2;
      // A pinned reading shows where it falls on the scale, in its own colour,
      // and slides along it as the months change.
      marker.hidden = !view.reading;
      if (view.reading) {
        marker.style.left = `${view.reading.position * 100}%`;
        marker.style.background = view.reading.color;
      }
      root.hidden = false;
    },

    hide() {
      root.hidden = true;
    },

    destroy() {
      root.remove();
      yearTicks = new Map();
    },
  };
}
