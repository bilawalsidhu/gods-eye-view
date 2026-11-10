// src/ui/cockpitBriefing.test.mjs — the Cockpit briefing card renders what
// the Cockpit controller presents, over happy-dom.
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia } from 'pinia';
import { createApp, nextTick } from 'vue';
import { setLocale } from '../i18n/index.js';
import { createBriefState } from './cockpitBriefPages.js';
import {
  publishBriefView,
  renderRegionalBrief,
  renderRegionalBriefStatus,
  setBriefAutoRotate,
  showBriefPage,
  updateLocalPosition,
} from './cockpitBriefing.js';
import { setSignalCollapsed } from './cockpitLayout.js';
import { useCockpitStore } from './stores/cockpit.js';
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
    brief: createBriefState(),
    publishBrief: (view) => store.publishBrief(view),
    publishBriefView,
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
  const current = () =>
    [...document.querySelectorAll('[data-cockpit-brief-index]')].map((tab) =>
      tab.getAttribute('aria-current'),
    );
  return { $, text, owner, visiblePages, current };
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
  assert.equal(
    text('#cockpit-brief-source'),
    'GOOGLE NEWS RSS · LOCATION QUERY · RECENT',
  );
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
        publishedAt: new Date().toISOString(),
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
  assert.equal(text('#cockpit-brief-source'), 'WIRE · LOCATION QUERY');
  assert.equal($('#cockpit-signal-stream').dataset.regionalStatus, 'ok');
  renderRegionalBriefStatus.call(owner, 'unavailable', {});
  await nextTick();
  assert.equal($('#cockpit-news-status').hidden, false);
  assert.equal(text('#cockpit-news-status'), 'REGIONAL NEWS UNAVAILABLE');
  assert.equal(document.querySelectorAll('#cockpit-news-list li').length, 0);
  assert.equal(text('#cockpit-local-place'), 'REGION UNAVAILABLE');
  assert.equal(text('#cockpit-local-coordinates'), 'POSITION UNAVAILABLE');
});

const story = (id, url = `https://example.com/${id}`) => ({
  url,
  title: `Story ${id}`,
  domain: 'example.com',
  publishedAt: new Date().toISOString(),
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

test('the news source names the feed only while it is current on page 2', async (t) => {
  const { text, owner } = fixture(t);
  showBriefPage.call(owner, 1);
  renderRegionalBrief.call(owner, { newsSource: 'wire', articles: [] }, INFO);
  await nextTick();
  assert.equal(text('#cockpit-brief-source'), 'WIRE · LOCATION QUERY');
  showBriefPage.call(owner, 2);
  showBriefPage.call(owner, 1);
  await nextTick();
  assert.equal(
    text('#cockpit-brief-source'),
    'GOOGLE NEWS RSS · LOCATION QUERY · RECENT',
  );
  showBriefPage.call(owner, 0);
  renderRegionalBrief.call(owner, { newsSource: 'wire', articles: [] }, INFO);
  await nextTick();
  assert.equal(
    text('#cockpit-brief-source'),
    'SOURCE-BACKED EVENTS · NO SYNTHETIC NEWS',
  );
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
  assert.equal(toggle.getAttribute('aria-label'), 'Expand cockpit briefing panel');
  assert.equal(toggle.title, 'Expand briefing panel');
  assert.equal(toggle.textContent.trim(), 'right_panel_open');
  assert.equal(owner.signalUserCollapsed, true);
  setSignalCollapsed.call(owner, false);
  await nextTick();
  assert.equal(card.dataset.collapsed, 'false');
  assert.equal(toggle.textContent.trim(), 'right_panel_close');
});
