// src/ui/contextPanel.test.mjs — the Context panel: situational awareness
// of the layers that are on, and the Contacts mode switch ContextControls
// presents, over happy-dom.
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPinia } from 'pinia';
import { createApp, nextTick } from 'vue';
import ContextView from './views/ContextView.vue';
import LayerPanelsView from './views/LayerPanelsView.vue';
import { LayerPanel } from './layerPanel.js';
import { useLayerFinderStore } from './stores/layerFinder.js';
import { INSPECTOR_PULSE_MS, useEntityCardStore } from './stores/entityCard.js';
import { usePanelChromeStore } from './stores/panelChrome.js';
import { useSpaceMissionsStore } from './stores/spaceMissions.js';
import { useLayerCountsStore } from './stores/layerCounts.js';
import { createLayerCounts } from './layerCounts.js';
import { getConfiguredLayerCounts } from '../services/application.js';
import { installEntityContext } from './entityContextBridge.js';
import { bindRenderer } from '../render/rendererOf.js';
import { fakeInput } from '../input/testDoubles.mjs';
import { contextRadiusKm, setContextRadiusKm } from './contextRadius.js';
import {
  closeContextSearch,
  contextSearchOpen,
  contextSearchText,
} from './contextSearch.js';
import { useContextStore } from './stores/context.js';
import { useBhoteKoshiPanelStore } from './stores/bhoteKoshiPanel.js';
import { useDisplayStore } from './stores/display.js';
import { useCockpitStore } from './stores/cockpit.js';
import { activeTab } from './contextLayerTabs.js';
import { ContextControls } from './contextControls.js';
import { createControls as createWildlifeControls } from '../layers/wildlifeSightings/controls.js';
import { normalizeInatObservations } from '../layers/wildlifeSightings/records.js';
import { aircraftIcon } from '../data/aircraftIcons.js';
import { LayerLifecycle } from '../data/lifecycle.js';
import { searchHls } from '../layers/recentImagery/catalog.js';
import { createRecentImageryLayer } from '../layers/recentImagery/index.js';
import {
  BOX,
  candidate,
  fakeCatalog,
  fakeRenderer,
  fakeThumbnails,
} from '../layers/recentImagery/testDoubles.mjs';
import { firePerimeterSnapshot } from '../layers/perimeters/records.js';
import { setLocale } from '../i18n/index.js';
import { applicationI18n } from './i18n.js';

const turn = () => new Promise((resolve) => setImmediate(resolve));

// Austin, Texas: a zoomed-in view, well below globe scale.
const HERE = { lat: 30.27, lon: -97.74 };
const flight = (id, lat, lon) => ({
  id,
  icao24: id,
  callsign: id.toUpperCase(),
  lat,
  lon,
  altitudeM: 2500,
});

/**
 * Mount Context with a data manager whose layers are given as
 * `{id, name, enabled, records, stats}`. Returns what the tests read.
 */

function fixture(
  t,
  layers,
  {
    previews = null,
    fetchImpl = null,
    brief = null,
    getCounts = getConfiguredLayerCounts,
    openPanel = null,
    useInspector = Boolean(fetchImpl || brief),
    startOpen = true,
    finderControls = true,
  } = {},
) {
  // Weather and hazard reads stay off the network: every feed answers 503.
  const realFetch = globalThis.fetch;
  globalThis.fetch =
    fetchImpl || (async () => new Response('', { status: 503 }));
  document.body.replaceChildren();
  const host = document.body.appendChild(document.createElement('div'));
  const pinia = createPinia();
  if (finderControls) t.after(useLayerFinderStore(pinia).attachControls());
  const app = createApp(ContextView).use(pinia);
  const cards = useEntityCardStore(pinia);
  const chrome = usePanelChromeStore(pinia);
  const radius = contextRadiusKm.value;
  let owner = null;
  let disconnect = () => cards.connect(null);
  let mounted = false;
  const unmount = () => {
    if (!mounted) return;
    mounted = false;
    app.unmount();
  };
  // Cleanup is registered before anything can throw: a fixture that fails
  // part way must not leave the app mounted, its timers running and the
  // fetch stub in place, or the test file never exits.
  t.after(() => {
    disconnect();
    if (owner) chrome.detach(owner);
    unmount();
    setContextRadiusKm(radius);
    closeContextSearch();
    contextSearchText.value = '';
    globalThis.fetch = realFetch;
  });
  app.mount(host);
  mounted = true;
  owner = chrome.connect({});
  // The layers given, kept live: a test can turn one off or empty it.
  const rows = layers.map((layer) =>
    Object.assign(layer, {
      module: {
        getAnalystRecords: () => layer.records || [],
        ...(layer.module || {}),
      },
    }),
  );
  const followed = [];
  const flown = [];
  const picked = [];
  const letGone = [];
  const asked = [];
  // The data manager's change listeners: a test announces a layer change.
  const layerListeners = new Set();
  const notifyLayers = () => {
    layerListeners.forEach((listener) => listener({ type: 'enabled' }));
    if (!useInspector) cards.publishInspectorRows(manager.getAll());
  };
  let manager = {
    layers: new Map(rows.map((row) => [row.id, row])),
    isEnabled: (id) => Boolean(rows.find((row) => row.id === id)?.enabled),
    getAll: () => rows.slice(),
    subscribe(listener) {
      layerListeners.add(listener);
      return () => layerListeners.delete(listener);
    },
  };
  let point;
  if (useInspector) {
    const viewer = { scene: {} };
    const input = fakeInput(viewer);
    const listeners = new Map();
    let pose = {};
    const unbind = bindRenderer(viewer, {
      camera: {
        pose: () => pose,
        viewRectangle: () => null,
        on(event, listener) {
          listeners.set(event, listener);
          return () => listeners.delete(event);
        },
      },
    });
    point = (center) => {
      pose = { ...center, height: 40_000 };
      listeners.get('moveEnd')();
    };
    const counts = useLayerCountsStore(pinia);
    const dispose = installEntityContext({
      viewer,
      pinia,
      getDataManager: () => manager,
      regionalBrief: brief,
      inspector: {
        counts: createLayerCounts({
          getCounts,
          readState: () => counts.state,
          writeState: counts.publish,
          readShown: () => cards.inspector.shown,
        }),
      },
    });
    disconnect = () => {
      dispose();
      unbind();
      input.destroy();
    };
  } else {
    cards.connect({
      dataManager: () => manager,
      previews: () => previews,
      openPanel,
      // As the app answers it: aircraft and satellites can be followed.
      canFollow: (card) =>
        ['flights', 'military', 'satellites'].includes(card?.layerId),
      follow: (card) => followed.push(card.key),
      flyTo: (card) => flown.push(card.key),
      // As the app answers it: a layer that selects by id takes the pick.
      pick: (card) =>
        typeof manager.layers.get(card.layerId)?.module?.pickById ===
          'function' && Boolean(picked.push(card.key)),
      letGo: (card) => letGone.push(card.key),
      ask: (card, title) => asked.push({ key: card.key, title }),
    });
    cards.publishInspectorRows(manager.getAll());
  }
  chrome.publish(owner, 'global-context-panel', { collapsed: !startOpen });
  chrome.publish(owner, 'data-panel', { collapsed: true });
  const $ = (selector) => document.querySelector(selector);
  const close = () =>
    chrome.publish(owner, 'global-context-panel', { collapsed: true });
  return {
    $,
    cards,
    pinia,
    followed,
    flown,
    picked,
    letGone,
    asked,
    close,
    notifyLayers,
    point,
    open: () =>
      chrome.publish(owner, 'global-context-panel', { collapsed: false }),
    unmount,
    replaceManager: (next) => {
      manager = next;
    },
  };
}

const flightsOn = (records, stats = {}) => ({
  id: 'flights',
  name: 'Live Flights',
  enabled: true,
  records,
  stats: { count: records.length, lastUpdate: Date.now(), ...stats },
});

// The Contacts mode switch, rendered from what ContextControls presents.
function contactsFixture(t) {
  document.body.replaceChildren();
  const host = document.body.appendChild(document.createElement('div'));
  const pinia = createPinia();
  const app = createApp(ContextView).use(pinia);
  app.mount(host);
  const $ = (id) => document.getElementById(id);
  const store = useContextStore(pinia);
  const controls = new ContextControls({
    elements: {
      _globalContextFlightsBtn: $('global-context-flights-btn'),
      _installationsSearchBtn: $('installations-search-btn'),
    },
    installations: {},
    actions: {
      getCockpit: () => null,
      claimVisualAuthority() {},
      showToast() {},
      setClearBusy() {},
      syncDetection() {},
      scheduleLayout() {},
      refreshRadio() {},
      setPanelCollapsed() {},
    },
    publish: (view) => store.publish(view),
  });
  t.after(() => {
    controls.stop();
    controls.disconnect();
    app.unmount();
  });
  const sync = async () => {
    controls._syncContextModeButtons();
    await nextTick();
  };
  return { $, controls, sync };
}

test('before ContextControls renders, the switch shows its initial markup', (t) => {
  const { $ } = contactsFixture(t);
  const panel = $('global-context-panel');
  assert.equal(
    panel.className,
    'ui-panel panel-collapsible collapsed ui-panel--collapsed',
  );
  assert.equal(panel.hasAttribute('data-context-mode'), false);
  const tab = $('global-context-flights-btn');
  assert.equal(
    tab.className,
    'ui-button ui-focus ui-button--ghost ui-button--accent context-mode-button',
  );
  assert.equal(tab.getAttribute('aria-selected'), 'false');
  assert.equal(tab.getAttribute('tabindex'), '0');
  assert.equal(tab.hasAttribute('aria-busy'), false);
  assert.equal($('context-mode-standby').hidden, false);
  assert.equal($('context-flights-view').hidden, true);
  assert.equal($('global-context-missions-btn'), null);
  assert.equal($('context-missions-view'), null);
  assert.equal($('installations-search-btn').hasAttribute('aria-busy'), false);
});

test('a Contacts transition keeps the tab focusable until it settles', async (t) => {
  const { $, controls, sync } = contactsFixture(t);
  const contacts = $('global-context-flights-btn');
  contacts.focus();
  controls._contextModeChanging = true;
  await sync();
  assert.equal(document.activeElement, contacts);
  assert.equal(contacts.disabled, false);
  assert.equal(contacts.getAttribute('tabindex'), '0');
  assert.equal(contacts.getAttribute('aria-disabled'), 'true');
  assert.equal(contacts.getAttribute('aria-busy'), 'true');

  controls._contextModeChanging = false;
  controls._contextMode = 'flights';
  await sync();
  assert.equal(document.activeElement, contacts);
  assert.equal(contacts.disabled, false);
  assert.equal(contacts.getAttribute('aria-disabled'), 'false');
  assert.equal(contacts.getAttribute('aria-busy'), 'false');
  assert.equal(contacts.classList.contains('active'), true);
  assert.equal(contacts.getAttribute('aria-selected'), 'true');
  assert.equal($('context-mode-standby').hidden, true);
  assert.equal($('context-flights-view').hidden, false);
});

test('the panel carries the mode beside the classes its chrome writes', async (t) => {
  const { $, controls, sync } = contactsFixture(t);
  const panel = $('global-context-panel');
  panel.classList.remove('collapsed');
  controls._contextMode = 'flights';
  await sync();
  // Without an owner the button, and the kit class, keep the start state.
  assert.equal(
    panel.className,
    'ui-panel panel-collapsible ui-panel--collapsed context-enabled',
  );
  assert.equal(panel.getAttribute('data-context-mode'), 'flights');
  assert.equal($('context-flights-view').hidden, false);

  panel.classList.add('collapsed');
  controls._contextMode = null;
  await sync();
  assert.equal(
    panel.className,
    'ui-panel panel-collapsible ui-panel--collapsed collapsed',
  );
  assert.equal(panel.getAttribute('data-context-mode'), 'none');
  assert.equal($('context-mode-standby').hidden, false);
  assert.equal($('context-flights-view').hidden, true);
});

test('the nearby sites search is busy, without native disable, until it settles', async (t) => {
  const { $, controls } = contactsFixture(t);
  const button = $('installations-search-btn');
  let release;
  let enables = 0;
  controls._dataManager = {
    layers: new Map([['military-installations', {}]]),
    setEnabled: () => {
      enables += 1;
      return new Promise((resolve) => (release = resolve));
    },
    isEnabled: () => true,
  };
  controls.installations.searchNearby = async () => true;
  button.focus();
  button.click();
  await nextTick();
  assert.equal(button.getAttribute('aria-busy'), 'true');
  assert.equal(button.getAttribute('aria-disabled'), 'true');
  assert.equal(button.disabled, false);
  assert.equal(document.activeElement === button, true);
  button.click();
  assert.equal(enables, 1, 'a busy search ignores a second click');

  release(true);
  await turn();
  await nextTick();
  assert.equal(button.getAttribute('aria-busy'), 'false');
  assert.equal(button.getAttribute('aria-disabled'), 'false');
});

test('with Context closed, the collapsible sections are already in the page for PanelChrome', (t) => {
  // PanelChrome finds collapsible panels once, at startup, by their collapse
  // buttons; Context starts closed, so a section that mounts only while it
  // is open would never be registered and its +/- would do nothing.
  contactsFixture(t);
  assert.equal(
    document
      .getElementById('global-context-panel')
      .classList.contains('collapsed'),
    true,
  );
  const targets = [
    ...document.querySelectorAll('.panel-collapse-btn[data-collapse-target]'),
  ].map((button) => button.dataset.collapseTarget);
  for (const id of ['station-panel', 'live-panel', 'radio-panel'])
    assert.ok(targets.includes(id), `${id} is there to be registered`);
});

const NEAREST = '.nearby-lists__row--nearest button';

test('nothing picked: one list per layer that is on, nearest first; its first row is picked as a click picks it', async (t) => {
  const { $, cards, followed, flown, picked, letGone } = fixture(t, [
    {
      ...flightsOn([
        flight('far01', 30.9, -97.74),
        flight('near01', 30.31, -97.74),
      ]),
      module: { pickById: () => true },
    },
    // A closer vessel on a layer that is off never counts.
    {
      id: 'ais-live-vessels',
      name: 'Live Vessels',
      enabled: false,
      records: [
        {
          id: 'boat01',
          mmsi: 'boat01',
          name: 'BOAT',
          lat: 30.271,
          lon: -97.741,
        },
      ],
    },
  ]);
  cards.setView({ center: HERE, heightM: 40_000 });
  await nextTick();
  const lists = [...document.querySelectorAll('.nearby-lists__layer')];
  assert.deepEqual(
    lists.map((list) => list.dataset.layer),
    ['flights'],
    'only layers that are on',
  );
  const rows = [...lists[0].querySelectorAll('li')].map(
    (row) => row.textContent,
  );
  assert.match(rows[0], /NEAR01/, 'sorted by distance');
  assert.match(rows[1], /FAR01/);
  const nearest = $(NEAREST);
  assert.ok(nearest, 'the first row is marked nearest');
  assert.match(nearest.textContent, /NEAR01.*Nearest/);
  assert.doesNotMatch(
    document.querySelector('.view-context').textContent,
    /BOAT/,
  );
  nearest.click();
  await nextTick();
  assert.equal(cards.card?.identity.id, 'near01');
  assert.deepEqual(followed, [], 'a tap does not follow');
  assert.deepEqual(
    picked,
    [cards.card.key],
    'its layer selects and centres it, as a click on it does',
  );
  assert.deepEqual(flown, [], 'no framing flight besides');
  // Closing the card lets the selection go, though nothing follows it.
  const key = cards.card.key;
  cards.clear();
  assert.deepEqual(letGone, [key]);
});

test('selected flight route rounds a 999.6 metre leg to one kilometre', async (t) => {
  const { $, cards } = fixture(t, [
    flightsOn([flight('near01', HERE.lat, HERE.lon)]),
  ]);
  cards.setView({ center: HERE, heightM: 40_000 });
  await nextTick();
  $(NEAREST).click();
  await nextTick();
  const offset = (0.9996 / 6371) * (180 / Math.PI);
  cards.card = {
    ...cards.card,
    route: {
      verified: true,
      from: 'AAA',
      to: 'BBB',
      fromAt: { lat: HERE.lat - offset, lon: HERE.lon },
      toAt: { lat: HERE.lat + offset, lon: HERE.lon },
    },
  };
  await nextTick();
  const legs = $('.entity-card__route-stats').children;
  assert.match(legs[0].textContent, /1 km/);
  assert.match(legs[1].textContent, /1 km/);
});

test('Nearby traffic card footer localizes the flow source and preserves provider credits', async (t) => {
  t.after(() => setLocale('en'));
  setLocale('es');
  const { $, cards } = fixture(t, [
    {
      id: 'traffic',
      name: 'Street Traffic',
      enabled: true,
      records: [
        {
          ...HERE,
          id: 'road',
          name: 'Congress Avenue',
          source: 'simulated-keyless',
        },
      ],
    },
  ]);
  cards.setView({ center: HERE, heightM: 40_000 });
  await nextTick();
  $('.nearby-lists [data-row-layer="traffic"]').click();
  await nextTick();
  assert.match(
    $('.entity-card__source:has(> span)').textContent,
    /Simulado \(sin clave de TomTom\)/,
  );
  assert.equal(
    cards.sourceOf({ layerId: 'traffic', source: 'Road-Feed (TX)' }),
    'Road-Feed (TX)',
  );
  assert.equal(
    cards.sourceOf({ layerId: 'other', source: 'simulated-keyless' }),
    'simulated-keyless',
  );
});

test('Nearby fire cards localize the last growth fact', async (t) => {
  t.after(() => setLocale('en'));
  setLocale('fr');
  const growth = Date.UTC(2026, 6, 15);
  const {
    fires: [fire],
  } = firePerimeterSnapshot(
    [
      {
        stableId: 'fixture-fire',
        name: 'Fixture Fire',
        polygonTime: growth,
        polygons: [
          [
            [
              [-97.75, 30.26],
              [-97.73, 30.26],
              [-97.73, 30.28],
              [-97.75, 30.26],
            ],
          ],
        ],
      },
    ],
    { now: growth + 60_000 },
  );
  const { anchor, ...record } = fire;
  const { $, cards } = fixture(t, [
    {
      id: 'fire-perimeters',
      name: 'Fire Perimeters',
      enabled: true,
      records: [{ ...record, ...anchor }],
    },
  ]);
  cards.setView({ center: HERE, heightM: 40_000 });
  await nextTick();
  $('.nearby-lists [data-row-layer="fire-perimeters"]').click();
  await nextTick();

  const facts = $('.entity-card__facts');
  assert.ok(facts);
  const growthLabel = [...facts.querySelectorAll('dt')].find(
    (part) => part.textContent === 'Dernière progression',
  );
  assert.ok(growthLabel);
  assert.equal(growthLabel.nextElementSibling.textContent, '15 juil. 2026');
});

test('filtered Nearby keeps Acartia attribution and viewing guidance visible on selection', async (t) => {
  contextSearchStyles(t);
  const center = { lat: 48.5, lon: -123.1 };
  const sighting = {
    ...center,
    stableId: 'acartia:9',
    origin: 'acartia',
    commonName: 'Harbor seal',
    cetacean: false,
    observedAt: Date.now(),
    provider: { name: 'Synthetic Whale Network', entity: 'Partner' },
    link: 'https://acartia.io/',
  };
  const { methods } = createWildlifeControls({
    state: { enabled: true, rows: new Map([[sighting.stableId, sighting]]) },
    services: { now: Date.now },
    parts: {},
  });
  const { $, cards, flown } = fixture(t, [
    {
      id: 'wildlife-sightings',
      name: 'Wildlife Sightings',
      stats: { source: 'iNaturalist' },
      enabled: true,
      module: {
        getAnalystRecords: (...args) =>
          methods.getAnalystRecords(...args).map((record) => ({
            ...record,
            website: 'https://example.com/',
          })),
      },
    },
  ]);
  cards.setView({ center, heightM: 40_000 });
  contextSearchOpen.value = true;
  contextSearchText.value = 'seal';
  await nextTick();
  assert.ok($('#context-tab-view').classList.contains('context-searching'));

  const button = $('.nearby-lists [data-row-layer="wildlife-sightings"]');
  assert.match(button.textContent, /Harbor seal/);
  button.click();
  await nextTick();

  assert.equal(cards.card.identity.id, sighting.stableId);
  assert.deepEqual(flown, [cards.card.key]);
  const card = $('.entity-card');
  const footer = card.querySelector('p.entity-card__source:has(> span)');
  assert.match(footer.textContent, /^Source Acartia(?: ·|$)/);
  const credit = [...card.querySelectorAll('p')].find((paragraph) =>
    paragraph.textContent.includes(
      'Reported by Synthetic Whale Network (Partner)',
    ),
  );
  assert.match(credit.textContent, /CC BY 4\.0/);
  assert.notEqual(getComputedStyle(credit).display, 'none');
  const source = card.querySelector('a[href="https://acartia.io/"]');
  const guidance = card.querySelector('a[href="https://www.bewhalewise.org"]');
  assert.match(source.textContent, /Acartia/);
  assert.ok(guidance, 'Acartia viewing guidance is linked on a seal card');
  for (const link of [source, guidance]) {
    for (let node = link; node !== card; node = node.parentElement) {
      assert.notEqual(getComputedStyle(node).display, 'none', link.textContent);
    }
  }
  const website = card.querySelector('a[href="https://example.com/"]');
  assert.equal(getComputedStyle(website.parentElement).display, 'none');
  card.querySelector('button[aria-label="Close card"]').click();
  await nextTick();
  assert.equal(contextSearchText.value, 'seal');
  assert.ok($('.nearby-lists [data-row-layer="wildlife-sightings"]'));
});

test('filtered Nearby keeps the iNaturalist observation link visible on selection', async (t) => {
  contextSearchStyles(t);
  const link = 'https://www.inaturalist.org/observations/1';
  const { $, cards } = fixture(t, [
    {
      id: 'wildlife-sightings',
      name: 'Wildlife Sightings',
      enabled: true,
      records: [
        {
          ...HERE,
          id: 'inat:1',
          name: 'Barred Owl',
          source: 'iNaturalist',
          obscured: true,
          link,
        },
      ],
    },
  ]);
  cards.setView({ center: HERE, heightM: 40_000 });
  contextSearchOpen.value = true;
  contextSearchText.value = 'owl';
  await nextTick();
  const row = $('.nearby-lists [data-row-layer="wildlife-sightings"]');
  assert.match(
    row.querySelector('.nearby-lists__meta').textContent,
    /approximate/,
  );
  row.click();
  await nextTick();
  const where = $('.entity-card__where').textContent;
  assert.match(where, /Location obscured to a 0\.2° cell/);
  assert.doesNotMatch(where, /\.\d{3}°/);
  const source = $(`.entity-card__attribution-links a[href="${link}"]`);
  assert.ok(source);
  assert.notEqual(getComputedStyle(source.parentElement).display, 'none');
  assert.equal($('.entity-card a[href="https://www.bewhalewise.org"]'), null);
});

test('selected cards qualify nearby distances when either end is an obscured sighting', async (t) => {
  const { $, cards } = fixture(t, [
    {
      id: 'local-dams',
      enabled: true,
      records: [{ ...HERE, id: 'dam', name: 'Dam' }],
    },
    {
      id: 'local-datacenters',
      enabled: true,
      records: [{ ...HERE, id: 'dc', name: 'Datacenter' }],
    },
    {
      id: 'wildlife-sightings',
      enabled: true,
      records: [
        { ...HERE, id: 'inat:1', name: 'Owl', obscured: true },
        { ...HERE, id: 'acartia:2', name: 'Whale', source: 'Acartia' },
      ],
    },
  ]);
  const distances = () => {
    const block = [
      ...$('.spot-conditions').querySelectorAll('.spot-conditions__block'),
    ].find((el) => el.querySelector('h4')?.textContent.includes('Also within'));
    return Object.fromEntries(
      [...block.querySelectorAll('li')].map((row) => [
        row.querySelector('.spot-conditions__row-title').textContent,
        row.querySelector('.spot-conditions__row-meta').textContent,
      ]),
    );
  };
  cards.select({ layerId: 'local-dams', id: 'dam' });
  await nextTick();
  assert.match(distances().Owl, /approximate/);
  assert.equal(distances().Datacenter, '0 m');
  cards.select({ layerId: 'wildlife-sightings', id: 'acartia:2' });
  await nextTick();
  assert.match(distances().Dam, /approximate/);
  cards.select({ layerId: 'wildlife-sightings', id: 'inat:1' });
  await nextTick();
  assert.match(distances().Dam, /approximate/);
});

test('a Nearby iNaturalist whale shows viewing guidance without Acartia credit', async (t) => {
  const center = { lat: 48.5, lon: -123.1 };
  const now = Date.now();
  const [sighting] = normalizeInatObservations([
    {
      id: 2,
      geojson: { coordinates: [center.lon, center.lat] },
      quality_grade: 'research',
      time_observed_at: new Date(now).toISOString(),
      taxon: {
        id: 41521,
        ancestor_ids: [40151, 152871],
        name: 'Orcinus orca',
        preferred_common_name: 'Orca',
      },
    },
  ]);
  const { methods } = createWildlifeControls({
    state: { enabled: true, rows: new Map([[sighting.stableId, sighting]]) },
    services: { now: () => now },
    parts: {},
  });
  const { $, cards } = fixture(t, [
    {
      id: 'wildlife-sightings',
      name: 'Wildlife Sightings',
      enabled: true,
      module: { getAnalystRecords: methods.getAnalystRecords },
    },
  ]);
  cards.setView({ center, heightM: 40_000 });
  await nextTick();
  $('.nearby-lists [data-row-layer="wildlife-sightings"]').click();
  await nextTick();
  const card = $('.entity-card');
  assert.equal(cards.card.identity.id, 'inat:2');
  assert.ok(
    card.querySelector('a[href="https://www.inaturalist.org/observations/2"]'),
  );
  const guidance = card.querySelector('a[href="https://www.bewhalewise.org"]');
  assert.ok(guidance);
  assert.equal(guidance.getAttribute('rel'), 'noopener noreferrer');
  assert.equal(card.querySelector('a[href="https://acartia.io/"]'), null);
});

test('the radius sits above the counts it sets; a layer with nothing in range shows only its 0', async (t) => {
  const { $, cards } = fixture(t, [
    flightsOn([flight('far01', 30.65, -97.74)], {
      status: 200,
      coverage: 'worldwide upstream snapshot',
    }),
  ]);
  cards.setView({ center: HERE, heightM: 40_000 });
  await nextTick();
  const radius = $('.view-context__radius');
  const tiles = $('.view-context__tiles');
  assert.ok(radius && tiles);
  assert.ok(
    radius.compareDocumentPosition(tiles) & Node.DOCUMENT_POSITION_FOLLOWING,
    'radius first',
  );
  assert.match($('.view-context__tile[data-layer="flights"]').textContent, /1/);
  assert.match($(NEAREST).textContent, /FAR01/);
  // About 42 km away: outside a 25 km radius.
  setContextRadiusKm(25);
  await nextTick();
  assert.equal(Boolean($(NEAREST)), false);
  assert.match(
    $('.view-context__tile[data-layer="flights"] strong').textContent,
    /^0$/,
  );
  assert.match($('.view-context__label').textContent, /25/);
});

test('Nearby uses ordinary records and reserves zero for a completed radius read', async (t) => {
  contextSearchStyles(t);
  t.mock.timers.enable({ apis: ['Date', 'setInterval'] });
  let recovered = false;
  const unavailable = () => {
    throw new Error('layer read unavailable');
  };
  const { $, cards } = fixture(t, [
    {
      id: 'local-dams',
      name: 'Dams',
      enabled: true,
      stats: { count: 1 },
      module: {
        getNearbyContextPoints: unavailable,
        getAnalystRecords: () => [{ id: 'dam', name: 'Fallback dam', ...HERE }],
      },
    },
    {
      id: 'local-datacenters',
      name: 'Data centres',
      enabled: true,
      stats: { count: 1 },
      module: {
        getNearbyContextPoints: unavailable,
        getAnalystRecords: () =>
          recovered
            ? [{ id: 'site', name: 'Recovered site', ...HERE }]
            : unavailable(),
      },
    },
    {
      id: 'earthquakes',
      name: 'Earthquakes',
      enabled: true,
      stats: { count: 1 },
      records: [{ id: 'far', lat: 40, lon: HERE.lon }],
    },
    {
      id: 'ais-live-vessels',
      name: 'Vessels',
      enabled: true,
      stats: { loading: true },
    },
  ]);
  setContextRadiusKm(25);
  cards.setView({ center: HERE, heightM: 40_000 });
  await nextTick();
  const tile = (id) => $(`.view-context__tile[data-layer="${id}"]`);
  const count = (id) => tile(id).querySelector('strong').textContent;
  const ids = [
    'local-dams',
    'local-datacenters',
    'earthquakes',
    'ais-live-vessels',
  ];
  assert.deepEqual(ids.map(count), ['1', 'Unavailable', '0', '…']);
  assert.equal(
    tile('local-datacenters')
      .querySelector('.view-context__dot')
      .getAttribute('aria-label'),
    'Live',
    'the failed radius read and the provider feed have separate states',
  );
  assert.match($('[data-row-layer="local-dams"]').textContent, /Fallback dam/);
  assert.equal($('.nearby-lists__layer[data-layer="local-datacenters"]'), null);

  contextSearchOpen.value = true;
  contextSearchText.value = 'fallback dam';
  await nextTick();
  const searchGrid = tile('local-datacenters').closest('.view-context__tiles');
  assert.equal(getComputedStyle(searchGrid).display, 'none');
  const matching = $('[data-row-layer="local-dams"]');
  assert.match(matching.textContent, /Fallback dam/);
  assert.notEqual(
    getComputedStyle(matching.closest('.nearby-lists')).display,
    'none',
  );
  const searchStatus = () => $('.view-context__empty[role="status"]');
  const incomplete = () => {
    const status = searchStatus();
    assert.match(status?.textContent ?? '', /Unavailable layers: .+/);
    assert.equal(status.closest('.view-context__tiles'), null);
    assert.notEqual(getComputedStyle(status).display, 'none');
  };
  incomplete();

  contextSearchText.value = 'nomatchxyz';
  await nextTick();
  assert.equal(count('local-datacenters'), 'Unavailable');
  assert.equal($('[data-row-layer="local-dams"]'), null);
  incomplete();

  recovered = true;
  t.mock.timers.tick(INSPECTOR_PULSE_MS);
  await nextTick();
  assert.match(
    searchStatus()?.textContent ?? '',
    /Nothing nearby matches.*nomatchxyz/,
  );

  closeContextSearch();
  await nextTick();
  assert.equal(count('local-datacenters'), '1');
  assert.match(
    $('[data-row-layer="local-datacenters"]').textContent,
    /Recovered site/,
  );
});

test('globe view: a count per layer that is on, with its feed state, and no Layers on rows', async (t) => {
  const { $, cards } = fixture(t, [
    {
      id: 'ais-live-vessels',
      name: 'Live Vessels',
      enabled: true,
      records: [],
      stats: { count: 2, scope: 'area' },
    },
    { id: 'earthquakes', name: 'Earthquakes', enabled: false, records: [] },
  ]);
  cards.setView({ center: HERE, heightM: 20_000_000 });
  await nextTick();
  const tiles = [...document.querySelectorAll('.view-context__block')];
  assert.equal(tiles.length, 1, 'each layer that is on, once');
  assert.equal(
    $('.view-context__label').textContent,
    'Layers on',
    'an area count is not labeled worldwide',
  );
  assert.match(tiles[0].textContent, /2/);
  assert.ok(
    tiles[0].querySelector('.view-context__dot--nominal'),
    'a live feed shows a live dot',
  );
  assert.equal(
    document.querySelector('.view-context__blocks button'),
    null,
    'no switches',
  );
  assert.equal(Boolean($('.view-context__live')), false, 'no Layers on rows');
  assert.equal(Boolean($(NEAREST)), false, 'no nearest at globe scale');
  assert.match($('.view-context__region').textContent, /UTC/);
});

test('street traffic labels the different nearby and globe count units', async (t) => {
  const { $, cards } = fixture(t, [
    {
      id: 'traffic',
      name: 'Street Traffic',
      enabled: true,
      records: [{ id: 'road-a', name: 'Major road', ...HERE }],
      stats: { count: 5 },
    },
  ]);
  cards.setView({ center: HERE, heightM: 40_000 });
  await nextTick();
  const local = $('.view-context__tile[data-layer="traffic"]');
  assert.equal(local.querySelector('strong').textContent, '1');
  assert.match(local.textContent, /Road segments/);
  assert.match(
    $('.nearby-lists__layer[data-layer="traffic"] .nearby-lists__count')
      .textContent,
    /Road segments · 1/,
  );
  cards.setView({ center: HERE, heightM: 20_000_000 });
  await nextTick();
  const globe = $('.view-context__block[data-layer="traffic"]');
  assert.equal(globe.querySelector('strong').textContent, '5');
  assert.match(globe.textContent, /Loaded traffic dots/);
});

test('the globe satellite class bar identifies the subset it represents', async (t) => {
  const { $, cards } = fixture(t, [
    {
      id: 'satellites',
      name: 'Satellites',
      enabled: true,
      records: [
        { id: 'one', satelliteClass: 'Station', ...HERE },
        { id: 'two', satelliteClass: 'Weather', ...HERE },
      ],
      stats: { count: 5 },
    },
  ]);
  cards.setView({ center: HERE, heightM: 20_000_000 });
  await nextTick();
  const block = $('.view-context__block[data-layer="satellites"]');
  assert.equal(block.querySelector('strong').textContent, '5');
  assert.equal(block.querySelectorAll('.view-context__bar span').length, 2);
  assert.match(block.textContent, /Breakdown covers 2 of 5 loaded/);
});

test('the incident locator shows its state alongside its place rows at globe height', async (t) => {
  const locator = {
    id: 'bhote-koshi-locator',
    name: 'Bhote Koshi',
    enabled: true,
    stats: { count: 1 },
    records: [
      { id: 'story', name: 'Site', lat: 28.01, lon: 86 },
      { id: 'bridge', name: 'Bridge', lat: 28.02, lon: 86 },
    ],
  };
  const { $, cards } = fixture(t, [locator]);
  cards.setView({ center: { lat: 28, lon: 86 }, heightM: 20_000_000 });
  await nextTick();
  const block = $('.view-context__block[data-layer="bhote-koshi-locator"]');
  assert.equal(block.querySelector('strong').textContent, 'Live');
  assert.equal(block.querySelectorAll('[data-row-key]').length, 2);
});

test('a layer refreshing items it holds keeps its state; a feed in trouble adds a line under the tiles', async (t) => {
  const { $, cards } = fixture(t, [
    flightsOn([flight('a', 30.3, -97.7)], {
      loading: true,
      source: 'OpenSky',
      statusMessage: 'Refreshing',
    }),
    {
      id: 'earthquakes',
      name: 'Earthquakes',
      enabled: true,
      records: [],
      stats: { loading: true },
    },
    {
      id: 'ais-live-vessels',
      name: 'Live Vessels',
      enabled: true,
      records: [],
      stats: { count: 0, error: 'socket closed', source: 'AISStream' },
    },
  ]);
  cards.setView({ center: HERE, heightM: 40_000 });
  await nextTick();
  const dots = [...document.querySelectorAll('.view-context__dot')].map(
    (node) => node.getAttribute('aria-label'),
  );
  assert.equal(dots[0], 'Live', 'a refresh keeps the live state');
  assert.equal(dots[1], 'Loading');
  const problems = [...document.querySelectorAll('.view-context__problem')].map(
    (node) => node.textContent,
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /AISStream/);
  const vessels = '[data-layer="ais-live-vessels"] strong';
  assert.equal($('.view-context__tile' + vessels).textContent, 'Unavailable');
  cards.setView({ center: HERE, heightM: 20_000_000 });
  await nextTick();
  assert.equal($('.view-context__block' + vessels).textContent, 'Unavailable');
});

test('stale GNSS shows its source and state without printing regional coverage metadata', async (t) => {
  const { $, cards } = fixture(t, [
    {
      id: 'gnss-integrity',
      name: 'GNSS Integrity',
      enabled: true,
      records: [],
      stats: {
        stale: true,
        fallback: false,
        source: 'adsb.lol',
        coverage: {
          kind: 'regional',
          latitude: 43.65,
          longitude: -79.38,
          radiusNm: 250,
        },
      },
    },
  ]);
  cards.setView({ center: HERE, heightM: 40_000 });
  await nextTick();
  const problem = $('.view-context__problem').textContent;
  assert.match(problem, /adsb\.lol/);
  assert.match(problem, /Stale/);
  assert.doesNotMatch(problem, /\[object Object\]/);
});

test('with nothing on, Context shows a few facts and points to Data Layers', async (t) => {
  const { $, cards } = fixture(t, [
    { id: 'flights', name: 'Live Flights', enabled: false, records: [] },
  ]);
  cards.setView({ center: HERE, heightM: 40_000, groundM: 149 });
  await nextTick();
  const facts = [...document.querySelectorAll('.view-context__tile')].map(
    (node) => node.textContent,
  );
  assert.ok(facts.some((fact) => /Daylight/.test(fact)));
  // Day length is short on the tile and in full in its title.
  const daylight = [
    ...document.querySelectorAll(
      '.view-context__tiles--facts .view-context__tile',
    ),
  ].find((tile) => /Daylight/.test(tile.textContent));
  assert.match(daylight.querySelector('strong').textContent, /^(\d+h )?\d+m$/);
  assert.match(daylight.getAttribute('title'), /minutes?$/);
  assert.match(
    $('.view-context__pointer').textContent,
    /Turn on layers to see what is around/,
  );
  assert.equal(
    Boolean($('.view-context__radius')),
    false,
    'no radius with nothing to count',
  );
  cards.setView({ center: HERE, heightM: 20_000_000 });
  await nextTick();
  // At globe view Flights is suggested: its Open takes the pointer's place.
  assert.equal($('.view-context__suggest-item')?.dataset.layer, 'flights');
  assert.match(
    $('.view-context__pointer').textContent,
    /See them in Data Layers/,
  );
  assert.match($('.view-context__region').textContent, /No layers on/);
});

function contextSearchStyles(t) {
  const style = document.createElement('style');
  // Happy DOM drops the multiline :is() rule. Chromium checks the original.
  style.textContent = readFileSync(
    new URL('./styles/context-dock.css', import.meta.url),
    'utf8',
  ).replace(/\s+/g, ' ');
  document.head.append(style);
  t.after(() => style.remove());
}

test('a remote local view shows the center coordinates and the general Data Layers action', async (t) => {
  const { $, cards } = fixture(t, [{ id: 'street-level', enabled: false }]);
  cards.setView({ center: { lat: -39.125, lon: -132.375 }, heightM: 40_000 });
  await turn();
  await nextTick();
  assert.match(
    $('.view-context__region').textContent,
    /39\.125°S\s+132\.375°W/,
  );
  assert.match($('.view-context__pointer').textContent, /Turn on layers/);
  assert.equal($('.view-context__suggest-open'), null);
});

test('keyboard selection focuses Close card and returns focus to the same Nearby row', async (t) => {
  const { $, cards } = fixture(t, [
    flightsOn([flight('near01', 30.31, -97.74)]),
  ]);
  cards.setView({ center: HERE, heightM: 40_000 });
  await nextTick();
  const row = $('.nearby-lists [data-row-key]');
  const rowKey = row.dataset.rowKey;
  row.focus();
  row.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
  await nextTick();
  await nextTick();
  const close = $('button[aria-label="Close card"]');
  assert.equal(document.activeElement, close);
  close.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
  await nextTick();
  await nextTick();
  assert.equal(document.activeElement.dataset.rowKey, rowKey);
});

test('globe search keeps successful matches visible when a layer cannot be read', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'] });
  let recovered = false;
  const site = {
    id: 'local-datacenters',
    name: 'Data centres',
    enabled: false,
    stats: { count: 1 },
    records: [{ id: 'site', name: 'Test dam control site', ...HERE }],
  };
  const { $, cards, notifyLayers } = fixture(t, [
    {
      id: 'local-dams',
      name: 'Dams',
      enabled: true,
      stats: { count: 1 },
      module: {
        getAnalystRecords() {
          if (!recovered) throw new Error('dam records unavailable');
          return [{ id: 'dam', name: 'Test dam', ...HERE }];
        },
      },
    },
    site,
  ]);
  cards.setView({ center: HERE, heightM: 20_000_000 });
  await nextTick();
  const status = () =>
    $('.view-context__blocks [role="status"]')?.textContent.trim();
  const names = () =>
    [
      ...document.querySelectorAll(
        '.view-context__block-rows .nearby-lists__name',
      ),
    ].map((row) => row.textContent);
  assert.equal(
    $('.view-context__block[data-layer="local-dams"] strong').textContent,
    '1',
  );
  assert.equal(status(), undefined);

  contextSearchOpen.value = true;
  contextSearchText.value = 'est dam';
  await nextTick();
  assert.match(status(), /^Unavailable layers: .*Dam/i);
  assert.deepEqual(names(), []);

  site.enabled = true;
  notifyLayers();
  await nextTick();
  assert.match(status(), /^Unavailable layers: .*Dam/i);
  assert.deepEqual(names(), ['Test dam control site']);

  recovered = true;
  t.mock.timers.tick(INSPECTOR_PULSE_MS);
  await nextTick();
  assert.equal(status(), undefined);
  assert.deepEqual(names(), ['Test dam', 'Test dam control site']);

  contextSearchText.value = 'nomatchxyz';
  await nextTick();
  assert.equal(status(), '0 results');
  assert.deepEqual(names(), []);
});

test('Context search leaves the Data Layers action available with all layers off', async (t) => {
  contextSearchStyles(t);
  const { $, cards, pinia } = fixture(t, [
    { ...flightsOn([]), enabled: false },
  ]);
  const open = t.mock.method(usePanelChromeStore(pinia), 'act');
  cards.setView({ center: HERE, heightM: 20_000_000 });
  await nextTick();
  const selectors = [
    '.view-context__tiles--facts',
    '.view-context__camera',
    '.view-context__suggest',
  ];
  contextSearchOpen.value = true;
  contextSearchText.value = 'paris';
  await nextTick();
  assert.ok($('#context-tab-view').classList.contains('context-searching'));
  assert.equal(
    $('.view-context__empty[role="status"]')?.textContent.trim(),
    '0 results',
  );
  for (const selector of selectors)
    assert.equal(getComputedStyle($(selector)).display, 'none', selector);
  const action = $('.view-context__pointer:not(.view-context__suggest-open)');
  assert.notEqual(getComputedStyle(action).display, 'none');
  action.click();
  assert.deepEqual(
    open.mock.calls.map(({ arguments: args }) => args),
    [
      ['reveal', 'data-panel'],
      ['toggle', 'data-panel'],
    ],
  );
});

test('the nearby lists follow the Context search', async (t) => {
  contextSearchStyles(t);
  const { $, cards } = fixture(t, [
    flightsOn([flight('near01', 30.31, -97.74)]),
  ]);
  cards.setView({ center: HERE, heightM: 40_000 });
  await nextTick();
  assert.ok($(NEAREST));
  contextSearchOpen.value = true;
  contextSearchText.value = 'nomatchxyz';
  await nextTick();
  assert.equal(
    Boolean($(NEAREST)),
    false,
    'nothing matches, so nothing is nearest',
  );
  assert.match($('.view-context__empty').textContent, /nomatchxyz/);
  contextSearchText.value = 'near01';
  await nextTick();
  assert.match($(NEAREST).textContent, /NEAR01/);
  assert.equal(getComputedStyle($('.view-context__tiles')).display, 'none');
  assert.notEqual(getComputedStyle($('.view-context__radius')).display, 'none');
  assert.notEqual(getComputedStyle($('.nearby-lists')).display, 'none');
});

test('nothing picked: the time reads local and UTC, and there is only counts and one Nearby section', async (t) => {
  const { $, cards } = fixture(t, [flightsOn([flight('far01', 35, -90)])]);
  cards.setView({ center: HERE, heightM: 40_000 });
  await nextTick();
  assert.match($('.view-context__region').textContent, /\d\d:\d\d UTC/);
  assert.equal(Boolean($('.view-context__towns')), false, 'no towns chips');
  assert.equal(
    Boolean($('.view-context .entity-card__action--ask')),
    false,
    'no Ask button',
  );
  assert.doesNotMatch(
    $('.view-context').textContent,
    /Nothing from the layers/,
    'never "nothing nearby"',
  );
});

test('with nothing on, display-only tiles show what free layers would show, worldwide and last known', async (t) => {
  const satellites = {
    id: 'satellites',
    name: 'Satellites',
    enabled: false,
    records: [],
    stats: {},
  };
  const asked = [];
  const flights = {
    ...flightsOn([]),
    enabled: false,
    stats: { sourceUnavailable: true },
  };
  const fetchImpl = async (url) => {
    asked.push(String(url));
    if (String(url).includes('/api/layer-counts'))
      return new Response(
        JSON.stringify({
          now: Date.now(),
          counts: [
            {
              layerId: 'satellites',
              count: 1272,
              at: Date.now() - 2 * 3600_000,
            },
            { layerId: 'cctv', count: 7350, at: Date.now() - 60_000 },
            { layerId: 'flights', count: 600, at: Date.now() - 60_000 },
            { layerId: 'traffic', count: 99, at: Date.now() },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    return new Response('', { status: 503 });
  };
  const { $, cards, notifyLayers } = fixture(t, [satellites, flights], {
    fetchImpl,
  });
  cards.setView({ center: { lat: 0, lon: 0 }, heightM: 20_000_000 });
  await nextTick();
  await turn();
  await nextTick();
  const tiles = () => [
    ...document.querySelectorAll(
      '.view-context__tiles--counts .view-context__tile',
    ),
  ];
  assert.deepEqual(
    tiles().map((tile) => tile.dataset.layer),
    ['satellites'],
    'registered free layers only',
  );
  assert.match(tiles()[0].textContent, /1,272/);
  assert.doesNotMatch(
    tiles()[0].textContent,
    /≈/,
    'an old count is marked by its age, not a sign',
  );
  assert.match(tiles()[0].textContent, /2 h ago/);
  assert.equal(
    document.querySelector('.view-context__tiles--counts button'),
    null,
    'display only',
  );
  assert.match($('.view-context__label').textContent, /Worldwide, last known/);
  assert.match(
    $('.view-context__hint--counts').textContent,
    /No live requests/,
  );
  assert.match($('.view-context__camera').textContent, /Camera height/);
  assert.equal(
    [
      ...document.querySelectorAll(
        '.view-context__tiles--facts .view-context__tile-name',
      ),
    ].some((node) => /^Camera$/.test(node.textContent)),
    false,
    'not a squeezed tile',
  );
  assert.ok($('.view-context__pointer'), 'the pointer to Data Layers stays');
  assert.equal(
    asked.filter((url) => url.includes('/api/layer-counts')).length,
    1,
  );
  satellites.enabled = true;
  satellites.stats = {
    count: 1300,
    lastUpdate: Date.now(),
  };
  notifyLayers();
  await nextTick();
  assert.match(
    $('.view-context__block[data-layer="satellites"] strong').textContent,
    /1,300/,
    'an enabled layer still shows its own count',
  );
  satellites.enabled = false;
  notifyLayers();
  await nextTick();
  assert.match(
    tiles()[0].textContent,
    /1,272/,
    'turning the layer off restores the server count',
  );
  assert.equal(
    asked.filter((url) => url.includes('/api/layer-counts')).length,
    1,
    'no second ask',
  );
});

test('turning off a healthy Flights layer leaves no count tile after an initial server failure', async (t) => {
  const flights = flightsOn([flight('near01', 30.28, -97.74)]);
  let asks = 0;
  const { $, cards, notifyLayers } = fixture(t, [flights], {
    fetchImpl: async (url) => {
      if (String(url).includes('/api/layer-counts')) asks++;
      return new Response('', { status: 503 });
    },
  });
  cards.setView({ center: { lat: 0, lon: 0 }, heightM: 20_000_000 });
  await nextTick();
  assert.ok($('.view-context__block[data-layer="flights"]'));
  assert.equal(asks, 0);

  flights.enabled = false;
  notifyLayers();
  await nextTick();
  await turn();
  assert.equal(asks, 1);
  assert.equal($('.view-context__tiles--counts [data-layer="flights"]'), null);
});

// Bounded: without the hand-off this test must fail by name, not hang.
test(
  'when the last Nearby row goes while focused, the radius slider takes the focus, not the page',
  { timeout: 10_000 },
  async (t) => {
    const flights = flightsOn([flight('near01', 30.31, -97.74)]);
    const { $, cards } = fixture(t, [flights]);
    cards.setView({ center: HERE, heightM: 40_000 });
    await nextTick();
    const row = $('.nearby-lists [data-row-key]');
    assert.ok(row, 'one Nearby row');
    row.focus();
    assert.equal(document.activeElement, row);
    // The aircraft leaves; the next read of the view finds nothing nearby.
    flights.records = [];
    flights.stats = {
      ...flights.stats,
      count: 0,
      lastUpdate: flights.stats.lastUpdate + 1,
    };
    cards.setView({ center: { ...HERE }, heightM: 40_000 });
    await nextTick();
    await nextTick();
    assert.equal(Boolean($('.nearby-lists')), false, 'the section is gone');
    assert.equal(document.activeElement, $('.view-context__radius input'));
  },
);

test(
  'a focused globe row that drops out hands the focus to the row now in its place',
  { timeout: 10_000 },
  async (t) => {
    const flights = flightsOn([
      flight('near01', 1, 1),
      flight('mid01', 10, 10),
    ]);
    const { $, cards } = fixture(t, [flights]);
    const GLOBE = { center: { lat: 0, lon: 0 }, heightM: 20_000_000 };
    cards.setView({ ...GLOBE });
    await nextTick();
    const first = $(
      '.view-context__block[data-layer="flights"] [data-row-key]',
    );
    first.focus();
    assert.equal(document.activeElement, first);
    // The nearest aircraft leaves with the next snapshot.
    flights.records = [flight('mid01', 10, 10)];
    flights.stats = {
      ...flights.stats,
      count: 1,
      lastUpdate: flights.stats.lastUpdate + 1,
    };
    cards.setView({ ...GLOBE });
    await nextTick();
    await nextTick();
    const row = $('.view-context__block[data-layer="flights"] [data-row-key]');
    assert.match(row.textContent, /MID01/);
    assert.equal(document.activeElement, row, 'the row now in its place');
  },
);

test('switching zoom modes preserves the focused item or moves focus to the view', async (t) => {
  const flights = flightsOn([flight('near01', 30.31, -97.74)]);
  const { $, cards, notifyLayers, replaceManager } = fixture(t, [flights], {
    useInspector: true,
  });
  const nearby = '.nearby-lists [data-row-key]';
  const atGlobe = '.view-context__blocks [data-row-key]';
  cards.setView({ center: HERE, heightM: 40_000 });
  await nextTick();
  $(nearby).focus();
  assert.equal(document.activeElement, $(nearby));

  cards.setView({ center: HERE, heightM: 6_000_000 });
  await nextTick();
  assert.ok(
    document.activeElement === $(atGlobe),
    'the same item owns focus in the globe view',
  );
  cards.setView({ center: HERE, heightM: 40_000 });
  await nextTick();
  assert.ok(
    document.activeElement === $(nearby),
    'the same item owns focus again in Nearby',
  );

  const globe = { center: HERE, heightM: 6_000_000 };
  cards.setView(globe);
  await nextTick();
  assert.equal(document.activeElement, $(atGlobe));
  flights.enabled = false;
  notifyLayers();
  cards.setView({ ...globe });
  await nextTick();
  assert.ok(
    document.activeElement === $('.view-context'),
    'the view owns focus when the last layer closes',
  );

  flights.enabled = true;
  notifyLayers();
  await nextTick();
  $(atGlobe).focus();
  replaceManager({ layers: new Map(), getAll: () => [] });
  cards.pulseInspector();
  await nextTick();
  assert.equal(
    document.activeElement,
    $('.view-context'),
    'a silent manager replacement recovers focus on the next pulse',
  );
});

test(
  'globe search keeps focus in Context when the last matching row leaves',
  { timeout: 10_000 },
  async (t) => {
    const flights = flightsOn([
      flight('near01', 1, 1),
      flight('mid01', 10, 10),
    ]);
    const { $, cards } = fixture(t, [flights]);
    const globe = { center: { lat: 0, lon: 0 }, heightM: 20_000_000 };
    cards.setView(globe);
    contextSearchOpen.value = true;
    contextSearchText.value = 'near01';
    await nextTick();
    const row = $('.view-context__block [data-row-key]');
    assert.match(row.textContent, /NEAR01/);
    row.focus();
    assert.equal(document.activeElement, row);

    flights.records = [flight('mid01', 10, 10)];
    flights.stats = {
      ...flights.stats,
      count: 1,
      lastUpdate: flights.stats.lastUpdate + 1,
    };
    cards.setView({ ...globe });
    await nextTick();
    await nextTick();
    assert.ok(
      document.activeElement === $('.view-context__blocks'),
      'focus moves to the globe results when the last matching row leaves',
    );
    assert.ok(!$('.view-context__block'), 'the unmatched group is gone');
    assert.match(
      $('.view-context__blocks [role="status"]')?.textContent ?? '',
      /\b0\b/,
    );
  },
);

test('Flights and vessels show their server counts and ages after their layers are turned off', async (t) => {
  const vessels = {
    id: 'ais-live-vessels',
    name: 'Live Vessels',
    enabled: false,
    records: [],
    stats: {},
  };
  const flights = {
    id: 'flights',
    name: 'Live Flights',
    enabled: false,
    records: [],
    stats: {},
  };
  const fetchImpl = async (url) =>
    String(url).includes('/api/layer-counts')
      ? new Response(
          JSON.stringify({
            now: Date.now(),
            counts: [
              { layerId: 'flights', count: 9100, at: Date.now() - 10 * 60_000 },
              {
                layerId: 'ais-live-vessels',
                count: 41000,
                at: Date.now() - 10 * 60_000,
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      : new Response('', { status: 503 });
  const { cards, notifyLayers } = fixture(t, [flights, vessels], { fetchImpl });
  cards.setView({ center: { lat: 0, lon: 0 }, heightM: 20_000_000 });
  await nextTick();
  await turn();
  await nextTick();
  const tile = (id) =>
    document.querySelector(
      `.view-context__tiles--counts .view-context__tile[data-layer="${id}"]`,
    );
  assert.match(tile('ais-live-vessels').textContent, /41,000/);
  // Host metadata can describe a current feed and still differ from the cache.
  vessels.enabled = true;
  vessels.stats = { count: 120, lastUpdate: Date.now() };
  flights.enabled = true;
  // A host can still supply the former worldwide metadata shape.
  flights.stats = {
    count: 9300,
    lastUpdate: Date.now(),
    scope: 'worldwide',
    scopeCount: 9400,
  };
  notifyLayers();
  await nextTick();
  vessels.enabled = false;
  flights.enabled = false;
  notifyLayers();
  await nextTick();
  assert.match(
    tile('ais-live-vessels').textContent,
    /41,000/,
    'the area count is not kept',
  );
  assert.match(tile('flights').textContent, /9,100/);
  assert.match(tile('flights').textContent, /10 min ago/);
});

test('at a local view, another layer refreshing never reads a moving layer again', async (t) => {
  let reads = 0;
  const satellites = {
    id: 'satellites',
    name: 'Satellites',
    enabled: true,
    stats: { count: 1, lastUpdate: Date.now() },
    module: {
      getAnalystRecords: () => {
        reads++;
        return [
          { noradId: '1', name: 'SAT', lat: HERE.lat + 0.1, lon: HERE.lon },
        ];
      },
    },
  };
  const flights = flightsOn([flight('near01', HERE.lat + 0.05, HERE.lon)]);
  const { $, cards, notifyLayers } = fixture(t, [satellites, flights]);
  cards.setView({ center: HERE, heightM: 40_000 });
  await nextTick();
  assert.match($('.nearby-lists').textContent, /SAT/);
  const before = reads;
  // Flights refresh ten times; the data manager announces each one.
  for (let n = 1; n <= 10; n++) {
    flights.stats = {
      ...flights.stats,
      count: 1,
      lastUpdate: flights.stats.lastUpdate + n,
    };
    notifyLayers();
    await nextTick();
  }
  assert.equal(reads, before, `${reads - before} extra satellite reads`);
  assert.match($('.nearby-lists').textContent, /SAT/, 'still listed');
});

test('Nearby removes a moving satellite within ten seconds of an expensive read', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let now = 2_000_000_000_000;
  let monotonic = 0;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(performance, 'now', () => monotonic);
  let position = HERE;
  const { $, cards } = fixture(t, [
    {
      id: 'satellites',
      enabled: true,
      stats: { count: 1, lastUpdate: 1 },
      module: {
        getAnalystRecords() {
          monotonic += 300;
          return [{ noradId: '1', name: 'SAT', ...position }];
        },
      },
    },
  ]);
  const advance = async (ms) => {
    now += ms;
    t.mock.timers.tick(ms);
    await nextTick();
  };
  // A settled pan can cause the first read between panel pulses.
  await advance(2_100);
  cards.setView({ center: HERE, heightM: 40_000 });
  await nextTick();
  const group = () => $('.nearby-lists__layer[data-layer="satellites"]');
  assert.match(group()?.textContent ?? '', /SAT/);

  position = { ...HERE, lat: HERE.lat + 20 };
  // The feed revision stays unchanged while the satellite moves away.
  await advance(1_900);
  assert.ok(group(), 'the early pulse reuses the cached rows');
  await advance(4_000);
  await advance(4_000);
  assert.equal(Boolean(group()), false, 'the departed row is gone by 9.9 s');
});

test('the globe wildlife count tracks inspectable sightings independently of grid density', async (t) => {
  const now = Date.now();
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now });
  const state = {
    enabled: true,
    rows: new Map(),
    gridAvailable: true,
    gridTotal: 250,
    lastUpdate: now,
    loading: true,
  };
  const { methods } = createWildlifeControls({
    state,
    services: { now: Date.now },
    parts: {},
  });
  const wildlife = {
    id: 'wildlife-sightings',
    name: 'Wildlife Sightings',
    enabled: true,
    stats: methods.getStats(),
    module: methods,
  };
  const { $, cards, notifyLayers } = fixture(t, [wildlife]);
  const block = () =>
    $('.view-context__block[data-layer="wildlife-sightings"]');
  const total = () => block().querySelector('strong').textContent;
  const publish = async () => {
    wildlife.stats = methods.getStats();
    notifyLayers();
    await nextTick();
  };

  cards.setView({ center: HERE, heightM: 20_000_000 });
  await nextTick();
  assert.equal(total(), '0', 'only grid density has loaded');
  assert.equal(block().querySelectorAll('[data-row-key]').length, 0);

  state.loading = false;
  state.error = 'iNaturalist HTTP 503';
  await publish();
  assert.equal(total(), 'Degraded', 'the observation request failed');
  assert.equal(
    methods.getStats().count,
    250,
    'Data Layers still counts the grid',
  );

  state.error = null;
  t.mock.timers.tick(4_000);
  state.lastUpdate = Date.now();
  state.rows.set('inat:1', {
    ...HERE,
    stableId: 'inat:1',
    commonName: 'Barred Owl',
    observedAt: now,
  });
  state.rows.set('inat:2', {
    ...HERE,
    stableId: 'inat:2',
    observedAt: now - 3 * 86_400_000,
  });
  await publish();
  assert.equal(total(), '1', 'an expired observation is not inspectable');
  assert.match(
    block().querySelector('[data-row-key]').textContent,
    /Barred Owl/,
  );
  assert.equal(methods.getStats().count, 250);

  state.selectedId = 'inat:2';
  state.selectedRow = state.rows.get(state.selectedId);
  t.mock.timers.tick(4_000);
  await publish();
  assert.equal(
    total(),
    '2',
    'the selected observation survives its age window',
  );
  assert.equal(block().querySelectorAll('[data-row-key]').length, 2);

  state.rows.delete(state.selectedId);
  assert.deepEqual(
    methods.getAnalystRecords().map((row) => row.id),
    ['inat:1', 'inat:2'],
  );
  assert.equal(methods.getInspectableCount(), 2);
  state.selectedId = null;
  state.selectedRow = null;
  t.mock.timers.tick(4_000);
  await publish();
  assert.equal(total(), '1');
  assert.equal(block().querySelectorAll('[data-row-key]').length, 1);
});

test('the globe count stays through a refresh and clears for a new enable', async (t) => {
  const flights = flightsOn([], { count: 123 });
  const { $, cards, notifyLayers } = fixture(t, [flights]);
  const total = () =>
    $('.view-context__block[data-layer="flights"] strong')?.textContent;
  cards.setView({ center: HERE, heightM: 20_000_000 });
  await nextTick();
  assert.equal(total(), '123');

  flights.stats = { ...flights.stats, count: 0, loading: true };
  notifyLayers();
  await nextTick();
  assert.equal(total(), '123');

  flights.enabled = false;
  notifyLayers();
  await nextTick();
  assert.equal(total(), undefined);
  flights.enabled = true;
  flights.stats = { count: 0, lastUpdate: null, loading: true };
  notifyLayers();
  await nextTick();
  assert.equal(total(), '…');
});

test('globe view: each block lists its three items nearest the centre, on the visible side, and a row opens the card', async (t) => {
  const { $, cards } = fixture(t, [
    flightsOn([
      flight('near01', 1, 1),
      flight('mid01', 10, 10),
      flight('far01', 40, 40),
      flight('far02', 50, 50),
      flight('back01', 0, 180),
    ]),
  ]);
  cards.setView({ center: { lat: 0, lon: 0 }, heightM: 20_000_000 });
  await nextTick();
  const rows = [
    ...document.querySelectorAll(
      '.view-context__block[data-layer="flights"] .view-context__block-rows li',
    ),
  ];
  assert.deepEqual(
    rows.map((row) => row.querySelector('.nearby-lists__name').textContent),
    ['NEAR01', 'MID01', 'FAR01'],
    'three, nearest the centre first',
  );
  assert.equal(
    Boolean($('.view-context__block .nearby-lists__badge')),
    false,
    'no Nearest badge',
  );
  // The block's head wears its layer's map sprite, not a glyph.
  const mark = $(
    '.view-context__block[data-layer="flights"] .view-context__block-head .entity-mark',
  );
  assert.equal(
    mark?.style.getPropertyValue('--mark'),
    `url("${aircraftIcon('airliner')}")`,
  );
  assert.equal(mark.textContent, '');
  const block = () => $('.view-context__block[data-layer="flights"]');
  const count = block().querySelector('strong').textContent;
  const names = () =>
    [...(block()?.querySelectorAll('.nearby-lists__name') ?? [])].map(
      (row) => row.textContent,
    );
  contextSearchOpen.value = true;
  contextSearchText.value = 'nomatchxyz';
  await nextTick();
  assert.deepEqual(names(), [], 'a nonmatching query hides globe rows');
  assert.ok(!block(), 'the unmatched layer group is gone');
  contextSearchText.value = 'far02';
  await nextTick();
  assert.deepEqual(
    names(),
    ['FAR02'],
    'search finds a matching item outside the first three',
  );
  assert.equal(block().querySelector('strong').textContent, count);
  contextSearchText.value = '';
  await nextTick();
  block().querySelectorAll('.view-context__block-rows li button')[1].click();
  await nextTick();
  assert.equal(cards.card?.identity.id, 'mid01');
});

test('a dated air-quality reading shows the age of the observation', async (t) => {
  const { $, cards } = fixture(t, [
    {
      id: 'air-quality',
      name: 'Air quality',
      enabled: true,
      stats: { count: 1, lastUpdate: Date.now() },
      module: {
        getValueAt: () => ({
          value: 'AQHI 2',
          detail: 'Park station',
          at: Date.now() - 20 * 60_000,
        }),
      },
    },
  ]);
  cards.setView({ center: HERE, heightM: 40_000 });
  await nextTick();
  const tile = $('.view-context__tile--value[data-layer="air-quality"]');
  assert.match(tile.textContent, /Park station/);
  assert.match(tile.textContent, /Updated 20 min ago/);
});

test('a field has a value tile, and Air Quality also offers searchable station rows', async (t) => {
  const asked = [];
  const { $, cards } = fixture(t, [
    flightsOn([flight('near01', 30.28, -97.74)]),
    {
      id: 'wind',
      name: 'Wind',
      enabled: true,
      stats: { count: 1, lastUpdate: Date.now() },
      module: {
        getAnalystRecords: undefined,
        getValueAt(lat, lon) {
          asked.push([lat, lon]);
          return { value: '36 km/h from N', detail: 'GFS · 12:00 UTC' };
        },
      },
    },
    {
      id: 'gnss-integrity',
      name: 'GNSS integrity',
      enabled: true,
      stats: { count: 0, lastUpdate: Date.now() },
      module: { getAnalystRecords: undefined, getValueAt: () => null },
    },
    {
      id: 'air-quality',
      name: 'Air quality',
      enabled: true,
      records: [
        { id: 'north', name: 'North station', lat: 30.97, lon: -97.74 },
        { id: 'south', name: 'South station', lat: 29.57, lon: -97.74 },
      ],
      stats: { count: 2, lastUpdate: Date.now() },
      module: {
        getValueAt: () => ({ value: null, reason: 'No station within 50 km' }),
      },
    },
  ]);
  cards.setView({ center: HERE, heightM: 40_000 });
  await nextTick();
  const wind = $('.view-context__tile--value[data-layer="wind"]');
  assert.ok(wind, 'a value tile for the field layer');
  assert.match(wind.querySelector('strong').textContent, /36 km\/h from N/);
  assert.match(wind.textContent, /GFS/);
  assert.deepEqual(
    asked.at(-1),
    [HERE.lat, HERE.lon],
    'read at the centre of the view',
  );
  assert.match(
    $('.view-context__tile--value[data-layer="gnss-integrity"] strong')
      .textContent,
    /—/,
  );
  // A coverage limit says so, rather than "No value".
  const air = $('.view-context__tile--value[data-layer="air-quality"]');
  assert.match(air.querySelector('strong').textContent, /—/);
  assert.match(air.textContent, /No station within 50 km/);
  assert.doesNotMatch(air.textContent, /No value/);
  assert.equal(
    $('.view-context__tile:not(.view-context__tile--value)[data-layer="wind"]'),
    null,
    'no count tile for a field',
  );
  const nearby = $('.nearby-lists')?.textContent || '';
  assert.doesNotMatch(nearby, /Wind|Radar/, 'fields have no Nearby group');
  assert.match(nearby, /NEAR01/);
  assert.match(nearby, /North station/);
  assert.match(nearby, /South station/);
  contextSearchOpen.value = true;
  contextSearchText.value = 'North station';
  await nextTick();
  const station = $('.nearby-lists [data-row-layer="air-quality"]');
  assert.match(station.textContent, /North station/);
  assert.doesNotMatch($('.nearby-lists').textContent, /South station/);
  station.click();
  await nextTick();
  assert.equal(cards.card?.identity.id, 'north');
});

test('an enabled layer without companions still offers the general Data Layers action', async (t) => {
  const { $, cards, pinia } = fixture(t, [{ id: 'wind', enabled: true }]);
  const action = t.mock.method(usePanelChromeStore(pinia), 'act');
  cards.setView({ center: HERE, heightM: 40_000 });
  await nextTick();
  $('.view-context__pointer').click();
  assert.deepEqual(
    action.mock.calls.map(({ arguments: args }) => args),
    [
      ['reveal', 'data-panel'],
      ['toggle', 'data-panel'],
    ],
  );
});

test('a globe breakdown is hidden when its cached total no longer matches the headline', async (t) => {
  const flights = flightsOn([
    { ...flight('one', 1, 1), aircraftClass: 'airliner' },
    { ...flight('two', 2, 2), aircraftClass: 'airliner' },
    { ...flight('three', 3, 3), aircraftClass: 'fastjet' },
  ]);
  const { $, cards, notifyLayers } = fixture(t, [flights]);
  cards.setView({ center: { lat: 0, lon: 0 }, heightM: 20_000_000 });
  await nextTick();
  assert.ok($('.view-context__block[data-layer="flights"] .view-context__bar'));
  flights.records = flights.records.slice(0, 1);
  flights.stats = { count: 1, lastUpdate: Date.now() };
  notifyLayers();
  await nextTick();
  assert.equal(
    $('.view-context__block[data-layer="flights"] strong').textContent,
    '1',
  );
  assert.equal(
    $('.view-context__block[data-layer="flights"] .view-context__bar'),
    null,
  );
});

test('a layer holding nothing says why in place of its 0', async (t) => {
  const { $, cards } = fixture(t, [
    {
      id: 'bikeshare',
      name: 'Bikeshare',
      enabled: true,
      records: [],
      stats: {
        count: 0,
        status: 'zoom-in',
        statusMessage: 'Zoom in to see bikes',
      },
    },
    flightsOn([]),
  ]);
  cards.setView({ center: HERE, heightM: 120_000 });
  await nextTick();
  const bikes = $('.view-context__tile[data-layer="bikeshare"] strong');
  assert.ok(bikes);
  assert.match(bikes.textContent, /Zoom in/);
  assert.ok(bikes.classList.contains('view-context__tile-status'));
  assert.match(
    $('.view-context__tile[data-layer="flights"] strong').textContent,
    /^0$/,
    'a plain 0 stays a 0',
  );
});

test('a layer turned on at globe view shows its block at once, as Loading, not at the next refresh', async (t) => {
  const cameras = {
    id: 'cctv',
    name: 'CCTV',
    enabled: false,
    module: { getAnalystRecords: undefined },
    stats: { count: 0, loading: true },
  };
  const { $, cards, notifyLayers } = fixture(t, [
    flightsOn([flight('near01', 28.1, -80)]),
    cameras,
  ]);
  cards.setView({ center: { lat: 28, lon: -80 }, heightM: 18_000_000 });
  await nextTick();
  assert.equal($('.view-context__block[data-layer="cctv"]'), null);
  cameras.enabled = true;
  notifyLayers();
  await nextTick();
  const block = $('.view-context__block[data-layer="cctv"]');
  assert.ok(block, 'the block shows without waiting for the refresh');
  assert.match(
    block.querySelector('strong').textContent,
    /…/,
    'its count is still coming',
  );
  assert.equal(
    block.querySelector('.view-context__block-head .entity-mark')?.textContent,
    'videocam',
    'a camera keeps its glyph',
  );
  assert.ok(block.querySelector('.view-context__dot--loading'));

  cameras.stats = { count: 32, lastUpdate: Date.now() };
  notifyLayers();
  await nextTick();
  assert.equal(
    block.querySelector('strong').textContent,
    '32',
    'the loaded camera count is shown even without analyst rows',
  );
});

async function settleWeather(t) {
  await nextTick();
  t.mock.timers.tick(400);
  await turn();
  await nextTick();
}

test('a failed read at a new point drops the local time loading hint', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let reads = 0;
  const brief = async () => ({
    weather: {
      temperatureC: reads++ === 0 ? 18 : null,
      timeZone: 'America/Chicago',
      utcOffsetSeconds: -21600,
    },
  });
  const { $, point } = fixture(t, [flightsOn([])], { brief });
  point(HERE);
  await settleWeather(t);
  assert.match($('.view-context__region').textContent, /local, \d\d:\d\d UTC/);
  point({ lat: HERE.lat + 0.2, lon: HERE.lon });
  await nextTick();
  assert.match(
    $('.view-context__region').textContent,
    /UTC · local time loading…$/,
  );
  await settleWeather(t);
  assert.match($('.view-context__region').textContent, /\d\d:\d\d UTC$/);
  assert.doesNotMatch($('.view-context__region').textContent, /local/);
});

test('a completed weather read from a different point in the same cache cell supplies weather but no local time', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const brief = async () => ({
    coordinates: { latitude: HERE.lat + 0.001, longitude: HERE.lon },
    weather: {
      temperatureC: 18,
      timeZone: 'America/Chicago',
      utcOffsetSeconds: -21600,
    },
  });
  const { $, point } = fixture(t, [flightsOn([])], { brief });
  point(HERE);
  await settleWeather(t);
  await turn();
  await nextTick();
  assert.match($('.view-context__weather').textContent, /18 °C/);
  assert.match($('.view-context__region').textContent, /\d\d:\d\d UTC$/);
  assert.doesNotMatch($('.view-context__region').textContent, /local/);
});

test('with a layer on, zoomed in, the weather block shows the reading the local time came from, with no read of its own', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const reads = [];
  const brief = async (lat, lon) => {
    reads.push([lat, lon]);
    return {
      weather: {
        observedAt: new Date().toISOString(),
        timeZone: 'America/Chicago',
        utcOffsetSeconds: -21600,
        temperatureC: 18.4,
        apparentTemperatureC: 17.2,
        weatherCode: 3,
        windKph: 14.6,
        windDirectionDeg: 180,
        cloudCoverPct: 92,
        visibilityM: 24_000,
        precipitationMm: 0.2,
      },
    };
  };
  const fetched = [];
  const fetchImpl = async (url) => {
    if (!String(url).endsWith('/wikidata_cities/cities.json'))
      fetched.push(String(url));
    return new Response('', { status: 503 });
  };
  // Denver: a spot no other test reads, so no kept reading answers for it.
  const DENVER = { lat: 39.74, lon: -104.99 };
  const { $, point } = fixture(
    t,
    [flightsOn([flight('near01', DENVER.lat + 0.05, DENVER.lon)])],
    { brief, fetchImpl },
  );
  point(DENVER);
  await nextTick();
  assert.match(
    $('.view-context__weather').textContent,
    /Reading conditions here/,
    'reading until it is in',
  );
  await settleWeather(t);
  const block = $('.view-context__weather');
  assert.match(
    block.querySelector('.spot-conditions__weather-now strong').textContent,
    /18 °C/,
  );
  assert.match(block.textContent, /feels 17°/);
  const facts = Object.fromEntries(
    [...block.querySelectorAll('.spot-conditions__weather-facts div')].map(
      (node) => [
        node.querySelector('dt').textContent,
        node.querySelector('dd').textContent,
      ],
    ),
  );
  assert.deepEqual(Object.keys(facts), [
    'Wind',
    'Cloud',
    'Visibility',
    'Precipitation',
  ]);
  assert.match(facts.Wind, /15 km\/h/);
  assert.equal(facts.Cloud, '92%');
  assert.equal(facts.Visibility, '24 km');
  assert.equal(facts.Precipitation, '0.2 mm');
  assert.match(
    $('.view-context__region').textContent,
    /local/,
    'the same reading gives the local time',
  );
  // It sits above the radius, under the place and time.
  assert.ok(
    block.compareDocumentPosition($('.view-context__radius')) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  );
  assert.equal(reads.length, 1, 'one weather read for the time and the block');
  assert.deepEqual(
    fetched.filter((url) => /weather|regional/.test(url)),
    [],
    'no request of its own',
  );
});

test('with a layer on, a spot whose weather cannot be read says so', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { $, point } = fixture(t, [flightsOn([])], { brief: async () => null });
  point({ lat: 59.91, lon: 10.75 });
  await settleWeather(t);
  assert.match(
    $('.view-context__weather').textContent,
    /No weather reading here/,
  );
});

test('nothing on: up to three suggested layers, and Open shows Data Layers without switching any on', async (t) => {
  const off = (id, name) => ({
    id,
    name,
    enabled: false,
    records: [],
    stats: {},
  });
  const layers = [
    off('satellites', 'Satellites'),
    off('flights', 'Live Flights'),
    {
      ...off('ais-live-vessels', 'Live AIS Vessels'),
      stats: { lastUpdate: Date.now() },
    },
    off('cctv', 'CCTV'),
  ];
  const { $, cards, pinia } = fixture(t, layers);
  const chrome = usePanelChromeStore(pinia);
  const finder = useLayerFinderStore(pinia);
  const acted = [];
  const act = chrome.act;
  chrome.act = (...args) => acted.push(args);
  t.after(() => {
    chrome.act = act;
  });
  cards.setView({ center: { lat: 28, lon: -80 }, heightM: 18_000_000 });
  await nextTick();
  const named = [
    ...document.querySelectorAll('.view-context__suggest-item'),
  ].map((node) => node.dataset.layer);
  assert.deepEqual(named, ['satellites', 'flights', 'ais-live-vessels']);
  assert.match(
    $(
      '.view-context__suggest-item[data-layer="ais-live-vessels"]',
    ).textContent.trim(),
    /Live Vessels$/,
  );
  $('.view-context__suggest-open').click();
  assert.deepEqual(finder.inputs().picked, named);
  assert.deepEqual(acted, [
    ['reveal', 'data-panel'],
    ['toggle', 'data-panel'],
  ]);
  assert.ok(
    layers.every((layer) => !layer.enabled),
    'nothing is switched on',
  );
  // At a city, cameras say nothing about where they are: not suggested.
  cards.setView({ center: HERE, heightM: 40_000 });
  await nextTick();
  assert.equal($('.view-context__suggest-open'), null);
  assert.deepEqual(
    finder.inputs().picked,
    named,
    'zoom does not change the Finder',
  );
  acted.length = 0;
  $('.view-context__pointer').click();
  assert.deepEqual(finder.inputs().picked, []);
  assert.equal(finder.narrowed, false);
  assert.deepEqual(acted, [
    ['reveal', 'data-panel'],
    ['toggle', 'data-panel'],
  ]);
});

test('a custom Data Layers panel opens without applying a filter it cannot clear', async (t) => {
  const { $, cards, pinia } = fixture(
    t,
    [
      { id: 'satellites', name: 'Satellites', enabled: false },
      { id: 'weather-radar', name: 'Radar', enabled: false },
    ],
    { finderControls: false },
  );
  const chrome = usePanelChromeStore(pinia);
  const action = t.mock.method(chrome, 'act');
  cards.setView({ center: HERE, heightM: 20_000_000 });
  await nextTick();
  assert.equal($('.view-context__suggest-open'), null);
  $('.view-context__pointer').click();
  assert.deepEqual(
    action.mock.calls.map(({ arguments: args }) => args),
    [
      ['reveal', 'data-panel'],
      ['toggle', 'data-panel'],
    ],
  );
  assert.equal(useLayerFinderStore(pinia).narrowed, false);
});

test('the visible Inspector publishes its layer rows once for rows, suggestions and counts', async (t) => {
  let asks = 0;
  const flights = flightsOn([flight('near01', 30.28, -97.74)]);
  const { $, cards, pinia, close, open, replaceManager, notifyLayers } =
    fixture(t, [flights], {
      startOpen: false,
      fetchImpl: async (url) => {
        if (String(url).includes('/api/layer-counts')) asks++;
        return new Response('', { status: 503 });
      },
    });
  const publish = t.mock.method(cards, 'publishInspectorRows');
  const published = () => publish.mock.callCount();
  const setHeight = (heightM) => cards.setView({ center: HERE, heightM });
  setHeight(40_000);
  await turn();
  open();
  await nextTick();
  assert.equal(published(), 1);
  assert.ok($('.view-context [data-layer="flights"]'));
  const counts = useLayerCountsStore(pinia);
  assert.deepEqual(counts.state.counts, {});

  setHeight(50_000);
  await nextTick();
  assert.equal(
    published(),
    1,
    'local camera movement does not republish the layer rows',
  );
  cards.pulseInspector();
  await nextTick();
  assert.equal(published(), 2);
  assert.deepEqual(counts.state.counts, {});

  close();
  await nextTick();
  notifyLayers();
  cards.pulseInspector();
  await nextTick();
  assert.equal(
    published(),
    2,
    'a hidden refresh does not republish the layer rows',
  );
  open();
  await nextTick();
  assert.equal(published(), 3);

  const rows = [{ id: 'satellites', name: 'Satellites', enabled: false }];
  replaceManager({ layers: new Map(), getAll: () => rows });
  setHeight(20_000_000);
  await nextTick();
  assert.equal(published(), 4);
  assert.equal($('.view-context__suggest-item')?.dataset.layer, 'satellites');
  assert.equal($('.view-context__suggest-item[data-layer="flights"]'), null);
  assert.equal(asks, 0, 'a category-only sample does not admit counts');
  const layerHost = document.body.appendChild(document.createElement('div'));
  const layersApp = createApp(LayerPanelsView).use(pinia);
  layersApp.mount(layerHost);
  t.after(() => layersApp.unmount());
  const list = layerHost.querySelector('#data-toggles');
  const layerPanel = new LayerPanel({
    getLayers: () =>
      ['flights', 'satellites'].map((id) => ({
        id,
        name: id,
        enabled: false,
        showInTogglePanel: true,
        stats: {},
      })),
    getRowControls: () => null,
    hasRowControls: () => false,
  });
  layerPanel.mount(list);
  t.after(() => layerPanel.destroy());
  $('.view-context__suggest-open').click();
  await nextTick();
  assert.deepEqual(
    [...list.querySelectorAll('.data-toggle-row:not(.is-filtered)')].map(
      (row) => row.dataset.layerId,
    ),
    ['satellites'],
    'Open applies the suggestions from the replacement manager',
  );
  const chip = layerHost.querySelector('[title="Show all layers"]');
  assert.ok(chip);
  chip.click();
  assert.deepEqual(layerPanel.finder.inputs().picked, []);

  cards.pulseInspector();
  await nextTick();
  assert.equal(
    asks,
    1,
    'the next eligible pulse reads the same rows for admission',
  );
});

test('Inspector rows and count admission update when a manager reuses its array', async (t) => {
  const flightRow = {
    id: 'flights',
    name: 'Live Flights',
    enabled: true,
    stats: { count: 1 },
  };
  const rows = [flightRow];
  let asks = 0;
  const { $, cards, open, replaceManager } = fixture(t, [], {
    startOpen: false,
    fetchImpl: async (url) => {
      if (String(url) === '/api/layer-counts') asks++;
      return new Response('', { status: 503 });
    },
  });
  replaceManager({ layers: new Map(), getAll: () => rows });
  cards.setView({ center: HERE, heightM: 20_000_000 });
  open();
  await nextTick();
  assert.ok($('.view-context__block[data-layer="flights"]'));
  assert.equal(asks, 0);

  flightRow.enabled = false;
  cards.pulseInspector();
  await nextTick();
  assert.ok(!$('.view-context__block[data-layer="flights"]'));
  assert.match($('.view-context__region').textContent, /No layers on/);
  assert.equal(asks, 1);
});

test('phone and Cockpit hide the mounted Inspector while field reads resume once per visible pulse', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let reads = 0;
  const { $, cards, pinia } = fixture(
    t,
    [
      {
        id: 'wind',
        enabled: true,
        module: { getValueAt: () => ({ value: String(++reads) }) },
      },
    ],
    { useInspector: true },
  );
  cards.setView({ center: HERE, heightM: 40_000 });
  await nextTick();
  const view = $('.view-context');
  const { publishPresence } = useCockpitStore(pinia);
  const { publishPhoneShell } = useDisplayStore(pinia);
  const pulse = cards.inspectorPulse;

  publishPhoneShell({ enabled: true, sheet: 'layers' });
  assert.equal(cards.inspector.shown, false);
  await nextTick();
  const phoneReads = reads;
  cards.setView({
    center: { ...HERE, lat: HERE.lat + 0.3 },
    heightM: 40_000,
  });
  t.mock.timers.tick(4000);
  await nextTick();
  assert.equal(cards.inspectorPulse, pulse);
  assert.equal(reads, phoneReads);
  assert.equal($('.view-context'), view);

  publishPhoneShell({ enabled: true, sheet: 'context' });
  assert.equal(cards.inspector.shown, true);
  publishPresence({ active: true });
  assert.equal(cards.inspector.shown, false);
  await nextTick();
  const cockpitReads = reads;
  t.mock.timers.tick(4000);
  await nextTick();
  assert.equal(cards.inspectorPulse, pulse);
  assert.equal(reads, cockpitReads);
  assert.equal($('.view-context'), view);

  publishPresence({ active: false });
  await nextTick();
  const before = reads;
  t.mock.timers.tick(4000);
  await nextTick();
  assert.equal(cards.inspectorPulse, pulse + 1);
  assert.equal(
    reads - before,
    1,
    'presentation and metadata share the same render',
  );
});

test('unmounting the Context host cancels its count request while the bridge is still connected', async (t) => {
  const reply = Promise.withResolvers();
  let signal;
  const { cards, pinia, unmount } = fixture(t, [], {
    fetchImpl: async (url, options) => {
      if (!String(url).includes('/api/layer-counts'))
        return new Response('', { status: 503 });
      signal = options.signal;
      return reply.promise;
    },
  });
  await nextTick();
  assert.equal(cards.inspector.shown, true);
  assert.equal(signal?.aborted, false);
  unmount();
  assert.deepEqual(cards.inspector, { shown: false, mountId: null });
  await nextTick();
  assert.equal(signal.aborted, true);
  reply.resolve(Response.json({ counts: [{ layerId: 'flights', count: 31 }] }));
  await turn();
  assert.deepEqual(useLayerCountsStore(pinia).state, {
    counts: {},
    lastAttemptAt: null,
  });
});

test('resuming the Inspector refreshes its clock and cached count age before the next pulse', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let now = Date.parse('2026-11-21T12:00:00Z');
  t.mock.method(Date, 'now', () => now);
  let visible = true;
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => (visible ? 'visible' : 'hidden'),
  });
  t.after(() => delete document.visibilityState);
  const { $, cards, pinia } = fixture(t, [
    { ...flightsOn([]), enabled: false },
  ]);
  cards.setView({ center: { lat: 47.61, lon: -122.31 }, heightM: 20_000_000 });
  const counts = useLayerCountsStore(pinia);
  counts.publish({
    ...counts.state,
    counts: { flights: { count: 17, at: now - 60_000 } },
  });
  const clock = () => $('.view-context__tiles--facts').textContent;
  const tile = () =>
    $('.view-context__tiles--counts [data-layer="flights"]').textContent;
  await nextTick();
  assert.match(clock(), /12:00/);
  assert.match(tile(), /1 min ago/);

  visible = false;
  document.dispatchEvent(new Event('visibilitychange'));
  now += 2 * 60 * 60_000;
  visible = true;
  document.dispatchEvent(new Event('visibilitychange'));
  await nextTick();
  assert.match(clock(), /14:00/);
  assert.match(tile(), /2 h ago/);
  assert.match(tile(), /17/);

  t.after(() => {
    activeTab.value = 'view';
  });
  activeTab.value = 'props';
  await nextTick();
  now += 60 * 60_000;
  activeTab.value = 'view';
  await nextTick();
  assert.match(clock(), /15:00/);
  assert.match(tile(), /3 h ago/);
  assert.match(tile(), /17/);
});

test('hiding or replacing the mounted Inspector cancels its weather and count requests', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  t.after(() => {
    activeTab.value = 'view';
  });
  const countRequests = [];
  const weatherRequests = [];
  const pending = (requests, signal) => {
    const { promise, resolve } = Promise.withResolvers();
    requests.push({ signal, resolve });
    return promise;
  };
  const { $, cards, pinia, point, close, open } = fixture(
    t,
    [{ id: 'directions', enabled: true }],
    {
      brief: (_lat, _lon, { signal }) => pending(weatherRequests, signal),
      fetchImpl: (url, { signal } = {}) =>
        String(url) === '/api/layer-counts'
          ? pending(countRequests, signal)
          : Promise.resolve(new Response('', { status: 503 })),
    },
  );
  const display = useDisplayStore(pinia);
  const cockpit = useCockpitStore(pinia);
  const bhote = useBhoteKoshiPanelStore(pinia);
  let pageVisible = true;
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => (pageVisible ? 'visible' : 'hidden'),
  });
  const showPage = (visible) => {
    pageVisible = visible;
    document.dispatchEvent(new Event('visibilitychange'));
  };
  const bhoteRefs = Object.fromEntries(
    [
      'observedStatus',
      'imagerySection',
      'splitReadout',
      'splitInput',
      'timelineLabel',
      'time',
      'progressInput',
      'previousButton',
      'beatIndex',
      'beatTitle',
      'beatMeta',
      'nextButton',
      'playButton',
      'playSceneButton',
      'cinematicButton',
      'storyReplayButton',
      'openSourceButton',
      'corridorButton',
      'caveat',
      'imageryCloudNote',
    ].map((name) => [name, { value: 0, attributes: {} }]),
  );
  const body = document.body;
  const hiddenModes = [
    'ui-clean-view',
    'recording-mode',
    'stories-mode',
    'ui-embed',
  ];
  t.after(() => {
    body.classList.remove(...hiddenModes);
    delete body.dataset.assistantDocked;
    delete document.visibilityState;
  });
  const counts = useLayerCountsStore(pinia);
  const transitions = [
    [
      () => {
        activeTab.value = 'props';
      },
      () => {
        activeTab.value = 'view';
      },
    ],
    [
      () => display.publishPhoneShell({ enabled: true, sheet: 'layers' }),
      () => display.publishPhoneShell({ enabled: true, sheet: 'context' }),
    ],
    [
      () => cockpit.publishPresence({ active: true }),
      () => cockpit.publishPresence({ active: false }),
    ],
    [() => showPage(false), () => showPage(true)],
    ...hiddenModes.map((className) => [
      () => body.classList.add(className),
      () => body.classList.remove(className),
    ]),
    [
      () => {
        body.dataset.assistantDocked = 'true';
      },
      () => delete body.dataset.assistantDocked,
    ],
    [
      () => {
        contextSearchStyles(t);
        const style = document.createElement('style');
        style.textContent = readFileSync(
          new URL('./styles/bhote-koshi.css', import.meta.url),
          'utf8',
        );
        document.head.append(style);
        t.after(() => {
          style.remove();
          body.classList.remove('context-docked');
        });
        body.classList.add('context-docked');
        bhote.publish({
          refs: bhoteRefs,
          beforeDate: {},
          afterDate: {},
          reports: [],
        });
      },
      () => {
        const panel = $('#bhote-koshi-event-panel');
        assert.ok(panel.querySelector('[data-action="close"]'));
        assert.notEqual(getComputedStyle(panel).display, 'none');
        assert.equal(
          getComputedStyle($('#global-context-panel')).display,
          'none',
        );
        bhote.publish(null);
      },
    ],
    [
      () =>
        assert.ok(
          cards.select({
            layerId: 'local-datacenters',
            id: 'fixture',
            label: 'Fixture site',
          }),
        ),
      () => cards.clear(),
      true,
    ],
    [close, open, true],
  ];
  point(HERE);
  await nextTick();
  for (const [index, [hide, show, unmounts]] of transitions.entries()) {
    t.mock.timers.tick(400);
    await turn();
    assert.equal(countRequests.length, index + 1);
    assert.equal(weatherRequests.length, index + 1);

    const mounted = $('.view-context');
    assert.ok(mounted);
    hide();
    await turn();
    assert.equal(cards.inspector.shown, false);
    assert.equal($('.view-context'), unmounts ? null : mounted);
    const count = countRequests[index];
    const weather = weatherRequests[index];
    assert.equal(count.signal.aborted, true);
    assert.equal(weather.signal.aborted, true);
    count.resolve(
      Response.json({ counts: [{ layerId: 'flights', count: 99 }] }),
    );
    weather.resolve({ weather: { temperatureC: 44 } });
    await turn();
    assert.deepEqual(counts.state.counts, {});
    assert.equal(cards.viewWeather?.reading ?? null, null);
    point({ ...HERE, lat: HERE.lat + (index + 1) * 0.25 });
    t.mock.timers.tick(400);
    await turn();
    assert.equal(countRequests.length, index + 1);
    assert.equal(weatherRequests.length, index + 1);

    show();
    await turn();
  }
  t.mock.timers.tick(400);
  await turn();
  assert.equal(countRequests.length, transitions.length + 1);
  assert.equal(weatherRequests.length, transitions.length + 1);
});

test('a map overlay gets a tile with its state and how fresh it is, at a city and at the globe; Directions, a tool, gets none', async (t) => {
  const { $, cards } = fixture(t, [
    flightsOn([flight('near01', 30.28, -97.74)]),
    {
      id: 'sea-marks',
      name: 'Sea marks',
      enabled: true,
      stats: {},
      module: { getAnalystRecords: undefined },
    },
    {
      id: 'weather-radar',
      name: 'Rain radar',
      enabled: true,
      stats: { lastUpdate: Date.now() - 4 * 60_000 },
      module: { getAnalystRecords: undefined },
    },
    {
      id: 'news',
      name: 'News',
      enabled: true,
      stats: { count: 8, lastUpdate: Date.now() - 4 * 60_000 },
      module: {
        supportsAnalystRecords: false,
        getAnalystRecords: () => [],
      },
    },
    {
      id: 'directions',
      name: 'Directions',
      enabled: true,
      stats: {},
      module: { getAnalystRecords: undefined },
    },
  ]);
  cards.setView({ center: HERE, heightM: 40_000 });
  await nextTick();
  const marks = $('.view-context__tile--value[data-layer="sea-marks"]');
  assert.ok(marks, 'the overlay has a tile');
  assert.match(marks.textContent, /On the map/);
  const news = document.querySelectorAll(
    '.view-context__tile[data-layer="news"]',
  );
  assert.equal(news.length, 1);
  assert.match(news[0].textContent, /On the map/);
  assert.match(
    $('.view-context__tile--value[data-layer="weather-radar"] strong')
      .textContent,
    /Updated 4 min ago/,
  );
  assert.equal($('[data-layer="directions"]'), null, 'no Directions tile');
  cards.setView({ center: HERE, heightM: 18_000_000 });
  await nextTick();
  assert.equal(
    $('.view-context__block[data-layer="directions"]'),
    null,
    'no Directions block at globe view',
  );
  assert.ok($('.view-context__block[data-layer="flights"]'));
  // At the globe an overlay says its state, never a count.
  assert.match(
    $('.view-context__block[data-layer="weather-radar"] strong').textContent,
    /Updated 4 min ago/,
  );
  assert.match(
    $('.view-context__block[data-layer="sea-marks"] strong').textContent,
    /Live/,
  );
  assert.match(
    $('.view-context__block[data-layer="news"] strong').textContent,
    /Updated 4 min ago/,
  );
});

test('every layer that is on has a tile at every zoom, a reason in place of a 0, and Space Missions counts its list', async (t) => {
  const { $, cards, pinia } = fixture(t, [
    flightsOn([flight('far01', 40.7, -74.0)]),
    {
      id: 'bikeshare',
      name: 'Bike Share',
      enabled: true,
      records: [],
      stats: {
        count: 0,
        status: 'zoom-in',
        statusMessage: 'Zoom in to see bikes',
      },
    },
    // The Space Missions layer's own row, on with its roster.
    {
      id: 'rocket-launches',
      name: 'Space Missions',
      enabled: true,
      records: [{ id: 'm1', name: 'Mission', lat: 30.3, lon: -97.7 }],
      stats: { count: 1, lastUpdate: Date.now() },
    },
  ]);
  const missions = useSpaceMissionsStore(pinia);
  missions.setEnabled(true);
  missions.publish({
    roster: { entries: new Array(23).fill({}) },
    mission: null,
  });
  cards.setView({ center: HERE, heightM: 40_000 });
  await nextTick();
  const missionTiles = (selector) =>
    [...document.querySelectorAll(selector)].filter((el) =>
      ['rocket-launches', 'space-missions'].includes(el.dataset.layer),
    );
  assert.equal(
    missionTiles('.view-context__tile').length,
    1,
    'one Space Missions tile',
  );
  assert.equal(
    Boolean($('.nearby-lists__layer[data-layer="rocket-launches"]')),
    false,
    'no second Nearby group',
  );
  // Nothing of theirs within the radius: still a tile each.
  assert.equal(
    $('.view-context__tile[data-layer="flights"] strong').textContent,
    '0',
  );
  assert.match(
    $('.view-context__tile[data-layer="bikeshare"] strong').textContent,
    /Zoom in to see bikes/,
  );
  assert.equal(
    $('.view-context__tile[data-layer="space-missions"] strong').textContent,
    '23',
  );
  cards.setView({ center: HERE, heightM: 18_000_000 });
  await nextTick();
  assert.match(
    $('.view-context__block[data-layer="bikeshare"] strong').textContent,
    /Zoom in to see bikes/,
    'the same rule at the globe',
  );
  assert.equal(
    $('.view-context__block[data-layer="space-missions"] strong').textContent,
    '23',
  );
  assert.equal(
    missionTiles('.view-context__block').length,
    1,
    'one Space Missions block',
  );
});

test('Space Missions alone is a layer that is on, and its tile carries the mission index feed state', async (t) => {
  const index = {
    id: 'rocket-launches',
    name: 'Space Missions (30d)',
    enabled: true,
    records: [],
    stats: { count: 0, error: 'HTTP 503', lastError: 'HTTP 503' },
  };
  const { $, cards, pinia } = fixture(t, [index]);
  const missions = useSpaceMissionsStore(pinia);
  missions.setEnabled(true);
  // The roster's failure shape: no entries.
  missions.publish({ roster: { count: '—', entries: [] }, mission: null });
  cards.setView({ center: HERE, heightM: 40_000 });
  await nextTick();
  assert.equal(
    Boolean($('.view-context__tiles--counts')),
    false,
    'not the nothing-on view',
  );
  assert.doesNotMatch($('.view-context').textContent, /No layers on/);
  const tile = $('.view-context__tile[data-layer="space-missions"]');
  assert.ok(tile, 'its one tile');
  assert.doesNotMatch(
    tile.textContent,
    /\b0\b/,
    'never a bare 0 for a failed index',
  );
  assert.notEqual(
    tile.querySelector('.view-context__dot').getAttribute('aria-label'),
    'Live',
  );
  assert.match(
    [...document.querySelectorAll('.view-context__problem')]
      .map((line) => line.textContent)
      .join('\n'),
    /Space Missions \(30d\).*HTTP 503/,
    'the trouble line stays',
  );
  cards.setView({ center: HERE, heightM: 18_000_000 });
  await nextTick();
  assert.doesNotMatch(
    $('.view-context__region').textContent,
    /No layers on/,
    'nor at the globe',
  );
});

test('a stale mission index marks the Space Missions tile stale, keeping its count', async (t) => {
  const index = {
    id: 'rocket-launches',
    name: 'Space Missions (30d)',
    enabled: true,
    records: [],
    stats: { count: 23, stale: true, lastUpdate: Date.now() - 3 * 3600_000 },
  };
  const { $, cards, pinia } = fixture(t, [index]);
  const missions = useSpaceMissionsStore(pinia);
  missions.setEnabled(true);
  missions.publish({
    roster: { entries: new Array(23).fill({}) },
    mission: null,
  });
  cards.setView({ center: HERE, heightM: 40_000 });
  await nextTick();
  const tile = $('.view-context__tile[data-layer="space-missions"]');
  assert.equal(tile.querySelector('strong').textContent, '23');
  assert.equal(
    tile.querySelector('.view-context__dot').getAttribute('aria-label'),
    'Stale',
  );
  assert.ok(
    document.querySelector('.view-context__problem'),
    'its stale line shows',
  );
});

test('field tiles distinguish failed, pending and empty readings', async (t) => {
  const catalog = fakeCatalog();
  const thumbnails = fakeThumbnails();
  const layer = createRecentImageryLayer({
    catalog,
    renderer: fakeRenderer(),
    thumbnails,
    host: () => ({ collection: {}, kind: 'globe' }),
  });
  const manager = new LayerLifecycle({ scene: {} });
  manager.register(layer);
  layer.attachDataManager(manager);
  manager.register({
    id: 'wind',
    name: 'Wind',
    init() {},
    enable() {},
    update() {},
    disable() {},
    getStats: () => ({ count: 1 }),
    getValueAt() {
      throw new Error('wind read failed');
    },
  });
  t.after(() => manager.destroyAll());

  const { $, cards, replaceManager, point } = fixture(t, [], {
    useInspector: true,
  });
  replaceManager(manager);
  assert.equal(await manager.setEnabled(layer.id, true), true);
  assert.equal(await manager.setEnabled('wind', true), true);
  point(HERE);
  await turn();

  const tile = () =>
    $('.view-context__tile--value[data-layer="recent-imagery"]');
  assert.match(tile().textContent, /No area chosen/);

  assert.equal(layer.setBox(BOX), true);
  await nextTick();
  assert.equal(tile().querySelector('strong').textContent, '…');
  assert.doesNotMatch(tile().textContent, /No value/);

  catalog.searches.at(-1).reject(new Error('CMR down'));
  await turn();
  cards.pulseInspector();
  await nextTick();
  const wind = $('.view-context__tile--value[data-layer="wind"]');
  for (const failed of [tile(), wind]) {
    assert.equal(failed.querySelector('strong').textContent, 'Unavailable');
    assert.equal(
      failed.querySelector('.view-context__dot').getAttribute('aria-label'),
      'Unavailable',
    );
    assert.doesNotMatch(failed.textContent, /No value/);
  }

  const update = async () => {
    await turn();
    cards.pulseInspector();
    await nextTick();
  };
  const tone = () =>
    tile().querySelector('.view-context__dot').getAttribute('aria-label');
  const reading = () => tile().querySelector('strong').textContent;

  assert.equal(layer.setBox(BOX), true);
  const outcome = await searchHls({
    box: BOX,
    days: 1,
    now: '2026-09-21T15:00:00Z',
    fetchImpl: async () => {
      throw new Error('CMR down');
    },
  });
  catalog.searches.at(-1).resolve(outcome);
  await update();
  assert.equal(tone(), 'Unavailable');
  assert.equal(reading(), 'Unavailable');
  assert.doesNotMatch(tile().textContent, /No value/);

  layer.setSources({ viirs: true });
  await update();
  assert.equal(tone(), 'Unavailable', 'unprobed VIIRS supplies no coverage');

  thumbnails.probe('VIIRS:2026-09-21', 'present');
  await update();
  assert.equal(tone(), 'Degraded');
  assert.match(tile().textContent, /Area imagery · point coverage unknown/);

  layer.setSources({ hls: false });
  await update();
  assert.equal(tone(), 'Live', 'the failed HLS source is off');
  assert.match(tile().textContent, /Area imagery · point coverage unknown/);
  layer.setSources({ hls: true, viirs: false });

  const wider = { ...BOX, west: BOX.west - 0.01 };
  assert.equal(layer.setBox(wider), true);
  await update();
  assert.equal(reading(), '…', 'a new search replaces the previous outage');
  const errors = outcome.errors.filter((error) => error.product === 'S30');
  catalog.searches.at(-1).resolve({ candidates: [], errors });
  await update();
  assert.equal(tone(), 'Degraded');
  assert.equal(reading(), 'Degraded');
  assert.doesNotMatch(tile().textContent, /No value/);

  const landsat = candidate('L30', '2026-09-20');
  landsat.granules[0].footprint = [
    [BOX.west, BOX.south],
    [BOX.east, BOX.south],
    [BOX.east, BOX.north],
    [BOX.west, BOX.north],
  ];
  assert.equal(layer.setBox(BOX), true);
  catalog.searches.at(-1).resolve({ candidates: [landsat], errors });
  await update();
  assert.equal(tone(), 'Degraded');
  assert.equal(reading(), 'Sep 20, 2026');
  assert.match(tile().textContent, /Landsat/);

  assert.equal(layer.setBox(wider), true);
  catalog.resolveLast([]);
  await update();
  assert.equal(tone(), 'Live');
  assert.match(tile().textContent, /No value at the centre of the view/);
});

test('a retry that becomes due in Properties waits for the Inspector to be visible', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'] });
  t.after(() => {
    activeTab.value = 'view';
  });
  let reads = 0;
  const { $, point } = fixture(t, [flightsOn([flight('a1', 30.3, -97.7)])], {
    brief: async () => {
      reads++;
      return null;
    },
  });
  const advance = async (ms) => {
    t.mock.timers.tick(ms);
    await nextTick();
    await turn();
  };
  point(HERE);
  await nextTick();
  await advance(400);
  assert.equal(reads, 1, 'weather is read once the view settles');
  await advance(20_000);
  const mounted = $('.view-context');
  activeTab.value = 'props';
  await nextTick();
  await advance(60_000);
  assert.equal(
    $('.view-context'),
    mounted,
    'Properties keeps Inspector mounted',
  );
  assert.equal(reads, 1, 'Properties does not issue the overdue read');

  activeTab.value = 'view';
  await nextTick();
  await advance(4000);
  await advance(400);
  assert.equal(reads, 2, 'the next visible pulse starts the overdue retry');
});

test('the local country heading follows the locale without moving the camera', async (t) => {
  applicationI18n();
  setLocale('en');
  const originalLang = document.documentElement.lang;
  document.documentElement.lang = 'en';
  t.after(() => {
    document.documentElement.lang = originalLang;
    setLocale('en');
  });
  let cityReads = 0;
  const { $, cards } = fixture(t, [], {
    useInspector: false,
    fetchImpl: async (url) => {
      if (!String(url).endsWith('/wikidata_cities/cities.json'))
        return new Response('', { status: 503 });
      cityReads++;
      return Response.json({
        rows: [['Badajoz', 38.878, -6.971, 150209, 'ES']],
      });
    },
  });
  cards.setView({ center: { lat: 38.87, lon: -7.09 }, heightM: 40_000 });
  await turn();
  assert.match($('.view-context__title').textContent, /Near Badajoz, Spain/);
  assert.match($('.view-context').textContent, /38.870°N\s+7.090°W/);

  document.documentElement.lang = 'fr';
  setLocale('fr');
  await nextTick();
  assert.match($('.view-context__title').textContent, /Badajoz, Espagne/);
  document.documentElement.lang = 'en';
  setLocale('en');
  cards.setView({ center: { lat: 38.878, lon: -6.971 }, heightM: 40_000 });
  await turn();
  assert.equal(
    $('.view-context__title').textContent.trim(),
    'Near Badajoz, Spain',
  );
  cards.setView({ center: { lat: 38.879, lon: -6.971 }, heightM: 40_000 });
  await nextTick();
  assert.match($('.view-context__title').textContent, /Near Badajoz, Spain/);
  assert.equal(cityReads, 1);
});

test('a globe class bar follows a changed loaded total within the 30 s cache', async (t) => {
  const recs = (a, f) => [
    ...Array.from({ length: a }, (_, i) => ({
      ...flight(`a${i}`, i, i),
      aircraftClass: 'airliner',
    })),
    ...Array.from({ length: f }, (_, i) => ({
      ...flight(`f${i}`, -i - 1, i),
      aircraftClass: 'fastjet',
    })),
  ];
  const flights = flightsOn(recs(2, 1));
  const { $, cards, notifyLayers } = fixture(t, [flights]);
  cards.setView({ center: { lat: 0, lon: 0 }, heightM: 20_000_000 });
  await nextTick();
  const bar = () =>
    $('.view-context__block[data-layer="flights"] .view-context__bar');
  const head = () =>
    $('.view-context__block[data-layer="flights"] strong').textContent;
  for (const [airliners, jets] of [
    [3, 2],
    [4, 2],
    [5, 2],
  ]) {
    flights.records = recs(airliners, jets);
    flights.stats = { count: airliners + jets, lastUpdate: Date.now() };
    notifyLayers();
    await nextTick();
    assert.equal(head(), String(airliners + jets));
    assert.ok(bar(), `a two-class bar at count ${airliners + jets}`);
  }
});

test('the Data Layers pointer does not ask to turn on layers while one is on', async (t) => {
  const { $, cards } = fixture(t, [
    {
      id: 'local-datacenters',
      name: 'Data Centers',
      enabled: true,
      stats: { count: 1, lastUpdate: Date.now() },
      records: [{ id: 'dc', name: 'DC one', ...HERE }],
    },
  ]);
  for (const heightM of [120_000, 20_000_000]) {
    cards.setView({ center: HERE, heightM });
    await nextTick();
    const pointer = $('.view-context__pointer-text');
    assert.ok(pointer, `the Data Layers pointer at ${heightM} m`);
    assert.equal(
      pointer.textContent.trim(),
      'Open Data Layers',
      `at ${heightM} m`,
    );
  }
});

test('globe search names a layer whose feed is unavailable with no records', async (t) => {
  const { $, cards } = fixture(t, [
    {
      id: 'satellites',
      name: 'Satellites',
      enabled: true,
      records: [],
      stats: {
        count: 0,
        status: 'unavailable',
        error: 'CelesTrak unreachable',
        lastUpdate: null,
      },
    },
    {
      id: 'local-dams',
      name: 'Dams',
      enabled: true,
      stats: { count: 1 },
      records: [{ id: 'dam', name: 'Test dam', ...HERE }],
    },
  ]);
  cards.setView({ center: HERE, heightM: 20_000_000 });
  await nextTick();
  const status = () =>
    $('.view-context__blocks [role="status"]')?.textContent.trim();
  contextSearchOpen.value = true;
  contextSearchText.value = 'ISS';
  await nextTick();
  assert.match(status() ?? '', /Unavailable layers: .*Satellites/);
  contextSearchText.value = 'est dam';
  await nextTick();
  assert.match(status() ?? '', /Unavailable layers: .*Satellites/);
});
