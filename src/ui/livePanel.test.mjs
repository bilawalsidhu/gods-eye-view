// src/ui/livePanel.test.mjs — the LIVE panel renders what LiveControls
// publishes, over happy-dom; it starts the stream as soon as one is chosen,
// collapsed or not, and its controls reach the store's owner.
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia } from 'pinia';
import { createApp, nextTick } from 'vue';
import { useLiveStore } from './stores/live.js';
import { usePanelChromeStore } from './stores/panelChrome.js';
import LivePanel from './views/panels/LivePanel.vue';

const settle = async () => {
  await nextTick();
  await nextTick();
};

function fixture(t) {
  document.body.replaceChildren();
  const host = document.body.appendChild(document.createElement('div'));
  const pinia = createPinia();
  const app = createApp(LivePanel).use(pinia);
  app.mount(host);
  t.after(() => app.unmount());
  const store = useLiveStore(pinia);
  const acted = [];
  store.connect({
    cycleLive: (direction) => acted.push(['cycle', direction]),
    playLive: () => acted.push(['play']),
    stopLive: () => acted.push(['stop']),
    retryLive: () => acted.push(['retry']),
    hideLive: (where) => acted.push(['hide', where]),
  });
  const chrome = usePanelChromeStore(pinia);
  const token = chrome.connect({ toggle() {}, pin() {} });
  const setOpen = async (open) => {
    chrome.publish(token, 'live-panel', { collapsed: !open });
    await settle();
  };
  const $ = (id) => document.getElementById(id);
  const publish = async (view) => {
    store.publish(
      view && {
        label: 'ISS (ZARYA)',
        streams: [
          { id: 'iss-exterior', title: 'Exterior cameras', owner: 'NASA' },
          {
            id: 'iss-crew',
            title: 'Live video and space-to-ground audio',
            owner: 'NASA',
          },
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
    await settle();
  };
  return { $, publish, acted, setOpen, chrome, token };
}

test('without a view the section is hidden and shows OFF', (t) => {
  const { $, acted } = fixture(t);
  assert.equal($('live-panel').hidden, true);
  assert.equal($('live-badge-text').textContent, 'OFF');
  assert.equal(
    $('live-player-host'),
    null,
    'no screen until a stream is offered',
  );
  assert.deepEqual(acted, [], 'nothing to start');
});

test('a view shows the subject, the stream and Play under the IP notice, and loads nothing by itself', async (t) => {
  const { $, publish, acted } = fixture(t);
  await publish({});
  const panel = $('live-panel');
  assert.equal(panel.hidden, false);
  assert.equal(panel.querySelector('.live-subject').textContent, 'ISS (ZARYA)');
  assert.equal($('live-stream-title').textContent, 'Exterior cameras · 1/2');
  assert.ok($('live-previous-btn'));
  assert.ok($('live-next-btn'));
  assert.ok($('live-player-host'), 'the screen is in the page for the player');
  assert.equal(
    $('live-watch-link').getAttribute('href'),
    'https://www.youtube.com/watch?v=ROboUHfPUrU',
  );
  assert.equal($('live-watch-link').getAttribute('rel'), 'noopener noreferrer');
  assert.deepEqual(acted, [], 'selecting the station loads no player');
  // The notice that YouTube sees the viewer's IP address comes before Play.
  const notice = panel.querySelector('.live-privacy');
  const play = $('live-play-btn');
  assert.ok(notice && play);
  assert.match(notice.textContent, /sees your IP address/);
  assert.equal(
    notice.compareDocumentPosition(play) & Node.DOCUMENT_POSITION_FOLLOWING,
    Node.DOCUMENT_POSITION_FOLLOWING,
    'the notice is above Play',
  );
  assert.equal($('live-status').textContent, 'Click to play');
  play.click();
  assert.deepEqual(acted, [['play']], 'Play is what loads the player');
  // Loading and playing hide Play and ask for nothing more.
  await publish({ state: 'loading' });
  assert.equal($('live-play-btn'), null);
  await publish({ state: 'playing' });
  assert.deepEqual(acted, [['play']]);
});

test('a different stream chosen while idle waits for Play too', async (t) => {
  const { $, publish, acted } = fixture(t);
  await publish({});
  await publish({
    current: {
      id: 'iss-crew',
      title: 'Live video and space-to-ground audio',
      owner: 'NASA',
      ownerUrl: 'https://www.youtube.com/@NASA',
      note: '',
      watchUrl: 'https://www.youtube.com/watch?v=M3HKLzjvKPc',
    },
    index: 1,
  });
  assert.deepEqual(acted, []);
  assert.ok($('live-play-btn'));
});

test('collapsing the section, or Context, stops the player; opening it starts nothing', async (t) => {
  const { $, publish, acted, setOpen, chrome, token } = fixture(t);
  await setOpen(true);
  await publish({ state: 'playing' });
  assert.deepEqual(acted, [], 'already playing: nothing to start');
  await setOpen(false);
  assert.deepEqual(acted, [['hide', 'section']], 'nothing plays unseen');
  assert.ok($('live-player-host'), 'the screen keeps its element');
  await setOpen(true);
  assert.deepEqual(acted, [['hide', 'section']], 'opening starts nothing');
  chrome.publish(token, 'global-context-panel', { collapsed: true });
  await settle();
  assert.deepEqual(acted, [
    ['hide', 'section'],
    ['hide', 'section'],
  ]);
});

test('while playing the badge says ON AIR with the blinking dot, and there is no card', async (t) => {
  const { $, publish } = fixture(t);
  await publish({ state: 'playing' });
  const panel = $('live-panel');
  assert.equal(panel.classList.contains('live-on-air'), true);
  assert.equal($('live-badge-text').textContent, 'ON AIR');
  assert.equal(
    panel.querySelector('.live-dot').classList.contains('on-air'),
    true,
  );
  assert.equal(
    panel.querySelector('.live-screen').classList.contains('active'),
    true,
  );
  assert.equal(panel.querySelector('.live-card'), null);
  assert.equal($('live-status').textContent, 'Live');
});

test('starting shows the waiting dot and says LOADING', async (t) => {
  const { $, publish } = fixture(t);
  await publish({ state: 'loading' });
  assert.equal($('live-badge-text').textContent, 'LOADING');
  assert.equal(
    $('live-panel').querySelector('.live-dot').classList.contains('waiting'),
    true,
  );
  assert.equal($('live-status').textContent, 'Starting…');
});

test('an offline stream shows the fallback card with Try again, and is not restarted by itself', async (t) => {
  const { $, publish, acted } = fixture(t);
  await publish({ state: 'offline', reason: 'timeout' });
  const card = $('live-panel').querySelector('.live-card');
  assert.equal(card.classList.contains('offline'), true);
  assert.equal(card.querySelector('strong').textContent, 'Stream is offline');
  assert.equal($('live-status').textContent, 'Stream is offline');
  assert.deepEqual(acted, [], 'offline is left to Try again');
  $('live-retry-btn').click();
  assert.deepEqual(acted, [['retry']]);
});

test('a stream that cannot be embedded says so, without Try again', async (t) => {
  const { $, publish, acted } = fixture(t);
  await publish({ state: 'unavailable', reason: 'error-150' });
  const card = $('live-panel').querySelector('.live-card');
  assert.equal(card.classList.contains('unavailable'), true);
  assert.equal(
    card.querySelector('strong').textContent,
    'This stream cannot play here',
  );
  assert.equal($('live-retry-btn'), null);
  assert.equal($('live-status').textContent, 'This stream cannot play here');
  assert.deepEqual(acted, []);
});

test('the arrows step through the streams', async (t) => {
  const { $, publish, acted } = fixture(t);
  await publish({ state: 'playing' });
  $('live-next-btn').click();
  $('live-previous-btn').click();
  assert.deepEqual(acted, [
    ['cycle', 1],
    ['cycle', -1],
  ]);
});

test('with one stream there are no arrows and no counter', async (t) => {
  const { $, publish } = fixture(t);
  await publish({
    count: 1,
    streams: [{ id: 'iss-exterior', title: 'Exterior cameras', owner: 'NASA' }],
  });
  assert.equal($('live-previous-btn'), null);
  assert.equal($('live-next-btn'), null);
  assert.equal($('live-stream-title').textContent, 'Exterior cameras');
});

test('publishing null hides the section again', async (t) => {
  const { $, publish } = fixture(t);
  await publish({});
  await publish(null);
  assert.equal($('live-panel').hidden, true);
});

test('a language change keeps the same screen element and neither stops nor restarts the stream', async (t) => {
  // The player is built into #live-player-host by LiveControls, outside Vue.
  // A locale change re-renders the panel's words; the screen must be the
  // same element afterwards, with nothing asked of the owner, or the stream
  // would be torn down and rebuilt with every language switch.
  const { getLocale, setLocale } = await import('../i18n/index.js');
  const originalLocale = getLocale();
  t.after(() => setLocale(originalLocale));
  const { $, publish, acted } = fixture(t);
  await publish({ state: 'playing' });
  const screen = $('live-player-host');
  assert.ok(screen, 'the screen is in the page while a stream is offered');
  const marker = screen.appendChild(document.createElement('span'));
  const askedBefore = acted.length;
  setLocale(originalLocale === 'fr' ? 'es' : 'fr');
  await settle();
  assert.equal($('live-player-host'), screen, 'the same screen element');
  assert.equal(marker.parentNode, screen, 'what LiveControls put in it stays');
  assert.equal(acted.length, askedBefore, 'no play, stop or retry asked');
  assert.equal($('live-panel').hidden, false);
});
