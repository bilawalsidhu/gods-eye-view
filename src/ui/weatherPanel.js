import { h, render as renderVue } from 'vue';
import { formatUtcDayMonth, t } from '../i18n/index.js';
import { utcClock } from './rail/utcClock.js';
import WeatherReadout from './weather/WeatherReadout.vue';

// Remounting controls must not reopen a panel the user already collapsed.
// Keyed by the page's Weather panel, which outlives remounted controls.
const appearedPanels = new WeakSet();
const openPanels = new WeakMap();
const ORDER = [
  'weather-cyclones',
  'wind',
  'weather-radar',
  'weather-satellite',
  'weather-lightning',
  'air-quality',
];
const OBSERVED = new Set(ORDER.slice(2, 5));
const utc = (time) =>
  Number.isFinite(Date.parse(time))
    ? `${formatUtcDayMonth(time)} ${utcClock(time)}`
    : t('Unavailable');
const clockTime = (time) => utcClock(time) || t('Unavailable');
// Ages are measured from `nowMs`: the world clock's time at a past time, the
// wall clock while live.
const minutesBefore = (time, nowMs = Date.now()) =>
  Math.max(0, Math.floor((nowMs - Date.parse(time)) / 60_000));
const age = (time, nowMs) => {
  const minutes = minutesBefore(time, nowMs);
  return minutes >= 60
    ? t('{hours}h {minutes}m ago', {
        hours: Math.floor(minutes / 60),
        minutes: minutes % 60,
      })
    : t('{minutes}m ago', { minutes });
};
// A frame's time on the timeline: its age while live; at a past time, the
// clock time alone, as the timeline time is the one it is measured from.
const historyTime = (time, state) =>
  state?.mode === 'history'
    ? clockTime(time)
    : t('{time} · {minutes} min ago', {
        time: clockTime(time),
        minutes: minutesBefore(time),
      });
const dated = (time, nowMs) => `${utc(time)} · ${age(time, nowMs)}`;
/** The time the observed products show: the timeline time, or now while live. */
const shownNow = (state) =>
  state?.mode === 'history' && Number.isFinite(Date.parse(state.target))
    ? Date.parse(state.target)
    : Date.now();
const set = (node, key, value) => {
  if (node[key] !== value) node[key] = value;
};

/**
 * Bring a newly opened card into the scrolled body: nearest alignment, or its
 * header at the top when the card is taller than the body. One write to the
 * body's own scroll position, without animation; ancestors never move.
 */
function revealCard(scroller, card) {
  const height = scroller?.clientHeight;
  if (!(height > 0) || !scroller.getBoundingClientRect) return;
  if (typeof card?.getBoundingClientRect !== 'function') return;
  const view = scroller.getBoundingClientRect();
  const box = card.getBoundingClientRect();
  const top = box.top - view.top - (scroller.clientTop || 0);
  const delta =
    top < 0 || box.height > height
      ? top
      : Math.max(0, top + box.height - height);
  if (delta) scroller.scrollTop = (scroller.scrollTop || 0) + delta;
}

/** Map weather descriptors and the observed clock into reusable rail readouts. */
export function createWeatherPanel({
  container,
  clock,
  setLayerParams = () => {},
  onAction = () => {},
} = {}) {
  const document = container?.ownerDocument;
  if (!document?.createElement) return null;
  const panel = container.closest?.('#weather-panel');
  const count = panel?.querySelector('#weather-panel-count');
  let entries = [];
  let destroyed = false;
  const selections = new Map();
  let previousIds = null;
  let hasAppeared = false;
  const page = panel || document;
  let openId = openPanels.get(page) || null;
  // Open card as last shown; null until cards are on screen.
  let shownOpenId = null;
  const handlers = {
    onParams: (id, params) => setLayerParams(id, params, { origin: 'user' }),
    onOpen: (id) => {
      openId = id;
      openPanels.set(page, id);
      render();
    },
  };
  // The readout patches synchronously, so a newly opened card can be measured.
  const paint = (view) =>
    renderVue(h(WeatherReadout, { view, ...handlers }), container);
  paint({
    hidden: true,
    observed: false,
    scope: '',
    frameTime: '',
    cards: [],
    observedCards: [],
  });
  const render = () => {
    if (destroyed) return;
    const state = clock?.getState() || {
      mode: 'latest',
      timeline: [],
      products: [],
    };
    const active = entries
      .filter(({ summary }) => summary)
      .sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));
    const observed = active.filter(({ id }) => OBSERVED.has(id));
    const showObserved = observed.length > 0;
    const names = {
      'weather-radar': t('Rain radar'),
      'weather-satellite': t('Satellite clouds'),
      'weather-lightning': t('Lightning density'),
    };
    // While live, the newest frame and its age; at a past time, the timeline
    // time alone. The world timeline moves the time. Live, each product's
    // newest frame counts, suspended or not (reduced motion, a hidden page),
    // as the timeline leaves those out.
    const newest = () => {
      const times = (state.products ?? [])
        .map(({ selected }) => selected)
        .filter((time) => Number.isFinite(Date.parse(time)))
        .sort((a, b) => Date.parse(a) - Date.parse(b));
      return times.at(-1) ?? state.timeline.at(-1);
    };
    const shownTime = state.mode === 'latest' ? newest() : state.target;
    const frameTime =
      showObserved && shownTime
        ? state.mode === 'history'
          ? clockTime(shownTime)
          : historyTime(shownTime)
        : '';
    const models = active.map((entry) => {
      const { id, icon, summary, legend = [], list, sublists = [] } = entry;
      // Discrete classes (storm geometry) list swatches, not a ramp.
      const categorical = entry.legendCategorical === true;
      let detail = summary.detail;
      const product = state.products.find((item) => item.id === id);
      if (OBSERVED.has(id)) {
        const shown = product?.shown ?? summary.shownTime;
        if (state.mode === 'history' && product?.selected === null) {
          const gap = summary.maxGapMinutes || 30;
          const time = clockTime(state.target);
          detail =
            gap < 60
              ? t('No frame within {gap} min of {time}', { gap, time })
              : t('No frame within {gap} h of {time}', { gap: gap / 60, time });
        } else if (shown) {
          detail = dated(shown, shownNow(state));
          if (state.mode === 'history')
            detail =
              Date.parse(shown) === Date.parse(state.target)
                ? t('{detail} · synced', { detail })
                : t('{detail} · nearest', { detail });
        }
      } else if (id === 'wind') {
        detail = t('Forecast · valid {valid} · issued {issued}', {
          valid: utc(summary.validTime),
          issued: utc(summary.issuedTime),
        });
        // Unless its source follows the timeline, wind stays at the live edge.
        if (state.mode === 'history' && !clock?.follows?.(id))
          detail = t('{detail} · Does not follow history', { detail });
      }
      const lines = [
        { id: 'time', text: detail, muted: true },
        { id: 'status', text: summary.status },
      ];
      for (const line of summary.lines || []) lines.push(line);
      const actions = (summary.actions || []).map((action) => ({
        ...action,
        onClick: action.onClick || (() => onAction(id, action.id)),
      }));
      const legendBlock = {
        id: 'legend',
        type: 'legend',
        legend: {
          categorical,
          colors: legend.map(({ color }) => color),
          labels: legend.map(({ label }) => label),
          units: categorical ? '' : summary.units,
          ...(summary.unitsVerbatim === true ? { unitsVerbatim: true } : {}),
          zeroIndex: legend.findIndex(({ label }) => label === '0'),
        },
      };
      // A titled list says what it ranks in a muted line above it.
      const listBlocks = list?.items?.length
        ? [
            ...(list.title
              ? [
                  {
                    id: 'list-title',
                    type: 'lines',
                    lines: [
                      { id: 'list-title', text: list.title, muted: true },
                    ],
                  },
                ]
              : []),
            { id: 'list', type: 'list', list },
          ]
        : [];
      // Groups of Globe-view tiles (each a choice with its value), and
      // switches, each one row.
      const tileBlocks = sublists
        .filter((group) => group?.tiles?.length)
        .map((group) => ({
          id: `tiles-${group.id}`,
          type: 'tiles',
          title: group.title,
          subtitle: group.subtitle,
          tiles: group.tiles,
        }));
      const toggleBlocks = (summary.toggles || []).map((toggle) => ({
        ...toggle,
        id: `toggle-${toggle.id}`,
        type: 'toggle',
      }));
      // A result marked `lead` (a selected station) heads the card.
      const lead = summary.result?.lead === true;
      const resultBlocks = summary.result
        ? [{ ...summary.result, type: 'result' }]
        : [];
      const blocks = [
        ...(lead ? resultBlocks : []),
        // A card with tiles reads top down: what it shows, its scale, the
        // tiles, then what stands out in view.
        ...(tileBlocks.length ? [] : listBlocks),
        { id: 'details', type: 'lines', lines },
        ...toggleBlocks,
        ...(legend.length ? [legendBlock] : []),
        ...tileBlocks,
        ...(tileBlocks.length ? listBlocks : []),
        ...(summary.settings?.length
          ? [{ id: 'settings', type: 'settings', settings: summary.settings }]
          : []),
        ...(actions.length
          ? [{ id: 'actions', type: 'actions', actions }]
          : []),
        ...(lead ? [] : resultBlocks),
      ];
      return {
        id,
        icon,
        title: summary.label,
        badge: summary.coverage,
        open: id === openId,
        compact:
          summary.status ||
          summary.compact ||
          (id === 'wind'
            ? t('Forecast · valid {valid}', { valid: utc(summary.validTime) })
            : detail),
        compactStatus: Boolean(summary.status),
        blocks,
      };
    });
    const hidden = active.length === 0;
    paint({
      hidden,
      observed: showObserved,
      scope: observed.map(({ id }) => names[id]).join(' · '),
      frameTime,
      cards: models.filter(({ id }) => !OBSERVED.has(id)),
      observedCards: models.filter(({ id }) => OBSERVED.has(id)),
    });
    // Only a change of open card moves the scroll position; refreshes leave it.
    if (shownOpenId !== null && openId !== shownOpenId) {
      const open = [
        ...container.querySelectorAll('.weather-cards > [data-card-id]'),
      ].find((node) => node.dataset.cardId === openId);
      revealCard(container, open);
    }
    shownOpenId = active.length ? openId : null;
    if (count) set(count, 'textContent', String(active.length));
    if (panel) set(panel, 'hidden', hidden);
    if (!hidden && panel && !appearedPanels.has(panel)) {
      appearedPanels.add(panel);
      // First appearance opens the panel unless a stored or shared collapse
      // choice exists (marked by the panel chrome when it restored the state).
      const preference = panel.dataset?.collapsedPreference;
      if (
        panel.classList.contains('collapsed') &&
        (preference === undefined || preference === 'default')
      )
        panel.querySelector('[data-collapse-target="weather-panel"]')?.click();
    }
  };
  const unsubscribe = clock?.subscribe(render);
  return {
    update(nextEntries) {
      entries = nextEntries.filter(({ summary }) => summary);
      const ids = new Set(entries.map(({ id }) => id));
      const ordered = [...entries].sort(
        (a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id),
      );
      const added =
        previousIds && entries.filter(({ id }) => !previousIds.has(id));
      if (hasAppeared && added?.length) {
        openId = added.at(-1).id;
        openPanels.set(page, openId);
      } else if (ids.size && !ids.has(openId)) {
        openId =
          (!hasAppeared &&
            !openId &&
            ordered.find(
              ({ id, list }) =>
                id === 'weather-cyclones' && list?.items?.length,
            )?.id) ||
          ordered[0]?.id ||
          null;
      }
      // A new selection on the map (a lead result) opens its card, even over
      // another open one; refreshes of the same selection leave the open card.
      for (const id of selections.keys())
        if (!ids.has(id)) selections.delete(id);
      for (const { id, summary } of entries) {
        const result = summary.result?.lead === true ? summary.result : null;
        const key = result ? String(result.key ?? result.label ?? '') : null;
        if (key !== null && key !== (selections.get(id) ?? null)) {
          openId = id;
          openPanels.set(page, id);
        }
        selections.set(id, key);
      }
      if (ids.size) hasAppeared = true;
      previousIds = ids;
      render();
    },
    destroy() {
      destroyed = true;
      unsubscribe?.();
      renderVue(null, container);
      if (panel) set(panel, 'hidden', true);
      if (count) set(count, 'textContent', '0');
    },
  };
}
