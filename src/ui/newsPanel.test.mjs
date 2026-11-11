import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createNewsPanel } from './newsPanel.js';
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
  document.body.innerHTML = `
    <div id="news-panel" class="collapsed" hidden>
      <span id="news-panel-count">0</span>
      <button data-collapse-target="news-panel"></button>
      <div id="news-panel-body"></div>
    </div>`;
  const panel = document.getElementById('news-panel');
  let opened = 0;
  panel
    .querySelector('[data-collapse-target]')
    .addEventListener('click', () => {
      opened++;
      panel.classList.remove('collapsed');
    });
  const calls = [];
  const news = createNewsPanel({
    container: document.getElementById('news-panel-body'),
    setLayerParams: (id, params, options) => calls.push([id, params, options]),
  });
  return { news, panel, calls, opened: () => opened };
}

test('the panel shows the last 24 h as event cards and opens once', () => {
  const { news, panel, opened } = fixture();
  news.update(null);
  assert.equal(panel.hidden, true);
  news.update(view());
  assert.equal(panel.hidden, false);
  assert.equal(opened(), 1);
  assert.equal(document.getElementById('news-panel-count').textContent, '2');
  assert.equal(
    panel.querySelector('.news-readout__window').textContent,
    'Last 24 h',
  );
  assert.deepEqual(
    [...panel.querySelectorAll('.news-readout__chips [data-chip-id]')].map(
      (chip) => chip.textContent,
    ),
    ['All 7', 'Ukraine–Russia 7'],
  );
  const [first, second] = panel.querySelectorAll(
    '.news-readout__feed .news-card',
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
  assert.equal(second.querySelector('.news-card__thumb'), null);
  // A later update does not reopen a panel the reader collapsed.
  panel.classList.add('collapsed');
  news.update(view());
  assert.equal(opened(), 1);
  news.destroy();
  assert.equal(panel.hidden, true);
});

test('a card click flies there; open, it links the source and closes', () => {
  const { news, panel, calls } = fixture();
  news.update(view());
  panel.querySelector('.news-card__main').click();
  assert.deepEqual(calls.at(-1), [
    'news',
    { reportId: 'big', focus: true },
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

test('filters, the Local section and empty or failed reads', () => {
  const { news, panel, calls } = fixture();
  news.update(view());
  assert.equal(panel.querySelector('[aria-label="Local"]'), null);
  assert.equal(panel.querySelector('.news-toggle'), null);
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
  assert.equal(panel.querySelector('.news-readout__footer button'), null);

  // Local: no hotspot chips or severity floor, and its own empty states.
  const localView = (inView) =>
    view({
      filters: normalizeFilters({ section: 'local' }),
      inView: { loading: false, error: null, items: [], ...inView },
    });
  news.update(localView({ active: false }));
  const section = panel.querySelector('[aria-label="Local"]');
  assert.match(section.textContent, /Zoom in to see local news/);
  assert.equal(panel.querySelector('[data-chip-id="ua-ru-war"]'), null);
  assert.equal(panel.querySelector('select[aria-label="Severity"]'), null);
  assert.equal(panel.querySelector('[aria-label="Latest news"]'), null);
  assert.equal(document.getElementById('news-panel-count').textContent, '0');
  news.update(
    localView({ active: true, items: [feedCardView(report('near'), NOW)] }),
  );
  assert.equal(document.getElementById('news-panel-count').textContent, '1');
  news.update(localView({ active: true }));
  assert.match(
    panel.querySelector('[aria-label="Local"]').textContent,
    /Nothing reported near here in the last 24 h/,
  );
  news.update(view());

  news.update(
    view({ items: [], error: 'News feed unavailable', hasMore: false }),
  );
  assert.equal(
    panel.querySelector('.news-readout__status').textContent,
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
  const latest = panel.querySelector('[aria-label="Latest news"]');
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
  const section = () => panel.querySelector('[aria-label="Local"]');
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
  assert.equal(own.querySelector('.news-card__via'), null);
  news.destroy();
});

test('scrolling to the end asks once per page, again after a filter change or a failed read', () => {
  const { news, calls } = fixture();
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
  // While loading, or with no older page, nothing is asked.
  news.update(view({ filters: hotspot, loading: true }));
  scroll();
  news.update(view({ filters: hotspot, hasMore: false }));
  scroll();
  assert.equal(loadMores(), 3);
  news.destroy();
});

test('the window choice offers shorter windows; the longest is the server window', () => {
  const { news, panel, calls } = fixture();
  news.update(view({ windowHours: 12, windowChoices: [12, 6, 3, 1] }));
  assert.equal(panel.querySelector('.news-readout__window'), null);
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

test('the panel names the window the server serves', () => {
  const { news, panel } = fixture();
  news.update(view({ windowHours: 12 }));
  assert.equal(
    panel.querySelector('.news-readout__window').textContent,
    'Last 12 h',
  );
});

test('a clip waits behind its picture and plays, on request, in the open card', () => {
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
  assert.equal(card.querySelector('video'), null);
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
  // An expired link leaves the card without the clip.
  video.dispatchEvent(new Event('error'));
  news.update(
    view({
      items: [feedCardView(clipped, NOW)],
      selected: feedCardView(clipped, NOW),
    }),
  );
  assert.equal(panel.querySelector('.news-card.is-open video'), null);
  news.destroy();
});
