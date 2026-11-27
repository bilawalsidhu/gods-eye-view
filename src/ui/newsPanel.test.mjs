import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { nextTick } from 'vue';
import { setLocale } from '../i18n/index.js';
import { resetListCardMemory } from './kit/ContextListCard.vue';
import { createNewsPanel } from './newsPanel.js';
import { installFakeResizeObserver } from '../testSupport/fakeResizeObserver.mjs';
import { flushPanelContent } from './rail/panelContent.js';
import {
  resetContextLists,
  setContextListPresence,
  showContextList,
} from './contextLists.js';
import {
  NEWS_CATEGORIES,
  NEWS_SEVERITY,
  categoryLabel,
  feedCardView,
  normalizeFilters,
} from '../layers/news/model.js';

const NOW = Date.parse('2026-10-28T10:00:00Z');
const report = (id, extra = {}) => ({
  id,
  title: `Report ${id}`,
  url: `https://www.example.com/${id}`,
  publishedAt: '2026-10-28T09:00:00.000Z',
  publisher: 'Example',
  side: 'UA',
  category: 'strike',
  severity: 2,
  geo: { lat: 50, lon: 36, place: 'Kharkiv', mappable: true },
  pins: [{ lat: 50, lon: 36, place: 'Kharkiv', mappable: true }],
  event: null,
  media: [],
  ...extra,
});
const big = report('big', {
  severity: 3,
  titleEn: 'Strike on Kharkiv',
  title: 'Удар по Харкову',
  media: ['video'],
  event: {
    size: 4,
    severity: 3,
    status: 'both-sides',
    lastAt: '2026-10-28T09:50:00.000Z',
    sides: [
      {
        side: 'UA',
        title: 'a',
        url: 'https://a.test/',
        publisher: 'A',
        publishedAt: '2026-10-28T09:00:00.000Z',
      },
      {
        side: 'RU',
        title: 'b',
        url: 'https://b.test/',
        publisher: 'B',
        publishedAt: '2026-10-28T09:40:00.000Z',
      },
    ],
    image: { url: 'https://a.test/p.jpg', publisher: 'A' },
  },
});

function view(extra = {}) {
  return {
    filters: normalizeFilters(),
    hotspots: [
      { id: 'all', label: 'All', count: 7, active: true },
      { id: 'ua-ru-war', label: 'Ukraine–Russia', count: 7, active: false },
    ],
    categories: Object.keys(NEWS_CATEGORIES).map((id) => ({
      value: id,
      label: categoryLabel(id),
    })),
    severities: NEWS_SEVERITY.map((level, index) => ({
      value: index,
      label: level.label,
      color: level.color,
    })),
    items: [feedCardView(big, NOW), feedCardView(report('lone'), NOW)],
    mapCount: 5,
    inView: { active: false, loading: false, error: null, items: [] },
    selected: null,
    hasMore: true,
    windowHours: 24,
    loading: false,
    error: null,
    ...extra,
  };
}

function fixture() {
  // News's list in Context: a body the readout renders into, and the list's
  // presence (whether its tab shows, and its count) reported as it goes.
  document.body.innerHTML = `
    <aside id="global-context-panel" data-panel-id="global-context-panel">
      <div id="context-list-news">
        <div id="news-panel-body"></div>
      </div>
    </aside>`;
  const panel = document.getElementById('context-list-news');
  const reports = [];
  const calls = [];
  const news = createNewsPanel({
    container: document.getElementById('news-panel-body'),
    setLayerParams: (id, params, options) => calls.push([id, params, options]),
    onPresence: (state) => reports.push(state),
  });
  return { news, panel, calls, presence: () => reports.at(-1) };
}

const countOf = (presence) => String(presence()?.count);

test('the list shows the last 24 h as event cards, with its tab only while News is on', () => {
  const { news, panel, presence } = fixture();
  news.update(null);
  assert.equal(presence(), null);
  news.update(view());
  assert.notEqual(presence(), null);
  // The tab counts the reports on the map, as Context's News tile does, not
  // the feed's loaded cards.
  assert.equal(countOf(presence), '5');
  assert.equal(
    panel.querySelector('.news-readout__chosen').textContent,
    'Last 24 h · Significant and above · All categories',
  );
  assert.deepEqual(
    [...panel.querySelectorAll('.news-readout__chips [data-chip-id]')].map(
      (chip) => chip.textContent,
    ),
    ['All 7', 'Ukraine–Russia 7'],
  );
  const [first, second] = panel.querySelectorAll(
    '[data-list-card="news"] .news-card',
  );
  assert.equal(
    first.querySelector('.news-card__title').textContent,
    'Strike on Kharkiv',
  );
  assert.equal(
    first.querySelector('.news-card__note').textContent,
    'English headline by the model',
  );
  assert.equal(
    first.querySelector('.news-card__meta').textContent,
    'Major · Strike · Kharkiv · 4 sources · 10 min',
  );
  assert.equal(
    first.querySelector('.news-card__marker').getAttribute('aria-label'),
    'Major',
  );
  assert.equal(
    first.querySelector('.news-card__sides').textContent,
    'Reported by UA sources · RU sources',
  );
  assert.deepEqual(
    [...first.querySelectorAll('.news-chip')].map((c) => c.textContent),
    ['Reported by both sides', 'Video'],
  );
  const img = first.querySelector('.news-card__thumb img');
  assert.equal(img.getAttribute('src'), 'https://a.test/p.jpg');
  assert.equal(img.getAttribute('referrerpolicy'), 'no-referrer');
  assert.equal(first.querySelector('.news-card__credit').textContent, 'A');
  // A lone report has no picture.
  assert.equal(second.querySelector('.news-card__thumb') === null, true);
  news.destroy();
  assert.equal(presence(), null, 'its tab goes with it');
});

test('a feed body that is not displayed is not repainted, and repaints once, current, when it is', () => {
  const sizes = installFakeResizeObserver();
  try {
    const { news, panel, presence } = fixture();
    const body = document.getElementById('news-panel-body');
    const cards = () =>
      panel.querySelectorAll('[data-list-card="news"] .news-card');
    sizes.report(body, 0, 0);
    news.update(view());
    assert.equal(cards().length, 0, 'not painted while its list is not shown');
    // The list's tab still shows, with its count.
    assert.equal(String(presence()?.count), '5');
    sizes.report(body, 280, 400);
    assert.ok(cards().length > 0, 'painted when displayed');
    const [observer] = sizes.watching(body);
    news.destroy();
    assert.equal(observer.disconnected, true);
  } finally {
    sizes.restore();
  }
});

test('Context opening on the News list paints the owed feed at once; on another list it stays owed', () => {
  const sizes = installFakeResizeObserver();
  try {
    const { news, panel } = fixture();
    const context = document.getElementById('global-context-panel');
    const body = document.getElementById('news-panel-body');
    const cards = () =>
      panel.querySelectorAll('[data-list-card="news"] .news-card');
    sizes.report(body, 0, 0);
    news.update(view());
    assert.equal(cards().length, 0);
    setContextListPresence('weather', { count: 1 });
    setContextListPresence('news', { count: 5 });
    showContextList('weather');
    flushPanelContent(context);
    assert.equal(cards().length, 0, 'Context opens on another list');
    showContextList('news');
    flushPanelContent(context);
    assert.ok(cards().length > 0);
    news.destroy();
  } finally {
    sizes.restore();
    resetContextLists();
  }
});

test('a card click flies there; open, it links the source and closes', () => {
  const { news, panel, calls } = fixture();
  news.update(view());
  panel.querySelector('.news-card__main').click();
  assert.deepEqual(calls.at(-1), [
    'news',
    { reportId: 'big', focus: true, fromNewsList: true },
    { origin: 'user' },
  ]);
  news.update(view({ selected: feedCardView(big, NOW) }));
  const open = panel.querySelector('.news-card.is-open');
  const link = open.querySelector('.news-card__link');
  assert.equal(link.textContent, 'Source: example.com ↗');
  assert.equal(link.getAttribute('href'), 'https://www.example.com/big');
  assert.equal(link.getAttribute('rel'), 'noopener noreferrer');
  assert.equal(
    open.querySelector('.news-card__original').textContent,
    'Удар по Харкову',
  );
  open.querySelector('.news-card__main').click();
  assert.deepEqual(calls.at(-1)[1], { clear: true });
  news.destroy();
});

test('the list card reports its order to the layer, for Prev and Next', async () => {
  const { news, calls } = fixture();
  news.update(view());
  await nextTick();
  assert.deepEqual(calls.at(-1), [
    'news',
    { listOrder: ['big', 'lone'] },
    { origin: 'user' },
  ]);
  news.destroy();
});

test('publishing the initial list order can refresh a failed feed while it mounts', async () => {
  const container = document.createElement('div');
  const failed = view({
    items: [],
    error: 'News feed unavailable',
    hasMore: false,
  });
  let publications = 0;
  const panel = createNewsPanel({
    container,
    setLayerParams: (_id, params) => {
      assert.deepEqual(params.listOrder, []);
      if (++publications === 1) panel.update({ ...failed });
    },
    onPresence() {},
  });
  panel.update(null);
  panel.update(failed);
  await nextTick();
  assert.equal(publications, 1);
  assert.match(container.textContent, /News feed unavailable/);
  panel.update(null);
  assert.equal(container.querySelector('.news-readout'), null);
  panel.destroy();
});

test('a selected report keeps its open detail and source across pages', async (t) => {
  const { news, panel } = fixture();
  resetListCardMemory();
  t.after(() => {
    news.destroy();
    resetListCardMemory();
  });
  const items = Array.from({ length: 8 }, (_, i) =>
    feedCardView(report(String(i + 1)), NOW),
  );
  news.update(view({ items, selected: items[6] }));
  const open = () => [...panel.querySelectorAll('.news-card.is-open')];
  assert.deepEqual(
    open().map((card) => card.querySelector('.news-card__link').href),
    ['https://www.example.com/7'],
  );
  assert.ok(open()[0].classList.contains('news-readout__selected'));

  panel.querySelector('[data-list-next]').click();
  await nextTick();
  assert.equal(open().length, 1);
  assert.ok(open()[0].classList.contains('news-readout__selected'));

  panel.querySelector('[data-list-previous]').click();
  await nextTick();
  assert.equal(open().length, 1);
  assert.ok(open()[0].classList.contains('news-readout__selected'));
});

test('a feed refresh keeps focus on the selected report source when the detail moves', (t) => {
  const { news, panel } = fixture();
  resetListCardMemory();
  t.after(() => {
    news.destroy();
    resetListCardMemory();
  });
  const items = Array.from({ length: 8 }, (_, i) =>
    feedCardView(
      report(
        String(i + 1),
        i === 4
          ? {
              event: {
                size: 1,
                sides: [],
                image: {
                  url: 'https://example.com/thumb.jpg',
                  publisher: 'News',
                  video: 'https://example.com/clip.mp4',
                },
              },
            }
          : {},
      ),
      NOW,
    ),
  );
  const selected = items[4];
  news.update(view({ items, selected }));
  const link = () => panel.querySelector('.news-card.is-open .news-card__link');
  const originalLink = link();
  const clip = panel.querySelector('video');
  clip.currentTime = 17;
  link().focus();

  news.update(
    view({ items: [feedCardView(report('new'), NOW), ...items], selected }),
  );
  assert.ok(
    panel.querySelector('video') === clip,
    'the playing element stays mounted',
  );
  assert.equal(clip.currentTime, 17);
  assert.ok(link() === originalLink, 'the selected detail remains mounted');
  assert.ok(
    document.activeElement === link(),
    'the link in the detail above the page',
  );

  news.update(view({ items, selected }));
  assert.ok(
    document.activeElement === link(),
    'the link in the detail on its page',
  );
});

test('filters, the Local section and empty or failed reads', () => {
  const { news, panel, calls, presence } = fixture();
  news.update(view());
  const heading = () =>
    panel.querySelector('.context-list-card__head .view-context__block-name')
      .textContent;
  assert.equal(heading(), 'Latest');
  assert.equal(panel.querySelector('.news-toggle') === null, true);
  const severity = panel.querySelector('select[aria-label="Severity"]');
  assert.equal(severity.value, '2');
  severity.value = '3';
  severity.dispatchEvent(new Event('change'));
  assert.deepEqual(calls.at(-1)[1], { filters: { minSeverity: 3 } });
  panel.querySelector('[data-chip-id="ua-ru-war"]').click();
  assert.deepEqual(calls.at(-1)[1], { filters: { hotspot: 'ua-ru-war' } });
  panel.querySelector('[data-chip-id="local"]').click();
  assert.deepEqual(calls.at(-1)[1], { filters: { section: 'local' } });

  news.update(
    view({
      items: [],
      hasMore: false,
    }),
  );
  assert.match(
    panel.textContent,
    /No news matches these filters in the last 24 h/,
  );
  assert.equal(
    panel.querySelector('.news-readout__footer button') === null,
    true,
  );

  // Local: no hotspot chips or severity floor, and its own empty states.
  const localView = (inView) =>
    view({
      filters: normalizeFilters({ section: 'local' }),
      inView: { loading: false, error: null, items: [], ...inView },
    });
  news.update(localView({ active: false }));
  const card = () => panel.querySelector('[data-list-card="news"]');
  assert.equal(heading(), 'Local');
  assert.match(card().textContent, /Zoom in to see local news/);
  assert.equal(
    panel.querySelector('[data-chip-id="ua-ru-war"]') === null,
    true,
  );
  assert.equal(
    panel.querySelector('select[aria-label="Severity"]') === null,
    true,
  );
  news.update(
    localView({ active: true, items: [feedCardView(report('near'), NOW)] }),
  );
  assert.equal(countOf(presence), '5');
  news.update({
    ...localView({ active: true, items: [feedCardView(report('near'), NOW)] }),
    mapCount: 1,
  });
  assert.equal(countOf(presence), '1');
  // A view without the map's count shows no count rather than a wrong one.
  news.update({ ...view(), mapCount: undefined });
  assert.equal(presence()?.count, null);
  news.update(localView({ active: true }));
  assert.match(
    card().textContent,
    /Nothing reported near here in the last 24 h/,
  );
  news.update(view());

  news.update(
    view({ items: [], error: 'News feed unavailable', hasMore: false }),
  );
  assert.equal(
    card().querySelector('.context-list-card__state').textContent,
    'News feed unavailable',
  );
  news.destroy();
});

test('each section says which key it lacks; Local names the area it reads', () => {
  const { news, panel } = fixture();
  const key = {
    title: 'Liveuamap key required',
    hint: 'Needs LIVEUAMAP_API_KEY — add it in Provider Settings',
  };
  news.update(view({ key, items: [], hasMore: false }));
  const latest = panel.querySelector('[data-list-card="news"]');
  assert.match(latest.textContent, /Liveuamap key required/);
  assert.match(latest.textContent, /Needs LIVEUAMAP_API_KEY/);
  assert.doesNotMatch(latest.textContent, /No news matches/);

  const localView = (inView) =>
    view({
      filters: normalizeFilters({ section: 'local' }),
      inView: {
        active: true,
        loading: false,
        error: null,
        items: [],
        radiusKm: 500,
        ...inView,
      },
    });
  const section = () => panel.querySelector('[data-list-card="news"]');
  const heading = () => section().querySelector('.news-readout__area');
  news.update(
    localView({
      key: {
        title: 'World News API limit reached for today',
        hint: 'News resumes tomorrow, or with a paid plan',
      },
    }),
  );
  assert.match(section().textContent, /World News API limit reached for today/);
  assert.match(section().textContent, /News resumes tomorrow/);
  assert.doesNotMatch(section().textContent, /Nothing reported near here/);

  // The area named, else the radius at sea.
  news.update(localView({ area: 'Ukraine' }));
  assert.equal(heading().textContent.trim(), 'News from Ukraine');
  news.update(localView({ area: null }));
  assert.equal(
    heading().textContent.trim(),
    'Within 500 km of the view centre',
  );
  // While the first area is named, neither: the radius does not flash.
  news.update(localView({ area: null, areaLoading: true, loading: true }));
  assert.equal(heading(), null);
  // A new area on the way keeps the one shown.
  news.update(localView({ area: 'Ukraine', areaLoading: true, loading: true }));
  assert.equal(heading().textContent.trim(), 'News from Ukraine');
  news.destroy();
});

test('a card credits the service its report came through', () => {
  const { news, panel } = fixture();
  news.update(
    view({
      items: [
        feedCardView(report('gdelt', { attribution: 'GDELT Project' }), NOW),
        feedCardView(report('own'), NOW),
      ],
    }),
  );
  const [credited, own] = panel.querySelectorAll('.news-card');
  assert.equal(
    credited.querySelector('.news-card__via').textContent,
    'via GDELT Project',
  );
  assert.equal(own.querySelector('.news-card__via') === null, true);
  news.destroy();
});

test('scrolling to the end asks once per page, again after a filter change or a failed read', () => {
  const { news, calls, panel } = fixture();
  const body = document.getElementById('news-panel-body');
  // A scroller at its bottom.
  Object.defineProperty(body, 'scrollHeight', {
    value: 1000,
    configurable: true,
  });
  Object.defineProperty(body, 'clientHeight', {
    value: 400,
    configurable: true,
  });
  body.scrollTop = 600;
  const loadMores = () => calls.filter(([, p]) => p.loadMore === true).length;
  const scroll = () => body.dispatchEvent(new Event('scroll'));
  news.update(view());
  scroll();
  scroll();
  assert.equal(loadMores(), 1);
  // The page came back with nothing new (as many items): no second request.
  news.update(view());
  scroll();
  assert.equal(loadMores(), 1);
  // Another hotspot, the same number of rows: the new list can be read on.
  const hotspot = normalizeFilters({ hotspot: 'ua-ru-war' }, [
    { id: 'ua-ru-war' },
  ]);
  news.update(view({ filters: hotspot }));
  scroll();
  assert.equal(loadMores(), 2);
  // The read fails: the next scroll tries again.
  news.update(view({ filters: hotspot, error: 'News feed unavailable' }));
  scroll();
  assert.equal(loadMores(), 3);
  // The action keeps its place while the older page is loading.
  const olderButton = () => panel.querySelector('.news-readout__footer button');
  const older = olderButton();
  news.update(view({ filters: hotspot, loading: true }));
  assert.ok(
    olderButton() === older,
    'the same older-news button stays mounted',
  );
  assert.equal(older.disabled, true);
  older.click();
  scroll();
  assert.equal(loadMores(), 3);
  news.update(view({ filters: hotspot }));
  assert.ok(olderButton() === older);
  assert.equal(older.disabled, false);
  older.click();
  assert.equal(loadMores(), 4);
  news.update(view({ filters: hotspot, hasMore: false }));
  assert.equal(olderButton(), null);
  scroll();
  assert.equal(loadMores(), 4);
  news.destroy();
});

test('the window, severity and category fold into one Filters row', () => {
  const { news, panel } = fixture();
  news.update(view({ windowHours: 24, windowChoices: [24, 12, 6, 3, 1] }));
  const filters = panel.querySelectorAll('details.news-readout__filters');
  assert.equal(filters.length, 1);
  const [row] = filters;
  assert.equal(row.open, false, 'folded at first');
  // The summary (a keyboard stop of its own) names what is chosen.
  const summary = row.querySelector('summary');
  assert.equal(
    summary.querySelector('.news-readout__filters-label').textContent,
    'Filters',
  );
  assert.equal(
    summary.querySelector('.news-readout__chosen').textContent,
    'Last 24 h · Significant and above · All categories',
  );
  // Every select is inside it, and none is left outside.
  assert.deepEqual(
    [...row.querySelectorAll('select')].map((select) =>
      select.getAttribute('aria-label'),
    ),
    ['Time window', 'Severity', 'Category'],
  );
  assert.equal(panel.querySelectorAll('select').length, 3);
  news.destroy();
});

test('the window choice offers shorter windows; the longest is the server window', () => {
  const { news, panel, calls } = fixture();
  news.update(view({ windowHours: 12, windowChoices: [12, 6, 3, 1] }));
  const choice = panel.querySelector('select[aria-label="Time window"]');
  assert.deepEqual(
    [...choice.options].map((option) => option.textContent),
    ['Last 12 h', 'Last 6 h', 'Last 3 h', 'Last 1 h'],
  );
  assert.equal(choice.value, '12');
  choice.value = '3';
  choice.dispatchEvent(new Event('change'));
  assert.deepEqual(calls.at(-1)[1], { filters: { hours: 3 } });
  choice.value = '12';
  choice.dispatchEvent(new Event('change'));
  assert.deepEqual(calls.at(-1)[1], { filters: { hours: null } });
});

test('the time window agrees with its number of hours', (t) => {
  t.after(() => setLocale('en'));
  setLocale('es');
  const { news, panel } = fixture();
  news.update(view({ windowHours: 24, windowChoices: [24, 12, 6, 3, 1] }));
  const choice = panel.querySelector(
    'select.news-readout__window-choice, .news-readout__window-choice select',
  );
  assert.deepEqual(
    [...choice.options].map((option) => option.textContent),
    [
      'Últimas 24 h',
      'Últimas 12 h',
      'Últimas 6 h',
      'Últimas 3 h',
      'Última 1 h',
    ],
  );
  news.update(view({ windowHours: 1, items: [], hasMore: false }));
  assert.match(
    panel.querySelector('.news-readout__chosen').textContent,
    /^Última 1 h · /,
  );
  assert.equal(
    panel.querySelector('.news-readout').getAttribute('aria-label'),
    'Noticias de la última 1 hora',
  );
  assert.match(
    panel.textContent,
    /En la última 1 h no hay noticias que coincidan con estos filtros/,
  );
  setLocale('ru');
  news.update(view({ windowHours: 1, items: [], hasMore: false }));
  assert.equal(
    panel.querySelector('.news-readout').getAttribute('aria-label'),
    'Новости за последний 1 час',
  );
  news.update(view({ windowHours: 12, items: [], hasMore: false }));
  assert.equal(
    panel.querySelector('.news-readout').getAttribute('aria-label'),
    'Новости за последние 12 часов',
  );
  news.destroy();
});

test('the Latest news heading agrees with the news it heads (fr)', (t) => {
  t.after(() => setLocale('en'));
  setLocale('fr');
  const { news, panel } = fixture();
  news.update(view());
  assert.equal(
    panel.querySelector('.context-list-card__head .view-context__block-name')
      .textContent,
    'Dernières',
  );
  news.destroy();
});

test('the panel names the window the server serves', () => {
  const { news, panel } = fixture();
  news.update(view({ windowHours: 12 }));
  assert.match(
    panel.querySelector('.news-readout__chosen').textContent,
    /^Last 12 h · /,
  );
  // With one window there is nothing to choose: no window select.
  assert.equal(panel.querySelector('select[aria-label="Time window"]'), null);
});

test('a clip waits behind its picture and plays, on request, in the open card', async () => {
  const { news, panel } = fixture();
  const clipped = report('clip', {
    event: {
      size: 1,
      sides: [],
      image: {
        url: 'https://cdn4.telesco.pe/file/v.jpg',
        publisher: 'Channel',
        video: 'https://cdn4.telesco.pe/file/v.mp4?token=x',
      },
    },
  });
  news.update(view({ items: [feedCardView(clipped, NOW)] }));
  const card = panel.querySelector('.news-card');
  assert.equal(card.querySelector('.news-card__play').textContent, '▶');
  assert.equal(card.querySelector('video') === null, true);
  news.update(
    view({
      items: [feedCardView(clipped, NOW)],
      selected: feedCardView(clipped, NOW),
    }),
  );
  const video = panel.querySelector('.news-card.is-open video');
  assert.equal(
    video.getAttribute('src'),
    'https://cdn4.telesco.pe/file/v.mp4?token=x',
  );
  assert.equal(
    video.getAttribute('poster'),
    'https://cdn4.telesco.pe/file/v.jpg',
  );
  assert.equal(video.getAttribute('preload'), 'none');
  assert.ok(video.hasAttribute('controls'));
  // An expired link leaves the card without the clip; the card drops it
  // itself, on Vue's next tick, with no new view from the layer.
  video.dispatchEvent(new Event('error'));
  await nextTick();
  assert.equal(panel.querySelector('.news-card.is-open video') === null, true);
  news.destroy();
});

test('switching News sections resets pagination', async (t) => {
  resetListCardMemory();
  const { news, panel } = fixture();
  t.after(() => {
    news.destroy();
    resetListCardMemory();
  });
  const items = Array.from({ length: 12 }, (_, i) =>
    feedCardView(report(String(i + 1)), NOW),
  );
  news.update(view({ items }));
  panel.querySelector('[data-list-next]').click();
  await nextTick();
  const first = () => panel.querySelector('[data-list-key]').dataset.listKey;
  assert.notEqual(first(), items[0].id);
  news.update(
    view({
      items,
      filters: { section: 'local' },
      inView: { active: true, items, error: 'Cached Local update failed' },
    }),
  );
  await nextTick();
  assert.equal(first(), items[0].id);
});

test('a hidden news list releases its playing media and restores the report without autoplay', async (t) => {
  const { news, panel } = fixture();
  t.after(() => news.destroy());
  const clip = feedCardView(
    report('clip', {
      event: {
        size: 1,
        sides: [],
        image: {
          url: 'https://example.com/thumb.jpg',
          publisher: 'News',
          video: 'https://example.com/v.mp4',
        },
      },
    }),
    NOW,
  );
  news.update(view({ items: [clip], selected: clip }));
  const video = panel.querySelector('video');
  assert.ok(video);
  panel.querySelector('#news-panel-body').setAttribute('data-news-hidden', '');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(Boolean(panel.querySelector('video')), false);
  assert.equal(video.hasAttribute('src'), false);
  panel.querySelector('#news-panel-body').removeAttribute('data-news-hidden');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(panel.querySelector('video')?.hasAttribute('autoplay'), false);
  assert.match(
    panel.querySelector('.news-card.is-open').textContent,
    /Report clip/,
  );
});

test('Local News shows its own stale error with cached reports and a healthy empty state after recovery', (t) => {
  const { news, panel } = fixture();
  t.after(() => news.destroy());
  const publish = (error, items) =>
    news.update(
      view({
        filters: { section: 'local' },
        items: [],
        inView: { active: true, items, error },
      }),
    );
  publish('Local refresh failed', [feedCardView(big, NOW)]);
  assert.ok(panel.querySelector('.news-card'));
  assert.match(
    panel.querySelector('.news-readout__status')?.textContent || '',
    /Local refresh failed/,
  );
  publish(null, []);
  assert.equal(Boolean(panel.querySelector('.news-readout__status')), false);
  assert.match(
    panel.querySelector('.news-readout__empty').textContent,
    /Nothing reported/,
  );
});
