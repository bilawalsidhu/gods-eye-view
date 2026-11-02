// src/ui/commandDock.test.mjs — the command dock and the scene chrome render
// what VisualSettings publishes, over happy-dom.
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia } from 'pinia';
import { createApp, h, nextTick } from 'vue';
import { setLocale } from '../i18n/index.js';
import { useDisplayStore } from './stores/display.js';
import { useLocationStore } from './stores/location.js';
import { LocationControls } from './locationControls.js';
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
  const active = () =>
    [...document.querySelectorAll('.style-btn.active')].map(
      (button) => button.dataset.style,
    );
  return { $, settings, active, pinia };
}

test('before VisualSettings publishes, the dock shows NORMAL', (t) => {
  const { $, active } = fixture(t);
  assert.deepEqual(active(), ['normal']);
  assert.equal($('#style-mini-value').textContent, 'NORMAL');
  assert.equal($('#active-style-name').textContent, 'NORMAL');
});

test('the active style marks its button and labels the dock and the corner', async (t) => {
  const { $, settings, active } = fixture(t);
  settings._publishActiveStyle('thermal');
  await nextTick();
  assert.deepEqual(active(), ['thermal']);
  assert.equal($('#style-mini-value').textContent, 'FLIR');
  assert.equal($('#active-style-name').textContent, 'FLIR');
  settings.activeStyle = 'unlisted';
  settings._publishActiveStyle();
  await nextTick();
  assert.deepEqual(active(), []);
  assert.equal($('#style-mini-value').textContent, 'UNLISTED');
  settings._publishActiveStyle('normal');
  await nextTick();
  assert.deepEqual(active(), ['normal']);
});

test('the style buttons keep classes other code sets', async (t) => {
  const { $, settings } = fixture(t);
  const noir = $('.style-btn[data-style="noir"]');
  noir.classList.add('voice-highlight');
  settings._publishActiveStyle('noir');
  await nextTick();
  assert.equal(noir.classList.contains('voice-highlight'), true);
  assert.equal(noir.classList.contains('active'), true);
});

test('the dock and the corner label the style in the UI language', async (t) => {
  t.after(() => setLocale('en'));
  setLocale('ru');
  const { $, settings } = fixture(t);
  assert.equal($('#style-mini-value').textContent, 'ОБЫЧНЫЙ');
  assert.equal($('#active-style-name').textContent, 'ОБЫЧНЫЙ');
  settings._publishActiveStyle('noir');
  await nextTick();
  assert.equal($('#style-mini-value').textContent, 'НУАР');
  assert.equal($('#active-style-name').textContent, 'НУАР');
});

const chipView = (activeId, { warn = false, text = 'OSM' } = {}) => ({
  chips: [
    {
      id: 'bing-aerial',
      label: 'Bing',
      available: false,
      active: false,
      requirement: 'ION',
      title: 'Needs a key',
      ariaLabel: 'Bing unavailable: Needs a key',
    },
    ...['esri-imagery', 'osm'].map((id) => ({
      id,
      label: id.toUpperCase(),
      available: true,
      active: id === activeId,
      requirement: '',
      title: id.toUpperCase(),
      ariaLabel: null,
    })),
  ],
  status: { text, warn },
});

test('the map source row renders the published chips and selects through the controls', async (t) => {
  const { $, pinia } = fixture(t);
  assert.equal($('#map-stack-status').textContent, '3D');
  assert.equal(document.querySelectorAll('.map-stack-chip').length, 0);
  const store = useDisplayStore(pinia);
  const selected = [];
  store.connectMapSource({
    select: async (id) => selected.push(id),
  });
  store.publishMapSource(chipView('osm'));
  await nextTick();
  const chips = [
    ...document.querySelectorAll('#map-stack-chips .map-stack-chip'),
  ];
  assert.deepEqual(
    chips.map((chip) => chip.dataset.stackId),
    ['bing-aerial', 'esri-imagery', 'osm'],
  );
  const [bing, esri, osm] = chips;
  assert.equal(bing.classList.contains('unavailable'), true);
  assert.equal(
    bing.disabled,
    false,
    'unavailable chips stay keyboard-reachable',
  );
  assert.equal(bing.getAttribute('aria-disabled'), 'true');
  assert.equal(
    bing.getAttribute('aria-label'),
    'Bing unavailable: Needs a key',
  );
  assert.equal(bing.title, 'Needs a key');
  assert.equal(bing.querySelector('.map-stack-chip-req').textContent, 'ION');
  assert.equal(osm.classList.contains('active'), true);
  assert.equal(osm.getAttribute('aria-pressed'), 'true');
  assert.equal(osm.hasAttribute('aria-label'), false);
  assert.equal(esri.querySelector('.map-stack-chip-req'), null);
  bing.click();
  esri.click();
  assert.deepEqual(selected, ['esri-imagery']);
  esri.classList.add('voice-highlight');
  store.publishMapSource(chipView('esri-imagery', { text: '...', warn: true }));
  await nextTick();
  assert.equal(esri.classList.contains('active'), true);
  assert.equal(esri.classList.contains('voice-highlight'), true);
  assert.equal(osm.classList.contains('active'), false);
  assert.equal($('#map-stack-status').textContent, '...');
  assert.equal($('#map-stack-status').classList.contains('warn'), true);
  store.publishMapSource(null);
  await nextTick();
  assert.equal($('#map-stack-status').textContent, '3D');
  assert.equal($('#map-stack-status').classList.contains('warn'), false);
  assert.equal(document.querySelectorAll('.map-stack-chip').length, 0);
});

test('the ORBIT indicator sits on the body while offered and lights while orbiting', async (t) => {
  const { $, pinia } = fixture(t);
  assert.equal($('#orbit-indicator'), null);
  const store = useLocationStore(pinia);
  const controls = new LocationControls({
    elements: {
      search: $('#location-search'),
    },
    cities: {},
    getExpandedCity: () => null,
    onCity() {},
    onPoi() {},
    onSearch() {},
    onReset() {},
    publish: (view) => store.publish(view),
    requestFrame() {},
    cancelFrame() {},
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

test('the location tray renders what LocationControls publishes', async (t) => {
  const { $, pinia } = fixture(t);
  assert.equal($('#location-mini-city').textContent, '📍 Location: --');
  assert.equal($('#location-mini-poi').textContent, 'Landmark: --');
  const store = useLocationStore(pinia);
  const calls = [];
  const frames = [];
  const controls = new LocationControls({
    elements: {
      search: $('#location-search'),
    },
    cities: {
      paris: { name: 'Paris', pois: [{ name: 'Louvre' }, { name: 'Eiffel' }] },
      rome: { name: 'Rome', pois: [{ name: 'Colosseum' }] },
    },
    getExpandedCity: () => null,
    onCity: (id) => calls.push(['city', id]),
    onPoi: (id, index) => calls.push(['poi', id, index]),
    onSearch() {},
    onReset() {},
    publish: (view) => store.publish(view),
    requestFrame: (fn) => frames.push(fn),
    cancelFrame() {},
  });
  t.after(() => controls.destroy());
  store.connect(controls);
  await nextTick();
  const pills = [
    ...document.querySelectorAll('#location-pills .location-pill'),
  ];
  assert.deepEqual(
    pills.map((pill) => `${pill.dataset.locationId}:${pill.textContent}`),
    ['paris:Paris', 'rome:Rome'],
  );
  pills[1].click();
  assert.deepEqual(calls, [['city', 'rome']]);
  pills[1].classList.add('voice-highlight');
  controls.highlightCity('rome');
  controls.showPois('paris');
  await nextTick();
  assert.equal(pills[1].classList.contains('active'), true);
  assert.equal(pills[1].classList.contains('voice-highlight'), true);
  const row = $('#poi-row');
  const pois = [...row.querySelectorAll('.poi-pill')];
  assert.deepEqual(
    pois.map((poi) => poi.textContent),
    ['QLouvre', 'WEiffel'],
  );
  assert.equal(row.classList.contains('expanded'), false);
  frames.shift()();
  await nextTick();
  assert.equal(row.classList.contains('expanded'), true);
  assert.equal($('#location-bar-divider').classList.contains('visible'), true);
  controls.highlightPoi(1);
  await nextTick();
  assert.equal(pois[1].classList.contains('active'), true);
  pois[1].click();
  assert.deepEqual(calls.at(-1), ['poi', 'paris', 1]);
  // Switching cities while the row is open swaps its pills and keeps it open.
  controls.showPois('rome');
  await nextTick();
  assert.equal(row.classList.contains('expanded'), true);
  const romePois = [...row.querySelectorAll('.poi-pill')];
  assert.deepEqual(
    romePois.map((poi) => poi.textContent),
    ['QColosseum'],
  );
  assert.equal(romePois[0].classList.contains('active'), false);
  romePois[0].click();
  assert.deepEqual(calls.at(-1), ['poi', 'rome', 0]);
  frames.shift()();
  controls.renderStatus({
    city: { name: 'Paris' },
    currentPoi: { name: 'Eiffel' },
  });
  controls.setSearchError('No match');
  await nextTick();
  assert.match($('#location-mini-city').textContent, /Paris/);
  assert.match($('#location-mini-poi').textContent, /Eiffel/);
  assert.equal($('#location-search-error').textContent, 'No match');
  const search = $('#location-search');
  assert.equal(search.getAttribute('aria-invalid'), 'true');
  assert.equal(
    search.getAttribute('aria-describedby'),
    'location-search-error',
  );
  controls.setSearchError(null);
  controls.hidePois();
  await nextTick();
  assert.equal(search.hasAttribute('aria-invalid'), false);
  assert.equal(search.hasAttribute('aria-describedby'), false);
  assert.equal($('#location-search-error').textContent, '');
  assert.equal(row.classList.contains('expanded'), false);
  assert.equal($('#location-bar-divider').classList.contains('visible'), false);
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
      'search:search:Search',
      'more:more_horiz:More',
    ],
  );
  assert.deepEqual(
    tabs.map((tab) => tab.getAttribute('aria-expanded')),
    ['false', 'false', 'false', 'false', 'false'],
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
    ['false', 'false', 'true', 'false', 'false'],
  );
  store.publishPhoneShell({ enabled: false, sheet: null, tabs: MOBILE_TABS });
  await nextTick();
  assert.equal(bar.getAttribute('aria-hidden'), 'true');
  assert.equal(backdrop.hidden, true);
  assert.deepEqual(
    tabs.map((tab) => tab.getAttribute('aria-expanded')),
    ['false', 'false', 'false', 'false', 'false'],
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
  const tab = $('#mobile-tab-bar [data-mobile-sheet="search"]');
  tab.focus();
  tab.click();
  await nextTick();
  assert.equal(tab.getAttribute('aria-expanded'), 'true');
  assert.equal(document.activeElement?.id, 'location-search');
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

test('the search toggle opens the field, and a lookup marks it', async (t) => {
  const { $, pinia } = fixture(t);
  const store = useLocationStore(pinia);
  const controls = new LocationControls({
    elements: { search: $('#location-search') },
    cities: {},
    getExpandedCity: () => null,
    onCity() {},
    onPoi() {},
    onSearch() {},
    onReset() {},
    publish: (view) => store.publish(view),
    requestFrame() {},
    cancelFrame() {},
  });
  t.after(() => controls.destroy());
  store.connect(controls);
  await nextTick();
  const field = $('#location-search');
  assert.equal(field.classList.contains('expanded'), false);
  $('#search-toggle').click();
  await nextTick();
  assert.equal(field.classList.contains('expanded'), true);
  assert.equal(document.activeElement, field);
  controls.setSearching(true);
  await nextTick();
  assert.equal(field.classList.contains('searching'), true);
  controls.settleSearch();
  await nextTick();
  assert.equal(field.classList.contains('searching'), false);
  assert.equal(field.classList.contains('expanded'), false);
});
