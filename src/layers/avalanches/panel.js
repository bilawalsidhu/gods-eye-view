import { dayInitial, dayLabel, seasonLabel } from './dates.js';
import { DANGER_LEVELS, PATH_COLOR } from './policy.js';

/**
 * On-map avalanche panel.
 *
 * The window is ten days long and both halves matter — what has happened and
 * what is forecast — so the panel says which one is on screen in words, not
 * just by position: the day in large type, an "observed" or "forecast" badge,
 * and a day scale whose forecast days are drawn differently. Off-season it
 * explains why the map is empty and offers last season instead; in replay it
 * shows that season as a bar per week, tallest where avalanches were most
 * often reported, and any week can be opened.
 *
 * The panel can be minimized to a pill — play/pause, the day and its
 * observed/forecast badge — so it stops covering the map while playback runs.
 * The choice holds for the session, across replays and layer toggles.
 * @param {{container:HTMLElement, onDay:Function, onToggle:Function,
 *   onReplay:Function, onWeek:Function, onLive:Function}} options
 * @returns {{render:Function, hide:Function, destroy:Function,
 *   setCollapsed:Function, isCollapsed:Function}}
 */
export function createAvalanchePanel({
  container,
  onDay,
  onToggle,
  onReplay,
  onWeek,
  onLive,
}) {
  const document = container.ownerDocument;
  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const button = (className, text) => {
    const node = element('button', className, text);
    node.type = 'button';
    return node;
  };

  const root = element('div', 'avalanche-panel');
  root.hidden = true;
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', 'Avalanche timeline');

  const kicker = element('div', 'avalanche-panel-kicker');
  const kickerText = element('span', '', 'Avalanches · Norway · Switzerland');
  const mode = element('span', 'avalanche-panel-mode');
  kicker.append(kickerText, mode);

  const head = element('div', 'avalanche-panel-head');
  const toggle = button('avalanche-panel-toggle');
  const titles = element('div', 'avalanche-panel-titles');
  const day = element('div', 'avalanche-panel-day');
  day.setAttribute('aria-live', 'polite');
  const sub = element('div', 'avalanche-panel-sub');
  const badge = element('span', 'avalanche-panel-badge');
  const count = element('span', 'avalanche-panel-count');
  sub.append(badge, count);
  titles.append(day, sub);
  const collapse = button('avalanche-panel-collapse');
  head.append(toggle, titles, collapse);

  const dayTrack = element('div', 'avalanche-panel-track is-days');
  dayTrack.setAttribute('aria-label', 'Day');
  const playhead = element('span', 'avalanche-panel-playhead');
  playhead.setAttribute('aria-hidden', 'true');
  dayTrack.appendChild(playhead);

  const legend = element('div', 'avalanche-panel-legend');
  for (const entry of DANGER_LEVELS.filter((level) => level.color)) {
    const item = element('span', 'avalanche-panel-legend-item');
    item.title = `${entry.level} ${entry.label}`;
    const swatch = element('span', 'avalanche-panel-swatch');
    swatch.style.background = entry.color;
    item.append(swatch, element('span', '', String(entry.level)));
    legend.appendChild(item);
  }
  const pathKey = element('span', 'avalanche-panel-legend-item is-path');
  const pathSwatch = element('span', 'avalanche-panel-path');
  pathSwatch.style.background = PATH_COLOR;
  pathKey.append(pathSwatch, element('span', '', 'observed avalanche'));
  legend.appendChild(pathKey);

  const notice = element('div', 'avalanche-panel-notice');
  const noticeText = element('div', 'avalanche-panel-notice-text');
  const replay = button('avalanche-panel-action');
  notice.append(noticeText, replay);

  const seasonBlock = element('div', 'avalanche-panel-season');
  const seasonHead = element('div', 'avalanche-panel-season-head');
  const seasonTitle = element('span', '');
  const live = button('avalanche-panel-action is-quiet', 'Back to live');
  seasonHead.append(seasonTitle, live);
  const weekTrack = element('div', 'avalanche-panel-track is-weeks');
  weekTrack.setAttribute('aria-label', 'Week of the season');
  seasonBlock.append(seasonHead, weekTrack);

  root.append(kicker, head, dayTrack, legend, notice, seasonBlock);
  container.appendChild(root);

  let collapsed = false;
  function applyCollapsed() {
    root.classList.toggle('is-collapsed', collapsed);
    const label = collapsed ? 'Expand timeline' : 'Minimize timeline';
    collapse.title = label;
    collapse.setAttribute('aria-label', label);
    collapse.setAttribute('aria-expanded', String(!collapsed));
  }
  applyCollapsed();

  toggle.addEventListener('click', () => onToggle());
  collapse.addEventListener('click', () => {
    collapsed = !collapsed;
    applyCollapsed();
  });
  replay.addEventListener('click', () => onReplay());
  live.addEventListener('click', () => onLive());
  dayTrack.addEventListener('click', (event) => {
    const tick = event.target?.closest?.('.avalanche-panel-tick');
    if (tick) onDay(Number(tick.dataset.day));
  });
  weekTrack.addEventListener('click', (event) => {
    const bar = event.target?.closest?.('.avalanche-panel-week');
    if (bar && !bar.disabled) onWeek(bar.dataset.from, bar.dataset.to);
  });

  let daysKey = '';
  let weeksKey = '';
  let dayTicks = [];
  let weekBars = [];
  let shownDay = null;

  function syncDays(days, anchor) {
    const key = days.map((entry) => entry.date).join(',');
    if (key === daysKey) return;
    daysKey = key;
    for (const tick of dayTicks) tick.remove();
    dayTicks = days.map((entry, index) => {
      const tick = button('avalanche-panel-tick');
      tick.dataset.day = String(index);
      tick.title = `${dayLabel(entry.date)}${entry.forecast ? ' · forecast' : ''}`;
      tick.classList.toggle('is-forecast', entry.forecast);
      tick.classList.toggle('is-anchor', entry.date === anchor);
      const initial = element(
        'span',
        'avalanche-panel-tick-day',
        dayInitial(entry.date),
      );
      const date = element(
        'span',
        'avalanche-panel-tick-date',
        String(Number(entry.date.slice(8))),
      );
      tick.append(initial, date);
      dayTrack.insertBefore(tick, playhead);
      return tick;
    });
    root.style.setProperty('--avalanche-days', String(days.length));
  }

  function syncWeeks(season, from) {
    const key = `${season?.season}:${(season?.weeks ?? []).map((w) => w.count).join(',')}`;
    if (key !== weeksKey) {
      weeksKey = key;
      for (const bar of weekBars) bar.remove();
      const weeks = season?.weeks ?? [];
      const peak = Math.max(1, ...weeks.map((week) => week.count));
      weekBars = weeks.map((week) => {
        const bar = button('avalanche-panel-week');
        bar.dataset.from = week.from;
        bar.dataset.to = week.to;
        bar.title = `${dayLabel(week.from)} – ${dayLabel(week.to)}: ${week.count} avalanche observations`;
        bar.disabled = week.count === 0;
        const fill = element('span', 'avalanche-panel-week-fill');
        fill.style.height = `${Math.max(6, (week.count / peak) * 100)}%`;
        bar.appendChild(fill);
        weekTrack.appendChild(bar);
        return bar;
      });
      root.style.setProperty('--avalanche-weeks', String(weeks.length));
    }
    for (const bar of weekBars)
      bar.classList.toggle('is-current', bar.dataset.from === from);
  }

  return {
    /**
     * @param {{days:Array<object>, anchor:string, position:number, current:number,
     *   playing:boolean, mode:string, season:?object, seasonNumber:?number,
     *   weekFrom:?string, quiet:boolean, loading:boolean, error:?string,
     *   visibleCount:number}} view
     */
    render(view) {
      root.hidden = false;
      mode.textContent =
        view.mode === 'replay' && view.seasonNumber
          ? `Replay ${seasonLabel(view.seasonNumber)}`
          : 'Live';
      mode.classList.toggle('is-replay', view.mode === 'replay');

      if (view.days.length) {
        syncDays(view.days, view.anchor);
        const current = view.days[view.current];
        dayTicks.forEach((tick, index) =>
          tick.classList.toggle('is-current', index === view.current),
        );
        const last = view.days.length;
        playhead.style.left = `${(Math.min(last, Math.max(0, view.position)) / last) * 100}%`;
        if (current.date !== shownDay) {
          day.textContent = dayLabel(current.date);
          day.classList.remove('is-changing');
          void day.offsetWidth;
          day.classList.add('is-changing');
          shownDay = current.date;
        }
        badge.textContent = current.forecast ? 'Forecast' : 'Observed';
        badge.classList.toggle('is-forecast', current.forecast);
        count.textContent = view.loading
          ? 'Loading…'
          : view.error
            ? view.error
            : `${view.visibleCount} avalanche${view.visibleCount === 1 ? '' : 's'} so far`;
      }

      const label = view.playing ? 'Pause' : 'Play';
      if (toggle.title !== label) {
        toggle.title = label;
        toggle.setAttribute('aria-label', label);
        toggle.textContent = view.playing ? '❚❚' : '▶';
      }

      notice.hidden = !(view.quiet && view.mode === 'live');
      if (!notice.hidden) {
        noticeText.textContent =
          'Out of season — daily avalanche forecasts resume in winter, and few avalanches are reported now.';
        replay.textContent = view.seasonNumber
          ? `Replay ${seasonLabel(view.seasonNumber)}`
          : 'Replay last season';
        replay.disabled = view.loading;
      }

      seasonBlock.hidden = view.mode !== 'replay';
      if (!seasonBlock.hidden) {
        seasonTitle.textContent = view.season
          ? `Season ${seasonLabel(view.season.season)} · avalanches reported in Norway per week`
          : 'Loading season…';
        syncWeeks(view.season, view.weekFrom);
      }
    },

    hide() {
      root.hidden = true;
    },

    /** @param {boolean} next Whether the panel shows as a minimized pill. */
    setCollapsed(next) {
      collapsed = Boolean(next);
      applyCollapsed();
    },

    isCollapsed: () => collapsed,

    destroy() {
      root.remove();
      dayTicks = [];
      weekBars = [];
    },
  };
}
