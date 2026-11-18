// src/ui/missionPanels.test.mjs — the Space Missions roster and selected
// mission render what the launches layer publishes (`subscribePanel()`),
// over happy-dom.
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia } from 'pinia';
import { createApp, h, nextTick } from 'vue';
import { useContextStore } from './stores/context.js';
import MissionDetail from './views/panels/MissionDetail.vue';
import MissionRoster from './views/panels/MissionRoster.vue';

function fixture(t) {
  document.body.replaceChildren();
  const scroller = document.body.appendChild(document.createElement('div'));
  scroller.className = 'global-context-panel-inner';
  const host = scroller.appendChild(document.createElement('div'));
  const pinia = createPinia();
  const app = createApp({
    render: () => [h(MissionRoster), h(MissionDetail)],
  }).use(pinia);
  app.mount(host);
  t.after(() => app.unmount());
  const store = useContextStore(pinia);
  const calls = [];
  const record =
    (name) =>
    (...args) =>
      calls.push([name, ...args]);
  store.connectMissions({
    selectMissionAt: record('select'),
    selectPreviousMission: record('previous'),
    selectNextMission: record('next'),
    deselectMission: record('deselect'),
    focusSelectedLaunchSite: record('focus'),
    startSelectedReplay: record('replay'),
    toggleReplayPause: record('toggle'),
    cancelReplay: record('cancel'),
    setReplaySpeed: record('speed'),
    rosterPointerEnter: record('pointer-enter'),
    rosterPointerLeave: record('pointer-leave'),
    rosterFocus: record('focus-row'),
    rosterBlur: record('blur-row'),
  });
  const $ = (selector) => document.querySelector(selector);
  const publish = async (view) => {
    store.publishMissions(view);
    await nextTick();
    await nextTick();
  };
  return { $, publish, calls, scroller };
}

const entry = (id, index, label = id.toUpperCase()) => ({
  index,
  id,
  color: 'rgb(1, 2, 3)',
  label,
  ariaLabel: `Select ${label}`,
  provider: 'SpaceX',
  date: '2026-11-01',
});

const roster = (entries) => ({
  count: `${entries.length} / 30D`,
  entries,
  empty: 'NONE IN WINDOW',
});

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
  scrollRequest: 1,
  title: 'STARLINK 12-3',
  provider: 'SpaceX',
  status: 'Go for Launch',
  site: null,
  time: '2026-11-01T10:00:00Z',
  orbit: 'LEO',
  ascent: 'ESTIMATED',
  distance: '410 KM',
  speed: '7.66 KM/S',
  speedTitle: '27,576 km/h',
  payloads: [],
  payloadsMore: null,
  stages: [],
  index: '2 / 5',
  previousDisabled: false,
  nextDisabled: true,
  replay: replay(),
  ...extra,
});

test('before the layer presents, the roster loads and no mission shows', (t) => {
  const { $ } = fixture(t);
  assert.equal($('[data-mission-roster-count]').textContent, '—');
  assert.equal(
    $('.space-mission-roster-empty').textContent,
    'LOADING 30-DAY MISSION INDEX',
  );
  assert.equal($('#space-mission-panel').hidden, true);
  assert.equal($('[data-mission-replay-speed-output]').textContent, '1×');
  assert.equal($('[data-mission-replay-speed]').value, '1');
});

test('the roster lists missions and drives selection and preview', async (t) => {
  const { $, publish, calls } = fixture(t);
  await publish({
    roster: roster([entry('a', 0), entry('b', 3)]),
    mission: null,
  });
  assert.equal($('[data-mission-roster-count]').textContent, '2 / 30D');
  const [a, b] = document.querySelectorAll('.space-mission-roster-item');
  assert.equal(b.dataset.missionRosterIndex, '3');
  assert.equal(b.dataset.missionRosterId, 'b');
  assert.equal(b.getAttribute('aria-label'), 'Select B');
  assert.equal(b.querySelector('small').textContent, 'SpaceX · 2026-11-01');
  assert.equal(
    b
      .querySelector('.space-mission-roster-marker')
      .style.getPropertyValue('--mission-roster-color'),
    'rgb(1, 2, 3)',
  );
  b.click();
  b.dispatchEvent(new MouseEvent('mouseenter'));
  b.dispatchEvent(new MouseEvent('mouseleave'));
  a.dispatchEvent(new FocusEvent('blur', { relatedTarget: b }));
  a.dispatchEvent(new FocusEvent('blur', { relatedTarget: null }));
  assert.deepEqual(calls, [
    ['select', 3],
    ['pointer-enter', 3],
    ['pointer-leave'],
    ['blur-row', 3],
    ['blur-row', null],
  ]);
  await publish({ roster: roster([]), mission: null });
  assert.equal($('.space-mission-roster-empty').textContent, 'NONE IN WINDOW');
  assert.equal(
    document.querySelectorAll('.space-mission-roster-item').length,
    0,
  );
});

test('a roster refresh keeps keyboard focus and its preview on the same mission', async (t) => {
  const { publish, calls } = fixture(t);
  await publish({
    roster: roster([entry('a', 0), entry('b', 1), entry('c', 2)]),
    mission: null,
  });
  const list = document.querySelector('[data-mission-roster-list]');
  // Browsers drop focus from a node that is moved; happy-dom keeps it, so
  // any move drops it here.
  const insertBefore = list.insertBefore;
  list.insertBefore = function (node, ref) {
    if (list.contains(document.activeElement)) document.activeElement.blur();
    return insertBefore.call(this, node, ref);
  };
  document.querySelector('[data-mission-roster-id="b"]').focus();
  calls.length = 0;
  await publish({
    roster: roster([entry('b', 0), entry('c', 1), entry('a', 2)]),
    mission: null,
  });
  const focused = document.activeElement;
  assert.equal(focused?.dataset?.missionRosterId, 'b');
  assert.deepEqual(calls.at(-1), ['focus-row', 0]);
});

test('a departed focused mission continues focus beyond the list', async (t) => {
  const { publish } = fixture(t);
  await publish({
    roster: roster([entry('a', 0), entry('b', 1)]),
    mission: null,
  });
  document.querySelector('[data-mission-roster-id="b"]').focus();
  await publish({ roster: roster([entry('a', 0)]), mission: null });
  assert.equal(
    document.activeElement ===
      document.querySelector('[data-mission-roster-focus-continuation]'),
    true,
  );
});

test('the selected mission shows its details and hides absent rows', async (t) => {
  const { $, publish } = fixture(t);
  await publish({ roster: null, mission: mission() });
  const panel = $('#space-mission-panel');
  assert.equal(panel.hidden, false);
  assert.equal($('[data-mission-title]').textContent, 'STARLINK 12-3');
  assert.equal($('[data-mission-status]').textContent, 'Go for Launch');
  assert.equal(
    $('[data-mission-site]').closest('[data-mission-field]').hidden,
    true,
  );
  assert.equal(
    $('[data-mission-orbit]').closest('[data-mission-field]').hidden,
    false,
  );
  assert.equal($('[data-mission-speed]').title, '27,576 km/h');
  assert.equal($('[data-mission-index]').textContent, '2 / 5');
  assert.equal($('[data-mission-prev]').disabled, false);
  assert.equal($('[data-mission-next]').disabled, true);
  assert.equal(
    $('[data-mission-payloads]').textContent,
    'PAYLOAD DATA UNAVAILABLE',
  );
  assert.equal($('[data-mission-stages-section]').hidden, true);
  await publish({
    roster: null,
    mission: mission({
      distance: null,
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
  assert.equal(
    $('[data-mission-distance]').closest('[data-mission-field]').hidden,
    true,
  );
  const rows = [...$('[data-mission-payloads]').querySelectorAll('tr')].map(
    (row) => row.textContent,
  );
  assert.deepEqual(rows, [
    'Sat ×2Maker · 500 KGCommsGTO',
    '+1 additional payload records',
  ]);
  assert.equal($('[data-mission-stages-section]').hidden, false);
  assert.equal(
    $('[data-mission-stages]').textContent,
    'B1080FLIGHT 9LandedASOG28.40, -77.10 · DRONESHIP',
  );
  await publish({ roster: null, mission: null });
  assert.equal(panel.hidden, true);
});

test('the replay controls follow the layer and call its commands', async (t) => {
  const { $, publish, calls } = fixture(t);
  await publish({
    roster: null,
    mission: mission({ replay: replay({ available: false }) }),
  });
  const start = $('[data-mission-replay]');
  assert.equal(start.hidden, true);
  assert.equal(start.disabled, true);
  assert.equal($('.mission-replay-speed-control').hidden, true);
  await publish({ roster: null, mission: mission() });
  assert.equal(start.hidden, false);
  assert.equal(start.getAttribute('aria-pressed'), 'false');
  assert.equal($('[data-mission-replay-transport]').hidden, true);
  start.click();
  await publish({
    roster: null,
    mission: mission({
      nextDisabled: false,
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
  const transport = $('[data-mission-replay-transport]');
  assert.equal(start.hidden, true);
  assert.equal(transport.hidden, false);
  assert.equal(transport.classList.contains('is-paused'), true);
  assert.equal(transport.getAttribute('aria-label'), 'Liftoff, paused');
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
  $('[data-mission-prev]').click();
  $('[data-mission-next]').click();
  $('[data-mission-close]').click();
  $('[data-mission-show-all]').click();
  assert.deepEqual(calls, [
    ['replay'],
    ['toggle'],
    ['cancel'],
    ['speed', 3],
    ['focus'],
    ['previous'],
    ['next'],
    ['deselect'],
    ['deselect'],
  ]);
});

test('each newly presented selection returns the Context panel to the top', async (t) => {
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

test('a roster refresh lets the row under the pointer take the preview back on its next movement', async (t) => {
  const { publish, calls } = fixture(t);
  await publish({
    roster: roster([entry('a', 0), entry('b', 1)]),
    mission: null,
  });
  const row = document.querySelector('[data-mission-roster-id="a"]');
  row.dispatchEvent(new MouseEvent('mouseenter'));
  row.dispatchEvent(new MouseEvent('mousemove'));
  await publish({
    roster: roster([entry('a', 0, 'RENAMED'), entry('b', 1)]),
    mission: null,
  });
  assert.equal(
    document.querySelector('[data-mission-roster-id="a"]') === row,
    true,
  );
  row.dispatchEvent(new MouseEvent('mousemove'));
  row.dispatchEvent(new MouseEvent('mousemove'));
  assert.deepEqual(calls, [
    ['pointer-enter', 0],
    ['pointer-enter', 0],
  ]);
});

test('a layer that stops presenting returns the roster to loading and hides the mission', async (t) => {
  const { $, publish } = fixture(t);
  await publish({ roster: roster([entry('a', 0)]), mission: mission() });
  await publish({ roster: null, mission: null });
  assert.equal($('[data-mission-roster-count]').textContent, '—');
  assert.equal(
    $('.space-mission-roster-empty').textContent,
    'LOADING 30-DAY MISSION INDEX',
  );
  assert.equal($('#space-mission-panel').hidden, true);
});
