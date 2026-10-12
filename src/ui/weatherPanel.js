import { createRailCards } from './railCards.js';
import { createRailTimeline } from './railTimeline.js';
import { subscribeLocale, t } from '../i18n/index.js';

// Remounting controls must not reopen a panel the user already collapsed.
const appearedDocuments = new WeakSet();
const openDocuments = new WeakMap();
const ORDER = [
  'weather-cyclones',
  'wind',
  'weather-radar',
  'weather-satellite',
  'weather-lightning',
];
const OBSERVED = new Set(ORDER.slice(2));
const utc = (time) =>
  Number.isFinite(Date.parse(time))
    ? `${new Date(time).toISOString().slice(5, 16).replace('T', ' ')} UTC`
    : t('common.unavailable');
const age = (time) => {
  const minutes = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(time)) / 60_000),
  );
  return minutes >= 60
    ? t('weather.age.hoursMinutes', {
        h: Math.floor(minutes / 60),
        m: minutes % 60,
      })
    : t('weather.age.minutes', { m: minutes });
};
const historyTime = (time) =>
  t('weather.historyAgo', {
    time: utc(time).slice(6),
    minutes: Math.max(0, Math.floor((Date.now() - Date.parse(time)) / 60_000)),
  });
const dated = (time) => `${utc(time)} · ${age(time)}`;
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
  const root = document.createElement('section');
  root.className = 'weather-readout';
  root.hidden = true;
  root.setAttribute('aria-label', t('weather.aria.active'));
  const timelineHost = document.createElement('div');
  timelineHost.className = 'weather-timeline-block';
  timelineHost.hidden = true;
  const cardsHost = document.createElement('div');
  cardsHost.className = 'weather-cards';
  const observedGroup = document.createElement('section');
  observedGroup.className = 'weather-observed-group';
  observedGroup.setAttribute('aria-label', t('weather.observedHistory'));
  const heading = document.createElement('h3');
  heading.className = 'panel-title';
  heading.textContent = t('weather.observedHistory');
  const scope = document.createElement('div');
  scope.className = 'weather-observed-scope';
  const observedCardsHost = document.createElement('div');
  observedCardsHost.className = 'weather-cards';
  observedGroup.append(heading, scope, timelineHost, observedCardsHost);
  root.append(cardsHost, observedGroup);
  container.appendChild(root);
  const panel = container.closest?.('#weather-panel');
  const count = panel?.querySelector('#weather-panel-count');
  let entries = [];
  let destroyed = false;
  let previousIds = null;
  let hasAppeared = false;
  let openId = openDocuments.get(document) || null;
  // Open card as last shown; null until cards are on screen.
  let shownOpenId = null;
  const timeline = createRailTimeline({
    container: timelineHost,
    document,
    sliderClassName: 'weather-timeline',
    heading: false,
    onCommit: (tick) => clock?.setTarget(tick),
    onPreview: historyTime,
    onStep: (direction) => clock?.step(direction),
    onLatest: () => clock?.latest(),
    onPlay: () => clock?.togglePlay(),
  });
  const cardOptions = {
    document,
    cardClassName: 'weather-card',
    badgeClassName: 'weather-coverage',
    onParams: (id, params) => setLayerParams(id, params, { origin: 'user' }),
    onOpen: (id) => {
      openId = id;
      openDocuments.set(document, id);
      render();
    },
  };
  const cards = createRailCards({ ...cardOptions, container: cardsHost });
  const observedCards = createRailCards({
    ...cardOptions,
    container: observedCardsHost,
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
    const showTimeline = observed.length > 0;
    set(observedGroup, 'hidden', !showTimeline);
    const names = {
      'weather-radar': t('weather.products.radar'),
      'weather-satellite': t('weather.products.satellite'),
      'weather-lightning': t('weather.products.lightning'),
    };
    set(scope, 'textContent', observed.map(({ id }) => names[id]).join(' · '));
    set(timelineHost, 'hidden', !showTimeline);
    const index =
      state.mode === 'latest'
        ? state.timeline.length - 1
        : Math.max(
            0,
            state.timeline.findLastIndex(
              (tick) => Date.parse(tick) <= Date.parse(state.target),
            ),
          );
    timeline.update({
      ticks: state.timeline,
      index,
      mode: state.mode,
      playing: Boolean(state.playing),
      disabled: !showTimeline || state.timeline.length < 2,
      readout:
        state.mode === 'latest'
          ? t('weather.readout.latest')
          : historyTime(state.target),
    });
    const models = active.map(({ id, icon, summary, legend = [], list }) => {
      let detail = summary.detail;
      const product = state.products.find((item) => item.id === id);
      if (OBSERVED.has(id)) {
        const shown = product?.shown ?? summary.shownTime;
        if (state.mode === 'history' && product?.selected === null) {
          const gap = summary.maxGapMinutes || 30;
          const gapText =
            gap < 60
              ? t('weather.gap.minutes', { gap })
              : t('weather.gap.hours', { gap: gap / 60 });
          detail = t('weather.noFrame', {
            gap: gapText,
            time: utc(state.target).slice(6),
          });
        } else if (shown) {
          detail = dated(shown);
          if (state.mode === 'history')
            detail +=
              Date.parse(shown) === Date.parse(state.target)
                ? t('weather.synced')
                : t('weather.nearest');
        }
      } else if (id === 'wind') {
        detail = t('weather.forecast.validIssued', {
          valid: utc(summary.validTime),
          issued: utc(summary.issuedTime),
        });
        if (state.mode === 'history')
          detail += t('weather.notFollowingHistory');
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
          categorical: id === 'weather-cyclones',
          colors: legend.map(({ color }) => color),
          labels: legend.map(({ label }) => label),
          units: id === 'weather-cyclones' ? '' : summary.units,
          zeroIndex: legend.findIndex(({ label }) => label === '0'),
        },
      };
      const blocks = [
        ...(id === 'weather-cyclones' && list?.items?.length
          ? [{ id: 'storms', type: 'list', list }]
          : []),
        { id: 'details', type: 'lines', lines },
        ...(legend.length ? [legendBlock] : []),
        ...(summary.settings?.length
          ? [{ id: 'settings', type: 'settings', settings: summary.settings }]
          : []),
        ...(actions.length
          ? [{ id: 'actions', type: 'actions', actions }]
          : []),
        ...(summary.result ? [{ ...summary.result, type: 'result' }] : []),
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
            ? t('weather.forecast.valid', { time: utc(summary.validTime) })
            : detail),
        compactStatus: Boolean(summary.status),
        blocks,
      };
    });
    cards.update(models.filter(({ id }) => !OBSERVED.has(id)));
    observedCards.update(models.filter(({ id }) => OBSERVED.has(id)));
    // Only a change of open card moves the scroll position; refreshes leave it.
    if (shownOpenId !== null && openId !== shownOpenId) {
      const open = [...cardsHost.children, ...observedCardsHost.children].find(
        (node) => node.dataset?.cardId === openId,
      );
      revealCard(container, open);
    }
    shownOpenId = active.length ? openId : null;
    const hidden = active.length === 0;
    set(root, 'hidden', hidden);
    if (count) set(count, 'textContent', String(active.length));
    if (panel) set(panel, 'hidden', hidden);
    if (!hidden && panel && !appearedDocuments.has(document)) {
      appearedDocuments.add(document);
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
  // Labels are resolved at render time; repaint the current state on a switch.
  const unsubscribeLocale = subscribeLocale(() => render());
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
        openDocuments.set(document, openId);
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
      if (ids.size) hasAppeared = true;
      previousIds = ids;
      render();
    },
    destroy() {
      destroyed = true;
      unsubscribe?.();
      unsubscribeLocale?.();
      timeline.destroy();
      cards.destroy();
      observedCards.destroy();
      root.remove();
      if (panel) set(panel, 'hidden', true);
      if (count) set(count, 'textContent', '0');
    },
  };
}
