// src/ui/nearbyMissions.test.mjs — with Space Missions on and nothing
// picked, Context's Inspect view lists the missions by launch time, a page
// at a time, and a mission's card takes the list's place, over happy-dom.
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createPinia } from 'pinia';
import { createApp, nextTick } from 'vue';
import { StyleManager } from './applicationShell.js';
import { installEntityContext } from './entityContextBridge.js';
import { applicationPinia } from './vueRuntime.js';
import { createLifecycle as createMissionLifecycle } from '../layers/launches/lifecycle.js';
import { createSelection as createMissionSelection } from '../layers/launches/selection.js';
import { bindRenderer } from '../render/rendererOf.js';
import { followedOf, stopFollowing } from '../data/followed.js';
import { fakeCameraPort } from '../testSupport/fakeCameraPort.mjs';
import { toLonLatH } from '../geo/ellipsoid.js';
import ContextView from './views/ContextView.vue';
import { useEntityCardStore } from './stores/entityCard.js';
import { usePanelChromeStore } from './stores/panelChrome.js';
import { usePinnedStore } from './stores/pinned.js';
import { useSpaceMissionsStore } from './stores/spaceMissions.js';
import {
  contextListsActive,
  resetContextLists,
  showContextList,
} from './contextLists.js';
import {
  closeContextSearch,
  contextSearchOpen,
  contextSearchText,
} from './contextSearch.js';
import { CONTEXT_MISSIONS_EVENT } from './contextEvents.js';
import { resetListCardMemory } from './kit/ContextListCard.vue';

const HOUR = 3_600_000;
const HERE = { lat: 30.27, lon: -97.74 };

// The selected mission as the launches layer presents it.
const missionView = (entry) => ({
  id: entry.id,
  scrollRequest: 1,
  lat: 28.56,
  lon: -80.58,
  title: entry.label,
  provider: entry.provider,
  status: 'Go for Launch',
  site: null,
  time: null,
  when: null,
  orbit: 'LEO',
  ascent: 'ESTIMATED',
  distance: null,
  speed: null,
  speedTitle: null,
  payloads: [],
  payloadsMore: null,
  stages: [],
  replay: {
    available: false,
    active: false,
    paused: false,
    toggleText: 'Ⅱ',
    toggleLabel: 'Pause replay',
    transportLabel: null,
    speed: '1',
    speedText: '1×',
    speedProgress: '20%',
  },
});

// Roster entries in the roster's own order (not by time), each `hours` from
// now; `providers` names each one's provider, SpaceX by default.
function rosterOf(hours, providers = []) {
  const now = Date.now();
  return {
    count: `${hours.length} / 30D`,
    entries: hours.map((h, index) => ({
      index,
      id: `m${h}`,
      color: 'rgb(1, 2, 3)',
      label: `MISSION ${h}`,
      ariaLabel: `Select MISSION ${h}`,
      provider: providers[index] ?? 'SpaceX',
      date: new Date(now + h * HOUR).toISOString().slice(0, 10),
      launchAt: now + h * HOUR,
    })),
    empty: 'NONE IN WINDOW',
  };
}

const layerRow = (id, name, records) => {
  const row = {
    id,
    name,
    enabled: true,
    records,
    stats: { count: records.length, lastUpdate: Date.now() },
  };
  row.module = { getAnalystRecords: () => row.records };
  return row;
};

function fixture(t, { pinia = createPinia() } = {}) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('', { status: 503 });
  resetListCardMemory();
  document.body.replaceChildren();
  const host = document.body.appendChild(document.createElement('div'));
  const app = createApp(ContextView).use(pinia);
  const cards = useEntityCardStore(pinia);
  const chrome = usePanelChromeStore(pinia);
  const missions = useSpaceMissionsStore(pinia);
  let owner = null;
  t.after(() => {
    cards.connect(null);
    if (owner) chrome.detach(owner);
    app.unmount();
    resetContextLists();
    closeContextSearch();
    contextSearchText.value = '';
    globalThis.fetch = realFetch;
  });
  app.mount(host);
  owner = chrome.connect({
    toggle: (id) =>
      chrome.publish(owner, id, { collapsed: !chrome.panels[id]?.collapsed }),
  });
  // A flight close by, so there is something to pick; Satellites and the
  // launches layer are on, as Space Missions turns them on.
  const rows = [
    layerRow('flights', 'Live Flights', [
      {
        id: 'near01',
        icao24: 'near01',
        callsign: 'NEAR01',
        lat: 30.31,
        lon: -97.74,
        altitudeM: 2500,
      },
    ]),
    layerRow('satellites', 'Satellites', [
      { id: 'sat1', name: 'SAT ONE', lat: 30.3, lon: -97.7 },
    ]),
    layerRow('rocket-launches', 'Space Missions (30d)', [
      { id: 'pad1', name: 'PAD LAUNCH', lat: 30.28, lon: -97.75 },
    ]),
  ];
  const manager = {
    layers: new Map(rows.map((row) => [row.id, row])),
    isEnabled: (id) => rows.some((row) => row.id === id && row.enabled),
    getAll: () => rows,
    subscribe: () => () => {},
  };
  cards.connect({
    dataManager: () => manager,
    regionalBrief: async () => null,
    previews: () => null,
    canFollow: () => false,
    follow() {},
    flyTo() {},
  });
  cards.publishInspectorRows(rows);
  chrome.publish(owner, 'global-context-panel', { collapsed: false });
  cards.setView({ center: HERE, heightM: 40_000 });
  // The launches layer's panel commands, publishing as the layer does.
  const selected = [];
  const previews = [];
  let roster = null;
  missions.connect({
    selectMissionAt(index) {
      selected.push(index);
      missions.publish({ roster, mission: missionView(roster.entries[index]) });
    },
    deselectMission: () => missions.publish({ roster, mission: null }),
    rosterReset: () => previews.push(['reset']),
    rosterPointerEnter: (index) => previews.push(['pointer-enter', index]),
    rosterPointerLeave: () => previews.push(['pointer-leave']),
    rosterFocus: (index) => previews.push(['focus', index]),
    rosterBlur: (next) => previews.push(['blur', next]),
  });
  const missionsWith = async (next) => {
    roster = next;
    missions.setEnabled(true);
    missions.publish({ roster, mission: missions.mission });
    await settle();
  };
  const missionsOn = (hours, providers) =>
    missionsWith(rosterOf(hours, providers));
  // A mission picked on the globe: the layer selects it and its reveal
  // asks Context for Inspect (applicationShell's showMissions).
  const globePick = async (id) => {
    missions.publish({
      roster,
      mission: missionView(roster.entries.find((entry) => entry.id === id)),
    });
    document.dispatchEvent(
      new CustomEvent(CONTEXT_MISSIONS_EVENT, {
        detail: { keepFollow: false },
      }),
    );
    await settle();
  };
  const $ = (selector) => document.querySelector(selector);
  return {
    $,
    cards,
    manager,
    missions,
    missionsOn,
    missionsWith,
    globePick,
    selected,
    previews,
    pinia,
  };
}

const settle = async () => {
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
};
const LIST = '.nearby-missions';
const rowButtons = () => [...document.querySelectorAll(`${LIST} li button`)];
const rowNames = () =>
  rowButtons().map(
    (button) => button.querySelector('.nearby-lists__name').textContent,
  );
// The range label: its text, or the chosen option's.
const range = () => {
  const label = document.querySelector(`${LIST} [data-list-range]`);
  return label?.textContent;
};
const escKey = (target) => {
  const event = new KeyboardEvent('keydown', {
    key: 'Escape',
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
};
const focusIs = (element) => document.activeElement === element;
// Seven missions, in no time order: three upcoming, four past.
const SEVEN = [-48, 24, -1, 240, 3, -120, -480];
// Twelve, for three pages of five.
const TWELVE = [1, 2, 3, 4, 5, 6, -1, -2, -3, -4, -5, -6];

test('the list shows only while Missions is on and nothing is picked, at every zoom', async (t) => {
  const { $, cards, missionsOn } = fixture(t);
  await settle();
  assert.equal($(LIST), null, 'Missions off: no list');
  await missionsOn(SEVEN);
  assert.ok($(LIST), 'Missions on, nothing picked');
  assert.equal(
    $(LIST).getAttribute('aria-labelledby'),
    $(`${LIST} h4`).id,
    'its own heading, at the level of Nearby’s',
  );
  $('[data-row-layer="flights"][data-row-key="flights:near01"]').click();
  await settle();
  assert.equal(cards.card?.identity.id, 'near01');
  assert.equal($(LIST), null, 'a pick replaces it');
  cards.clear();
  await settle();
  assert.ok($(LIST), 'back once the pick goes');
  cards.setView({ center: HERE, heightM: 18_000_000 });
  await settle();
  assert.ok($(LIST), 'and at globe view: missions are not near anything');
});

test('the header is a layer block’s: feed dot, mark, name and the count', async (t) => {
  const { $, missionsOn } = fixture(t);
  await missionsOn(SEVEN);
  const head = $(`${LIST} h4.view-context__block-head`);
  assert.ok(head.querySelector('.view-context__dot--nominal'));
  assert.ok(head.querySelector('.entity-mark'));
  assert.equal(
    head.querySelector('.view-context__block-name').textContent,
    'Space Missions',
  );
  assert.equal(head.querySelector('strong').textContent, '7');
});

test('the bar splits the missions by provider: the leading three, then Other', async (t) => {
  const { $, missionsOn } = fixture(t);
  const providers = [
    'SpaceX',
    'CASC',
    'SpaceX',
    'Rocket Lab',
    'ULA',
    'SpaceX',
    'CASC',
    'Arianespace',
  ];
  await missionsOn([1, 2, 3, 4, -1, -2, -3, -4], providers);
  const bar = $(`${LIST} .view-context__bar`);
  assert.equal(bar.getAttribute('aria-hidden'), 'true', 'the legend says it');
  assert.equal(bar.querySelectorAll('span').length, 4);
  const legend = [
    ...document.querySelectorAll(`${LIST} .view-context__bar-key span`),
  ].map((part) => part.textContent);
  assert.deepEqual(legend, ['SpaceX 3', 'CASC 2', 'Rocket Lab 1', 'Other 2']);
  const sum = legend.reduce(
    (total, text) => total + Number(text.split(' ').at(-1)),
    0,
  );
  assert.equal(sum, 8, 'the legend adds up to the count');
});

test('launches are ordered across the page boundary, scheduled before recent', async (t) => {
  const { $, missionsOn } = fixture(t);
  await missionsOn(TWELVE);
  assert.deepEqual(rowNames(), [
    'MISSION 1',
    'MISSION 2',
    'MISSION 3',
    'MISSION 4',
    'MISSION 5',
  ]);
  $(`${LIST} [data-list-next]`).click();
  await settle();
  assert.deepEqual(rowNames(), [
    'MISSION 6',
    'MISSION -1',
    'MISSION -2',
    'MISSION -3',
    'MISSION -4',
  ]);
});

test('the Context search narrows the list; the count, the bar and the pager count the matches', async (t) => {
  const { $, cards, missionsOn } = fixture(t);
  const providers = TWELVE.map((_, i) => (i % 3 === 0 ? 'CASC' : 'SpaceX'));
  await missionsOn(TWELVE, providers);
  $(`${LIST} [data-list-next]`).click();
  await settle();
  contextSearchOpen.value = true;
  contextSearchText.value = 'casc';
  await settle();
  assert.equal($(`${LIST} h4 strong`).textContent, '4');
  assert.deepEqual(
    [...document.querySelectorAll(`${LIST} .view-context__bar-key span`)].map(
      (part) => part.textContent,
    ),
    ['CASC 4'],
  );
  assert.equal(rowNames().length, 4, 'a new search starts at page one');
  assert.equal(range(), '1–4 of 4');
  assert.equal($(`${LIST} [data-list-next]`), null);
  contextSearchText.value = 'mission -';
  await settle();
  assert.equal(range(), '1–5 of 6');
  contextSearchText.value = 'zzzz';
  await settle();
  assert.equal(rowButtons().length, 0);
  assert.equal(
    $(`${LIST} .context-list-card__state`).textContent,
    'Nothing matches “zzzz”.',
  );
  assert.equal($(`${LIST} h4 strong`).textContent, '0');
  cards.setView({ center: HERE, heightM: 20_000_000 });
  contextSearchText.value = 'casc';
  await settle();
  assert.equal(rowNames().length, 4);
  assert.ok(!$('.view-context__empty[role="status"]'));
});

test('payload and mission names match both the roster and the Inspect search', async (t) => {
  const { $, missionsWith } = fixture(t);
  const roster = rosterOf([-1, -2]);
  Object.assign(roster.entries[0], {
    name: 'Falcon 9 | Test Payload',
    label: 'FALCON 9',
    missionName: 'Transporter 17',
  });
  await missionsWith(roster);
  contextSearchOpen.value = true;
  for (const query of ['test payload', 'transporter']) {
    contextSearchText.value = query;
    await settle();
    assert.deepEqual(rowNames(), ['FALCON 9']);
    assert.ok(!$('.view-context__empty[role="status"]'));
  }
});

test('with Missions on, telemetry-only Satellites and the launches layer have no tile, block or Nearby group; off, both are back', async (t) => {
  const { $, missions, missionsOn, cards } = fixture(t);
  cards.layerModule('satellites').getParams = () => ({
    showPoints: !missions.enabled,
  });
  await settle();
  const shown = () => ({
    satellitesTile: Boolean($('.view-context__tile[data-layer="satellites"]')),
    launchesTile: Boolean(
      $('.view-context__tile[data-layer="rocket-launches"]'),
    ),
    missionsTile: Boolean(
      $('.view-context__tile[data-layer="space-missions"]'),
    ),
    launchesGroup: Boolean(
      $('.nearby-lists__layer[data-layer="rocket-launches"]'),
    ),
  });
  assert.deepEqual(shown(), {
    satellitesTile: true,
    launchesTile: true,
    missionsTile: false,
    launchesGroup: true,
  });
  await missionsOn(SEVEN);
  assert.deepEqual(shown(), {
    satellitesTile: false,
    launchesTile: false,
    missionsTile: false,
    launchesGroup: false,
  });
  assert.ok(
    $('.view-context__tile[data-layer="flights"]'),
    'other layers stay',
  );
  cards.setView({ center: HERE, heightM: 18_000_000 });
  await settle();
  assert.equal($('.view-context__block[data-layer="satellites"]'), null);
  assert.equal($('.view-context__block[data-layer="rocket-launches"]'), null);
  assert.ok($('.view-context__block[data-layer="flights"]'));
  missions.setEnabled(false);
  await settle();
  assert.ok(
    $('.view-context__block[data-layer="satellites"]'),
    'back when off',
  );
  assert.ok($('.view-context__block[data-layer="rocket-launches"]'));
});

test('showContextList for Space Missions is no list; a Context reveal brings Inspect and the list', async (t) => {
  const { $, missionsOn, pinia, cards } = fixture(t);
  await missionsOn(SEVEN);
  showContextList('space-missions');
  await settle();
  assert.equal(contextListsActive.value, false, 'not a list of the list tab');
  // On Pinned with a pick open, the reveal (voice, a direct turn-on, the
  // first-run start) lets the pick go and shows the list on Inspect.
  const pinned = usePinnedStore(pinia);
  pinned.pin({
    key: 'flights:x',
    kind: 'item',
    title: 'X',
    icon: 'flight',
    identity: { layerId: 'flights', id: 'x' },
  });
  $('.nearby-lists__row--nearest button').click();
  await settle();
  $('#context-tab-pinned').click();
  await settle();
  assert.equal($(LIST), null);
  document.dispatchEvent(new CustomEvent(CONTEXT_MISSIONS_EVENT));
  await settle();
  assert.equal(cards.card, null, 'the pick is let go');
  assert.equal($('#context-tab-inspect').getAttribute('aria-selected'), 'true');
  assert.ok($(LIST), 'the list shows');
});

test('opening Missions keeps a followed aircraft, train or ISS and Back restores its card', async (t) => {
  const pinia = applicationPinia();
  const { $, cards, missions, missionsOn, globePick } = fixture(t, { pinia });
  await missionsOn(SEVEN);

  const viewer = {};
  const { port, emit } = fakeCameraPort();
  let followTarget = null;
  const cameraMoves = [];
  const camera = {
    ...port,
    get followed() {
      return followTarget;
    },
    follow(target) {
      followTarget = target;
      emit('followChanged');
    },
    flyTo: () => cameraMoves.push('fly'),
    release: () => cameraMoves.push('release'),
  };
  const unbind = bindRenderer(viewer, {
    camera,
    canvas: { clientWidth: 1200, clientHeight: 800 },
    input: { on: () => () => {}, isPointerFree: () => true },
  });

  const flight = layerRow('flights', 'Live Flights', [
    { id: 'near01', icao24: 'near01', callsign: 'NEAR01', ...HERE },
  ]);
  const rail = layerRow('rail', 'Rail', [
    { id: 'rail:fixture:train01', name: 'Train 01', ...HERE },
  ]);
  const satellites = layerRow('satellites', 'Satellites', [
    { id: 'ISS', noradId: '25544', name: 'ISS', ...HERE, altitudeM: 416000 },
  ]);
  const releaseCalls = [];
  for (const row of [flight, satellites]) {
    row.module.stopTracking = ({ origin }) => {
      releaseCalls.push([row.id, origin]);
      stopFollowing(viewer);
    };
  }
  const layers = new Map(
    [flight, rail, satellites].map((row) => [row.id, row]),
  );
  const subscribers = new Set();
  let enabled = false;
  const manager = {
    layers,
    getAll: () => [...layers.values()],
    isEnabled: (id) => (id === 'rocket-launches' ? enabled : layers.has(id)),
    subscribe(listener) {
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
  };
  const weatherTimers = new Set();
  const weather = Promise.withResolvers();
  let weatherSignal;
  const disconnect = installEntityContext({
    viewer,
    pinia,
    getDataManager: () => manager,
    spotWeather: (_lat, _lon, { signal }) => {
      weatherSignal = signal;
      return weather.promise;
    },
    inspector: {
      counts: { update() {}, note() {}, stop() {} },
      weatherClock: {
        setTimeout(callback) {
          weatherTimers.add(callback);
          return callback;
        },
        clearTimeout(callback) {
          weatherTimers.delete(callback);
        },
      },
    },
  });
  emit('moveEnd');
  const roster = missions.roster;
  const missionLayer = {
    ...missions.layer,
    subscribePanel(listener) {
      listener({ roster, mission: null });
      return () => {};
    },
  };
  const shell = {
    services: { rocketLaunchesLayer: missionLayer },
    setPanelCollapsed() {},
    revealPanel() {},
  };
  StyleManager.prototype._initSpaceMissionsPanel.call(shell);
  shell._spaceMissionsControls.connect(manager);
  t.after(() => {
    shell._spaceMissionsControls.destroy();
    disconnect();
    unbind();
  });

  const noop = () => {};
  const missionContext = {
    state: { _viewer: viewer, _enabled: true, _lifecycleToken: 1 },
    services: {
      render: {},
      geometry: { getKeyholeGeometry: () => ({ radius: 350 }) },
    },
    parts: {
      rendering: { showMissions: noop, selectLaunchEntity: noop },
      orbitRendering: { syncMissionOrbitPrimitiveVisibility: noop },
      ingestion: { captureSatelliteDependency: noop },
    },
  };
  missionContext.parts.selection = createMissionSelection(missionContext);
  const missionEntry = createMissionLifecycle(missionContext).methods;
  async function revealMissions() {
    await missionEntry._enableBody();
    enabled = true;
    for (const listener of subscribers)
      listener({
        type: 'visibility',
        layerId: 'rocket-launches',
        enabled,
        origin: 'user',
      });
    await settle();
  }

  for (const [layerId, id] of [
    ['flights', 'near01'],
    ['rail', 'rail:fixture:train01'],
    ['satellites', '25544'],
  ]) {
    missionLayer.deselectMission();
    assert.ok(cards.select({ layerId, id }, { follow: false }));
    const selected = cards.card;
    const target = { key: selected.key };
    camera.follow(target);
    await settle();
    assert.ok(cards.isFollowing());
    $('#entity-card .entity-card__close').focus();
    const priorReleaseCount = releaseCalls.length;

    await revealMissions();
    assert.equal(followedOf(viewer), target, layerId);
    assert.equal(cards.card.key, selected.key, layerId);
    assert.ok(cards.isFollowing(), layerId);
    assert.equal($('#entity-card'), null, layerId);
    assert.ok($(LIST), layerId);
    assert.ok(
      cards.readViewContextShown(),
      'the roster keeps Inspector active',
    );
    const back = $('[data-missions-back]');
    assert.equal(back, document.activeElement, layerId);

    if (layerId === 'flights') {
      const timer = weatherTimers.values().next().value;
      assert.equal(typeof timer, 'function', 'the roster schedules weather');
      weatherTimers.delete(timer);
      timer();
      assert.ok(weatherSignal && !weatherSignal.aborted);
    }

    if (layerId === 'satellites') {
      rowButtons()[0].click();
      await settle();
      assert.ok(
        $(`${LIST} #space-mission-panel`),
        'ISS can return from mission detail',
      );
      assert.equal(followedOf(viewer), target);
    }
    back.click();
    await settle();
    if (layerId === 'satellites')
      assert.equal(
        missions.mission,
        null,
        'Back lets the mission go with the list',
      );
    assert.equal(
      $('#entity-card .entity-card__title').textContent,
      selected.title,
      layerId,
    );
    assert.equal(
      $('#entity-card .entity-card__close'),
      document.activeElement,
      layerId,
    );
    assert.equal(followedOf(viewer), target, layerId);
    assert.equal(releaseCalls.length, priorReleaseCount, layerId);
    assert.equal($(LIST), null, layerId);
    assert.equal(cards.readViewContextShown(), false, 'Back closes Inspector');
    if (layerId === 'flights') {
      assert.equal(weatherSignal.aborted, true, 'Back cancels pending weather');
      weather.resolve({ weather: { temperatureC: 21 } });
      await settle();
      assert.equal(cards.viewWeather?.reading ?? null, null);
    }

    $('#entity-card .entity-card__close').click();
    await settle();
    assert.equal(
      followedOf(viewer),
      null,
      `${layerId} can explicitly stop following`,
    );
  }
  assert.deepEqual(cameraMoves, []);
  assert.deepEqual(releaseCalls, [
    ['flights', 'user'],
    ['satellites', 'user'],
  ]);

  // The free camera still gets the standard opening flight.
  await missionEntry._enableBody();
  assert.equal(cameraMoves[0], 'fly');

  // Replay taking the camera leaves its controls on the page.
  missionLayer.deselectMission();
  assert.ok(
    cards.select({ layerId: 'satellites', id: '25544' }, { follow: false }),
  );
  camera.follow({ key: cards.card.key });
  await settle();
  await revealMissions();
  rowButtons()[0].click();
  await settle();
  camera.follow(null);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(cards.card, null);
  assert.equal($('[data-missions-back]'), null);
  assert.ok($(`${LIST} #space-mission-panel`));
  assert.deepEqual(releaseCalls, [
    ['flights', 'user'],
    ['satellites', 'user'],
  ]);
  // The launch has released the camera, but the Context debounce still
  // reports the previous follow until its next check.
  missionLayer.deselectMission();
  assert.ok(
    cards.select({ layerId: 'flights', id: 'near01' }, { follow: false }),
  );
  camera.follow({ key: cards.card.key });
  await settle();
  camera.follow(null);
  assert.ok(cards.isFollowing());
  await globePick(roster.entries[0].id);
  assert.equal(cards.card, null);
  assert.equal($('[data-missions-back]'), null);
  assert.ok($(`${LIST} #space-mission-panel`));
});

test('a row opens its mission’s card in the list’s place; Back returns to the same page and row', async (t) => {
  const { $, cards, missionsOn, missionsWith, selected } = fixture(t);
  await missionsOn(TWELVE);
  $(`${LIST} [data-list-next]`).click();
  await settle();
  const originalPage = rowButtons().map((button) => button.dataset.listKey);
  const row = rowButtons()[2];
  assert.equal(row.dataset.listKey, 'm-2');
  const scroller = row.closest('.global-context-panel-inner');
  scroller.scrollTop = 125;
  row.focus();
  row.click();
  await settle();
  assert.equal(scroller.scrollTop, 0);
  assert.deepEqual(selected, [7], 'selected through the layer’s own command');
  const card = $(`#context-tab-panel ${LIST} #space-mission-panel`);
  assert.equal(card.hidden, false, 'its card, in the list card in Inspect');
  assert.equal(rowButtons().length, 0, 'in place of the rows');
  assert.ok($('.view-context'), 'the rest of Inspect stays');
  assert.equal(
    card.querySelector('[data-mission-title]').textContent,
    'MISSION -2',
  );
  assert.equal(
    card.querySelector('[data-mission-more]').open,
    true,
    'More details starts open',
  );
  const back = $(`${LIST} [data-list-back]`);
  assert.ok(back.closest('h4'));
  assert.equal(back.getAttribute('aria-label'), 'Show all missions');
  assert.equal(back.parentElement.querySelector('strong'), null);
  assert.equal(focusIs(back), true, 'focus moves to Back');
  // A catalogue update reschedules this mission while its detail is open.
  const updated = rosterOf(TWELVE);
  const rescheduled = updated.entries.find((entry) => entry.id === 'm-2');
  rescheduled.launchAt = Date.now() + 60_000;
  await missionsWith(updated);
  back.click();
  await settle();
  assert.equal($('#space-mission-panel'), null);
  assert.equal(range(), '6–10 of 12', 'the same page');
  assert.deepEqual(
    rowButtons().map((button) => button.dataset.listKey),
    originalPage,
  );
  assert.equal(
    document.activeElement?.dataset?.listKey,
    'm-2',
    'focus is back on the mission’s row',
  );
  cards.setView({ center: HERE, heightM: 40_000, manualInputCount: 1 });
  await settle();
  assert.notDeepEqual(
    rowButtons().map((button) => button.dataset.listKey),
    originalPage,
    'a deliberate move allows the revised launch order',
  );
});

test('Esc in a mission’s card returns to the list; Esc on the list lets nothing go', async (t) => {
  const { $, missions, missionsOn } = fixture(t);
  await missionsOn(SEVEN);
  rowButtons()[0].focus();
  rowButtons()[0].click();
  await settle();
  const event = escKey($(`${LIST} [data-list-back]`));
  await settle();
  assert.equal(event.defaultPrevented, true);
  assert.equal(missions.mission, null);
  assert.ok($(LIST), 'the list is back');
  assert.equal(document.activeElement?.dataset?.listKey, 'm3');
  const again = escKey(rowButtons()[0]);
  await settle();
  assert.equal(again.defaultPrevented, false, 'nothing to let go');
  assert.ok($(LIST));
});

test('a mission picked on the globe shows its card in Inspect, over a pick', async (t) => {
  const { $, cards, missionsOn, globePick } = fixture(t);
  await missionsOn(SEVEN);
  $('.nearby-lists__row--nearest button').click();
  await settle();
  assert.ok(cards.card, 'a flight is picked');
  await globePick('m24');
  assert.equal(cards.card, null);
  assert.equal($(`${LIST} #space-mission-panel`).hidden, false);
  assert.equal($('[data-mission-title]').textContent, 'MISSION 24');
});

test('both mission pin controls save one launch site, and opening it frames the pad during replay', async (t) => {
  const { $, cards, manager, missions, missionsOn, globePick, pinia } =
    fixture(t);
  const pins = usePinnedStore(pinia);
  const viewer = {};
  const { port } = fakeCameraPort();
  const flights = [];
  const unbind = bindRenderer(viewer, {
    camera: {
      ...port,
      flyTo: (pose) => flights.push(pose),
      flyToBounds: ({ center }) => flights.push(toLonLatH(center)),
    },
    input: { on: () => () => {}, isPointerFree: () => true },
  });
  const disconnect = installEntityContext({
    viewer,
    pinia,
    getDataManager: () => manager,
  });
  t.after(() => {
    disconnect();
    unbind();
  });
  await missionsOn(SEVEN);
  const replayPose = {
    ...HERE,
    height: 50_000,
    heading: 1,
    pitch: -0.7,
    roll: 0,
  };
  cards.setView({ center: HERE, heightM: replayPose.height, pose: replayPose });
  await settle();
  const headerPin = () => $('.view-context__pin');
  const missionPin = () => $('[data-mission-pin]');
  assert.equal(headerPin().getAttribute('aria-label'), 'Pin this view');
  await globePick('m24');
  const selected = { ...missions.mission, site: 'SLC-40' };
  missions.publish({
    roster: missions.roster,
    mission: { ...selected, replay: { ...selected.replay, active: true } },
  });
  await settle();
  headerPin().click();
  await settle();
  assert.equal(pins.pins.length, 1);
  assert.equal(pins.pins[0].kind, 'place');
  assert.equal(pins.pins[0].title, 'SLC-40');
  assert.equal(missionPin().getAttribute('aria-pressed'), 'true');

  // The camera moves again while the selected replay is in orbit.
  const orbit = { lat: 1.5, lon: -36, height: 400_000 };
  cards.setView({ center: orbit, heightM: orbit.height, pose: orbit });
  await settle();
  assert.equal(headerPin().getAttribute('aria-pressed'), 'true');
  pins.show('pinned');
  await settle();
  $('.pinned-grid__open').click();
  await settle();
  assert.equal(cards.card?.title, 'SLC-40');
  assert.equal(flights.length, 1);
  assert.ok(Math.abs(flights[0].lat - selected.lat) < 1e-6);
  assert.ok(Math.abs(flights[0].lon - selected.lon) < 1e-6);
});

test('the list goes when Missions turns off, its card too', async (t) => {
  const { $, missions, missionsOn } = fixture(t);
  await missionsOn(SEVEN);
  rowButtons()[0].click();
  await settle();
  assert.ok($('#space-mission-panel'));
  missions.setEnabled(false);
  await settle();
  assert.equal($('#space-mission-panel'), null);
  assert.equal($(LIST), null);
});

test('the minute clock runs only while the list has missions', async (t) => {
  const live = new Set();
  const { setInterval: set, clearInterval: clear } = globalThis;
  globalThis.setInterval = (fn, ms, ...rest) => {
    const id = set(fn, ms, ...rest);
    if (ms === 60_000) live.add(id);
    return id;
  };
  globalThis.clearInterval = (id) => {
    live.delete(id);
    return clear(id);
  };
  t.after(() => {
    globalThis.setInterval = set;
    globalThis.clearInterval = clear;
  });
  const { $, cards, missions, missionsOn } = fixture(t);
  await settle();
  assert.equal(live.size, 0, 'Missions off');
  await missionsOn(SEVEN);
  assert.equal(live.size, 1, 'listing');
  $('.nearby-lists__row--nearest button').click();
  await settle();
  assert.equal(live.size, 0, 'a pick hides the list');
  cards.clear();
  await settle();
  assert.equal(live.size, 1);
  missions.setEnabled(false);
  await settle();
  assert.equal(live.size, 0, 'Missions turned off');
});

test('hovering or focusing a row previews its mission on the globe, as the roster did', async (t) => {
  const { missionsOn, previews } = fixture(t);
  await missionsOn(SEVEN);
  const [first, second] = rowButtons();
  // MISSION 3 is the roster's fifth entry, MISSION 24 its second.
  first.dispatchEvent(new MouseEvent('mouseenter'));
  first.dispatchEvent(new MouseEvent('mousemove'));
  first.dispatchEvent(new MouseEvent('mouseleave'));
  first.focus();
  second.focus();
  assert.deepEqual(previews, [
    ['pointer-enter', 4],
    ['pointer-leave'],
    ['focus', 4],
    ['blur', 1],
    ['focus', 1],
  ]);
  // A changed roster: the row under a still pointer takes the preview back
  // on its next movement, once.
  previews.length = 0;
  await missionsOn([...SEVEN, 500]);
  const row = rowButtons()[0];
  row.dispatchEvent(new MouseEvent('mousemove'));
  row.dispatchEvent(new MouseEvent('mousemove'));
  assert.deepEqual(
    previews.filter(([name]) => name === 'pointer-enter'),
    [['pointer-enter', 4]],
  );
});

test('closing Context releases an outstanding mission preview', async (t) => {
  const { missionsOn, previews } = fixture(t);
  await missionsOn(SEVEN);
  rowButtons()[0].dispatchEvent(new MouseEvent('mouseenter'));
  document.querySelector('#global-context-panel .panel-collapse-btn').click();
  await settle();
  assert.equal(document.querySelector('.nearby-missions'), null);
  assert.deepEqual(previews.slice(-2), [['pointer-enter', 4], ['reset']]);
});

test('the overlay QA script’s mission selector finds the first row', async (t) => {
  const { $, missionsOn } = fixture(t);
  await missionsOn(SEVEN);
  const script = readFileSync(
    new URL('../../scripts/qa-overlay-baseline.mjs', import.meta.url),
    'utf8',
  );
  const body = script.slice(script.indexOf('async function prepareMission'));
  const selector = body.match(/querySelector\('([^']+)'\)/)[1];
  assert.ok(rowButtons()[0], 'the list has a first row');
  assert.ok($(selector) === rowButtons()[0], selector);
});

test('a roster refresh keeps the preview of a row that keeps focus', async (t) => {
  const { missionsOn, previews } = fixture(t);
  await missionsOn(SEVEN);
  const row = rowButtons()[0];
  const key = row.dataset.listKey;
  row.focus();
  previews.length = 0;
  await missionsOn([...SEVEN, 500]);
  const kept = rowButtons().find((button) => button.dataset.listKey === key);
  assert.ok(kept === document.activeElement, 'the row keeps focus');
  const focuses = previews.filter(([name]) => name === 'focus');
  assert.equal(focuses.length, 1);
});
