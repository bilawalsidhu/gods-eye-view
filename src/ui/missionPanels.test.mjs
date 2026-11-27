// src/ui/missionPanels.test.mjs — the selected Space Mission renders what
// the launches layer publishes (`subscribePanel()`), over happy-dom.
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia } from 'pinia';
import { createApp, h, nextTick } from 'vue';
import { usePinnedStore } from './stores/pinned.js';
import { useSpaceMissionsStore } from './stores/spaceMissions.js';
import MissionDetail from './views/panels/MissionDetail.vue';

function fixture(t) {
  document.body.replaceChildren();
  // Context's scroller, which holds the Missions list.
  const scroller = document.body.appendChild(document.createElement('div'));
  scroller.className = 'global-context-panel-inner';
  const host = scroller.appendChild(document.createElement('div'));
  const pinia = createPinia();
  const app = createApp({
    render: () => h(MissionDetail),
  }).use(pinia);
  app.mount(host);
  t.after(() => app.unmount());
  const store = useSpaceMissionsStore(pinia);
  const calls = [];
  const record =
    (name) =>
    (...args) =>
      calls.push([name, ...args]);
  store.connect({
    selectMissionAt: record('select'),
    deselectMission: record('deselect'),
    focusSelectedLaunchSite: record('focus'),
    startSelectedReplay: record('replay'),
    toggleReplayPause: record('toggle'),
    cancelReplay: record('cancel'),
    setReplaySpeed: record('speed'),
  });
  const $ = (selector) => document.querySelector(selector);
  const publish = async (view) => {
    store.publish(view);
    await nextTick();
    await nextTick();
  };
  return { $, publish, calls, scroller, pinia };
}

const replay = (extra = {}) => ({
  available: true,
  active: false,
  paused: false,
  toggleText: 'Ⅱ',
  toggleLabel: 'Pause replay',
  transportLabel: null,
  speed: '1',
  speedText: '1×',
  speedProgress: '20%',
  ...extra,
});

const mission = (extra = {}) => ({
  id: 'starlink-12-3',
  scrollRequest: 1,
  lat: 28.56,
  lon: -80.58,
  title: 'STARLINK 12-3',
  provider: 'SpaceX',
  status: 'Go for Launch',
  site: null,
  time: '2026-11-01T10:00:00Z',
  when: 'Nov 1, 2026, 10:00 AM UTC',
  orbit: 'LEO',
  ascent: 'ESTIMATED',
  distance: '410 KM',
  speed: '7.66 KM/S',
  speedTitle: '27,576 km/h',
  payloads: [],
  payloadsMore: null,
  stages: [],
  replay: replay(),
  ...extra,
});

test('the selected mission reads as an item card: map, name and status, actions, figures, details', async (t) => {
  const { $, publish } = fixture(t);
  await publish({ roster: null, mission: mission() });
  const panel = $('#space-mission-panel');
  assert.equal(panel.hidden, false);
  // The top image is the launch site's close-up map.
  assert.equal($('.entity-hero').dataset.hero, 'map');
  assert.notEqual($('.entity-hero .close-up-map'), null);
  assert.equal($('.close-up-map__icon').textContent, 'rocket_launch');
  assert.equal($('[data-mission-title]').textContent, 'STARLINK 12-3');
  assert.equal($('[data-mission-provider]').textContent, 'SpaceX');
  assert.equal($('[data-mission-status]').textContent, 'Go for Launch');
  assert.deepEqual(
    [...panel.querySelectorAll('.entity-card__action-row > button')].map(
      (button) => button.textContent.replace(/^[a-z_]+/, ''),
    ),
    ['Replay', 'Fly to', 'Pin'],
  );
  assert.deepEqual(
    [...panel.querySelectorAll('[data-mission-tile]')].map((tile) => [
      tile.dataset.missionTile,
      tile.querySelector('span').textContent,
      tile.querySelector('strong').textContent,
    ]),
    [
      ['time', 'Launch time', 'Nov 1, 2026, 10:00 AM UTC'],
      ['orbit', 'Orbit', 'LEO'],
      ['status', 'Status', 'Go for Launch'],
    ],
  );
  // The card has no stepping of its own: the Data Layers row steps.
  assert.equal(
    panel.querySelector('[data-mission-prev], [data-mission-next]'),
    null,
  );
  assert.equal(panel.querySelector('[data-mission-index]'), null);
  // Payloads and stages sit under More details, open at first.
  const more = $('[data-mission-more]');
  assert.equal(more.open, true);
  assert.equal(more.querySelector('summary').textContent, 'More details');
  assert.equal($('[data-mission-site]'), null);
  assert.equal($('[data-mission-speed]').title, '27,576 km/h');
  assert.equal(
    $('[data-mission-payloads]').textContent,
    'PAYLOAD DATA UNAVAILABLE',
  );
  assert.equal($('[data-mission-stages-section]'), null);
  await publish({
    roster: null,
    mission: mission({
      site: 'SLC-40',
      distance: null,
      when: null,
      orbit: null,
      payloads: [
        {
          name: 'Sat ×2',
          detail: 'Maker · 500 KG',
          type: 'Comms',
          destination: 'GTO',
        },
      ],
      payloadsMore: '+1 additional payload records',
      stages: [
        {
          name: 'B1080',
          detail: 'FLIGHT 9',
          status: 'Landed',
          destination: 'ASOG',
          position: '28.40, -77.10 · DRONESHIP',
        },
      ],
    }),
  });
  assert.equal($('[data-mission-site]').textContent, 'SLC-40');
  assert.equal($('[data-mission-distance]'), null);
  // A missing figure drops its tile; the raw time stands in for the formatted one.
  assert.deepEqual(
    [...panel.querySelectorAll('[data-mission-tile]')].map(
      (tile) => tile.querySelector('strong').textContent,
    ),
    ['2026-11-01T10:00:00Z', 'Go for Launch'],
  );
  const rows = [...$('[data-mission-payloads]').querySelectorAll('tr')].map(
    (row) => row.textContent,
  );
  assert.deepEqual(rows, [
    'Sat ×2Maker · 500 KGCommsGTO',
    '+1 additional payload records',
  ]);
  assert.equal(
    $('[data-mission-stages]').textContent,
    'B1080FLIGHT 9LandedASOG28.40, -77.10 · DRONESHIP',
  );
  // A launch with no site position has no map and nothing to pin.
  await publish({ roster: null, mission: mission({ lat: null, lon: null }) });
  assert.equal($('.entity-hero'), null);
  assert.equal($('[data-mission-pin]'), null);
  await publish({ roster: null, mission: null });
  assert.equal(panel.hidden, true);
});

test('Pin keeps the launch site as a place on the Pinned tab', async (t) => {
  const { $, publish, pinia } = fixture(t);
  const pinned = usePinnedStore(pinia);
  await publish({ roster: null, mission: mission({ site: 'SLC-40' }) });
  const pin = $('[data-mission-pin]');
  assert.equal(pin.getAttribute('aria-pressed'), 'false');
  pin.click();
  await nextTick();
  assert.equal(pinned.pins.length, 1);
  const [entry] = pinned.pins;
  assert.equal(entry.kind, 'place');
  assert.equal(entry.title, 'SLC-40');
  assert.equal(entry.identity.layerId, 'place');
  assert.equal(entry.identity.lat, 28.56);
  assert.equal(entry.identity.lon, -80.58);
  assert.equal(pin.getAttribute('aria-pressed'), 'true');
  assert.match(pin.textContent, /Pinned$/);
  pin.click();
  await nextTick();
  assert.equal(pinned.pins.length, 0);
  assert.equal(pin.getAttribute('aria-pressed'), 'false');
});

test('the replay controls follow the layer and call its commands', async (t) => {
  const { $, publish, calls } = fixture(t);
  await publish({
    roster: null,
    mission: mission({ replay: replay({ available: false }) }),
  });
  assert.equal($('[data-mission-replay]'), null);
  assert.equal($('.mission-replay-speed-control').hidden, true);
  await publish({ roster: null, mission: mission() });
  assert.equal($('[data-mission-replay-transport]'), null);
  $('[data-mission-replay]').click();
  await publish({
    roster: null,
    mission: mission({
      replay: replay({
        active: true,
        paused: true,
        toggleText: '▶',
        toggleLabel: 'Resume replay',
        transportLabel: 'Liftoff, paused',
        speed: '2.5',
        speedText: '2.50×',
        speedProgress: '60%',
      }),
    }),
  });
  // While it runs, the replay is the top image and pause and cancel take
  // Replay's place.
  assert.equal($('.entity-hero').dataset.hero, 'replay');
  assert.match($('[data-mission-replay-hero]').textContent, /Liftoff, paused/);
  assert.match(
    $('[data-mission-replay-hero]').textContent,
    /410 KM · 7.66 KM\/S/,
  );
  assert.equal($('[data-mission-replay]'), null);
  const transport = $('[data-mission-replay-transport]');
  assert.equal(transport.classList.contains('is-paused'), true);
  assert.equal(transport.getAttribute('aria-label'), 'Liftoff, paused');
  assert.equal($('.mission-replay-speed-control').hidden, false);
  const toggle = $('[data-mission-replay-toggle]');
  assert.equal(toggle.textContent, '▶');
  assert.equal(toggle.getAttribute('aria-label'), 'Resume replay');
  const speed = $('[data-mission-replay-speed]');
  assert.equal(speed.value, '2.5');
  assert.equal(speed.style.getPropertyValue('--replay-speed-progress'), '60%');
  assert.equal($('[data-mission-replay-speed-output]').textContent, '2.50×');
  toggle.click();
  $('[data-mission-replay-cancel]').click();
  speed.value = '3';
  speed.dispatchEvent(new Event('input'));
  $('[data-mission-focus]').click();
  assert.deepEqual(calls, [
    ['replay'],
    ['toggle'],
    ['cancel'],
    ['speed', 3],
    ['focus'],
  ]);
});

test('each newly presented selection returns Context to the top', async (t) => {
  const { publish, scroller } = fixture(t);
  scroller.scrollTop = 120;
  await publish({ roster: null, mission: mission({ scrollRequest: 4 }) });
  assert.equal(scroller.scrollTop, 0);
  scroller.scrollTop = 80;
  await publish({
    roster: null,
    mission: mission({ scrollRequest: 4, distance: '412 KM' }),
  });
  assert.equal(scroller.scrollTop, 80);
  await publish({ roster: null, mission: mission({ scrollRequest: 5 }) });
  assert.equal(scroller.scrollTop, 0);
});

test('the card has no close of its own (its list card’s Back lets it go); a layer that stops presenting hides it', async (t) => {
  const { $, publish } = fixture(t);
  await publish({ roster: null, mission: mission() });
  assert.equal($('[data-mission-close]'), null);
  await publish({ roster: null, mission: null });
  assert.equal($('#space-mission-panel').hidden, true);
});

test('More details opens for each mission as it shows, and stays folded while the same one stays', async (t) => {
  const { $, publish } = fixture(t);
  await publish({ roster: null, mission: mission() });
  const more = $('[data-mission-more]');
  assert.equal(more.open, true);
  more.open = false;
  await publish({ roster: null, mission: mission({ distance: '412 KM' }) });
  assert.equal($('[data-mission-more]').open, false, 'the same mission');
  await publish({ roster: null, mission: mission({ id: 'other-mission' }) });
  assert.equal($('[data-mission-more]').open, true, 'the next mission');
});
