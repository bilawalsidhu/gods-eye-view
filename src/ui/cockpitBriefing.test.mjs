// src/ui/cockpitBriefing.test.mjs — the Cockpit briefing card renders what
// the Cockpit controller presents, over happy-dom.
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createPinia } from 'pinia';
import { createApp, nextTick } from 'vue';
import { setLocale } from '../i18n/index.js';
import {
  briefCycleTarget,
  cockpitBriefPages,
  createBriefState,
} from './cockpitBriefPages.js';
import {
  maybeRefreshRegionalBrief,
  publishBriefView,
  renderRegionalBrief,
  renderRegionalBriefStatus,
  setBriefAutoRotate,
  setBriefLiveOffered,
  showBriefPage,
  updateLocalPosition,
} from './cockpitBriefing.js';
import { setSignalCollapsed } from './cockpitLayout.js';
import { useCockpitStore } from './stores/cockpit.js';
import { useLiveStore } from './stores/live.js';
import CockpitBriefing from './views/panels/CockpitBriefing.vue';

function fixture(t) {
  document.body.replaceChildren();
  const host = document.body.appendChild(document.createElement('div'));
  const pinia = createPinia();
  const app = createApp(CockpitBriefing).use(pinia);
  app.mount(host);
  t.after(() => app.unmount());
  const store = useCockpitStore(pinia);
  // The briefing presenters need only this much of the controller.
  const owner = {
    destroyed: false,
    briefPageIndex: 0,
    briefAutoRotateEnabled: false,
    briefLiveOffered: false,
    brief: createBriefState(),
    publishBrief: (view) => store.publishBrief(view),
    publishBriefView,
    showBriefPage,
    scheduleContextLayout() {},
    startBriefRotation() {},
    stopBriefRotation() {},
    services: { weatherCodeLabel: () => 'RAIN' },
  };
  const $ = (selector) => document.querySelector(selector);
  const text = (selector) => $(selector).textContent.trim();
  const visiblePages = () =>
    [...document.querySelectorAll('[data-cockpit-brief-page]')]
      .filter((page) => !page.hidden)
      .map((page) => page.dataset.cockpitBriefPage);
  // The tabs on offer: the LIVE tab is in the markup but hidden without a stream.
  const current = () =>
    [...document.querySelectorAll('[data-cockpit-brief-index]')]
      .filter((tab) => !tab.hidden)
      .map((tab) => tab.getAttribute('aria-current'));
  // A stream on offer for the ridden subject, as LiveControls publishes it;
  // the briefing then offers its LIVE page.
  const liveStore = useLiveStore(pinia);
  const liveActed = [];
  liveStore.connect({
    cycleLive: (direction) => liveActed.push(['cycle', direction]),
    playLive: () => liveActed.push(['play']),
    stopLive: () => liveActed.push(['stop']),
    retryLive: () => liveActed.push(['retry']),
    hideLive: (where) => liveActed.push(['hide', where]),
  });
  const offerLive = async (view) => {
    liveStore.publish(
      view && {
        label: 'ISS (ZARYA)',
        streams: [
          { id: 'iss-exterior', title: 'Exterior cameras', owner: 'NASA' },
          { id: 'iss-crew', title: 'Live video and audio', owner: 'NASA' },
        ],
        index: 0,
        count: 2,
        current: {
          id: 'iss-exterior',
          title: 'Exterior cameras',
          owner: 'NASA',
          ownerUrl: 'https://www.youtube.com/@NASA',
          note: 'NASA video, via YouTube',
          watchUrl: 'https://www.youtube.com/watch?v=ROboUHfPUrU',
        },
        state: 'idle',
        reason: null,
        ...view,
      },
    );
    setBriefLiveOffered.call(owner, view !== null);
    await nextTick();
    await nextTick();
  };
  return { $, text, owner, visiblePages, current, offerLive, liveActed };
}

const INFO = { latitude: 30.25, longitude: -97.75 };

test('before the controller presents, the card shows the state it starts in', (t) => {
  const { $, text, visiblePages, current } = fixture(t);
  assert.equal(text('#cockpit-brief-kicker'), 'LIVE SIGNALS');
  assert.equal(text('#cockpit-brief-subtitle'), 'OBSERVED / MAPPED PINGS');
  assert.equal(text('#cockpit-brief-position'), '1 / 3');
  assert.equal(
    text('#cockpit-brief-source'),
    'SOURCE-BACKED EVENTS · NO SYNTHETIC NEWS',
  );
  assert.deepEqual(visiblePages(), ['signals']);
  assert.deepEqual(current(), ['true', null, null]);
  const auto = $('#cockpit-brief-auto');
  assert.equal(auto.textContent, 'CYCLE OFF');
  assert.equal(auto.getAttribute('aria-label'), 'CYCLE OFF');
  assert.equal(auto.getAttribute('aria-pressed'), 'false');
  assert.match(auto.title, /^Cycle briefing pages automatically/);
  assert.equal(text('#cockpit-news-status'), 'ACQUIRING REGIONAL NEWS');
  assert.equal($('#cockpit-news-status').hasAttribute('data-state'), false);
  assert.equal(text('#cockpit-local-place'), 'RESOLVING REGION');
  assert.equal(text('#cockpit-local-coordinates'), '--');
  assert.equal(text('#cockpit-local-condition'), 'UNKNOWN');
  const stream = $('#cockpit-signal-stream');
  assert.equal(stream.hidden, true);
  assert.equal(stream.hasAttribute('data-brief-page'), false);
  assert.equal(stream.hasAttribute('data-regional-status'), false);
});

test('pages, the cycle toggle and the source follow the controller', async (t) => {
  const { $, text, owner, visiblePages, current } = fixture(t);
  showBriefPage.call(owner, 1);
  await nextTick();
  assert.equal(text('#cockpit-brief-kicker'), 'REGIONAL NEWS');
  assert.equal(text('#cockpit-brief-position'), '2 / 3');
  assert.equal(text('#cockpit-brief-source'), 'GOOGLE NEWS RSS · LAST 24 H');
  assert.deepEqual(visiblePages(), ['news']);
  assert.deepEqual(current(), ['false', 'true', 'false']);
  assert.equal($('#cockpit-signal-stream').dataset.briefPage, 'news');
  showBriefPage.call(owner, -1);
  await nextTick();
  assert.deepEqual(visiblePages(), ['local']);
  assert.equal(
    text('#cockpit-brief-source'),
    'NATURAL EARTH · OPEN-METEO · UTC',
  );
  setBriefAutoRotate.call(owner, true);
  await nextTick();
  const auto = $('#cockpit-brief-auto');
  assert.equal(auto.textContent, 'CYCLE ON');
  assert.equal(auto.getAttribute('aria-label'), 'CYCLE ON');
  assert.equal(auto.getAttribute('aria-pressed'), 'true');
  assert.match(auto.title, /^Stop automatic page cycling/);
});

test('without a stream the briefing keeps its three pages and hides the LIVE tab', async (t) => {
  const { $, text, owner, visiblePages } = fixture(t);
  const liveTab = $('[data-cockpit-brief-index="3"]');
  assert.equal(liveTab.hidden, true);
  assert.equal(liveTab.textContent, 'LIVE');
  assert.equal(liveTab.getAttribute('aria-label'), 'Show Live Video');
  assert.equal(
    $('[data-cockpit-brief-page="live"]').querySelector('*'),
    null,
    'no page body without a stream',
  );
  // Next from Local wraps to Live Signals, past the page not on offer.
  showBriefPage.call(owner, 3);
  await nextTick();
  assert.deepEqual(visiblePages(), ['signals']);
  assert.equal(text('#cockpit-brief-position'), '1 / 3');
});

test('with a stream the LIVE page is the fourth, reached by the arrows and its tab', async (t) => {
  const { $, text, owner, visiblePages, current, offerLive } = fixture(t);
  await offerLive({});
  assert.equal(text('#cockpit-brief-position'), '1 / 4');
  const liveTab = $('[data-cockpit-brief-index="3"]');
  assert.equal(liveTab.hidden, false);
  assert.deepEqual(current(), ['true', 'false', 'false', 'false']);
  showBriefPage.call(owner, 2);
  showBriefPage.call(owner, owner.briefPageIndex + 1);
  await nextTick();
  assert.deepEqual(visiblePages(), ['live']);
  assert.deepEqual(current(), ['false', 'false', 'false', 'true']);
  assert.equal(text('#cockpit-brief-kicker'), 'LIVE VIDEO');
  assert.equal(
    text('#cockpit-brief-subtitle'),
    'STREAM ATTACHED TO THE SUBJECT',
  );
  assert.equal(text('#cockpit-brief-position'), '4 / 4');
  assert.equal(
    text('#cockpit-brief-source'),
    'YOUTUBE EMBEDDED PLAYER · MUTED',
  );
  assert.equal($('#cockpit-signal-stream').dataset.briefPage, 'live');
  // The page shows what the LIVE section shows, with the player's own screen.
  const page = $('[data-cockpit-brief-page="live"]');
  assert.equal(
    page.querySelector('.cockpit-live-subject strong').textContent,
    'ISS (ZARYA)',
  );
  assert.equal(text('#cockpit-live-stream-title'), 'Exterior cameras · 1/2');
  assert.ok($('#cockpit-live-player-host'));
  assert.ok($('#cockpit-live-previous'));
  assert.ok($('#cockpit-live-next'));
  assert.equal(text('#cockpit-live-badge-text'), 'OFF');
  assert.equal(text('#cockpit-live-status'), 'Click to play');
  assert.ok($('#cockpit-live-play'), 'Play, under the IP notice');
  assert.match(
    page.querySelector('.cockpit-live-privacy').textContent,
    /sees your IP address/,
  );
  assert.equal(
    $('#cockpit-live-watch-link').getAttribute('href'),
    'https://www.youtube.com/watch?v=ROboUHfPUrU',
  );
  // Next from LIVE wraps to Live Signals.
  showBriefPage.call(owner, owner.briefPageIndex + 1);
  await nextTick();
  assert.deepEqual(visiblePages(), ['signals']);
  assert.equal(text('#cockpit-brief-position'), '1 / 4');
});

test('the LIVE page loads the stream only on Play, stops it when left, and its controls reach LiveControls', async (t) => {
  const { $, owner, offerLive, liveActed } = fixture(t);
  await offerLive({});
  assert.deepEqual(liveActed, [], 'riding the station loads no player');
  showBriefPage.call(owner, 3);
  await nextTick();
  $('#cockpit-live-play').click();
  assert.deepEqual(liveActed, [['play']]);
  await offerLive({ state: 'playing' });
  const page = $('[data-cockpit-brief-page="live"]');
  assert.equal($('#cockpit-live-badge-text').textContent, 'ON AIR');
  assert.equal(
    page.querySelector('.live-dot').classList.contains('on-air'),
    true,
  );
  assert.equal(
    page.querySelector('.live-screen').classList.contains('active'),
    true,
  );
  assert.equal($('#cockpit-live-status').textContent, 'Live');
  $('#cockpit-live-next').click();
  $('#cockpit-live-previous').click();
  assert.deepEqual(liveActed, [['play'], ['cycle', 1], ['cycle', -1]]);
  // Leaving the page stops what plays there.
  showBriefPage.call(owner, 0);
  await nextTick();
  assert.deepEqual(liveActed.at(-1), ['hide', 'cockpit']);
  showBriefPage.call(owner, 3);
  await nextTick();
  await offerLive({ state: 'offline', reason: 'timeout' });
  const card = page.querySelector('.live-card');
  assert.equal(card.classList.contains('offline'), true);
  assert.equal(card.querySelector('strong').textContent, 'Stream is offline');
  $('#cockpit-live-retry').click();
  assert.deepEqual(liveActed.at(-1), ['retry']);
  await offerLive({ state: 'unavailable', reason: 'error-150' });
  assert.equal($('#cockpit-live-retry'), null);
  assert.equal(
    $('#cockpit-live-status').textContent,
    'This stream cannot play here',
  );
});

test('the stream going while LIVE is shown falls back to Live Signals with three pages', async (t) => {
  const { $, text, owner, visiblePages, offerLive } = fixture(t);
  await offerLive({});
  showBriefPage.call(owner, 3);
  await nextTick();
  assert.deepEqual(visiblePages(), ['live']);
  await offerLive(null);
  assert.deepEqual(visiblePages(), ['signals']);
  assert.equal(text('#cockpit-brief-position'), '1 / 3');
  assert.equal($('[data-cockpit-brief-index="3"]').hidden, true);
  // Going on another page, the page stays and only the count changes.
  showBriefPage.call(owner, 1);
  await offerLive({});
  assert.deepEqual(visiblePages(), ['news']);
  assert.equal(text('#cockpit-brief-position'), '2 / 4');
  // Offering what is already offered changes nothing.
  const views = [];
  owner.publishBrief = (view) => views.push(view);
  setBriefLiveOffered.call(owner, true);
  assert.equal(views.length, 0);
});

test('the automatic cycle never turns to the LIVE page and waits while it is shown', () => {
  const three = cockpitBriefPages(false);
  assert.deepEqual(
    [0, 1, 2].map((index) => briefCycleTarget(three, index)),
    [1, 2, 0],
  );
  const four = cockpitBriefPages(true);
  assert.equal(four.length, 4);
  assert.equal(four[3].id, 'live');
  assert.deepEqual(
    [0, 1, 2].map((index) => briefCycleTarget(four, index)),
    [1, 2, 0],
    'Local goes back to Live Signals, past LIVE',
  );
  assert.equal(briefCycleTarget(four, 3), null, 'shown by hand, LIVE stays');
});

test('regional news and local conditions render what the region returned', async (t) => {
  const { $, text, owner } = fixture(t);
  renderRegionalBriefStatus.call(owner, 'loading', INFO);
  await nextTick();
  assert.equal($('#cockpit-news-status').dataset.state, 'loading');
  assert.match(text('#cockpit-local-coordinates'), /N · .*W$/);
  showBriefPage.call(owner, 1);
  renderRegionalBrief.call(
    owner,
    {
      status: 'ok',
      newsStatus: 'ok',
      newsSource: 'wire',
      place: { label: 'Austin, Texas' },
      articles: Array.from({ length: 5 }, (_, index) => ({
        url: `https://example.com/${index}`,
        title: `Story ${index}`,
        domain: 'example.com',
        // Newest first is the shown order, so Story 0 is the newest.
        publishedAt: new Date(Date.now() - index * 60_000).toISOString(),
      })),
      weather: {
        temperatureC: 21.6,
        windKph: 12.2,
        windDirectionDeg: 90,
        weatherCode: 61,
        cloudCoverPct: 40,
        precipitationMm: 1.25,
      },
    },
    INFO,
  );
  await nextTick();
  assert.equal($('#cockpit-news-status').hidden, true);
  const links = [...document.querySelectorAll('#cockpit-news-list li a')];
  assert.deepEqual(
    links.map((link) => link.querySelector('strong').textContent),
    ['Story 0', 'Story 1', 'Story 2', 'Story 3'],
  );
  assert.equal(links[0].getAttribute('href'), 'https://example.com/0');
  assert.equal(links[0].target, '_blank');
  assert.equal(links[0].rel, 'noopener noreferrer');
  assert.match(links[0].querySelector('span').textContent, /^example\.com · /);
  assert.equal(text('#cockpit-local-place'), 'AUSTIN, TEXAS');
  assert.equal(text('#cockpit-local-temperature'), '22°C');
  assert.equal(text('#cockpit-local-wind'), '12 KM/H');
  assert.equal(text('#cockpit-local-condition'), 'RAIN');
  assert.equal(text('#cockpit-local-cloud'), 'CLOUD 40%');
  assert.equal(text('#cockpit-local-precipitation'), '1.3');
  assert.equal(text('#cockpit-brief-source'), 'WIRE · LAST 24 H');
  assert.equal($('#cockpit-signal-stream').dataset.regionalStatus, 'ok');
  renderRegionalBriefStatus.call(owner, 'unavailable', {});
  await nextTick();
  assert.equal($('#cockpit-news-status').hidden, false);
  assert.equal(text('#cockpit-news-status'), 'REGIONAL NEWS UNAVAILABLE');
  assert.equal(document.querySelectorAll('#cockpit-news-list li').length, 0);
  assert.equal(text('#cockpit-local-place'), 'REGION UNAVAILABLE');
  assert.equal(text('#cockpit-local-coordinates'), 'POSITION UNAVAILABLE');
});

// One time for every story: newest-first order then keeps the order a test
// lists them in. A clock read per story could tick between two of them and
// swap them.
const STORY_PUBLISHED_AT = new Date().toISOString();
const story = (id, url = `https://example.com/${id}`) => ({
  url,
  title: `Story ${id}`,
  domain: 'example.com',
  publishedAt: STORY_PUBLISHED_AT,
});

test('a refreshed news list keeps a focused story on its own link', async (t) => {
  const { $, owner } = fixture(t);
  const render = (articles) =>
    renderRegionalBrief.call(owner, { newsStatus: 'ok', articles }, INFO);
  render([story('a'), story('b'), story('c')]);
  await nextTick();
  const link = (title) =>
    [...document.querySelectorAll('#cockpit-news-list a')].find(
      (anchor) => anchor.querySelector('strong').textContent === title,
    );
  const focused = link('Story b');
  focused.focus();
  render([story('b'), story('d'), story('a')]);
  await nextTick();
  // Focus may drop when rows move, as it did when the list was rebuilt,
  // but a link never turns into another story under it.
  assert.equal(link('Story b') === focused, true);
  assert.equal(focused.getAttribute('href'), 'https://example.com/b');
  const active = document.activeElement;
  assert.equal(
    active === focused || !$('#cockpit-news-list').contains(active),
    true,
  );
  // Two stories at one address still render as two rows.
  render([
    story('x', 'https://example.com/same'),
    story('y', 'https://example.com/same'),
  ]);
  await nextTick();
  assert.equal(document.querySelectorAll('#cockpit-news-list li').length, 2);
  assert.equal($('#cockpit-news-list').textContent.includes('Story y'), true);
});

// This contract changed on purpose: the footer used to fall back to a
// static "· RECENT" on every page change, which promised nothing. It now
// follows the news state and names the window it holds articles to.
test('the news footer follows the news state across page changes, not a static RECENT', async (t) => {
  const { text, owner } = fixture(t);
  showBriefPage.call(owner, 1);
  renderRegionalBrief.call(
    owner,
    {
      newsStatus: 'ready',
      newsSource: 'wire',
      newsWindowHours: 24,
      articles: [story('a')],
    },
    INFO,
  );
  await nextTick();
  assert.equal(text('#cockpit-brief-source'), 'WIRE · LAST 24 H');
  showBriefPage.call(owner, 2);
  showBriefPage.call(owner, 1);
  await nextTick();
  assert.equal(text('#cockpit-brief-source'), 'WIRE · LAST 24 H');
  showBriefPage.call(owner, 0);
  renderRegionalBrief.call(
    owner,
    {
      newsStatus: 'ready',
      newsSource: 'wire',
      newsWindowHours: 12,
      articles: [story('a')],
    },
    INFO,
  );
  await nextTick();
  // Off page 2 the footer is the current page's.
  assert.equal(
    text('#cockpit-brief-source'),
    'SOURCE-BACKED EVENTS · NO SYNTHETIC NEWS',
  );
  showBriefPage.call(owner, 1);
  await nextTick();
  assert.equal(text('#cockpit-brief-source'), 'WIRE · LAST 12 H');
});

test('the news banner is hidden by the stylesheet, not only by the attribute', async (t) => {
  // happy-dom applies no author CSS by itself, so `hidden` alone proves
  // nothing: `.cockpit-brief-status { display: grid }` used to beat it.
  const css = readFileSync(
    fileURLToPath(new URL('./styles/cockpit.css', import.meta.url)),
    'utf8',
  );
  assert.match(
    css,
    /\.cockpit-brief-status\[hidden\]\s*\{\s*display:\s*none;?\s*\}/,
  );
  const { $, owner } = fixture(t);
  const style = document.head.appendChild(document.createElement('style'));
  t.after(() => style.remove());
  style.textContent = css;
  showBriefPage.call(owner, 1);
  renderRegionalBrief.call(
    owner,
    { newsStatus: 'ready', articles: [story('a')] },
    INFO,
  );
  await nextTick();
  const banner = $('#cockpit-news-status');
  assert.equal(banner.hidden, true);
  assert.equal(getComputedStyle(banner).display, 'none');
  renderRegionalBrief.call(owner, { newsStatus: 'empty', articles: [] }, INFO);
  await nextTick();
  assert.equal(getComputedStyle(banner).display, 'grid');
});

const hoursAgo = (hours) =>
  new Date(Date.now() - hours * 3_600_000).toISOString();

test('ready, cached, empty and unavailable each label the news differently', async (t) => {
  const { $, text, owner } = fixture(t);
  showBriefPage.call(owner, 1);
  const rows = () =>
    [...document.querySelectorAll('#cockpit-news-list strong')].map(
      (row) => row.textContent,
    );
  const banner = () => ({
    hidden: $('#cockpit-news-status').hidden,
    state: $('#cockpit-news-status').dataset.state,
    text: text('#cockpit-news-status'),
  });
  const ready = {
    status: 'ready',
    newsStatus: 'ready',
    newsSource: 'Google News RSS',
    newsWindowHours: 24,
    newsFetchedAt: hoursAgo(0.5),
    articles: [story('a'), story('b')],
  };
  renderRegionalBrief.call(owner, ready, INFO);
  await nextTick();
  assert.equal(banner().hidden, true);
  assert.equal(banner().state, 'ready');
  assert.deepEqual(rows(), ['Story a', 'Story b']);
  assert.equal(text('#cockpit-brief-source'), 'GOOGLE NEWS RSS · LAST 24 H');

  // The local proxy's stale answer is a refresh that failed.
  renderRegionalBrief.call(owner, { ...ready, status: 'stale' }, INFO);
  await nextTick();
  assert.deepEqual(banner(), {
    hidden: false,
    state: 'cached',
    text: 'CACHED · REFRESH FAILED',
  });
  assert.deepEqual(rows(), ['Story a', 'Story b']);
  assert.equal(
    text('#cockpit-brief-source'),
    'GOOGLE NEWS RSS · CACHED 30M AGO',
  );

  renderRegionalBrief.call(
    owner,
    {
      ...ready,
      newsStatus: 'empty',
      newsSource: 'Google News RSS',
      articles: [],
    },
    INFO,
  );
  await nextTick();
  assert.deepEqual(banner(), {
    hidden: false,
    state: 'empty',
    text: 'NO NEWS IN THE LAST 24 H',
  });
  assert.deepEqual(rows(), []);

  renderRegionalBrief.call(
    owner,
    { ...ready, newsStatus: 'unavailable', newsSource: null, articles: [] },
    INFO,
  );
  await nextTick();
  assert.deepEqual(banner(), {
    hidden: false,
    state: 'unavailable',
    text: 'REGIONAL NEWS UNAVAILABLE',
  });
  assert.deepEqual(rows(), []);
});

test('articles outside the window are dropped even when a server sends them', async (t) => {
  const { $, text, owner } = fixture(t);
  showBriefPage.call(owner, 1);
  const dated = (id, publishedAt) => ({ ...story(id), publishedAt });
  // The reported case: 4, 104, 215 and 165 days old under "RECENT".
  renderRegionalBrief.call(
    owner,
    {
      newsStatus: 'ready',
      articles: [
        dated('old', hoursAgo(4 * 24)),
        dated('older', hoursAgo(104 * 24)),
        dated('undated', null),
        dated('one', hoursAgo(20)),
        dated('two', hoursAgo(2)),
      ],
    },
    INFO,
  );
  await nextTick();
  assert.deepEqual(
    [...document.querySelectorAll('#cockpit-news-list strong')].map(
      (row) => row.textContent,
    ),
    ['Story two', 'Story one'],
  );
  assert.equal($('#cockpit-news-status').hidden, true);
  renderRegionalBrief.call(
    owner,
    { newsStatus: 'ready', articles: [dated('old', hoursAgo(25))] },
    INFO,
  );
  await nextTick();
  assert.equal(document.querySelectorAll('#cockpit-news-list li').length, 0);
  assert.equal(text('#cockpit-news-status'), 'NO NEWS IN THE LAST 24 H');
});

test('a failed refresh keeps the earlier articles as cached, and clears only when there are none', async (t) => {
  const { $, text, owner } = fixture(t);
  const answers = [];
  Object.assign(owner, {
    active: true,
    regionalBriefSubjectId: null,
    regionalBriefAbort: null,
    regionalBriefRequestToken: 0,
    regionalBriefFetchedAt: 0,
    regionalBrief: null,
    renderRegionalBrief,
    renderRegionalBriefStatus,
  });
  owner.services = {
    ...owner.services,
    regionalDistanceM: () => 0,
    fetchRegionalBrief: () => answers.shift()(),
  };
  const refresh = async (answer, info = { ...INFO, icao24: 'abc123' }) => {
    answers.push(answer);
    owner.regionalBriefFetchedAt = 0;
    maybeRefreshRegionalBrief.call(owner, info);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();
  };
  const rows = () => document.querySelectorAll('#cockpit-news-list li').length;
  showBriefPage.call(owner, 1);

  // No earlier brief: an error clears and says unavailable.
  await refresh(() => Promise.reject(new Error('503')));
  assert.equal($('#cockpit-news-status').dataset.state, 'unavailable');
  assert.equal(text('#cockpit-news-status'), 'REGIONAL NEWS UNAVAILABLE');
  assert.equal(rows(), 0);

  const fetchedAt = hoursAgo(1);
  await refresh(() =>
    Promise.resolve({
      status: 'ready',
      newsStatus: 'ready',
      newsSource: 'Google News RSS',
      newsWindowHours: 24,
      newsFetchedAt: fetchedAt,
      articles: [story('a'), story('b')],
    }),
  );
  assert.equal($('#cockpit-news-status').hidden, true);
  assert.equal(rows(), 2);

  // A network failure keeps the rows and says so, with their age.
  await refresh(() => Promise.reject(new TypeError('Failed to fetch')));
  assert.equal($('#cockpit-news-status').hidden, false);
  assert.equal(text('#cockpit-news-status'), 'CACHED · REFRESH FAILED');
  assert.equal(rows(), 2);
  assert.equal(
    text('#cockpit-brief-source'),
    'GOOGLE NEWS RSS · CACHED 1H AGO',
  );
  showBriefPage.call(owner, 2);
  showBriefPage.call(owner, 1);
  await nextTick();
  assert.equal(
    text('#cockpit-brief-source'),
    'GOOGLE NEWS RSS · CACHED 1H AGO',
  );

  // So does a brief whose news read failed while weather answered.
  await refresh(() =>
    Promise.resolve({
      status: 'partial',
      newsStatus: 'unavailable',
      articles: [],
    }),
  );
  assert.equal(text('#cockpit-news-status'), 'CACHED · REFRESH FAILED');
  assert.equal(rows(), 2);

  // A successful refresh clears the cached label; a true empty clears rows.
  await refresh(() =>
    Promise.resolve({
      status: 'ready',
      newsStatus: 'empty',
      newsSource: 'Google News RSS',
      articles: [],
    }),
  );
  assert.equal(text('#cockpit-news-status'), 'NO NEWS IN THE LAST 24 H');
  assert.equal(rows(), 0);
  assert.equal(text('#cockpit-brief-source'), 'GOOGLE NEWS RSS · LAST 24 H');

  // Another aircraft never inherits the last one's rows.
  await refresh(() =>
    Promise.resolve({ newsStatus: 'ready', articles: [story('c')] }),
  );
  assert.equal(rows(), 1);
  await refresh(() => Promise.reject(new Error('503')), {
    ...INFO,
    icao24: 'def456',
  });
  assert.equal(text('#cockpit-news-status'), 'REGIONAL NEWS UNAVAILABLE');
  assert.equal(rows(), 0);
});

test('an unchanged position publishes nothing new', (t) => {
  const { owner } = fixture(t);
  const views = [];
  owner.publishBrief = (view) => views.push(view);
  updateLocalPosition.call(owner, INFO);
  updateLocalPosition.call(owner, INFO);
  assert.equal(views.length, 1);
});

test('the route card sits in the briefing card, hidden until a route', (t) => {
  const { $ } = fixture(t);
  const route = $('#cockpit-signal-stream > #cockpit-route');
  assert.equal(route?.hidden, true);
});

test('the card is labelled in the UI language', async (t) => {
  t.after(() => setLocale('en'));
  setLocale('ru');
  const { $, text, owner } = fixture(t);
  const auto = $('#cockpit-brief-auto');
  assert.equal(text('#cockpit-brief-kicker'), 'СИГНАЛЫ ОНЛАЙН');
  assert.equal(auto.textContent, 'АВТО: ВЫКЛ');
  assert.equal(auto.getAttribute('aria-label'), 'АВТО: ВЫКЛ');
  assert.match(auto.title, /^Автоматически листать/);
  showBriefPage.call(owner, 1);
  await nextTick();
  assert.equal(text('#cockpit-brief-kicker'), 'НОВОСТИ РЕГИОНА');
});

test('the card and its toggle render the collapse the controller presents', async (t) => {
  const { $, owner } = fixture(t);
  const store = useCockpitStore();
  Object.assign(owner, {
    active: true,
    signalCollapsed: false,
    presence: { active: true, signalCollapsed: false },
    publishPresenceView: () => store.publishPresence({ ...owner.presence }),
  });
  const card = $('#cockpit-signal-stream');
  const toggle = $('#cockpit-signal-toggle');
  assert.equal(card.hasAttribute('data-collapsed'), false);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  setSignalCollapsed.call(owner, true, { user: true });
  await nextTick();
  assert.equal(card.dataset.collapsed, 'true');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(
    toggle.getAttribute('aria-label'),
    'Expand cockpit briefing panel',
  );
  assert.equal(toggle.title, 'Expand briefing panel');
  assert.equal(toggle.textContent.trim(), 'right_panel_open');
  assert.equal(owner.signalUserCollapsed, true);
  setSignalCollapsed.call(owner, false);
  await nextTick();
  assert.equal(card.dataset.collapsed, 'false');
  assert.equal(toggle.textContent.trim(), 'right_panel_close');
});

test("a refresh that fails after a move never shows the last location's brief as current", async (t) => {
  const { $, text, owner } = fixture(t);
  const answers = [];
  Object.assign(owner, {
    active: true,
    regionalBriefSubjectId: null,
    regionalBriefAbort: null,
    regionalBriefRequestToken: 0,
    regionalBriefFetchedAt: 0,
    regionalBrief: null,
    renderRegionalBrief,
    renderRegionalBriefStatus,
  });
  owner.services = {
    ...owner.services,
    // One degree of latitude stands for a move past the refresh distance.
    regionalDistanceM: (from, to) =>
      from ? Math.abs(from.latitude - to.latitude) * 111_000 : Infinity,
    fetchRegionalBrief: () => answers.shift()(),
  };
  const refresh = async (answer, latitude) => {
    answers.push(answer);
    owner.regionalBriefFetchedAt = 0;
    maybeRefreshRegionalBrief.call(owner, {
      ...INFO,
      icao24: 'abc123',
      latitude,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();
  };
  const rows = () => document.querySelectorAll('#cockpit-news-list li').length;
  const here = () =>
    Promise.resolve({
      status: 'ready',
      newsStatus: 'ready',
      newsSource: 'Google News RSS',
      newsWindowHours: 24,
      newsFetchedAt: hoursAgo(1),
      articles: [story('a'), story('b')],
    });
  showBriefPage.call(owner, 1);

  await refresh(here, 40);
  assert.equal(rows(), 2);
  // The same place: a failed refresh keeps the rows as cached.
  await refresh(() => Promise.reject(new TypeError('Failed to fetch')), 40);
  assert.equal(text('#cockpit-news-status'), 'CACHED · REFRESH FAILED');
  assert.equal(rows(), 2);
  // Elsewhere: the brief is unavailable, as it was before there was a cache.
  await refresh(() => Promise.reject(new TypeError('Failed to fetch')), 45);
  assert.equal($('#cockpit-news-status').dataset.state, 'unavailable');
  assert.equal(rows(), 0);
  // Nor is it held, for a language change to show again.
  assert.equal(owner.regionalBrief, null);

  // Nor does a brief there whose news read failed borrow the last place's rows.
  await refresh(here, 40);
  assert.equal(rows(), 2);
  await refresh(
    () =>
      Promise.resolve({
        status: 'partial',
        newsStatus: 'unavailable',
        articles: [],
      }),
    45,
  );
  assert.equal($('#cockpit-news-status').dataset.state, 'unavailable');
  assert.equal(rows(), 0);
});
