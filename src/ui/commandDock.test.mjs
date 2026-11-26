// src/ui/commandDock.test.mjs — the command dock and the scene chrome render
// what VisualSettings publishes, over happy-dom.
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia } from 'pinia';
import { createApp, h, nextTick } from 'vue';
import { setLocale } from '../i18n/index.js';
import { useDisplayStore } from './stores/display.js';
import { useEntityCardStore } from './stores/entityCard.js';
import { useLocationStore } from './stores/location.js';
import { useOmnibarStore } from './stores/omnibar.js';
import { useVoiceStore } from './stores/voice.js';
import { useGlobeActionsStore } from './stores/globeActions.js';
import { LocationControls } from './locationControls.js';
import { LocationSearch } from './locationSearch.js';
import { LocationNavigation } from './locationNavigation.js';
import { NavigationController } from './navigationController.js';
import { MOBILE_TABS, initMobileShell } from './mobileShell.js';
import CommandDockView from './views/CommandDockView.vue';
import SceneChromeView from './views/SceneChromeView.vue';
import { VisualSettings } from './visualSettings.js';

function fixture(t) {
  document.body.replaceChildren();
  const host = document.body.appendChild(document.createElement('div'));
  const pinia = createPinia();
  const app = createApp({
    render: () => [h(SceneChromeView), h(CommandDockView)],
  }).use(pinia);
  app.mount(host);
  t.after(() => app.unmount());
  const store = useDisplayStore(pinia);
  // VisualSettings publishes through its store; the method needs no more.
  const settings = Object.assign(Object.create(VisualSettings.prototype), {
    store,
    activeStyle: 'normal',
  });
  const $ = (selector) => document.querySelector(selector);
  return { $, settings, pinia };
}

test('before VisualSettings publishes, the corner shows NORMAL', (t) => {
  const { $ } = fixture(t);
  assert.equal($('#active-style-name').textContent, 'NORMAL');
});

test('the corner labels the active style', async (t) => {
  const { $, settings } = fixture(t);
  settings._publishActiveStyle('thermal');
  await nextTick();
  assert.equal($('#active-style-name').textContent, 'FLIR');
  settings.activeStyle = 'unlisted';
  settings._publishActiveStyle();
  await nextTick();
  assert.equal($('#active-style-name').textContent, 'UNLISTED');
});

test('the corner labels the style in the UI language', async (t) => {
  t.after(() => setLocale('en'));
  setLocale('ru');
  const { $, settings } = fixture(t);
  assert.equal($('#active-style-name').textContent, 'ОБЫЧНЫЙ');
  settings._publishActiveStyle('noir');
  await nextTick();
  assert.equal($('#active-style-name').textContent, 'НУАР');
});

test('the dock holds the voice control only', (t) => {
  const { $ } = fixture(t);
  const dock = $('#command-dock');
  assert.ok(dock);
  assert.equal(dock.getAttribute('aria-label'), 'Voice and search controls');
  assert.equal($('#location-bar'), null);
  assert.equal($('#control-panel'), null);
});

test('the ORBIT indicator sits on the body while offered and lights while orbiting', async (t) => {
  const { $, pinia } = fixture(t);
  assert.equal($('#orbit-indicator'), null);
  const store = useLocationStore(pinia);
  const controls = new LocationControls({
    cities: {},
    getExpandedCity: () => null,
    onCity() {},
    onPoi() {},
    onSearch() {},
    onReset() {},
    publish: (view) => store.publish(view),
  });
  controls.showOrbit(false);
  await nextTick();
  const indicator = $('#orbit-indicator');
  assert.equal(indicator.parentElement, document.body);
  assert.equal(indicator.textContent, '↻ ORBIT');
  assert.equal(indicator.querySelector('.orbit-icon').textContent, '↻');
  assert.equal(indicator.classList.contains('active'), false);
  controls.showOrbit(true);
  await nextTick();
  assert.equal(indicator.classList.contains('active'), true);
  controls.showOrbit(false);
  await nextTick();
  assert.equal(indicator.classList.contains('active'), false);
  assert.ok($('#orbit-indicator') === indicator, 'stopping keeps it in place');
  controls.destroy();
  await nextTick();
  assert.equal($('#orbit-indicator'), null);
});

// These compare nodes by identity in a boolean: a failing assertion on a
// happy-dom node would try to print the whole document.
test('the phone tab bar joins the end of the page while the shell publishes', async (t) => {
  const { $, pinia } = fixture(t);
  assert.equal($('#mobile-tab-bar') === null, true);
  assert.equal($('#mobile-sheet-backdrop') === null, true);
  // The scene adds its credits after the views mount; the bar follows them.
  const credits = document.body.appendChild(document.createElement('div'));
  const store = useDisplayStore(pinia);
  store.publishPhoneShell({ enabled: true, sheet: null, tabs: MOBILE_TABS });
  await nextTick();
  const bar = $('#mobile-tab-bar');
  const backdrop = $('#mobile-sheet-backdrop');
  assert.equal(document.body.lastElementChild === bar, true);
  assert.equal(bar.previousElementSibling === backdrop, true);
  assert.equal(backdrop.previousElementSibling === credits, true);
  assert.equal(bar.getAttribute('aria-label'), 'Panels');
  assert.equal(bar.getAttribute('aria-hidden'), 'false');
  assert.equal(backdrop.hidden, true);
  const tabs = [...bar.querySelectorAll('.mobile-tab')];
  assert.deepEqual(
    tabs.map(
      (tab) =>
        `${tab.dataset.mobileSheet}:${tab.querySelector('.mobile-tab-icon').textContent}:${tab.querySelector('.mobile-tab-label').textContent}`,
    ),
    [
      'layers:layers:Layers',
      'cameras:videocam:Cameras',
      'context:radar:Context',
      'more:more_horiz:More',
    ],
  );
  assert.deepEqual(
    tabs.map((tab) => tab.getAttribute('aria-expanded')),
    ['false', 'false', 'false', 'false'],
  );
  store.publishPhoneShell({
    enabled: true,
    sheet: 'context',
    tabs: MOBILE_TABS,
  });
  await nextTick();
  assert.equal(backdrop.hidden, false);
  assert.deepEqual(
    tabs.map((tab) => tab.getAttribute('aria-expanded')),
    ['false', 'false', 'true', 'false'],
  );
  store.publishPhoneShell({ enabled: false, sheet: null, tabs: MOBILE_TABS });
  await nextTick();
  assert.equal(bar.getAttribute('aria-hidden'), 'true');
  assert.equal(backdrop.hidden, true);
  assert.deepEqual(
    tabs.map((tab) => tab.getAttribute('aria-expanded')),
    ['false', 'false', 'false', 'false'],
  );
  store.publishPhoneShell(null);
  await nextTick();
  assert.equal($('#mobile-tab-bar') === null, true);
  assert.equal($('#mobile-sheet-backdrop') === null, true);
});

test('the phone tabs are labelled in the UI language', async (t) => {
  t.after(() => setLocale('en'));
  setLocale('ru');
  const { $, pinia } = fixture(t);
  useDisplayStore(pinia).publishPhoneShell({
    enabled: true,
    sheet: null,
    tabs: MOBILE_TABS,
  });
  await nextTick();
  assert.equal($('#mobile-tab-bar').getAttribute('aria-label'), 'Панели');
  assert.equal(
    $('#mobile-tab-bar [data-mobile-sheet="layers"] .mobile-tab-label')
      .textContent,
    'Слои',
  );
});

test('closing a sheet returns focus to its tab once the tab bar shows it closed', async (t) => {
  const { $, pinia } = fixture(t);
  const store = useDisplayStore(pinia);
  // The Cameras sheet's first panel, with its first control.
  const cctv = document.body.appendChild(document.createElement('section'));
  cctv.id = 'cctv-panel';
  cctv.appendChild(document.createElement('button')).id = 'cctv-first';
  const init = () =>
    initMobileShell({
      documentRef: document,
      matchMedia: () => ({ matches: true }),
      ResizeObserverImpl: null,
      requestFrame: () => 0,
      setPanelCollapsed() {},
      publish: (view) => store.publishPhoneShell(view),
      afterPublish: (callback) => {
        void nextTick(callback);
      },
    });
  let shell = init();
  t.after(() => shell.destroy());
  await nextTick();
  const tab = $('#mobile-tab-bar [data-mobile-sheet="cameras"]');
  tab.focus();
  tab.click();
  await nextTick();
  assert.equal(tab.getAttribute('aria-expanded'), 'true');
  assert.equal(document.activeElement?.id, 'cctv-first');
  let expandedAtFocus = null;
  tab.addEventListener('focus', () => {
    expandedAtFocus = tab.getAttribute('aria-expanded');
  });
  document.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
  );
  await nextTick();
  await nextTick();
  assert.equal(document.activeElement === tab, true);
  assert.equal(expandedAtFocus, 'false');
  assert.equal($('#mobile-sheet-backdrop').hidden, true);
  // Reopening before the closed tab bar renders keeps focus in the sheet.
  const layers = $('#mobile-tab-bar [data-mobile-sheet="layers"]');
  const inSheet = document.body.appendChild(document.createElement('button'));
  const escape = () =>
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
  layers.focus();
  layers.click();
  inSheet.focus();
  escape();
  layers.click();
  await nextTick();
  await nextTick();
  assert.equal(document.body.dataset.mobileSheet, 'layers');
  assert.equal(document.activeElement === inSheet, true);
  // So does destroying the shell with a sheet open.
  escape();
  layers.focus();
  layers.click();
  inSheet.focus();
  shell.destroy();
  shell = init();
  await nextTick();
  await nextTick();
  assert.equal(document.activeElement === inSheet, true);
  // A destroyed shell takes its bar along; a new one brings it back.
  shell.destroy();
  await nextTick();
  assert.equal($('#mobile-tab-bar') === null, true);
  shell = init();
  await nextTick();
  assert.equal(document.querySelectorAll('#mobile-tab-bar').length, 1);
  $('#mobile-tab-bar [data-mobile-sheet="more"]').click();
  await nextTick();
  assert.equal(
    $('#mobile-tab-bar [data-mobile-sheet="more"]').getAttribute(
      'aria-expanded',
    ),
    'true',
  );
  assert.equal($('#mobile-sheet-backdrop').hidden, false);
});

function omnibarFixture(t, onSearch = () => {}) {
  const mounted = fixture(t);
  const { $, pinia } = mounted;
  const location = useLocationStore(pinia);
  const controls = new LocationControls({
    cities: {},
    getExpandedCity: () => null,
    onCity() {},
    onPoi() {},
    onReset() {},
    onSearch: (query) => {
      controls.setSearching(true);
      return onSearch(query);
    },
    onSearchEdit: () => controls.setSearchError(null),
    publish: (view) => location.publish(view),
  });
  t.after(() => controls.destroy());
  location.connect(controls);
  const mutations = [];
  // Switching a layer changes its state, as the app's layers do.
  const fixtureLayers = [
    { id: 'flights', name: 'Flights', enabled: false },
    {
      id: 'scene-layer',
      name: 'Scene Layer',
      enabled: false,
      showInTogglePanel: false,
    },
  ];
  useOmnibarStore(pinia).connect({
    layers: () => fixtureLayers,
    setLayer: (id, enabled) => {
      mutations.push([id, enabled]);
      const layer = fixtureLayers.find((each) => each.id === id);
      if (layer) layer.enabled = enabled;
    },
  });
  const voiceEvents = [];
  useVoiceStore(pinia).connect({ emit: (...args) => voiceEvents.push(args) });
  const globeEvents = [];
  useGlobeActionsStore(pinia).connect({
    northUp: () => globeEvents.push('northUp'),
  });
  const input = $('#gev-omnibar-input');
  async function type(text) {
    input.focus();
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await nextTick();
  }
  async function key(key, options = {}) {
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, ...options }),
    );
    await nextTick();
  }
  function option(kind) {
    return [
      ...document.querySelectorAll('#gev-omnibar-list [role="option"]'),
    ].find((row) =>
      row.classList.contains(`omnibar-item--${kind.toLowerCase()}`),
    );
  }
  return {
    ...mounted,
    controls,
    mutations,
    voiceEvents,
    globeEvents,
    input,
    type,
    key,
    option,
  };
}

test('omnibar uses loaded records when one viewport point snapshot throws', async (t) => {
  const { $, pinia, input } = omnibarFixture(t);
  const point = (id, name, lon) => ({ id, name, lat: 0, lon });
  const rows = [
    {
      id: 'local-dams',
      name: 'Dams',
      enabled: true,
      module: {
        getNearbyContextPoints() {
          throw new Error('point snapshot unavailable');
        },
        getAnalystRecords: () => [point('dam', 'Dam from loaded records', 0)],
      },
    },
    {
      id: 'local-firms',
      name: 'FIRMS',
      enabled: true,
      module: {
        getNearbyContextPoints: () => ({
          points: [
            point('fire-in', 'Fire from live snapshot', 0.4),
            point('fire-out', 'Fire beyond viewport', 5),
          ],
          recordForPoint: (record) => record,
        }),
        getAnalystRecords: () => [
          point('ordinary', 'Capped fire records', 0.5),
        ],
      },
    },
  ];
  const prompts = [];
  const cards = useEntityCardStore(pinia);
  const manager = {
    getAll: () => rows,
    layers: new Map(rows.map((row) => [row.id, row])),
    isEnabled: (id) => rows.some((row) => row.id === id),
  };
  cards.connect({
    dataManager: () => manager,
    askText: (prompt) => prompts.push(prompt),
  });
  cards.setView({
    center: { lat: 0, lon: 0 },
    heightM: 20_000_000,
    rect: { west: -1, east: 1, south: -1, north: 1 },
  });
  input.focus();
  await nextTick();
  const chips = [...document.querySelectorAll('.omnibar-strip__chip')];
  assert.equal(chips.length, 2, 'the fallback dam and the in-viewport fire');
  assert.match(chips[0].textContent, /Dam from loaded records/);
  assert.match(chips[1].textContent, /Fire from live snapshot/);
  $('.omnibar-item--view-ask').click();
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /showing 1 Dams, 1 FIRMS/);
});

test('omnibar preserves ambiguous and disambiguated place queries, including IME input', async (t) => {
  const searched = [];
  const { type, key, mutations } = omnibarFixture(t, (query) =>
    searched.push(query),
  );
  await type('Little Rock');
  await key('Enter', { isComposing: true });
  assert.deepEqual(searched, []);
  await key('Enter');
  await type('Paris, Texas');
  await key('Enter');
  assert.deepEqual(searched, ['Little Rock', 'Paris, Texas']);
  assert.deepEqual(mutations, []);
});

test('omnibar executes explicit commands and click selections, while guides and unknown commands do not mutate', async (t) => {
  const {
    $,
    type,
    key,
    option,
    mutations,
    voiceEvents,
    globeEvents,
    pinia,
    input,
  } = omnibarFixture(t);
  await type('> show flights');
  await key('Enter');
  await type('> hide flights');
  await key('Enter');
  assert.deepEqual(mutations, [
    ['flights', true],
    ['flights', false],
  ]);
  await type('scene layer');
  assert.equal(option('Layer'), undefined);
  assert.equal(option('Guide'), undefined);
  await type('> show scene-layer');
  await key('Enter');
  assert.equal(mutations.length, 2);
  await type('> not a command');
  await key('Enter');
  assert.deepEqual(voiceEvents, []);
  await type('flights');
  const layer = option('Layer');
  layer.dispatchEvent(new Event('pointerdown', { bubbles: true }));
  assert.equal(
    mutations.length,
    2,
    'starting a touch scroll does not select a layer',
  );
  layer.click();
  await nextTick();
  assert.deepEqual(mutations[2], ['flights', true]);
  await type('how to see flights');
  option('Guide').click();
  await nextTick();
  assert.ok($('.gev-guide [role="dialog"]'));
  $('.gev-guide-close').click();
  assert.deepEqual(globeEvents, []);
  assert.equal(mutations.length, 3);
  await type('> north up');
  for (const mode of ['scene-playback-mode', 'cockpit-mode']) {
    document.body.classList.add(mode);
    try {
      const escape = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      });
      input.dispatchEvent(escape);
      assert.equal(escape.defaultPrevented, false);
      await key('Enter');
      assert.deepEqual(globeEvents, []);
    } finally {
      document.body.classList.remove(mode);
    }
  }
  await key('Enter');
  assert.deepEqual(globeEvents, ['northUp']);
  let accepted = false;
  useOmnibarStore(pinia).connect({
    layers: () => [{ id: 'flights', name: 'Flights', enabled: false }],
    setLayer: () => accepted,
  });
  await type('> show flights');
  await key('Enter');
  assert.ok($('#gev-omnibar [role="alert"]').textContent.trim());
  assert.equal(input.getAttribute('aria-expanded'), 'true');
  accepted = true;
  await key('Enter');
  assert.equal($('#gev-omnibar [role="alert"]').textContent.trim(), '');
  assert.equal(input.getAttribute('aria-expanded'), 'false');
});

test('omnibar uses the existing microphone and typed chat controls', async (t) => {
  const { $, type, option, voiceEvents } = omnibarFixture(t);
  await nextTick();
  $('#gev-omnibar button').click();
  await type('What is here?');
  option('Ask').click();
  await nextTick();
  assert.deepEqual(voiceEvents, [
    ['button'],
    ['chat-restore'],
    ['chat-prompt', 'What is here?'],
    ['chat-submit'],
  ]);
});

test('a replacement omnibar search keeps newer input', async (t) => {
  const pending = [];
  const { type, key, input, option, mutations } = omnibarFixture(
    t,
    (query) => new Promise((resolve) => pending.push({ query, resolve })),
  );
  await type('Paris');
  await key('Enter');
  await type('Paris, Texas');
  await key('Enter');
  assert.deepEqual(
    pending.map(({ query }) => query),
    ['Paris', 'Paris, Texas'],
  );
  pending[0].resolve();
  await nextTick();
  assert.equal(document.activeElement, input);
  assert.equal(input.value, 'Paris, Texas');
  await type('flights');
  option('Layer').click();
  await nextTick();
  assert.deepEqual(
    mutations,
    [['flights', true]],
    'a pending place lookup does not block an explicit layer selection',
  );
  pending[1].resolve();
  await nextTick();
});

test('a superseded compound command does not run steps after its flight', async (t) => {
  const { type, key, pinia, mutations, globeEvents } = omnibarFixture(t);
  let finishFlight;
  const calls = [];
  useOmnibarStore(pinia).connectRunner((name) => {
    calls.push(name);
    return new Promise((resolve) => {
      finishFlight = resolve;
    });
  });

  await type('go to Austin and show flights');
  await key('Enter');
  assert.deepEqual(calls, ['fly_to_location']);
  await type('> north up');
  await key('Enter');
  assert.deepEqual(globeEvents, ['northUp']);
  finishFlight({ ok: true });
  await nextTick();
  assert.deepEqual(mutations, []);
});

test('a cancelled flight stops the remaining steps in an omnibar command', async (t) => {
  const { type, key, pinia, mutations } = omnibarFixture(t);
  useOmnibarStore(pinia).connectRunner(async (name) => {
    assert.equal(name, 'fly_to_location');
    return { ok: false, cancelled: true };
  });
  await type('go to Austin and show flights');
  await key('Enter');
  assert.deepEqual(mutations, []);
});

test('failed omnibar searches keep focus and clear their error on edit', async (t) => {
  const { $, controls, input, type, key } = omnibarFixture(t, () => {
    controls.setSearchError('No match');
    controls.settleSearch();
  });
  await type('missing place');
  const results = $('.omnibar-results');
  results.scrollTop = 20;
  assert.equal(results.scrollTop, 20);
  await key('Enter');
  assert.equal(document.activeElement, input);
  assert.equal(results.scrollTop, 0);
  assert.ok($('#gev-omnibar [role="alert"]'));
  await type('corrected place');
  assert.equal($('#gev-omnibar [role="alert"]').textContent.trim(), '');
  await key('Escape');
  assert.equal(document.activeElement, input);
  assert.equal(input.getAttribute('aria-expanded'), 'false');
});

test('a pending omnibar search yields to a newer one without settling its draft', async (t) => {
  const requests = [];
  let lookup;
  const { $, controls, input, type, key } = omnibarFixture(t, (query) =>
    lookup.run(query),
  );
  controls.onSearch = (query) => lookup.run(query);
  const navigation = new NavigationController({
    viewer: {},
    tracking: {
      flightsLayer: {},
      militaryFlightsLayer: {},
      satellitesLayer: {},
    },
    cancelShareSelection() {},
    getDataManager: () => null,
    settleSearch: () => controls.settleSearch(),
  });
  const owner = {
    _disposed: false,
    get _activeLocationSearchGeneration() {
      return navigation._activeLocationSearchGeneration;
    },
    set _activeLocationSearchGeneration(value) {
      navigation._activeLocationSearchGeneration = value;
    },
    _locationControls: controls,
    _setLocationSearchError:
      LocationNavigation.prototype._setLocationSearchError,
    _settleLocationSearchUi:
      navigation._settleLocationSearchUi.bind(navigation),
  };
  lookup = new LocationSearch({
    begin: () => navigation._stampNavigation(),
    isCurrent: (generation) => generation === navigation._navigationGeneration,
    setSearching: (value) => controls.setSearching(value),
    search: (query, options) =>
      new Promise((resolve, reject) =>
        requests.push({ query, options, resolve, reject }),
      ),
  });
  lookup.subscribe(({ state, change }) =>
    LocationNavigation.prototype._handleLocationSearchState.call(
      owner,
      state,
      change,
    ),
  );
  t.after(() => lookup.destroy());
  async function submit(text) {
    await type(text);
    await key('Enter');
  }
  await submit('Old place');
  await submit('New place');
  assert.deepEqual(
    requests.map(({ query }) => query),
    ['Old place', 'New place'],
  );
  assert.equal(requests[0].options.signal.aborted, true);
  assert.equal(input.value, 'New place');
  assert.equal(document.activeElement, input);
  requests[0].reject(new Error('obsolete provider failure'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(controls.searching, true);
  assert.equal(controls.searchError, null);
  assert.equal(input.value, 'New place');
  assert.equal(document.activeElement, input);
  requests[1].resolve(null);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(controls.searching, false);
  assert.equal(controls.searchOrigin, 'omnibar');
  assert.equal(input.value, 'New place');
  assert.equal(document.activeElement, input);
  assert.ok($('#gev-omnibar [role="alert"]').textContent.trim());
});

/** The suggestion rows as `kind: label`, top first. */
function omnibarRows() {
  return [...document.querySelectorAll('#gev-omnibar-list .omnibar-item')].map(
    (row) =>
      `${[...row.classList].find((name) => name.startsWith('omnibar-item--')).slice(14)}: ${row.querySelector('.omnibar-item-label').textContent.trim()}`,
  );
}

test('a command leads only on its exact name, and never the mic or cockpit', async (t) => {
  const { type, input } = omnibarFixture(t);
  const first = () => omnibarRows()[0];
  const activeRow = () =>
    document.getElementById(input.getAttribute('aria-activedescendant'));
  for (const text of ['Voi', 'mic', 'Fly', 'Pilot']) {
    await type(text);
    assert.match(first(), /^place: /, `${text}: ${omnibarRows().join(' | ')}`);
    assert.ok(
      !activeRow().classList.contains('omnibar-item--mic'),
      `${text} must not default to the microphone`,
    );
    assert.doesNotMatch(activeRow().textContent, /cockpit/i, text);
  }
  // Still offered, after the first row.
  await type('mic');
  assert.ok(omnibarRows().includes('mic: Talk to GEV'));
  await type('Fly');
  assert.ok(omnibarRows().includes('plan: Enter cockpit'));
  // A search word alone only finds its command, after the first row.
  await type('Globe');
  assert.equal(first(), 'place: Go to Globe');
  assert.ok(omnibarRows().includes('plan: Globe view'));
  // "Home" reads as Reset view, a whole-view change, so it is no default.
  await type('Home');
  assert.equal(first(), 'plan: Reset view');
  assert.equal(input.getAttribute('aria-activedescendant'), null);
  // A general word is no command name: Enter on it clears nothing.
  await type('everything');
  assert.notEqual(first(), 'plan: Clear all layers');
});

test('an empty field has no default row, so a bare Enter asks nothing', async (t) => {
  const { type, key, input, voiceEvents, option } = omnibarFixture(t);
  await type('');
  assert.ok(option('view-ask'), 'the empty field still offers What’s here?');
  assert.equal(input.getAttribute('aria-activedescendant'), null);
  await key('Enter');
  assert.deepEqual(voiceEvents, []);
  await key('ArrowDown');
  assert.equal(
    input.getAttribute('aria-activedescendant'),
    'gev-omnibar-item-0',
  );
});

test('short place names that start like questions keep a place row first', async (t) => {
  const { type } = omnibarFixture(t);
  for (const text of ['Can Tho', 'Tell City']) {
    await type(text);
    const rows = omnibarRows();
    assert.equal(rows[0], `place: Go to ${text}`, rows.join(' | '));
    assert.ok(
      rows.indexOf(`place: Go to ${text}`) <
        rows.findIndex((row) => row.startsWith('ask:')),
    );
  }
  await type('Can Tho?');
  assert.match(omnibarRows()[0], /^ask: /);
});

test('near-miss lines in the field: clears, turning off, and a place named like a verb', async (t) => {
  const searched = [];
  const { type, key } = omnibarFixture(t, (query) => searched.push(query));
  await type('hide everything');
  assert.equal(omnibarRows()[0], 'plan: Clear all layers');
  await type('remove everything');
  assert.equal(omnibarRows()[0], 'plan: Clear all layers');
  await type('How do I turn off flights');
  // Flights is off already: its row offers nothing to switch.
  assert.ok(
    [
      ...document.querySelectorAll(
        '#gev-omnibar-list .omnibar-item--layer small',
      ),
    ].some((hint) => hint.textContent === 'Layer'),
    omnibarRows().join(' | '),
  );
  await type('Show Low, AZ');
  assert.equal(omnibarRows()[0], 'place: Go to Show Low, AZ');
  await key('Enter');
  assert.deepEqual(searched, ['Show Low, AZ']);
});

test('Escape while a plan waits on its flight leaves the layers alone', async (t) => {
  const { type, key, pinia, mutations, input } = omnibarFixture(t);
  let finishFlight;
  useOmnibarStore(pinia).connectRunner(
    () =>
      new Promise((resolve) => {
        finishFlight = resolve;
      }),
  );
  await type('go to Austin and show flights');
  await key('Enter');
  assert.equal(input.getAttribute('aria-busy'), 'true');
  await key('Escape');
  assert.equal(input.getAttribute('aria-busy'), 'false');
  finishFlight({ ok: true });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(mutations, []);
});

test('a plan step that fails stops the plan and shows the error', async (t) => {
  const { $, type, key, pinia, mutations } = omnibarFixture(t);
  const calls = [];
  useOmnibarStore(pinia).connectRunner(async (name) => {
    calls.push(name);
    return name === 'fly_to_location'
      ? { ok: false, error: 'no route' }
      : { ok: true };
  });
  await type('go to Austin and show flights');
  await key('Enter');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, ['fly_to_location']);
  assert.deepEqual(mutations, []);
  assert.ok($('#gev-omnibar [role="alert"]').textContent.trim());

  // A layer the shell refuses is an error too.
  useOmnibarStore(pinia).connect({
    layers: () => [{ id: 'flights', name: 'Flights', enabled: false }],
    setLayer: () => false,
  });
  useOmnibarStore(pinia).connectRunner(async () => ({ ok: true }));
  await type('show flights near tokyo');
  await key('Enter');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok($('#gev-omnibar [role="alert"]').textContent.trim());
});

test('radio off in a plan flies there first and turns the radio off', async (t) => {
  const { type, key, pinia } = omnibarFixture(t);
  const calls = [];
  useOmnibarStore(pinia).connectRunner(async (name, args) => {
    calls.push([name, args]);
    return { ok: true };
  });
  await type('tokyo and turn off the radio');
  assert.equal(omnibarRows()[0], 'plan: Tokyo · Radio off');
  await key('Enter');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, [
    ['fly_to_location', { query: 'tokyo', waitForArrival: true }],
    ['control_radio', { action: 'disable' }],
  ]);
});

test('the field states what it controls and the mic its state', async (t) => {
  const { $, type, input } = omnibarFixture(t);
  input.blur();
  await nextTick();
  assert.equal(input.getAttribute('aria-controls'), null);
  await type('flights');
  assert.equal(input.getAttribute('aria-controls'), 'gev-omnibar-list');
  assert.ok($('#gev-omnibar-list'));
  const mic = $('.omnibar-mic');
  // Off until a voice session is in voice mode.
  assert.equal(mic.getAttribute('aria-pressed'), 'false');
});

test('the guide is a non-modal dialog that takes focus and only Escape', async (t) => {
  const { $, type, option } = omnibarFixture(t);
  await type('how to see flights');
  option('Guide').click();
  await nextTick();
  await nextTick();
  const dialog = $('.gev-guide [role="dialog"]');
  assert.equal(dialog.getAttribute('aria-modal'), 'false');
  // Steps are announced from a status line, not the whole dialog.
  assert.equal(dialog.getAttribute('aria-live'), null);
  assert.equal($('.gev-guide-status').getAttribute('role'), 'status');
  assert.equal(document.activeElement, dialog);
  const other = new KeyboardEvent('keydown', {
    key: 'a',
    bubbles: true,
    cancelable: true,
  });
  document.dispatchEvent(other);
  assert.equal(other.defaultPrevented, false);
  assert.ok($('.gev-guide'), 'another key leaves the guide open');
  const escape = new KeyboardEvent('keydown', {
    key: 'Escape',
    bubbles: true,
    cancelable: true,
  });
  document.dispatchEvent(escape);
  assert.equal(escape.defaultPrevented, true);
  assert.equal($('.gev-guide'), null);
});

test('a bare ">" picks nothing, and whole-map commands need their name', async (t) => {
  const { type, key, pinia, input, mutations } = omnibarFixture(t);
  const acted = [];
  useGlobeActionsStore(pinia).connect({
    clear: () => acted.push('clear'),
    reset: () => acted.push('reset'),
    northUp: () => acted.push('northUp'),
  });
  for (const text of ['>', '> ', '> cl', '> clear']) {
    await type(text);
    assert.ok(omnibarRows().length, text);
    assert.equal(input.getAttribute('aria-activedescendant'), null, text);
    await key('Enter');
  }
  assert.deepEqual(acted, []);
  assert.deepEqual(mutations, []);
  // Its exact name makes it the default.
  await type('> Clear all layers');
  assert.equal(
    input.getAttribute('aria-activedescendant'),
    'gev-omnibar-item-0',
  );
  await key('Enter');
  assert.deepEqual(acted, ['clear']);
  // A harmless command still leads on its name.
  await type('> North up');
  await key('Enter');
  assert.deepEqual(acted, ['clear', 'northUp']);
});

test('place names holding a command word go to the place on Enter', async (t) => {
  const searched = [];
  const { type, key, input, pinia } = omnibarFixture(t, (query) =>
    searched.push(query),
  );
  useOmnibarStore(pinia).connect({
    layers: () => [
      { id: 'flights', name: 'Flights', enabled: false },
      { id: 'rocket-launches', name: 'Rocket launches', enabled: false },
      { id: 'earthquakes', name: 'Earthquakes', enabled: false },
      { id: 'radio', name: 'Radio', enabled: false },
    ],
    setLayer: () => {},
  });
  const activeRow = () =>
    document.getElementById(input.getAttribute('aria-activedescendant'));
  for (const text of [
    'Cockpit Country, Jamaica',
    'Radio City Music Hall',
    'Radio Free Europe',
    'Thermal, California',
    'Tilt Cove',
    'Hud Valley',
    'Rock and Roll Hall of Fame',
    'cockpit',
    'cockpit view',
  ]) {
    await type(text);
    assert.match(
      omnibarRows()[0],
      /^place: Go to /,
      `${text}: ${omnibarRows().join(' | ')}`,
    );
    assert.ok(activeRow().classList.contains('omnibar-item--place'), text);
    await key('Enter');
    assert.equal(searched.at(-1), text);
  }
  // The plan is still offered, second.
  await type('Thermal, California');
  assert.equal(omnibarRows()[1], 'plan: California · Style: Thermal');
  // A word alone is no action default.
  for (const text of ['music', 'link', 'heat', 'green', 'rotate', 'missions']) {
    await type(text);
    assert.ok(
      !/^(plan|mic): /.test(
        activeRow()?.classList.contains('omnibar-item--place')
          ? ''
          : omnibarRows()[0],
      ),
      `${text}: ${omnibarRows().join(' | ')}`,
    );
    assert.ok(activeRow()?.classList.contains('omnibar-item--place'), text);
  }
  // "earth" offers the globe view before the earthquakes layer.
  await type('earth');
  const rows = omnibarRows();
  const globe = rows.indexOf('plan: Globe view');
  assert.ok(globe > 0, rows.join(' | '));
  const quakes = rows.findIndex((row) => row.startsWith('layer: Earthquakes'));
  assert.ok(quakes === -1 || globe < quakes, rows.join(' | '));
});

test('several places and a magnitude floor in one line', async (t) => {
  const { type, pinia } = omnibarFixture(t);
  useOmnibarStore(pinia).connect({
    layers: () => [
      { id: 'flights', name: 'Flights', enabled: false },
      { id: 'earthquakes', name: 'Earthquakes', enabled: false },
    ],
    setLayer: () => {},
  });
  await type('flights near New York and Paris');
  const rows = omnibarRows();
  assert.match(rows[0], /^plan: New York · /);
  assert.ok(rows.includes('place: Go to Paris'), rows.join(' | '));
  await type('show me earthquakes above m5 in japan');
  assert.ok(
    omnibarRows().includes('place: Go to Japan'),
    omnibarRows().join(' | '),
  );
});

test('a refusal shows the action’s own short reason', async (t) => {
  const { $, type, key, pinia } = omnibarFixture(t);
  useOmnibarStore(pinia).connectRunner(async () => ({
    ok: false,
    error: 'internal: no such entity',
    say: 'I could not find that flight.',
  }));
  await type('follow ual123');
  await key('Enter');
  await new Promise((resolve) => setTimeout(resolve, 0));
  const alert = $('#gev-omnibar [role="alert"]').textContent;
  assert.match(alert, /I could not find that flight\./);
  assert.doesNotMatch(alert, /internal/);
});

test('a plan whose flight does not land stops before its layers', async (t) => {
  const { type, key, pinia, mutations } = omnibarFixture(t);
  // A location search that was superseded answers neither true nor found.
  useLocationStore(pinia).controls.search = async () => ({ cancelled: true });
  await type('go to Austin and show flights');
  await key('Enter');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(mutations, []);
});

test('pressing the mic stops a plan still waiting on its flight', async (t) => {
  const { type, key, pinia, mutations, voiceEvents, $ } = omnibarFixture(t);
  let land;
  useOmnibarStore(pinia).connectRunner((name) =>
    name === 'fly_to_location'
      ? new Promise((resolve) => {
          land = () => resolve({ ok: true });
        })
      : { ok: true },
  );
  await type('go to Austin and show flights');
  await key('Enter');
  await new Promise((resolve) => setTimeout(resolve, 0));
  $('#gev-omnibar .omnibar-mic').click();
  assert.deepEqual(voiceEvents.at(-1), ['button']);
  land();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(mutations, []);
});

test('"how to measure distance" walks to Draw in Utilities', async (t) => {
  const { type, key, $ } = omnibarFixture(t);
  const rail = document.body.appendChild(document.createElement('div'));
  rail.className = 'ui-rail--left';
  const utilities = rail.appendChild(document.createElement('button'));
  utilities.className = 'ui-rail__item';
  utilities.dataset.railItem = 'utilities-panel';
  utilities.setAttribute('aria-pressed', 'true');
  const draw = document.body.appendChild(document.createElement('button'));
  draw.id = 'draw-toggle';
  t.after(() => {
    rail.remove();
    draw.remove();
    $('.gev-guide-close')?.click();
  });
  await type('how to measure distance');
  await key('Enter');
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
  assert.match(
    $('.gev-guide [role="dialog"]').textContent,
    /Press Draw to start drawing on the map/,
  );
});

test('the field keeps focus after a command, a plan or a layer runs', async (t) => {
  const { type, key, input } = recordingOmnibar(t, ['cctv']);
  input.focus();
  for (const text of ['> North up', 'North up', 'show flights', 'noir']) {
    await type(text);
    await key('Enter');
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();
    assert.equal(document.activeElement, input, text);
    assert.equal(input.value, '', text);
  }
});

test('a tapped or clicked row lets go of the field', async (t) => {
  const { type, input } = recordingOmnibar(t);
  input.focus();
  await type('North up');
  document.querySelector('#gev-omnibar-list .omnibar-item').click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
  assert.notEqual(document.activeElement, input);
});

test('while drawing, Enter leaves the keys to the draw tool', async (t) => {
  const { type, key, input, pinia } = recordingOmnibar(t);
  useDisplayStore(pinia).publishDraw({ active: true, shape: 'line' });
  input.focus();
  await type('North up');
  await key('Enter');
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
  assert.notEqual(document.activeElement, input);
});

test("on the phone, the keyboard's Go key lets go of the field too", async (t) => {
  const { type, key, input } = recordingOmnibar(t);
  document.body.classList.add('mobile-shell');
  t.after(() => document.body.classList.remove('mobile-shell'));
  input.focus();
  await type('North up');
  await key('Enter');
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
  assert.notEqual(document.activeElement, input);
});

test('Escape closes the list, then lets go of the empty field', async (t) => {
  const { key, input } = recordingOmnibar(t);
  input.focus();
  await key('Escape');
  assert.equal(document.activeElement, input);
  await key('Escape');
  assert.notEqual(document.activeElement, input);
});

test('asking GEV hands the keyboard to the chat', async (t) => {
  const { type, key, input } = recordingOmnibar(t);
  input.focus();
  await type('how far is paris');
  await key('Enter');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.notEqual(document.activeElement, input);
});

test('text withheld as private says so', async (t) => {
  const { type } = recordingOmnibar(t);
  const note = () =>
    [...document.querySelectorAll('#gev-omnibar [role="status"]')].find(
      (element) => /Looks private/.test(element.textContent),
    );
  await type('4111 1111 1111 1111');
  assert.notEqual(note().style.display, 'none');
  await type('Tokyo');
  assert.equal(note().style.display, 'none');
});

test('a panel with no rail button fails rather than passing for done', async (t) => {
  const { enter, $ } = recordingOmnibar(t);
  await enter('Open Utilities');
  assert.match(
    $('#gev-omnibar [role="alert"]').textContent,
    /Unable to complete this action/,
  );
});

test('outside English a refusal shows the translated message alone', async (t) => {
  t.after(() => setLocale('en'));
  setLocale('de');
  const { type, key, pinia, $ } = omnibarFixture(t);
  useOmnibarStore(pinia).connectRunner(async () => ({
    ok: false,
    say: 'I could not find that flight.',
  }));
  await type('follow ual123');
  await key('Enter');
  await new Promise((resolve) => setTimeout(resolve, 0));
  const alert = $('#gev-omnibar [role="alert"]').textContent;
  assert.ok(alert.trim());
  assert.doesNotMatch(alert, /could not find/);
});

test('a recent place that came from Photon shows the OpenStreetMap credit', async (t) => {
  const store = globalThis.localStorage;
  store.setItem(
    'gev:omnibar:recent-places',
    JSON.stringify([
      {
        name: 'Shibuya Crossing',
        latitude: 35.6595,
        longitude: 139.7005,
        source: 'photon',
      },
    ]),
  );
  t.after(() => store.removeItem('gev:omnibar:recent-places'));
  stubPhoton(t);
  const { type, credits } = recordingOmnibar(t);
  await type('Tokyo');
  assert.ok(
    [...document.querySelectorAll('.omnibar-strip__chip')].some((chip) =>
      chip.textContent.includes('Shibuya Crossing'),
    ),
  );
  assert.equal(credits.at(-1), true);
});

/** The fixture with a recording runner and globe actions, as the shell has. */
function recordingOmnibar(
  t,
  layers = [],
  { acts: actNames = ['clear', 'reset', 'share', 'northUp', 'tilt'] } = {},
) {
  const searched = [];
  const fixture = omnibarFixture(t, (query) => searched.push(query));
  const calls = [];
  const acted = [];
  const switched = [];
  const credits = [];
  // One list, so a test can change a layer's live state.
  const layerList = [
    { id: 'flights', name: 'Flights', enabled: false },
    ...layers.map((id) => ({
      id,
      name: id.replace(/-/g, ' '),
      enabled: false,
    })),
  ];
  useOmnibarStore(fixture.pinia).connect({
    layers: () => layerList,
    setLayer: (...args) => switched.push(args),
    creditSuggestions: (shown) => credits.push(shown),
  });
  useOmnibarStore(fixture.pinia).connectRunner(async (name, args) => {
    calls.push([name, args]);
    return { ok: true };
  });
  const acts = {};
  for (const act of actNames) acts[act] = () => acted.push(act);
  useGlobeActionsStore(fixture.pinia).connect(acts);
  async function enter(text) {
    await fixture.type(text);
    await fixture.key('Enter');
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();
  }
  return {
    ...fixture,
    searched,
    calls,
    acted,
    switched,
    credits,
    layerList,
    enter,
  };
}

test('the radio and sharing are never Enter defaults unless named in full', async (t) => {
  const { enter, calls, acted, input, type, switched } = recordingOmnibar(t, [
    'radio',
  ]);
  for (const text of [
    'radio',
    'Radio',
    '> radio',
    'share',
    'Share',
    'copy map',
  ]) {
    await enter(text);
    assert.deepEqual(calls, [], text);
    assert.deepEqual(acted, [], text);
  }
  await type('radio');
  // Not asked outright: the place row leads, the Radio layer follows.
  assert.deepEqual(omnibarRows().slice(0, 2), [
    'place: Go to Radio',
    'layer: Radio',
  ]);
  assert.equal(
    input.getAttribute('aria-activedescendant'),
    'gev-omnibar-item-0',
  );
  // The Radio layer plays sound too: a verb turns it on, its name alone not.
  assert.deepEqual(switched, []);
  await enter('turn on radio');
  assert.deepEqual(switched, [['radio', true]]);
  await enter('Share this view');
  assert.deepEqual(acted, ['share']);
  // Its full name runs the command where no Radio layer answers it first.
  await enter('Enable Radio');
  assert.deepEqual(switched.at(-1), ['radio', true]);
  assert.deepEqual(calls, []);
});

test('the radio command runs on its full name', async (t) => {
  const { enter, calls } = recordingOmnibar(t);
  await enter('radio');
  assert.deepEqual(calls, []);
  await enter('Enable Radio');
  assert.deepEqual(calls, [['control_radio', { action: 'enable' }]]);
});

test('"go to" takes the rest of its clause as the place, keywords and all', async (t) => {
  const { enter, calls, acted, switched, searched } = recordingOmnibar(t);
  for (const [text, place] of [
    ['go to cockpit country', 'cockpit country'],
    ['go to Thermal, California', 'Thermal, California'],
    ['fly to Tilt Cove', 'Tilt Cove'],
    ['go to Night Vision Way', 'Night Vision Way'],
    ['go to Whole Earth Provision', 'Whole Earth Provision'],
  ]) {
    await enter(text);
    // A place alone goes through the place search, with nothing else run.
    assert.equal(searched.at(-1), place, text);
    assert.deepEqual(calls, [], text);
  }
  assert.deepEqual(acted, []);
  assert.deepEqual(switched, []);
  calls.length = 0;
  await enter('go to Austin and show flights');
  assert.deepEqual(
    calls.map(([name]) => name),
    ['fly_to_location'],
  );
  assert.deepEqual(switched, [['flights', true]]);
});

test('a radio verb must apply to the radio', async (t) => {
  const { enter, calls } = recordingOmnibar(t);
  await enter('play radio in Kill Devil Hills');
  assert.deepEqual(calls, [
    ['control_radio', { action: 'enable', locationQuery: 'kill devil hills' }],
  ]);
});

test('Ask GEV is no default for a word or two, and CJK names are places from two characters', async (t) => {
  const { enter, voiceEvents, searched, input, type } = recordingOmnibar(t);
  // Two letters are too few for a place or a question; "help" may be a
  // place, so it searches rather than asking.
  for (const text of ['NY', 'Uk', 'hi']) {
    await type(text);
    assert.equal(input.getAttribute('aria-activedescendant'), null, text);
    await enter(text);
  }
  await enter('help');
  assert.deepEqual(voiceEvents, []);
  assert.deepEqual(searched.splice(0), ['help']);
  for (const text of ['東京', '北京', '서울']) {
    await type(text);
    assert.equal(omnibarRows()[0], `place: Go to ${text}`, text);
    await enter(text);
  }
  assert.deepEqual(searched, ['東京', '北京', '서울']);
  await enter('what is here?');
  assert.deepEqual(voiceEvents.at(-1), ['chat-submit']);
});

test('the place service is asked about whole names, never about callsigns', async (t) => {
  const asked = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    asked.push(new URL(String(url)).searchParams.get('q'));
    return Response.json({ features: [] });
  };
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  const { type } = recordingOmnibar(t, ['traffic']);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 800));
  for (const text of ['UAL2110', 'N123AB', 'BAW15K']) {
    await type(text);
    await settle();
  }
  assert.deepEqual(asked, []);
  for (const text of ['Tokyo traffic', 'Home, Washington', '東京']) {
    await type(text);
    await settle();
  }
  assert.deepEqual(asked, ['Tokyo traffic', 'Home, Washington', '東京']);
});

test('the search shortcut leaves an open dialog its focus', async (t) => {
  const { input } = recordingOmnibar(t);
  const dialog = document.body.appendChild(document.createElement('div'));
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  const button = dialog.appendChild(document.createElement('button'));
  button.focus();
  document.dispatchEvent(
    new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true }),
  );
  assert.notEqual(document.activeElement, input);
  dialog.remove();
  button.blur();
  document.dispatchEvent(
    new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true }),
  );
  assert.equal(document.activeElement, input);
});

test('a modal dialog kept in a hidden container does not hold the search shortcut', async (t) => {
  const { input } = recordingOmnibar(t);
  // A page may keep its sign-in dialog in the document and hide the section
  // around it: the dialog is closed, so Cmd/Ctrl+K and "/" still focus the field.
  const gate = document.body.appendChild(document.createElement('section'));
  t.after(() => gate.remove());
  gate.hidden = true;
  const dialog = gate.appendChild(document.createElement('div'));
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  const isMac = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform || '');
  const commandK = () =>
    new KeyboardEvent('keydown', {
      key: 'k',
      metaKey: isMac,
      ctrlKey: !isMac,
      bubbles: true,
      cancelable: true,
    });
  const press = commandK();
  document.body.dispatchEvent(press);
  assert.ok(document.activeElement === input);
  assert.equal(press.defaultPrevented, true);
  input.blur();
  document.body.dispatchEvent(
    new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true }),
  );
  assert.ok(document.activeElement === input);
  // Shown again, the dialog keeps its keys.
  input.blur();
  gate.hidden = false;
  document.body.dispatchEvent(commandK());
  assert.ok(document.activeElement !== input);
});

// ── Enter-safety table ─────────────────────────────────────────────────
// Every line below is typed into the mounted Omnibar and Enter pressed with
// no row chosen; the table says exactly what runs. See src/ui/omnibarEnter.js
// and the Omnibar section of docs/CURRENT-STATE.md for the rule.
// `search(q)` is the place search, `fly(q)` a plan's flight, `nothing`
// means Enter ran nothing at all.
const ENTER_TABLE = [
  // A switch after its subject, a closing full stop, "please",
  // names that look like questions, words about a layer.
  ['noir off', 'style(normal)'],
  ['turn off noir', 'style(normal)'],
  ['Show flights.', 'layer(flights,on)'],
  ['please show flights', 'layer(flights,on)'],
  ['North up.', 'globe(northUp)'],
  ['Do it Best Hardware', 'search(Do it Best Hardware)'],
  ['Can You Imagine', 'search(Can You Imagine)'],
  ['Show radio stations', 'layer(radio,on)'],
  ['I went to the store yesterday and it was really great', 'nothing'],
  ['123 45 6789', 'nothing'],
  ['hunter22', 'nothing'],
  // A layer is asked for only by a switch right before its word.
  ['Kill Devil Hills radio', 'search(Kill Devil Hills radio)'],
  ['Show Low radio', 'search(Show Low radio)'],
  ['show low radio', 'search(show low radio)'],
  ['Show Low noir', 'search(Show Low noir)'],
  ['See radio', 'search(See radio)'],
  ['PIN code 1234', 'nothing'],
  ['my bank pin is 1234', 'nothing'],
  ['123-45-6789', 'nothing'],
  ['pw hunter2', 'nothing'],
  ['Bearer abcdef', 'nothing'],
  // Verbs in any letter case.
  ['Turn on the radio', 'layer(radio,on)'],
  ['Turn On Radio', 'layer(radio,on)'],
  ['Draw', 'open(utilities)'],
  // A bundled place's name that is also a command or layer word.
  ['Thermal', 'search(Thermal)'],
  ['Normal', 'search(Normal)'],
  ['Hurricane', 'search(Hurricane)'],
  ['Ski', 'search(Ski)'],
  ['Street', 'search(Street)'],
  ['Bike', 'search(Bike)'],
  ['Rain', 'search(Rain)'],
  // A question's form alone asks nothing.
  ['Is there', 'search(Is there)'],
  ['Can I', 'search(Can I)'],
  ['Do it', 'search(Do it)'],
  ['what is', 'search(what is)'],
  ['how to', 'search(how to)'],
  ['Who is it', 'search(Who is it)'],
  ['N Y?', 'nothing'],
  ['how far is paris', 'ask(how far is paris)'],
  ['東京はどこ？', 'ask(東京はどこ？)'],
  ['وين القاهرة؟', 'ask(وين القاهرة؟)'],
  ['what cheer', 'search(what cheer)'],
  ['List', 'search(List)'],
  ['Describe', 'search(Describe)'],
  // Verbs are read per clause, never inside a place's name.
  ['radio near Clear Lake', 'search(clear lake)'],
  ['radio in Show Low', 'search(show low)'],
  ['Clear Lake radio', 'search(Clear Lake radio)'],
  ['radio near Race Track', 'search(race track)'],
  ['radio near Zoom Hill', 'search(zoom hill)'],
  ['radio near Stop, Arkansas', 'search(stop, arkansas)'],
  ['radio near Mute', 'search(mute)'],
  ['turn radio on', 'radio(enable)'],
  ['start radio', 'radio(enable)'],
  ['toggle radio', 'layer(radio,on)'],
  ['Track Hill', 'search(Track Hill)'],
  // A question mark alone is no question; names that start like one are places.
  ['?', 'nothing'],
  ['??', 'nothing'],
  ['what?', 'nothing'],
  ['Why?', 'nothing'],
  ['who?', 'nothing'],
  ['Can Tho City', 'search(Can Tho City)'],
  ['Can Gio District', 'search(Can Gio District)'],
  ['Is Kinabalu Park', 'search(Is Kinabalu Park)'],
  // A bare switch verb only lists what it could switch.
  ['hide', 'nothing'],
  ['remove', 'nothing'],
  ['disable', 'nothing'],
  ['turn off', 'nothing'],
  ['switch off', 'nothing'],
  ['clear everything', 'globe(clear)'],
  ['hide everything near tokyo', 'fly(tokyo) + globe(clear)'],
  ['hide everything in tokyo', 'fly(tokyo) + globe(clear)'],
  // Private text gets no rows and no search.
  ['4111 1111 1111 1111', 'nothing'],
  ['+1 (415) 555-0100', 'nothing'],
  ['SSN 123-45-6789', 'nothing'],
  ['GB29 NWBK 6016 1331 9268 19', 'nothing'],
  ['sk_live_51Habcdef', 'nothing'],
  ['pk_live_abc', 'nothing'],
  ['password hunter2', 'nothing'],
  ['me@example.com', 'nothing'],
  ['>', 'nothing'],
  ['> ', 'nothing'],
  ['a', 'nothing'],
  ['ny', 'nothing'],
  ['Uk', 'nothing'],
  ['hi', 'nothing'],
  ['help', 'search(help)'],
  ['Is', 'nothing'],
  ['why', 'search(why)'],
  ['how', 'search(how)'],
  ['what', 'search(what)'],
  ['who', 'search(who)'],
  ['where', 'search(where)'],
  ['explain', 'search(explain)'],
  ['summarize', 'search(summarize)'],
  ['Why, Arizona', 'search(Why, Arizona)'],
  ['What Cheer', 'search(What Cheer)'],
  ['What Cheer, Iowa', 'search(What Cheer, Iowa)'],
  ['Tell City', 'search(Tell City)'],
  ['Tell City, Indiana', 'search(Tell City, Indiana)'],
  ['Can Tho', 'search(Can Tho)'],
  ['Can Tho, Vietnam', 'search(Can Tho, Vietnam)'],
  ['what is here', 'ask(what is here)'],
  ['how far is tokyo', 'ask(how far is tokyo)'],
  // An auxiliary's question without "?" offers GEV but runs nothing.
  ['is it raining in tokyo', 'nothing'],
  ['is it raining in tokyo?', 'ask(is it raining in tokyo?)'],
  ['where is tokyo?', 'ask(where is tokyo?)'],
  ['radio', 'search(radio)'],
  ['> radio', 'nothing'],
  ['radio near tokyo', 'search(tokyo)'],
  ['Radio, Tokyo', 'search(Radio, Tokyo)'],
  ['radio in Kill Devil Hills', 'search(kill devil hills)'],
  ['play radio in Tokyo', 'radio(enable@tokyo)'],
  ['turn on radio', 'layer(radio,on)'],
  ['radio on', 'radio(enable)'],
  ['Enable Radio', 'layer(radio,on)'],
  ['Radio City Music Hall', 'search(Radio City Music Hall)'],
  ['share', 'nothing'],
  ['copy map', 'nothing'],
  ['Share this view', 'globe(share)'],
  ['home', 'nothing'],
  ['start over', 'nothing'],
  ['Reset view', 'globe(reset)'],
  ['globe', 'search(globe)'],
  ['Globe view', 'zoom_to_globe'],
  ['clear', 'search(clear)'],
  ['clear map', 'globe(clear)'],
  ['hide everything', 'globe(clear)'],
  ['Clear all layers', 'globe(clear)'],
  ['> Clear all layers', 'globe(clear)'],
  ['> cl', 'nothing'],
  ['close all panels', 'close(left) + close(right)'],
  ['Close left panel', 'close(left)'],
  ['cockpit', 'search(cockpit)'],
  ['Cockpit Country', 'search(Cockpit Country)'],
  ['enter cockpit', 'control_cockpit'],
  ['mic', 'search(mic)'],
  ['Talk to GEV', 'mic'],
  ['display', 'nothing'],
  ['turn on', 'nothing'],
  ['flights', 'layer(flights,on)'],
  ['show flights', 'layer(flights,on)'],
  ['earthquakes', 'layer(earthquakes,on)'],
  ['Hurricane, Utah', 'search(Hurricane, Utah)'],
  ['Thermal, California', 'search(Thermal, California)'],
  ['Tilt Cove', 'search(Tilt Cove)'],
  ['Satellite Beach', 'search(Satellite Beach)'],
  ['tokyo traffic', 'search(tokyo traffic)'],
  ['go to tokyo in noir', 'search(tokyo)'],
  ['go to tokyo, noir', 'search(tokyo)'],
  ['go to Tokyo, north up', 'search(tokyo)'],
  ['take me to Austin in thermal', 'search(austin)'],
  ['go to London with flights', 'search(london)'],
  ['go to tokyo show flights', 'search(tokyo)'],
  ['go to Thermal, California', 'search(Thermal, California)'],
  ['fly to Tilt Cove', 'search(Tilt Cove)'],
  ['go to Night Vision Way', 'search(Night Vision Way)'],
  ['go to cockpit country', 'search(cockpit country)'],
  ['go to Whole Earth Provision', 'search(Whole Earth Provision)'],
  ['go to Austin and show flights', 'fly(austin) + layer(flights,on)'],
  [
    'go to Austin and show flights in noir',
    'fly(austin) + style(noir) + layer(flights,on)',
  ],
  ['show flights near Tokyo', 'fly(tokyo) + layer(flights,on)'],
  ['flights near tokyo', 'fly(tokyo) + layer(flights,on)'],
  ['earthquakes above m5 in japan', 'fly(japan) + layer(earthquakes,on)'],
  ['go to Paris, Texas and noir', 'fly(paris, texas) + style(noir)'],
  ['go to tokyo and follow UAL123', 'fly(tokyo) + follow(ual123)'],
  // Keywords without a verb ask for nothing, however many clauses: the
  // place after "near" is searched and the plan offered.
  ['noir and cctv near austin, north up', 'search(austin)'],
  [
    'show noir and show cctv near austin, face north',
    'fly(austin) + style(noir) + layer(cctv,on) + globe(northUp)',
  ],
  ['noir', 'style(noir)'],
  ['North up', 'globe(northUp)'],
  ['> North up', 'globe(northUp)'],
  ['zoom in', 'adjust_camera_zoom'],
  ['orbit', 'move_camera'],
  ['follow UAL123', 'follow(ual123)'],
  ['nearest plane to heathrow', 'select_nearest_aircraft'],
  ['東京', 'search(東京)'],
  ['Show Low, AZ', 'search(Show Low, AZ)'],
  ['Paris, Texas', 'search(Paris, Texas)'],
];

async function enterOutcome(t, text, { hover = false } = {}) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ features: [] });
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  const m = recordingOmnibar(t, [
    'earthquakes',
    'cctv',
    'radio',
    'traffic',
    'weather-cyclones',
    'ski-pistes',
    'bikeshare',
    'weather-radar',
  ]);
  // Open side panels whose rail buttons record a close.
  const closed = [];
  const opened = [];
  for (const side of ['left', 'right']) {
    const rail = document.body.appendChild(document.createElement('div'));
    rail.className = `ui-rail--${side}`;
    const button = rail.appendChild(document.createElement('button'));
    button.className = 'ui-rail__item';
    button.setAttribute('aria-pressed', 'true');
    button.dataset.railItem = `${side}-panel`;
    button.addEventListener('click', () => closed.push(side));
  }
  // Utilities, closed, for "open draw options".
  const utilities = document
    .querySelector('.ui-rail--left')
    .appendChild(document.createElement('button'));
  utilities.className = 'ui-rail__item';
  utilities.setAttribute('aria-pressed', 'false');
  utilities.dataset.railItem = 'utilities-panel';
  utilities.addEventListener('click', () => opened.push('utilities'));
  await m.type(text);
  if (hover) {
    const rows = [
      ...document.querySelectorAll('#gev-omnibar-list .omnibar-item'),
    ];
    rows.at(-1)?.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    await nextTick();
  }
  await m.key('Enter');
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
  const events = [
    ...m.searched.map((q) => `search(${q})`),
    ...m.calls.map(([name, args]) =>
      name === 'fly_to_location'
        ? `fly(${args.query})`
        : name === 'set_visual_style'
          ? `style(${args.style})`
          : name === 'control_radio'
            ? `radio(${args.action}${args.locationQuery ? `@${args.locationQuery}` : ''})`
            : name === 'track_entity'
              ? `follow(${args.query})`
              : name,
    ),
    ...m.switched.map(([id, on]) => `layer(${id},${on ? 'on' : 'off'})`),
    ...m.acted.map((act) => `globe(${act})`),
    ...m.voiceEvents
      .filter(([kind]) => kind === 'chat-prompt')
      .map(([, q]) => `ask(${q})`),
    ...m.voiceEvents.filter(([kind]) => kind === 'button').map(() => 'mic'),
    ...closed.map((side) => `close(${side})`),
    ...opened.map((panel) => `open(${panel})`),
  ];
  return events.join(' + ') || 'nothing';
}

for (const [text, expected] of ENTER_TABLE)
  test(`Enter on ${JSON.stringify(text)} runs ${expected}`, async (t) => {
    assert.equal(await enterOutcome(t, text), expected);
  });

// The pointer last on the Ask GEV row, or on a guarded plan, changes
// nothing: Enter still runs the default (or nothing).
for (const [text, expected] of [
  ['radio near tokyo', 'search(tokyo)'],
  ['Share', 'nothing'],
  ['hi', 'nothing'],
])
  test(`hovering a row of ${JSON.stringify(text)} never makes it what Enter runs`, async (t) => {
    assert.equal(await enterOutcome(t, text, { hover: true }), expected);
  });

/** Route Photon requests to a stub; return the queries it was sent. */
function stubPhoton(t, features = () => []) {
  const asked = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const q = new URL(String(url)).searchParams.get('q');
    asked.push(q);
    return Response.json({ features: features(q) });
  };
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  return asked;
}
const settle = (ms = 800) => new Promise((resolve) => setTimeout(resolve, ms));

for (const text of [
  '4111 1111 1111 1111',
  '4111-1111-1111-1111',
  '+1 (415) 555-0100',
  '415.555.0100 x12',
  'SSN 123-45-6789',
  'GB29 NWBK 6016 1331 9268 19',
  'DE89370400440532013000',
  'sk_live_51Habcdef',
  'rk_live_51Habcdef',
  'pk_live_abc',
  'password hunter2',
  'my passcode is 4433',
  'pin 1234',
  'me@example.com',
  'PIN code 1234',
  'my bank pin is 1234',
  '123-45-6789',
  'pw hunter2',
  'Bearer abcdef',
])
  test(`private text ${JSON.stringify(text)} is never looked up or searched`, async (t) => {
    const asked = stubPhoton(t);
    const { type, key, searched, calls } = recordingOmnibar(t);
    await type(text);
    await settle();
    // At most a row to search it as a place on purpose, which Enter skips.
    assert.ok(omnibarRows().every((row) => row.includes('as a place anyway')));
    await key('Enter');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(asked, []);
    assert.deepEqual(searched, []);
    assert.deepEqual(calls, []);
  });

test('a row chosen with the keys stays chosen when rows arrive above it', async (t) => {
  stubPhoton(t, (q) => [
    {
      geometry: { type: 'Point', coordinates: [2.35, 48.86] },
      properties: {
        name: 'Paris',
        country: 'France',
        countrycode: 'fr',
        osm_value: 'city',
      },
    },
    {
      geometry: { type: 'Point', coordinates: [-95.55, 33.66] },
      properties: {
        name: `${q} Texas`,
        country: 'United States',
        countrycode: 'us',
        osm_value: 'city',
      },
    },
  ]);
  const { type, key, voiceEvents, searched } = recordingOmnibar(t);
  await type('Paris');
  // Choose Ask GEV, the second row, before the suggestions come in.
  assert.deepEqual(omnibarRows(), [
    'place: Go to Paris',
    'ask: Ask GEV: “Paris”',
  ]);
  await key('ArrowDown');
  await settle();
  assert.ok(omnibarRows().length > 2, omnibarRows().join(' | '));
  await key('Enter');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(searched, []);
  assert.deepEqual(
    voiceEvents.find(([kind]) => kind === 'chat-prompt'),
    ['chat-prompt', 'Paris'],
  );
});

test('a plan switches a layer by its state when it runs, not when it was read', async (t) => {
  const { type, key, switched, calls, layerList } = recordingOmnibar(t);
  await type('go to Austin and show flights');
  // Flights came on elsewhere after the line was read.
  layerList[0].enabled = true;
  await key('Enter');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(
    calls.map(([name]) => name),
    ['fly_to_location'],
  );
  assert.deepEqual(switched, []);
});

test('a globe action nobody answers fails the plan', async (t) => {
  const { $, type, key, acted } = recordingOmnibar(t, [], { acts: ['clear'] });
  await type('go to Austin and tilt');
  await key('Enter');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(acted, []);
  assert.ok($('#gev-omnibar [role="alert"]').textContent.trim());
});

test('the OpenStreetMap credit shows while Photon suggestions do', async (t) => {
  stubPhoton(t, () => [
    {
      geometry: { type: 'Point', coordinates: [139.69, 35.69] },
      properties: {
        name: 'Tokyo',
        country: 'Japan',
        countrycode: 'jp',
        osm_value: 'city',
      },
    },
  ]);
  const { type, key, credits } = recordingOmnibar(t);
  await type('Tokyo');
  await settle();
  assert.deepEqual(credits, [true]);
  await key('Escape');
  await nextTick();
  assert.deepEqual(credits, [true, false]);
});

test('ids name no layer: "Local" and "Global" search a place', async (t) => {
  stubPhoton(t);
  const searched = [];
  const fixture = omnibarFixture(t, (query) => searched.push(query));
  const switched = [];
  useOmnibarStore(fixture.pinia).connect({
    layers: () => [
      { id: 'local-firms', name: 'Active fires', enabled: false },
      { id: 'global-context', name: 'World context', enabled: false },
      // A shown name holding a word of kind names it only in full.
      { id: 'local-adsb', name: 'Local ADS-B', enabled: false },
    ],
    setLayer: (...args) => switched.push(args),
  });
  for (const text of ['Local', 'Global']) {
    await fixture.type(text);
    await fixture.key('Enter');
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.deepEqual(switched, []);
  assert.deepEqual(searched, ['Local', 'Global']);
});

// A deterministic sample of about 2,000 bundled place names, alone and with
// " radio" and " noir" after them: none may default to an action. Sweeping
// every name the same way takes minutes, so the suite samples them.
test('bundled place names never default to an action', async (t) => {
  stubPhoton(t);
  const { readFile, readdir } = await import('node:fs/promises');
  const names = new Set();
  const cities = JSON.parse(
    await readFile(
      new URL(
        '../data/local_data/wikidata_cities/cities.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  for (const row of cities.rows) names.add(row[0]);
  const dir = new URL('../data/local_data/wikidata_places/', import.meta.url);
  for (const file of (await readdir(dir)).sort())
    if (/^-?\d+_-?\d+\.json$/.test(file))
      for (const row of JSON.parse(await readFile(new URL(file, dir), 'utf8'))
        .rows)
        names.add(row[0]);
  const all = [...names].sort();
  const step = Math.floor(all.length / 2000);
  const sample = all.filter((_, index) => index % step === 0);
  // The words of PLACE_WORDS are in the sample too.
  sample.push(
    'Thermal',
    'Normal',
    'Hurricane',
    'Ski',
    'Street',
    'Bike',
    'Rain',
  );
  const { type, input } = recordingOmnibar(t, [
    'radio',
    'traffic',
    'earthquakes',
    'weather-cyclones',
    'news',
  ]);
  const wrong = [];
  for (const name of sample)
    for (const text of [name, `${name} radio`, `${name} noir`]) {
      await type(text);
      const id = input.getAttribute('aria-activedescendant');
      const row = id && document.getElementById(id);
      if (row && !row.classList.contains('omnibar-item--place'))
        wrong.push(`${text} => ${row.textContent.trim()}`);
    }
  assert.ok(sample.length > 1900, `${sample.length} names`);
  assert.deepEqual(wrong, []);
});
