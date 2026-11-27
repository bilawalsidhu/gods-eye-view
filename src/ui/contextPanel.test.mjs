import { ownerFlagStyle, preloadOwnerFlags } from './ownerFlag.js';
// src/ui/contextPanel.test.mjs — the Context panel: what is picked, led by
// its hero, or situational awareness of the layers that are on, over
// happy-dom.
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import { styleFixture } from '../testSupport/styleFixture.mjs';
import assert from 'node:assert/strict';
import { useCctvStore } from './stores/cctv.js';
import { useLiveStore } from './stores/live.js';
import { useStationStore } from './stores/station.js';
import { LiveControls } from './liveControls.js';
import { createPinia, setActivePinia } from 'pinia';
import {
  computed,
  createApp,
  h,
  nextTick,
  render as renderVue,
  watch,
} from 'vue';
import ContextView from './views/ContextView.vue';
import { resetListCardMemory } from './kit/ContextListCard.vue';
import LayerPanelsView from './views/LayerPanelsView.vue';
import PhoneTabBar from './views/panels/PhoneTabBar.vue';
import EntityPreview from './views/panels/EntityPreview.vue';
import { LayerPanel } from './layerPanel.js';
import { createLayerFinder } from './layerFinderFilter.js';
import { layerSettingsGuide } from './omnibarGuide.js';
import { useLayerFinderStore } from './stores/layerFinder.js';
import {
  createContextCardOpener,
  INSPECTOR_PULSE_MS,
  useEntityCardStore,
} from './stores/entityCard.js';
import { usePanelChromeStore } from './stores/panelChrome.js';
import { useStreetLevelStore } from './stores/streetLevel.js';
import { usePinnedStore } from './stores/pinned.js';
import { useDockedStore } from './stores/docked.js';
import { placeStreetLevelViewer } from './streetLevelViewerPlacement.js';
import { StreetLevelControls } from './streetLevelControls.js';
import { StyleManager } from './applicationShell.js';
import { applicationPinia } from './vueRuntime.js';
import { createGoogleProvider } from '../layers/streetLevel/providers/google/index.js';
import { createStreetLevelLayer } from '../layers/streetLevel/index.js';
import {
  fakeCesiumViewer,
  posingStreetLevelProvider,
} from '../testSupport/streetLevelFakes.mjs';
import { _setFrameStillCaptureForTest } from './frameStill.js';
import { CAMERA_SETTINGS_EVENT } from './contextEvents.js';
import { placeIdentity, placePin } from './placeCard.js';
import { useSpaceMissionsStore } from './stores/spaceMissions.js';
import { useLayerCountsStore } from './stores/layerCounts.js';
import { createLayerCounts } from './layerCounts.js';
import { getConfiguredLayerCounts } from '../services/application.js';
import { useVoiceStore } from './stores/voice.js';
import { installEntityContext } from './entityContextBridge.js';
import { bindRenderer } from '../render/rendererOf.js';
import { fakeInput } from '../input/testDoubles.mjs';
import { fakeCameraPort } from '../testSupport/fakeCameraPort.mjs';
import { useOmnibarStore } from './stores/omnibar.js';
import { useRadioStore } from './stores/radio.js';
import { createRadioLayer } from '../layers/radio/index.js';
import { _resetPinnedStationForTest } from './pinnedStation.js';
import { useRadioLayer } from './radioContext.js';
import { presentCctvPanel } from './cctvPresentation.js';
import {
  contextRadiusKm,
  overheadRangeKm,
  setContextRadiusKm,
  setOverheadRangeKm,
} from './contextRadius.js';
import {
  closeContextSearch,
  contextSearchOpen,
  contextSearchText,
} from './contextSearch.js';
import { loadFleetModelSet, resetFleetModelSet } from '../data/fleetModels.js';
import fs from 'node:fs';
import { HERO_AUTOPLAY_MS } from './entityHeroViews.js';
import { useBhoteKoshiPanelStore } from './stores/bhoteKoshiPanel.js';
import { useDisplayStore } from './stores/display.js';
import { useContextStore } from './stores/context.js';
import { useCockpitStore } from './stores/cockpit.js';
import { createControls as createWildlifeControls } from '../layers/wildlifeSightings/controls.js';
import { normalizeInatObservations } from '../layers/wildlifeSightings/records.js';
import { aircraftIcon } from '../data/aircraftIcons.js';
import { GNSS_LEVEL_COLORS } from '../layers/gnss/records.js';
import { bindFakeDraw } from '../testSupport/fakeDrawPort.mjs';
import { usAqiBand } from '../layers/airQuality/usAqi.js';
import { onAqiPeriods } from '../testSupport/airQualityViewer.mjs';
import { createAirQualityLayer } from '../layers/airQuality/index.js';
import { LayerLifecycle } from '../data/lifecycle.js';
import { searchHls } from '../layers/recentImagery/catalog.js';
import { firePerimeterSnapshot } from '../layers/perimeters/records.js';
import { setLocale } from '../i18n/index.js';
import { applicationI18n } from './i18n.js';

import { CockpitCoordinator } from './cockpitCoordinator.js';
import {
  resetContextLists,
  setContextListPresence,
  showContextList,
} from './contextLists.js';
import { createRecentImageryPanel } from './recentImagery.js';
import {
  bindPanelDisclosure,
  collapsePanelOnEscape,
} from './panelDisclosure.js';
import { createRecentImageryLayer } from '../layers/recentImagery/index.js';
import {
  BOX,
  candidate,
  fakeCatalog,
  fakeController,
  fakeRenderer,
  fakeThumbnails,
  manualTimers,
  settle as settleImagery,
} from '../layers/recentImagery/testDoubles.mjs';
import { bindFakeCesiumCamera } from '../testSupport/fakeCameraPort.mjs';
import { fakeGlobePort } from '../testSupport/fakeGlobePort.mjs';

const turn = () => new Promise((resolve) => setImmediate(resolve));

test('ViewContext leaves service reads and request lifetimes to the bridge', () => {
  const source = fs.readFileSync(
    new URL('./views/panels/ViewContext.vue', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(
    source,
    /\b(?:setTimeout|AbortController|readWeather|ensureLayerCounts|noteLiveCount)\b/,
  );
});

// Austin, Texas: a zoomed-in view, well below globe scale.
const HERE = { lat: 30.27, lon: -97.74 };
const WHOLE_GLOBE = { west: -180, south: -90, east: 180, north: 90 };
function localView(center = HERE) {
  const { lat, lon } = center;
  return {
    center,
    heightM: 40_000,
    rect: { west: lon - 1, east: lon + 1, south: lat - 1, north: lat + 1 },
  };
}
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
// The renderer's previews, as stubs: each draws nothing and never fails.
const stubPreview = () => ({ setActive() {}, update() {}, destroy() {} });
const STUB_PREVIEWS = {
  model: stubPreview,
  route: stubPreview,
  cockpit: stubPreview,
};

/** The fleet's catalog and type map loaded as the layers load them, each model a stand-in byte. */
async function withFleet(t) {
  const file = (name) =>
    fs.readFileSync(
      new URL(`../../public/models/fleet/${name}`, import.meta.url),
      'utf8',
    );
  const info = console.info;
  console.info = () => {};
  t.after(() => {
    console.info = info;
    resetFleetModelSet();
  });
  await loadFleetModelSet({
    fetchImpl: async (url) =>
      url.endsWith('.json')
        ? new Response(file(url.slice(url.lastIndexOf('/') + 1)))
        : new Response(new Uint8Array(1)),
  });
}

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
    weatherClock,
    startOpen = true,
    finderControls = true,
    pinia = createPinia(),
  } = {},
) {
  // Weather and hazard reads stay off the network: every feed answers 503.
  const realFetch = globalThis.fetch;
  globalThis.fetch =
    fetchImpl || (async () => new Response('', { status: 503 }));
  document.body.replaceChildren();
  const host = document.body.appendChild(document.createElement('div'));
  if (finderControls) t.after(useLayerFinderStore(pinia).attachControls());
  const app = createApp(ContextView).use(pinia);
  const cards = useEntityCardStore(pinia);
  const chrome = usePanelChromeStore(pinia);
  const radius = contextRadiusKm.value;
  const overhead = overheadRangeKm.value;
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
    setOverheadRangeKm(overhead);
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
        ...(layer.id === 'cctv'
          ? {
              findByQuery: (id) =>
                layer.records?.find((record) => record.id === id),
            }
          : {}),
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
  const notifyLayers = (change = { type: 'enabled' }) => {
    layerListeners.forEach((listener) => listener(change));
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
  const dataManager = () => manager;
  let point;
  let clickGround;
  if (useInspector) {
    const viewer = { scene: {} };
    const input = fakeInput(viewer);
    clickGround = input.click;
    const listeners = new Map();
    let pose = {};
    const unbind = bindRenderer(viewer, {
      camera: {
        pose: () => pose,
        viewRectangle: () => WHOLE_GLOBE,
        on(event, listener) {
          listeners.set(event, listener);
          return () => listeners.delete(event);
        },
      },
    });
    point = (center, height = 40_000) => {
      pose = { ...center, height };
      listeners.get('moveEnd')();
    };
    const counts = useLayerCountsStore(pinia);
    const dispose = installEntityContext({
      viewer,
      pinia,
      getDataManager: dataManager,
      regionalBrief: brief,
      inspector: {
        counts: createLayerCounts({
          getCounts,
          readState: () => counts.state,
          writeState: counts.publish,
          readShown: cards.readViewContextShown,
        }),
        weatherClock,
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
    clickGround,
    open: () =>
      chrome.publish(owner, 'global-context-panel', { collapsed: false }),
    unmount,
    replaceManager: (next) => {
      manager = next;
    },
    dataManager,
  };
}

const flightsOn = (records, stats = {}) => ({
  id: 'flights',
  name: 'Live Flights',
  enabled: true,
  records,
  stats: { count: records.length, lastUpdate: Date.now(), ...stats },
});

test('Context owns the right rail and keeps the Radio fold hidden until needed', async (t) => {
  const { $ } = fixture(t, [flightsOn([])]);
  await nextTick();
  const panel = $('#global-context-panel');
  assert.equal(panel.parentElement.id, 'right-context-rail');
  // Radio's own controls stay in the page, folded away until its stations show.
  assert.equal($('#radio-panel').tagName, 'DETAILS');
  assert.equal($('#radio-panel').closest('#right-context-rail'), null);
  assert.ok($('#radio-panel').closest('.radio-fold-home[hidden]'));
  assert.ok($('#context-body'));
});

const NEAREST = '.nearby-lists__row--nearest button';

// These small catalogs fit in one scheduled spatial-index build.
async function settleInspectorIndex() {
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
}

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
  cards.setView(localView());
  await settleInspectorIndex();
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

test('a selected flight displays route progress between its two airports', async (t) => {
  const { $, cards } = fixture(t, [
    flightsOn([flight('near01', HERE.lat, HERE.lon)]),
  ]);
  cards.setView(localView());
  await settleInspectorIndex();
  $(NEAREST).click();
  await nextTick();
  const offset = (0.9996 / 6371) * (180 / Math.PI);
  cards.card = {
    ...cards.card,
    altitudeM: 3000,
    route: {
      verified: true,
      from: 'AAA',
      to: 'BBB',
      fromAt: { lat: HERE.lat - offset, lon: HERE.lon },
      toAt: { lat: HERE.lat + offset, lon: HERE.lon },
    },
  };
  await nextTick();
  assert.match($('.route-profile__head').textContent, /50% flown/);
  assert.match($('.route-profile__ends').textContent, /AAA.*BBB/);
  assert.equal($('.route-profile__note').textContent, 'FL100');

  cards.card = {
    ...cards.card,
    altitudeM: 10_760,
    speedMps: 125,
    route: {
      ...cards.card.route,
      toAt: { lat: HERE.lat + 19 * offset, lon: HERE.lon },
    },
  };
  await nextTick();
  await t.test('early climb reaches cruise before descent', () => {
    assert.match($('.route-profile__head').textContent, /5% flown/);
    const points = $('.route-profile__ahead').getAttribute('d').split(' L');
    const cruise = points[1].split(' ')[1];
    assert.deepEqual(points.slice(1), [
      `22 ${cruise}`,
      `178 ${cruise}`,
      '200 38',
    ]);
  });
  await t.test(
    'remaining time is marked as an estimate in the text and chart name',
    () => {
      const note = $('.route-profile__note').textContent;
      assert.match(note, /^FL350 · ~.*left/);
      assert.equal($('.route-profile__chart').getAttribute('aria-label'), note);
    },
  );
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
  cards.setView(localView());
  await settleInspectorIndex();
  $('.nearby-lists [data-row-layer="traffic"]').click();
  await nextTick();
  assert.match(
    $('.entity-card__source-line').textContent,
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
  cards.setView(localView());
  await settleInspectorIndex();
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
  cards.setView(localView(center));
  contextSearchOpen.value = true;
  contextSearchText.value = 'seal';
  await nextTick();
  assert.ok($('#context-body').classList.contains('context-searching'));

  const button = $('.nearby-lists [data-row-layer="wildlife-sightings"]');
  assert.match(button.textContent, /Harbor seal/);
  assert.match(
    button.querySelector('.nearby-lists__meta').textContent,
    /approximate/,
  );
  button.click();
  await nextTick();

  assert.equal(cards.card.identity.id, sighting.stableId);
  assert.deepEqual(flown, [cards.card.key]);
  const card = $('.entity-card');
  const sourceLine = card.querySelector('.entity-card__source-line');
  assert.match(sourceLine.textContent, /^Acartia(?: ·|$)/);
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
  const website = 'a[href="https://example.com/"]';
  assert.equal(card.querySelector(website), null);
  contextSearchText.value = '';
  await nextTick();
  assert.ok(card.querySelector(website));
  contextSearchText.value = 'seal';
  await nextTick();
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
  cards.setView(localView());
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
  assert.ok(!$('.entity-hero .close-up-map'));
  assert.ok($('.entity-hero__placeholder'));
  assert.match(where, /Location obscured to a 0\.2° cell/);
  assert.doesNotMatch(where, /\.\d{3}°/);
  const source = $(`.entity-card__attribution-links a[href="${link}"]`);
  assert.ok(source);
  assert.notEqual(getComputedStyle(source.parentElement).display, 'none');
  assert.equal($('.entity-card a[href="https://www.bewhalewise.org"]'), null);
});

test('a withheld wildlife position stops the card’s coordinate-based previews and conditions', async (t) => {
  const sighting = { ...HERE, id: 'inat:1', name: 'Barred Owl' };
  const layerId = 'wildlife-sightings';
  const { $, cards, notifyLayers, dataManager } = fixture(t, [
    {
      id: layerId,
      name: 'Wildlife Sightings',
      enabled: true,
      records: [sighting],
    },
  ]);
  const weatherRequests = [];
  cards.readWeather = (_lat, _lon, { signal }) => {
    weatherRequests.push(signal);
    return new Promise((resolve) =>
      signal.addEventListener('abort', () => resolve(null), { once: true }),
    );
  };
  assert.equal(
    cards.open({ layerId, id: sighting.id }, { fromPin: true, follow: false }),
    true,
  );
  await nextTick();
  assert.ok($('.entity-hero .close-up-map'));
  assert.ok($('.spot-conditions'));

  sighting.positionUnconfirmed = true;
  cards.refresh({ forAction: true });
  await nextTick();
  assert.equal(cards.locationWithheld, true);
  assert.equal($('.entity-card__title').textContent, 'Barred Owl');
  assert.ok(!$('.entity-hero .close-up-map'), 'no position-derived imagery');
  assert.ok(!$('.spot-conditions'), 'no position-derived conditions');
  assert.ok($('.entity-hero__placeholder'));

  sighting.positionUnconfirmed = false;
  cards.refresh({ forAction: true });
  await nextTick();
  assert.equal(cards.locationWithheld, false);
  assert.ok($('.entity-hero .close-up-map'));
  assert.ok($('.spot-conditions'));

  const beforeOff = weatherRequests.length;
  assert.ok(beforeOff > 0);
  const layer = dataManager().layers.get(layerId);
  layer.enabled = false;
  notifyLayers();
  cards.refresh();
  await nextTick();
  assert.equal(cards.card?.title, 'Barred Owl', 'the pin remains open');
  assert.equal(cards.locationWithheld, true);
  assert.equal($('.spot-conditions'), null);
  assert.equal($('.entity-hero .close-up-map'), null);
  assert.ok(weatherRequests.at(-1).aborted);
  cards.refresh();
  await nextTick();
  assert.equal(weatherRequests.length, beforeOff);
  layer.enabled = true;
  notifyLayers();
  cards.refresh();
  await nextTick();
  assert.equal(cards.locationWithheld, false);
  assert.ok($('.spot-conditions'));
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
      records: [{ ...HERE, id: 'inat:1', name: 'Owl', obscured: true }],
    },
  ]);
  const distances = () => {
    const block = [
      ...$('.spot-conditions').querySelectorAll('.nearby-lists [data-row-key]'),
    ];
    return Object.fromEntries(
      block.map((row) => [
        row.querySelector('.nearby-lists__name').textContent,
        row.querySelector('.nearby-lists__meta').textContent,
      ]),
    );
  };
  cards.select({ layerId: 'local-dams', id: 'dam' });
  await nextTick();
  assert.match(distances().Owl, /approximate/);
  assert.equal(distances().Datacenter, '0 m');
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
  cards.setView(localView(center));
  await settleInspectorIndex();
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

test('local Inspect enables Flights on request and distinguishes an empty observation from loading or failure', async (t) => {
  const row = { ...flightsOn([]), enabled: false };
  const { $, cards, pinia, notifyLayers } = fixture(t, [row]);
  const changes = [];
  useOmnibarStore(pinia).connect({
    layers: () => [row],
    setLayer(id, enabled) {
      changes.push([id, enabled]);
      row.enabled = enabled;
      row.stats.loading = true;
      notifyLayers();
      return true;
    },
  });
  cards.setView(localView());
  await settleInspectorIndex();
  const toggle = $('[data-flights-off] button');
  assert.match($('[data-flights-off]').textContent, /Live Flights off/);
  assert.equal(toggle.textContent.trim(), 'Turn on Flights');
  assert.deepEqual(changes, []);
  toggle.focus();
  toggle.click();
  await settleInspectorIndex();
  assert.equal(document.activeElement, $('.view-context'));
  assert.deepEqual(changes, [['flights', true]]);
  const tile = () => $('.view-context__tile[data-layer="flights"]').textContent;
  assert.match(tile(), /Loading/);
  assert.doesNotMatch(tile(), /No nearby aircraft/);
  row.stats = { count: 0, status: 503, error: 'Offline' };
  notifyLayers();
  await settleInspectorIndex();
  assert.doesNotMatch(tile(), /No nearby aircraft/);
  assert.match(tile(), /Unavailable|Offline|Error/i);
  row.stats = { count: 0, lastUpdate: Date.now() };
  notifyLayers();
  await settleInspectorIndex();
  assert.match(tile(), /No nearby aircraft/);
  row.records = [flight('abc123', HERE.lat, HERE.lon)];
  row.stats = { count: 1, lastUpdate: Date.now() + 1 };
  notifyLayers();
  await settleInspectorIndex();
  assert.doesNotMatch(tile(), /No nearby aircraft/);
  assert.match($('.view-context').textContent, /ABC123/);
  row.enabled = false;
  notifyLayers();
  await settleInspectorIndex();
  assert.ok($('[data-flights-off] button'));
  assert.deepEqual(changes, [['flights', true]]);
});

test('ordinary Inspect offers the closest civilian flight with distance before showing an empty local result', async (t) => {
  const layer = flightsOn([
    { ...flight('town01', HERE.lat + 3, HERE.lon), onGround: false },
  ]);
  const { $, cards, flown, followed, notifyLayers } = fixture(t, [
    { id: 'town-parks', name: 'Town parks', enabled: true, records: [] },
    { id: 'town-ponds', name: 'Town ponds', enabled: true, records: [] },
    layer,
  ]);
  setOverheadRangeKm(50);
  cards.setView(localView());
  await settleInspectorIndex();
  const tile = () => $('.view-context__tile[data-layer="flights"]');
  const button = () => $('.nearby-lists button[data-row-layer="flights"]');
  assert.match(tile().getAttribute('aria-label'), /Closest to view · 1$/);
  const tileIds = () =>
    [...document.querySelectorAll('.view-context__tile[data-layer]')].map(
      (el) => el.dataset.layer,
    );
  assert.deepEqual(
    tileIds(),
    ['flights', 'town-parks', 'town-ponds'],
    'places with results precede empty layers in their existing order',
  );
  assert.doesNotMatch(tile().textContent, /No nearby aircraft/);
  assert.match(button().textContent, /TOWN01/);
  assert.equal(
    button().querySelector('.nearby-lists__meta').textContent,
    '334 km',
  );
  assert.equal(cards.card, null);
  assert.deepEqual(flown, []);
  assert.deepEqual(followed, []);

  layer.records = [];
  layer.stats = { count: 0, lastUpdate: layer.stats.lastUpdate + 1 };
  notifyLayers();
  await settleInspectorIndex();
  assert.equal(button(), null);
  assert.match(tile().textContent, /No nearby aircraft/);
});

test('the city flight tile shows the overhead range in the active language', async (t) => {
  const { $, cards } = fixture(t, [
    flightsOn([{ ...flight('near01', HERE.lat, HERE.lon), onGround: false }]),
  ]);
  t.after(() => setLocale('en'));
  setLocale('de');
  setOverheadRangeKm(50);
  cards.setView(localView());
  await settleInspectorIndex();
  const tile = $('.view-context__tile[data-layer="flights"]');
  assert.equal(
    tile.querySelector('.view-context__tile-age').textContent,
    'Überflug innerhalb von 50 km',
  );
});

test('changing the radius leaves visible flights and their counts in place', async (t) => {
  const { $, cards } = fixture(t, [
    flightsOn([flight('far01', 30.65, -97.74)], {
      status: 200,
      coverage: 'worldwide upstream snapshot',
    }),
  ]);
  cards.setView(localView());
  await settleInspectorIndex();
  assert.ok($('.view-context__radius input'), 'city scope offers a radius');
  const previousRadius = contextRadiusKm.value;
  t.after(() => setContextRadiusKm(previousRadius));
  assert.match($('.view-context__tile[data-layer="flights"]').textContent, /1/);
  assert.match($(NEAREST).textContent, /FAR01/);
  // About 42 km away: outside a 25 km radius.
  setContextRadiusKm(25);
  await nextTick();
  assert.match($(NEAREST).textContent, /FAR01/);
  assert.match(
    $('.view-context__tile[data-layer="flights"] strong').textContent,
    /^1$/,
  );
  assert.match($('.view-context__label').textContent, /In view/);
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
  cards.setView(localView());
  await settleInspectorIndex();
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
  await settleInspectorIndex();
  assert.match(
    searchStatus()?.textContent ?? '',
    /Nothing matches.*nomatchxyz/,
  );

  closeContextSearch();
  await settleInspectorIndex();
  assert.equal(count('local-datacenters'), '1');
  assert.match(
    $('[data-row-layer="local-datacenters"]').textContent,
    /Recovered site/,
  );
});

test('a picked item leads with its hero, then its actions; its full details fold away', async (t) => {
  const { $, cards } = fixture(t, [flightsOn([flight('test01', 30.3, -97.7)])]);
  assert.equal(
    cards.select({ layerId: 'flights', id: 'test01' }, { follow: false }),
    true,
  );
  await nextTick();
  const card = $('#entity-card');
  const order = [
    '.entity-hero',
    '.entity-card__head',
    '.entity-card__actions',
  ].map((selector) => {
    const node = card.querySelector(selector);
    assert.ok(node, selector);
    return node;
  });
  for (let index = 1; index < order.length; index++)
    assert.ok(
      order[index - 1].compareDocumentPosition(order[index]) &
        Node.DOCUMENT_POSITION_FOLLOWING,
      'the hero, its name and its actions come first, in that order',
    );
  const more = card.querySelector('.entity-card__more');
  assert.ok(more, 'the full details are there');
  assert.equal(more.open, false, 'the full details start folded');
  assert.ok(
    order[2].compareDocumentPosition(more) & Node.DOCUMENT_POSITION_FOLLOWING,
    'the details come after the actions',
  );
  assert.equal(
    Boolean($('.view-context')),
    false,
    'awareness gives way to the card',
  );
});

// The model view draws the corner icon. Other views and the button row leave it out.
test('TR-3B is never a button, and stays off the views that are not the 3D model', async (t) => {
  await withFleet(t);
  const { $, cards, pinia } = fixture(
    t,
    [flightsOn([flight('test01', 30.3, -97.7)])],
    { previews: STUB_PREVIEWS },
  );
  const cockpit = useCockpitStore(pinia);
  cockpit.publishPresence({ entryAvailable: true, tr3b: { converted: false } });
  cards.select({ layerId: 'flights', id: 'test01' }, { follow: false });
  cards.following = cards.card.key;
  await nextTick();
  assert.equal(
    Boolean($('.entity-card__action--tr3b')),
    false,
    'no TR-3B button in the row',
  );
  const cockpitView = [
    ...document.querySelectorAll(
      '#entity-card .entity-card__preview-switch button',
    ),
  ].find((button) => button.title === 'Cockpit view');
  assert.ok(cockpitView);
  cockpitView.click();
  await nextTick();
  assert.equal(
    Boolean($('.entity-hero__ufo')),
    false,
    'not on the cockpit view',
  );
});

test('a model preview converts and restores the aircraft through its own Cockpit owner', async (t) => {
  await withFleet(t);
  const { $, cards, pinia } = fixture(
    t,
    [flightsOn([flight('test01', 30.3, -97.7)])],
    { previews: STUB_PREVIEWS },
  );
  cards.select({ layerId: 'flights', id: 'test01' }, { follow: false });
  cards.following = cards.card.key;

  const otherPinia = createPinia();
  const otherCards = useEntityCardStore(otherPinia);
  otherCards.connect({ previews: () => STUB_PREVIEWS });
  otherCards.card = cards.card;
  otherCards.following = cards.card.key;
  const host = document.body.appendChild(document.createElement('div'));
  const otherApp = createApp(EntityPreview, {
    card: otherCards.card,
    title: 'Other preview',
  }).use(otherPinia);
  otherApp.mount(host);
  t.after(() => {
    otherApp.unmount();
    otherCards.connect(null);
    host.remove();
  });

  const receiveToggle = (appPinia) => {
    const cockpitStore = useCockpitStore(appPinia);
    const viewer = { scene: {} };
    const { port } = fakeCameraPort();
    const unbind = bindRenderer(viewer, {
      camera: port,
      frame: { on: () => () => {} },
    });
    const coordinator = new CockpitCoordinator({
      viewer,
      cockpitStore,
      services: {},
      readDataManager: () => null,
      readContext: () => null,
    });
    t.after(() => {
      coordinator.stop();
      unbind();
    });
    let converted = false;
    const publish = () => cockpitStore.publishPresence({ tr3b: { converted } });
    publish();
    // Observe the controller before its own eligibility can mask a cross-app call.
    return t.mock.method(coordinator.cockpitView, 'toggleTrackedTr3b', () => {
      converted = !converted;
      publish();
    });
  };
  const origin = receiveToggle(pinia);
  const other = receiveToggle(otherPinia);
  await nextTick();
  $('#entity-card button[title="3D model"]').click();
  await nextTick();
  const button = () => $('#entity-card .entity-hero__ufo');
  assert.equal(button().title, 'Reclassify as TR-3B');
  setActivePinia(otherPinia);
  button().click();
  await nextTick();
  assert.equal(button().title, 'Restore real aircraft');
  setActivePinia(otherPinia);
  button().click();
  await nextTick();
  assert.equal(button().title, 'Reclassify as TR-3B');
  assert.equal(origin.mock.callCount(), 2);
  assert.equal(other.mock.callCount(), 0);
});

test('a local earthquake tile breaks down every counted event inside the viewport', async (t) => {
  const records = [
    { ...HERE, id: 'minor-a', magnitude: 3.1 },
    { ...HERE, id: 'minor-b', magnitude: 3.3 },
    { ...HERE, id: 'moderate', magnitude: 4.4 },
    { ...HERE, id: 'strong', magnitude: 5.2 },
    { ...HERE, lat: HERE.lat + 4, id: 'outside', magnitude: 6.1 },
  ];
  const read = t.mock.fn(() => records);
  const { $, cards } = fixture(t, [
    {
      id: 'earthquakes',
      name: 'Earthquakes',
      enabled: true,
      stats: { count: records.length },
      module: { getAnalystRecords: read },
    },
  ]);
  cards.setView({
    center: HERE,
    heightM: 40_000,
    rect: { west: -98, east: -97, south: 30, north: 31 },
  });
  await settleInspectorIndex();

  const tile = $('.view-context__tile[data-layer="earthquakes"]');
  assert.equal(tile.querySelector('strong').textContent, '4');
  const bar = tile.querySelector('[role="img"].view-context__bar');
  assert.ok(bar, 'the local count includes a breakdown bar');
  const legend = bar.getAttribute('aria-label');
  assert.match(legend, /Below M4 2/);
  assert.match(legend, /M4 to 5 1/);
  assert.match(legend, /M5 to 6 1/);
  assert.doesNotMatch(legend, /M6 and above/);
  assert.equal(read.mock.callCount(), 1);
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
  await settleInspectorIndex();
  const tiles = [
    ...document.querySelectorAll(
      '.view-context__block:not(.context-list-card)',
    ),
  ];
  assert.equal(tiles.length, 1, 'each layer that is on, once');
  assert.equal($('.view-context__label').textContent, 'Layers');
  assert.equal(
    tiles[0].querySelector('.view-context__tile-age').textContent,
    'Loaded',
    'the area feed reports only its loaded sample',
  );
  assert.equal(
    tiles[0].querySelector('strong').textContent,
    '0',
    'neither catalog vessel has a visible record',
  );
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

test('street traffic counts visible road segments at both zoom levels', async (t) => {
  const { $, cards } = fixture(t, [
    {
      id: 'traffic',
      name: 'Street Traffic',
      enabled: true,
      records: [{ id: 'road-a', name: 'Major road', ...HERE }],
      stats: { count: 5 },
    },
  ]);
  cards.setView(localView());
  await settleInspectorIndex();
  const local = $('.view-context__tile[data-layer="traffic"]');
  assert.equal(local.querySelector('strong').textContent, '1');
  assert.match(local.textContent, /Road segments/);
  assert.ok(local.querySelector('[data-row-key="traffic:road-a"]'));
  assert.equal(
    local.querySelector('.nearby-lists__count'),
    null,
    'one road-segment count',
  );
  cards.setView({ center: HERE, heightM: 20_000_000 });
  await settleInspectorIndex();
  const globe = $('.view-context__block[data-layer="traffic"]');
  assert.equal(globe.querySelector('strong').textContent, '1');
  assert.match(globe.textContent, /Road segments/);
});

test('a worldwide count is visible before the local sample index settles', async (t) => {
  const { $, cards, pinia } = fixture(t, [
    flightsOn([flight('near01', HERE.lat, HERE.lon)]),
  ]);
  const counts = useLayerCountsStore(pinia);
  counts.publish({ ...counts.state, counts: { flights: { count: 1700 } } });
  cards.setView({ center: HERE, heightM: 20_000_000 });
  await nextTick();
  const block = $('.view-context__block[data-layer="flights"]');
  assert.equal(block.querySelector('strong').textContent, '1,700');
  assert.match(block.getAttribute('aria-label'), /Total.*1,700/);
  await settleInspectorIndex();
  assert.match(block.textContent, /NEAR01/);

  const totalAge = /Last known 2 h ago/;
  assert.doesNotMatch(block.textContent, /Last known/);
  counts.publish({
    ...counts.state,
    counts: { flights: { count: 1700, at: Date.now() - 2 * 3_600_000 } },
  });
  await nextTick();
  assert.match(block.textContent, totalAge);
  assert.match(block.getAttribute('aria-label'), totalAge);
  counts.publish({
    ...counts.state,
    counts: { flights: { count: 1700, at: Date.now() } },
  });
  await nextTick();
  assert.doesNotMatch(block.textContent, /Last known/);

  t.mock.method(cards, 'inspectorGroups', () => [
    { layerId: 'flights', readFailed: true, count: null, items: [] },
  ]);
  cards.setView({
    center: { ...HERE, lat: HERE.lat + 1 },
    heightM: 20_000_000,
  });
  await nextTick();
  assert.equal(block.querySelector('strong').textContent, '1,700');
  assert.match(
    block.querySelector('[role="status"]').textContent,
    /Loaded · Unavailable/,
  );
  assert.match(block.getAttribute('aria-label'), /Total.*1,700/);
});

test('the globe satellite class bar counts classes in the loaded catalog', async (t) => {
  const satellites = {
    id: 'satellites',
    name: 'Satellites',
    enabled: true,
    records: [
      { id: 'one', satelliteClass: 'Station', ...HERE },
      { id: 'two', satelliteClass: 'Weather', ...HERE },
      {
        id: 'far',
        satelliteClass: 'Science',
        lat: -HERE.lat,
        lon: HERE.lon + 180,
      },
    ],
    stats: { count: 5 },
  };
  const { $, cards, notifyLayers, pinia } = fixture(t, [satellites]);
  cards.setView({ center: HERE, heightM: 20_000_000 });
  await settleInspectorIndex();
  const block = $('.view-context__block[data-layer="satellites"]');
  assert.equal(block.querySelector('strong').textContent, '3');
  assert.equal(block.querySelectorAll('.view-context__bar span').length, 3);
  const legend = block
    .querySelector('.view-context__bar')
    .getAttribute('aria-label');
  assert.match(legend, /Station 1/);
  assert.match(legend, /Weather 1/);
  assert.match(legend, /Science 1/);
  satellites.records.push({ id: 'three', satelliteClass: 'Weather', ...HERE });
  satellites.stats.count++;
  notifyLayers();
  await settleInspectorIndex();
  assert.equal(block.querySelector('strong').textContent, '4');
  assert.match(
    block.querySelector('.view-context__bar').getAttribute('aria-label'),
    /Weather 2/,
  );
  const counts = useLayerCountsStore(pinia);
  counts.publish({ ...counts.state, counts: { satellites: { count: 1000 } } });
  await nextTick();
  assert.equal(block.querySelector('strong').textContent, '1,000');
  assert.match(
    block.querySelector('.view-context__bar').getAttribute('aria-label'),
    /Weather 2/,
  );
  assert.doesNotMatch(block.textContent, /of 1,000 loaded/);
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
  await settleInspectorIndex();
  const block = $('.view-context__block[data-layer="bhote-koshi-locator"]');
  assert.equal(block.querySelector('strong').textContent, '2');
  assert.equal(
    block.querySelector('.view-context__dot').getAttribute('aria-label'),
    'Live',
  );
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
  cards.setView(localView());
  await settleInspectorIndex();
  const feedState = (id) =>
    $(
      `.view-context__tile[data-layer="${id}"] .view-context__dot`,
    ).getAttribute('aria-label');
  assert.equal(feedState('flights'), 'Live', 'a refresh keeps the live state');
  assert.equal(feedState('earthquakes'), 'Loading');
  const problems = [...document.querySelectorAll('.view-context__problem')].map(
    (node) => node.textContent,
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /AISStream/);
  const vessels = '[data-layer="ais-live-vessels"] strong';
  assert.equal($('.view-context__tile' + vessels).textContent, 'Unavailable');
  cards.setView({ center: HERE, heightM: 20_000_000 });
  await settleInspectorIndex();
  assert.equal($('.view-context__block' + vessels).textContent, 'Unavailable');
  const unavailable = $('.view-context__block[data-layer="ais-live-vessels"]');
  for (const label of [
    unavailable.textContent,
    unavailable.getAttribute('aria-label'),
  ]) {
    assert.doesNotMatch(label, /Loaded/);
  }
});

test('an unavailable Mapped Installations tile reports empty scope only after recovery', async (t) => {
  const layer = {
    id: 'military-installations',
    name: 'Mapped Installations',
    enabled: true,
    records: [],
    stats: {
      count: 0,
      status: 'unavailable',
      error: 'Mapped names temporarily unavailable',
      retryAt: Date.now() + 117000,
    },
  };
  const { $, cards, notifyLayers } = fixture(t, [layer]);
  cards.setView({ ...localView(), heightM: 300_000 });
  await settleInspectorIndex();
  const tile = $('.view-context__tile[data-layer="military-installations"]');
  const check = (shown, hidden) => {
    for (const label of [tile.textContent, tile.getAttribute('aria-label')]) {
      assert.match(label, shown);
      assert.doesNotMatch(label, hidden);
    }
  };
  check(/Unavailable/, /None in view/);
  layer.stats = {
    count: 0,
    loading: true,
    status: 'loading',
    statusMessage: 'Loading',
  };
  notifyLayers();
  await settleInspectorIndex();
  check(/Loading/, /None in view/);
  layer.stats = { count: 0, lastUpdate: Date.now() };
  notifyLayers();
  await settleInspectorIndex();
  check(/None in view/, /Unavailable|Loading/);
});

test('a weather feed problem keeps its registered or verbatim provider', async (t) => {
  const layer = {
    id: 'weather-radar',
    name: 'Weather Radar',
    enabled: true,
    source: 'RainViewer',
    stats: { stale: true, sourceVerbatim: true, source: '' },
  };
  const { $, cards, notifyLayers } = fixture(t, [layer]);
  cards.setView(localView());
  await nextTick();
  const problem = () => $('.view-context__problem').textContent;
  assert.match(problem(), /RainViewer/);
  setLocale('de');
  t.after(() => setLocale('en'));
  layer.stats = { ...layer.stats, source: 'Local' };
  notifyLayers();
  await nextTick();
  assert.match(problem(), /Local/);
  assert.doesNotMatch(problem(), /RainViewer/);
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
  cards.setView(localView());
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
  assert.ok(facts.some((fact) => /Elevation.*149/.test(fact)));
  cards.setView(localView());
  await nextTick();
  assert.doesNotMatch(
    $('.view-context__tiles--facts').textContent,
    /Elevation/,
  );
  assert.equal($('.view-context__suggest-item')?.dataset.layer, 'flights');
  assert.match(
    $('.view-context__suggest-open').textContent,
    /See them in Data Layers/,
  );
  assert.equal(
    $('.view-context__pointer:not(.view-context__suggest-open)'),
    null,
  );
  assert.equal(cards.layerOff('flights'), true);
  assert.equal(
    Boolean($('.view-context__radius')),
    false,
    'no radius with nothing to count',
  );
  cards.setView({ center: HERE, heightM: 20_000_000 });
  await nextTick();
  // With no other eligible layers, Flights is also suggested at globe scale.
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
  style.textContent = fs
    .readFileSync(new URL('./styles/context-dock.css', import.meta.url), 'utf8')
    .replace(/\s+/g, ' ');
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
  cards.setView(localView());
  await settleInspectorIndex();
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

test('keyboard selection of a summary row returns focus to that row', async (t) => {
  const area = {
    key: 'gnss-integrity:cell-a',
    text: '3 of 4 aircraft',
    lat: 33.1,
    lon: 35.2,
  };
  const { $, cards } = fixture(t, [
    {
      ...fieldLayer('gnss-integrity', 'GNSS integrity', () => null),
      module: {
        getContextPopulation: () => [area],
        getContextSummary: () => ({ items: [area] }),
      },
    },
  ]);
  cards.setView({ center: HERE, heightM: 20_000_000 });
  await settleInspectorIndex();
  const row = $('.view-context__summary-rows button');
  row.focus();
  row.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
  await nextTick();
  await nextTick();
  const close = $('button[aria-label="Close card"]');
  assert.equal(document.activeElement, close);
  close.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
  await nextTick();
  await nextTick();
  assert.equal(
    document.activeElement.dataset.rowKey,
    'summary:gnss-integrity:gnss-integrity:cell-a',
  );
});

for (const phone of [false, true]) {
  test(`a new pick resets the ${phone ? 'phone' : 'desktop'} scroll owner without moving it on refresh or close`, async (t) => {
    const { $, cards } = fixture(t, [
      flightsOn([flight('test01', 30.3, -97.7), flight('test02', 30.4, -97.7)]),
    ]);
    if (phone) {
      document.body.classList.add('mobile-shell');
      document.body.dataset.mobileSheet = 'context';
      t.after(() => {
        document.body.classList.remove('mobile-shell');
        delete document.body.dataset.mobileSheet;
      });
    }

    cards.setView(localView());
    await settleInspectorIndex();
    const owner = phone
      ? $('#right-context-rail')
      : $('.global-context-panel-inner');
    const body = $('.cyber-panel-body');
    const reset = t.mock.method(owner, 'scrollTo', ({ top }) => {
      owner.scrollTop = top;
    });
    const bodyReset = t.mock.method(body, 'scrollTo');
    owner.scrollTop = 170;
    const pick = $('.nearby-lists button[data-row-key]');
    assert.ok(pick, 'a real Nearby row');
    pick.click();
    await nextTick();
    await turn();
    assert.ok($('#entity-card'));
    assert.equal(owner.scrollTop, 0);
    assert.equal(reset.mock.callCount(), 1);
    assert.equal(bodyReset.mock.callCount(), 0);

    owner.scrollTop = 130;
    cards.refresh();
    cards.select(cards.card.identity, { follow: false });
    await nextTick();
    await turn();
    assert.equal(owner.scrollTop, 130);
    assert.equal(reset.mock.callCount(), 1);

    $('.entity-card__close').click();
    await nextTick();
    await turn();
    assert.equal(cards.card, null);
    assert.equal(reset.mock.callCount(), 1);
  });
}

test('reselecting the same aircraft by voice brings its card back from Pinned', async (t) => {
  const { $, cards, pinia } = fixture(t, [
    flightsOn([flight('test01', 30.3, -97.7)]),
  ]);
  const identity = { layerId: 'flights', id: 'test01' };
  cards.select(identity, { follow: false });
  await nextTick();
  $('.entity-card__action--pin').click();
  await nextTick();
  $('#context-tab-pinned').click();
  await nextTick();
  assert.equal($('#entity-card'), null);
  cards.refresh();
  await nextTick();
  assert.equal($('#entity-card'), null, 'a refresh leaves the tab alone');
  const opener = createContextCardOpener(pinia);
  assert.equal(opener.show(identity, { since: opener.generation() }), true);
  await nextTick();
  assert.equal($('#context-tab-inspect').getAttribute('aria-selected'), 'true');
  assert.ok($('#entity-card'));
});

test('a keyboard-picked coverage line keeps its feed, details and return focus when its photo arrives', async (t) => {
  const line = {
    id: 'near:mapillary:30.300000,-97.740000:line',
    name: 'Mapillary',
    providerId: 'mapillary',
    sequenceId: 'line',
    ...HERE,
  };
  let viewLine = line;
  const photo = { id: 'mapillary:photo', name: 'Congress Avenue', ...HERE };
  const { $, cards } = fixture(t, [
    {
      id: 'street-level',
      name: 'Street Level',
      enabled: true,
      stats: { count: 0 },
      module: {
        getAnalystRecords: () => [photo],
        getRecordsNear: () => [line],
        getViewRecords: (_, area) => (area?.rect ? [viewLine, photo] : [photo]),
      },
    },
  ]);
  cards.setView({
    center: HERE,
    heightM: 200_000,
    rect: {
      west: -98,
      south: 29,
      east: -97,
      north: 31,
    },
  });
  await settleInspectorIndex();
  const row = $(
    '.nearby-lists[aria-label="In view"] [data-row-key*="near:mapillary:"]',
  );
  assert.ok(row, 'the drawn line is available in the viewport group');
  const rowKey = row.dataset.rowKey;
  row.focus();
  row.click();
  await nextTick();
  await nextTick();
  cards.refresh();
  assert.equal(cards.lost, false);
  assert.equal($('.entity-card__source-line').textContent.trim(), 'Mapillary');
  const close = $('.entity-card__close');
  assert.equal(document.activeElement, close);
  const details = $('.entity-card__more');
  if (details) details.open = true;
  cards.advance({ layerId: 'street-level', id: photo.id });
  await nextTick();
  if (details) assert.equal($('.entity-card__more'), details);
  viewLine = {
    ...line,
    id: 'near:mapillary:30.301000,-97.740000:line',
    lat: 30.301,
  };
  cards.setView({
    ...cards.view,
    center: { ...HERE, lat: HERE.lat + 0.01 },
  });
  close.click();
  await settleInspectorIndex();
  await nextTick();
  assert.equal(document.activeElement.dataset.rowKey, rowKey);
  cards.setView({ center: HERE, heightM: 20_000_000 });
  await settleInspectorIndex();
  assert.equal(
    $('.view-context__block[data-layer="street-level"] strong').textContent,
    '1',
    'globe tile counts remembered photos',
  );
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
  await settleInspectorIndex();
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
    'Unavailable',
  );
  assert.equal(status(), undefined);

  contextSearchOpen.value = true;
  contextSearchText.value = 'est dam';
  await nextTick();
  assert.match(status(), /^Unavailable layers: .*Dam/i);
  assert.deepEqual(names(), []);

  site.enabled = true;
  notifyLayers();
  await settleInspectorIndex();
  assert.match(status(), /^Unavailable layers: .*Dam/i);
  assert.deepEqual(names(), ['Test dam control site']);

  recovered = true;
  t.mock.timers.tick(INSPECTOR_PULSE_MS);
  await settleInspectorIndex();
  assert.equal(status(), undefined);
  assert.deepEqual(names(), ['Test dam', 'Test dam control site']);

  contextSearchText.value = 'nomatchxyz';
  await nextTick();
  assert.equal(status(), '0 results');
  assert.deepEqual(names(), []);
});

test('Context search leaves the Data Layers action available with all layers off', async (t) => {
  contextSearchStyles(t);
  const layer = {
    ...flightsOn([
      flight('paris', HERE.lat, HERE.lon),
      flight('lyon', HERE.lat, HERE.lon),
    ]),
    enabled: false,
  };
  const { $, cards, pinia, notifyLayers } = fixture(t, [layer]);
  const open = t.mock.method(usePanelChromeStore(pinia), 'act');
  cards.setView({ center: HERE, heightM: 20_000_000 });
  await nextTick();
  const selectors = [
    '.view-context__tiles--facts',
    '.view-context__camera',
    '.view-context__suggest',
  ];
  $('[aria-label="Search in Context"]').click();
  await nextTick();
  await nextTick();
  const input = $('.context-search__input');
  assert.ok(document.activeElement === input);
  const type = () => {
    input.value = 'paris';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  type();
  await nextTick();
  assert.ok($('#context-body').classList.contains('context-searching'));
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
  $('.context-search__clear').click();
  await nextTick();
  for (const selector of selectors)
    assert.notEqual(getComputedStyle($(selector)).display, 'none', selector);
  layer.enabled = true;
  notifyLayers();
  cards.setView(localView());
  type();
  await settleInspectorIndex();
  const matches = document.querySelectorAll('[data-row-layer="flights"]');
  assert.equal(matches.length, 1);
  assert.match(matches[0].textContent, /PARIS/);
});

test('a nearest vessel is flown to, since it cannot be followed', async (t) => {
  const { $, cards, followed, flown } = fixture(t, [
    {
      id: 'ais-live-vessels',
      name: 'Live Vessels',
      enabled: true,
      records: [
        { id: 'boat01', mmsi: 'boat01', name: 'BOAT', lat: 30.28, lon: -97.74 },
      ],
    },
  ]);
  cards.setView(localView());
  await settleInspectorIndex();
  $(NEAREST).click();
  await nextTick();
  assert.equal(cards.card?.identity.id, 'boat01');
  assert.deepEqual(followed, []);
  assert.deepEqual(flown, [cards.card.key]);
});

test('the nearby lists follow the Context search', async (t) => {
  contextSearchStyles(t);
  const { $, cards } = fixture(t, [
    flightsOn([flight('near01', 30.31, -97.74)]),
  ]);
  cards.setView(localView());
  await settleInspectorIndex();
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
  assert.equal(
    $('.view-context__radius input').getAttribute('aria-label'),
    'Overhead range',
  );
  assert.notEqual(getComputedStyle($('.nearby-lists')).display, 'none');
});

test('More details starts folded for every new pick', async (t) => {
  const { $, cards } = fixture(t, [
    flightsOn([flight('test01', 30.3, -97.7), flight('test02', 30.4, -97.7)]),
  ]);
  cards.select({ layerId: 'flights', id: 'test01' }, { follow: false });
  await nextTick();
  $('.entity-card__more').open = true;
  cards.select({ layerId: 'flights', id: 'test02' }, { follow: false });
  await nextTick();
  assert.equal($('.entity-card__more').open, false);
});

test('Pin adds Inspect and Pinned tabs; a pin opens on Inspect; unpinning the last removes the tabs', async (t) => {
  const { $, cards, pinia } = fixture(t, [
    flightsOn([flight('test01', 30.3, -97.7), flight('test02', 30.4, -97.7)]),
  ]);
  const pinned = usePinnedStore(pinia);
  cards.select({ layerId: 'flights', id: 'test01' }, { follow: false });
  await nextTick();
  assert.equal(
    Boolean($('.context-pin-tabs')),
    false,
    'no tabs with nothing pinned',
  );
  const pin = $('.entity-card__action--pin');
  assert.ok(pin, 'Pin is among the actions');
  assert.equal(
    Boolean($('.entity-hero .entity-card__action--pin')),
    false,
    'never on the hero',
  );
  pin.click();
  await nextTick();
  assert.ok($('#context-tab-inspect') && $('#context-tab-pinned'));
  assert.match($('#context-tab-pinned').textContent, /Pinned · 1/);
  assert.equal($('#context-tab-inspect').getAttribute('aria-selected'), 'true');
  $('#context-tab-pinned').click();
  await nextTick();
  assert.equal(
    Boolean($('#entity-card')),
    false,
    'Pinned shows the grid, not the card',
  );
  assert.equal(
    document.querySelectorAll('.pinned-grid__tile').length,
    1,
    'one tile, no empty slots',
  );
  // A new pick shows on Inspect.
  cards.select({ layerId: 'flights', id: 'test02' }, { follow: false });
  await nextTick();
  assert.equal(pinned.tab, 'inspect');
  assert.equal(cards.card.identity.id, 'test02');
  // Tapping a pin selects it and switches to Inspect; the pin stays.
  pinned.show('pinned');
  await nextTick();
  $('.pinned-grid__open').click();
  await nextTick();
  assert.equal(cards.card.identity.id, 'test01');
  assert.equal(pinned.tab, 'inspect');
  assert.equal(pinned.pins.length, 1);
  pinned.unpin(pinned.pins[0].key);
  await nextTick();
  assert.equal(Boolean($('.context-pin-tabs')), false);
  // The last pin gone takes the tabs with it, but its Undo stays in reach.
  const undo = $('.pin-undo-notice button');
  assert.ok(undo, 'Undo is offered after the last unpin');
  undo.click();
  await nextTick();
  assert.equal(pinned.pins.length, 1, 'Undo puts it back');
  pinned.unpin(pinned.pins[0].key);
});

// A pinned place wears its card map's marker, an amber ring around its
// glyph (the airport glyph for an airport, a pin otherwise), apart from the
// items pinned beside it, which wear the sprite the map drew them with.
test('pinned places wear their place marker; pinned aircraft keep the plane', async (t) => {
  const { $, pinia } = fixture(t, [flightsOn([])]);
  const pinned = usePinnedStore(pinia);
  const airport = {
    ident: 'KDCA',
    iata: 'DCA',
    name: 'Ronald Reagan Washington National Airport',
    lat: 38.8521,
    lon: -77.0377,
  };
  pinned.pin(placePin(placeIdentity({ airport }), airport.name));
  pinned.pin(
    placePin(
      placeIdentity({
        name: 'Austin',
        lat: 30.27,
        lon: -97.74,
        from: 'search',
      }),
      'Austin',
    ),
  );
  pinned.pin({
    key: 'flights:n8832j',
    kind: 'item',
    title: 'N8832J',
    icon: 'flight',
    mark: 'helicopter',
    still: '/still/n.png',
    identity: { layerId: 'flights', id: 'n8832j' },
  });
  t.after(() =>
    pinned.pins.map((pin) => pin.key).forEach((key) => pinned.unpin(key)),
  );
  pinned.show('pinned');
  await nextTick();
  const tiles = [...document.querySelectorAll('.pinned-grid__tile')].map(
    (tile) => {
      const icon = tile.querySelector('.pinned-grid__icon');
      return [
        tile.textContent.includes('N8832J')
          ? 'aircraft'
          : tile.textContent.includes('Austin')
            ? 'place'
            : 'airport',
        icon.style.getPropertyValue('--mark') || icon.textContent.trim(),
        icon.classList.contains('pinned-grid__icon--place'),
      ];
    },
  );
  assert.deepEqual(tiles.sort(), [
    ['aircraft', `url("${aircraftIcon('helicopter')}")`, false],
    ['airport', 'local_airport', true],
    ['place', 'location_on', true],
  ]);
  assert.ok($('.pinned-grid__icon--place'));
});

test('pins have no limit: a fifth keeps all five, the grid holds them all, and Undo on unpin puts one back', async (t) => {
  const { $, pinia } = fixture(t, [flightsOn([])]);
  const pinned = usePinnedStore(pinia);
  const item = (n) => ({
    key: `flights:${n}`,
    kind: 'item',
    title: `ITEM${n}`,
    icon: 'flight',
    still: `/still/${n}.png`,
    identity: { layerId: 'flights', id: String(n) },
  });
  for (const n of [1, 2, 3, 4, 5, 6]) pinned.pin(item(n));
  t.after(() =>
    pinned.pins.map((pin) => pin.key).forEach((key) => pinned.unpin(key)),
  );
  await nextTick();
  assert.deepEqual(
    pinned.pins.map((pin) => pin.title),
    ['ITEM1', 'ITEM2', 'ITEM3', 'ITEM4', 'ITEM5', 'ITEM6'],
    'nothing made room',
  );
  assert.equal(
    Boolean($('.context-pin-notice')),
    false,
    'no replaced-the-oldest notice',
  );
  pinned.show('pinned');
  await nextTick();
  assert.equal(document.querySelectorAll('.pinned-grid__tile').length, 6);
  assert.match($('.pinned-grid__title').textContent, /Pinned · 6/);
  assert.doesNotMatch(
    $('.pinned-grid__title').textContent,
    /of/,
    'no cap in the title',
  );
  // Unpinning says what went and offers Undo, which puts it back where it was.
  document.querySelectorAll('.pinned-grid__unpin')[2].click();
  await nextTick();
  assert.equal(pinned.pins.length, 5);
  assert.match($('.pin-undo-notice').textContent, /Unpinned ITEM3/);
  $('.pin-undo-notice button').click();
  await nextTick();
  assert.deepEqual(
    pinned.pins.map((pin) => pin.title),
    ['ITEM1', 'ITEM2', 'ITEM3', 'ITEM4', 'ITEM5', 'ITEM6'],
  );
  assert.equal(pinned.stillOf('flights:3'), '/still/3.png', 'with its still');
  assert.equal(Boolean($('.pin-undo-notice')), false);
});

test('Esc anywhere in Context clears the pick first, then the search (text kept); pins stay', async (t) => {
  const { $, cards, pinia } = fixture(t, [
    flightsOn([flight('test01', 30.3, -97.7)]),
  ]);
  const pinned = usePinnedStore(pinia);
  pinned.pin({
    key: 'flights:x',
    kind: 'item',
    title: 'X',
    icon: 'flight',
    identity: { layerId: 'flights', id: 'x' },
  });
  t.after(() => pinned.unpin('flights:x'));
  cards.select({ layerId: 'flights', id: 'test01' }, { follow: false });
  contextSearchOpen.value = true;
  contextSearchText.value = 'swa';
  await nextTick();
  // From the search field, the pick still goes first.
  assert.equal(escKey($('.context-search__input')), true);
  await nextTick();
  assert.equal(cards.card, null, 'the pick goes first');
  assert.equal(contextSearchOpen.value, true);
  // From a header button, the search closes next and keeps its text.
  assert.equal(escKey($('#global-context-panel .context-dock-btn')), true);
  assert.equal(contextSearchOpen.value, false, 'then the search');
  assert.equal(contextSearchText.value, 'swa', 'its text is kept');
  assert.equal(
    escKey($('#global-context-panel .cyber-panel-body')),
    false,
    'then the panel may collapse',
  );
  assert.equal(pinned.pins.length, 1, 'pins stay');
});

function escKey(target) {
  const event = new KeyboardEvent('keydown', {
    key: 'Escape',
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

// The pick is cleared only where it shows: on Lists or Pinned it is out of
// view, so Esc there leaves it.
test('Esc on the Lists or the Pinned tab leaves the pick; on Inspect it clears it', async (t) => {
  const { $, cards, pinia } = fixture(t, [
    flightsOn([flight('test01', 30.3, -97.7)]),
  ]);
  t.after(resetContextLists);
  const pinned = usePinnedStore(pinia);
  pinned.pin({
    key: 'flights:x',
    kind: 'item',
    title: 'X',
    icon: 'flight',
    identity: { layerId: 'flights', id: 'x' },
  });
  t.after(() => pinned.unpin('flights:x'));
  cards.select({ layerId: 'flights', id: 'test01' }, { follow: false });
  await nextTick();
  const searchButton = () => $('[aria-label="Search in Context"]');
  searchButton().click();
  contextSearchText.value = 'training';
  await nextTick();
  await nextTick();
  assert.ok(document.activeElement === $('.context-search__input'));
  pinned.show('pinned');
  await nextTick();
  await nextTick();
  assert.ok(!searchButton(), 'Pinned has no Inspect search button');
  assert.ok(!$('.context-search__input'), 'Pinned has no Inspect search field');
  assert.ok(document.activeElement === $('#context-tab-pinned'));
  assert.equal($('#context-tab-pinned').getAttribute('aria-selected'), 'true');
  assert.equal(
    escKey($('#context-tab-pinned')),
    false,
    'nothing for Context to do on Pinned',
  );
  assert.equal(
    cards.card?.identity.id,
    'test01',
    'the pick stays while Pinned shows',
  );
  setContextListPresence('weather', { count: 2 });
  showContextList('weather');
  await nextTick();
  assert.equal($('#context-tab-lists').getAttribute('aria-selected'), 'true');
  assert.equal(
    escKey($('#weather-panel-body')),
    false,
    'nothing for Context to do on Lists',
  );
  assert.equal(
    cards.card?.identity.id,
    'test01',
    'the pick stays while a list shows',
  );
  assert.ok(!searchButton(), 'Lists has no Inspect search button');
  assert.ok(!$('.context-search__input'), 'Lists has no Inspect search field');
  assert.equal(contextSearchOpen.value, true, 'the Inspect query is retained');
  $('#context-tab-inspect').click();
  await nextTick();
  assert.equal($('.context-search__input').value, 'training');
  assert.equal(escKey($('#context-tab-inspect')), true);
  assert.equal(cards.card, null, 'on Inspect the pick clears');
});

// Folded, Context shows neither the pick nor the search: its Esc leaves both.
test('Esc on a folded Context leaves the pick it does not show', async (t) => {
  const { $, cards, close } = fixture(t, [
    flightsOn([flight('test01', 30.3, -97.7)]),
  ]);
  cards.select({ layerId: 'flights', id: 'test01' }, { follow: false });
  await nextTick();
  close();
  await nextTick();
  const title = $('#global-context-panel .context-title-open');
  assert.ok(title, 'Context is folded');
  assert.equal(escKey(title), false, 'nothing for Context to do');
  assert.equal(cards.card?.identity.id, 'test01', 'the pick stays');
});

/** Recent Imagery's real readout and layer, in Context's list body. */
async function recentImageryInContext(t) {
  const timers = manualTimers();
  const catalog = fakeCatalog();
  const layer = createRecentImageryLayer({
    catalog,
    renderer: fakeRenderer(),
    thumbnails: fakeThumbnails(),
    host: () => ({ collection: {}, kind: 'globe' }),
    now: () => new Date('2026-09-21T15:00:00Z'),
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
  });
  layer.setSources({ viirs: true });
  const viewer = {
    camera: {},
    scene: { canvas: { clientWidth: 1000 }, requestRender() {} },
  };
  bindFakeCesiumCamera(viewer, { globe: fakeGlobePort() });
  // The layer panel updates the readout on the frame after the layer
  // invalidates it; here it updates at once.
  let readout = null;
  layer.init(viewer, { panel: { invalidate: () => readout?.update() } });
  layer.attachMapStackController(fakeController());
  let active = false;
  const tool = {
    start() {
      active = true;
      layer.setToolActive(true);
    },
    cancel() {
      active = false;
      layer.setToolActive(false);
    },
    isActive: () => active,
  };
  readout = createRecentImageryPanel({
    container: document.getElementById('recent-imagery-panel-body'),
    layer,
    viewer,
    tool,
    createSplit: () => ({ setValue() {}, destroy() {} }),
    fetchImpl: async () => new Response(''),
  });
  t.after(() => {
    readout.destroy?.();
    resetContextLists();
  });
  layer.enable();
  layer.setBox(BOX);
  catalog.resolveLast();
  await settleImagery();
  await nextTick();
  return { layer, tool, readout };
}

test('Recent Imagery consumes Escape only while its box tool or preview is active', async (t) => {
  const { $, cards } = fixture(t, [flightsOn([flight('test01', 30.3, -97.7)])]);
  cards.select({ layerId: 'flights', id: 'test01' }, { follow: false });
  await nextTick();
  const { layer, tool, readout } = await recentImageryInContext(t);
  showContextList('recent-imagery');
  contextSearchOpen.value = true;
  await nextTick();
  const root = readout.root;
  // A day's row, where the keyboard is in the list.
  const strip = root.querySelector('.ri-card-open');
  assert.ok(root.closest('#global-context-panel'), 'the readout is in Context');
  // Previewing a day (the first day shows at once): Esc from elsewhere in
  // the readout clears the preview and nothing else.
  assert.ok(layer.getSnapshot().preview.key, 'a day is previewed');
  assert.equal(root.hasAttribute('data-owns-escape'), true);
  assert.equal(escKey(root.querySelector('#ri-opacity')), true);
  assert.equal(layer.getSnapshot().preview.key, null, 'the preview is cleared');
  assert.equal(contextSearchOpen.value, true, 'the search stays open');
  assert.equal(cards.card?.identity.id, 'test01', 'the pick stays');
  await nextTick();
  assert.equal(
    root.hasAttribute('data-owns-escape'),
    false,
    'idle, Esc is not its own',
  );
  // Drawing a box: Esc on a day’s row cancels the tool and nothing else.
  tool.start();
  await nextTick();
  assert.equal(root.hasAttribute('data-owns-escape'), true);
  assert.equal(escKey(strip), true);
  assert.equal(tool.isActive(), false, 'the box tool is cancelled');
  assert.equal(contextSearchOpen.value, true, 'the search stays open');
  // The list has no search field. Once idle, it leaves Escape to the outer panel.
  assert.equal($('.context-search__input'), null);
  await nextTick();
  assert.equal(root.hasAttribute('data-owns-escape'), false);
  strip.focus();
  let blurred = 0;
  strip.addEventListener('blur', () => blurred++);
  assert.equal(escKey(strip), false);
  assert.equal(
    contextSearchOpen.value,
    true,
    'the hidden Inspect search is preserved',
  );
  assert.equal(blurred, 0, 'the row keeps focus');
  assert.equal(
    cards.card?.identity.id,
    'test01',
    'the pick, out of view on Lists, stays',
  );
});

test('Esc while typing a camera calibration value cancels the edit and keeps the card', async (t) => {
  const camera = { id: 'cam1', name: 'I-35 @ 12th', lat: 30.27, lon: -97.73 };
  const { $, cards, pinia } = fixture(t, [
    {
      id: 'cctv',
      name: 'Cameras',
      enabled: true,
      records: [camera],
      module: {
        frameUrlForCamera: (id) => ({
          url: `/frame/${id}.jpg`,
          refreshMs: 10_000,
        }),
      },
    },
  ]);
  const cctv = useCctvStore(pinia);
  cctv.publish(
    presentCctvPanel({ enabled: true, activeCameraId: 'cam1' }, true),
  );
  cards.select({ layerId: 'cctv', id: 'cam1' }, { fly: false });
  await nextTick();
  $('#context-tab-camera').click();
  await nextTick();
  await nextTick();
  const finished = [];
  cctv.setCalEdit({
    field: 'heading',
    label: 'HDG ',
    ariaLabel: 'Heading',
    step: '1',
    value: '90',
    finish: (commit) => finished.push(commit),
  });
  await nextTick();
  const input = $('#context-tab-panel .cctv-cal-input');
  assert.ok(input, 'the value is being typed in the Camera settings tab');
  // Vue ignores an event stamped in the same millisecond its listener was
  // attached; a person never types that fast.
  await new Promise((resolve) => setTimeout(resolve, 5));
  escKey(input);
  assert.deepEqual(finished, [false], 'the edit is cancelled');
  assert.equal(cards.card?.identity.id, 'cam1', 'the camera card stays');
  // The card is out of view on Camera settings, so Esc there leaves it; on
  // Inspect it clears the pick.
  assert.equal(escKey($('#context-tab-camera')), false);
  assert.equal(cards.card?.identity.id, 'cam1');
  $('#context-tab-inspect').click();
  await nextTick();
  assert.equal(escKey($('#context-tab-inspect')), true);
  assert.equal(cards.card, null);
});

test('clearing the pick from inside its card keeps focus in Context', async (t) => {
  const { $, cards } = fixture(t, [flightsOn([flight('test01', 30.3, -97.7)])]);
  cards.select({ layerId: 'flights', id: 'test01' }, { follow: false });
  await nextTick();
  const button = $('.entity-card__action--pin');
  button.focus();
  escKey(button);
  await nextTick();
  assert.equal(cards.card, null);
  assert.equal(
    document.activeElement,
    $('#global-context-panel .cyber-panel-body'),
    'focus moves to the panel body, ahead of the card leaving',
  );
});

/**
 * A Radio layer module double: two stations near Austin, one far away. It
 * plays as the layer does: playStation works with the layer off, pause
 * keeps the station, stop lets it go, and turning off (`turnOff`, as Clear
 * all or Radio off do) keeps only a stream the player asked to keep.
 */
function radioLayer({ playing = null } = {}) {
  const stations = [
    {
      id: 'kut',
      name: 'KUT 90.5',
      lat: 30.28,
      lon: -97.74,
      tags: ['news'],
      state: 'Texas',
      country: 'US',
    },
    { id: 'kutx', name: 'KUTX 98.9', lat: 30.3, lon: -97.7, tags: ['music'] },
    { id: 'far', name: 'FAR FM', lat: 40.7, lon: -74, tags: ['talk'] },
  ];
  const listeners = new Set();
  const calls = [];
  let keep = null;
  const derive = (next) => ({
    ...next,
    playingStation:
      stations.find((station) => station.id === next.playingStationId) || null,
    filteredCount: next.filteredCount ?? stations.length,
  });
  let state = derive({
    enabled: true,
    filter: 'all',
    categories: [
      { id: 'all', label: 'All' },
      { id: 'news', label: 'News' },
    ],
    presentationActive: true,
    acceptedCatalogGeneration: 1,
    selected: stations[0],
    audioState: playing ? 'playing' : 'stopped',
    playingStationId: playing,
    volume: 0.8,
  });
  const radio = {
    calls,
    stations,
    subscribe(listener) {
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },
    emit(patch) {
      state = derive({ ...state, ...patch });
      for (const listener of listeners) listener(state);
    },
    state: () => state,
    getUIState: () => state,
    getRadioAcceptedCatalogSnapshot: () => ({ stations }),
    filterRadioStations: (all) => all,
    selectStation(id, options) {
      calls.push(['select', id, options?.autoplay ?? false]);
      const station = stations.find((each) => each.id === id);
      if (!station) return false;
      radio.emit(
        options?.autoplay
          ? { selected: station, audioState: 'loading', playingStationId: id }
          : { selected: station },
      );
      return true;
    },
    playStation(id) {
      calls.push(['play', id]);
      const station = stations.find((each) => each.id === id);
      if (!station) return false;
      radio.emit({
        selected: station,
        audioState: 'loading',
        playingStationId: id,
      });
      return true;
    },
    pause() {
      calls.push(['pause']);
      radio.emit({ audioState: 'paused' });
      return true;
    },
    togglePlayback: () => calls.push(['toggle']),
    stopPlayback() {
      calls.push(['stop']);
      radio.emit({ audioState: 'stopped', playingStationId: null });
    },
    cycleStation(direction, { stationIds, autoplay }) {
      calls.push(['cycle', direction, stationIds, autoplay]);
      return true;
    },
    stepStationWhileOff(direction) {
      calls.push(['step', direction]);
      return true;
    },
    keepStreamWhenOff: (predicate) => (keep = predicate),
    /** Radio turning off as the layer does: a kept stream plays on. */
    turnOff() {
      const kept =
        state.playingStationId && keep?.(state.playingStationId) === true;
      radio.emit({
        enabled: false,
        presentationActive: false,
        ...(kept ? {} : { audioState: 'stopped', playingStationId: null }),
      });
    },
  };
  return radio;
}

test('Radio on: its loaded stations show in one shared list card with the tuner; only the selected one can be pinned', async (t) => {
  const radio = radioLayer();
  const { $, cards, pinia, close } = fixture(t, [
    { id: 'radio', name: 'Radio', enabled: true, records: [] },
  ]);
  const dm = cards.layerModule;
  cards.layerModule = (id) => (id === 'radio' ? radio : dm(id));
  cards.setView(localView());
  await nextTick();
  await turn();
  await nextTick();
  const list = $('[data-list-card=radio]');
  const rows = [...list.querySelectorAll('[data-list-key]')];
  assert.deepEqual(
    rows.map((row) => row.dataset.listKey),
    ['kut', 'kutx', 'far'],
  );
  assert.match(rows[0].textContent, /KUT 90\.5/);
  assert.equal(
    document.querySelectorAll('.radio-stations .entity-card__action--pin')
      .length,
    1,
    'one Pin, on the selected station',
  );
  assert.ok(
    list.querySelector('#radio-fold-slot #radio-panel'),
    'the fold is in the shared card',
  );
  assert.ok(
    rows.at(-1).compareDocumentPosition($('#radio-panel')) &
      Node.DOCUMENT_POSITION_FOLLOWING,
    'the tuner follows the station rows',
  );
  rows[1].focus();
  rows[1].click();
  assert.deepEqual(
    radio.calls.at(-1),
    ['select', 'kutx', true],
    'a row plays its station',
  );
  await nextTick();
  assert.equal(document.activeElement, rows[1]);
  assert.equal(
    rows[1].querySelector('[aria-current]')?.getAttribute('aria-current'),
    'true',
  );
  $('.radio-stations .entity-card__action--pin').click();
  await nextTick();
  const pinned = usePinnedStore(pinia);
  t.after(() => pinned.unpin('radio:kutx'));
  assert.deepEqual(
    pinned.pins.map((pin) => [pin.key, pin.kind]),
    [['radio:kutx', 'station']],
  );
  // Closing Context takes the list away; the fold goes back to its home.
  close();
  await nextTick();
  await nextTick();
  assert.ok(
    $('.radio-fold-home > #radio-panel'),
    'the fold is back in the page',
  );
});

async function radioWithStations(t, count) {
  resetListCardMemory();
  t.after(resetListCardMemory);
  const radio = radioLayer();
  for (let i = radio.stations.length; i < count; i++)
    radio.stations.push({
      id: `near${i}`,
      name: `Near ${i}`,
      lat: 30.27 + i * 0.01,
      lon: -97.74,
      tags: ['music'],
    });
  const fixed = fixture(t, [
    { id: 'radio', name: 'Radio', enabled: true, records: [] },
  ]);
  const dm = fixed.cards.layerModule;
  fixed.cards.layerModule = (id) => (id === 'radio' ? radio : dm(id));
  fixed.cards.setView(localView());
  await nextTick();
  await turn();
  await nextTick();
  return { ...fixed, radio };
}

test('Radio pages the full catalog at each zoom and preserves the focused row when the view moves', async (t) => {
  const { $, cards, radio } = await radioWithStations(t, 12);
  const list = $('[data-list-card=radio]');
  const rows = () => [...list.querySelectorAll('[data-list-key]')];
  const keys = () => rows().map((row) => row.dataset.listKey);
  const range = () => list.querySelector('[data-list-range]').textContent;
  assert.deepEqual(keys(), ['kut', 'kutx', 'far', 'near3', 'near4']);
  assert.match(list.querySelector('h4').textContent, /12/);
  assert.equal(range(), '1–5 of 12');
  rows()[2].focus();
  for (const heightM of [120_000, 20_000_000, 5_000]) {
    cards.setView({ ...localView(), heightM, center: { lat: -28, lon: 135 } });
    await nextTick();
    assert.deepEqual(keys(), ['kut', 'kutx', 'far', 'near3', 'near4']);
    assert.equal(document.activeElement, rows()[2]);
  }
  assert.equal($('.radio-stations__widen'), null);
  const next = list.querySelector('[data-list-next]');
  next.focus();
  next.click();
  await nextTick();
  assert.equal(document.activeElement, next);
  assert.deepEqual(keys(), ['near5', 'near6', 'near7', 'near8', 'near9']);
  assert.equal(range(), '6–10 of 12');
  next.click();
  await nextTick();
  assert.deepEqual(keys(), ['near10', 'near11']);
  assert.equal(range(), '11–12 of 12');
  assert.equal(next.getAttribute('aria-disabled'), 'true');
  assert.equal(radio.calls.length, 0);
});

test('Radio Context search resets paging and matches distant stations by metadata', async (t) => {
  const { $, radio } = await radioWithStations(t, 12);
  const list = $('[data-list-card=radio]');
  const rows = () => [...list.querySelectorAll('[data-list-key]')];
  list.querySelector('[data-list-next]').click();
  await nextTick();
  radio.stations[2].country = 'United States';
  const previousText = contextSearchText.value;
  t.after(() => {
    contextSearchText.value = previousText;
  });
  contextSearchOpen.value = true;
  contextSearchText.value = 'United States';
  await nextTick();
  assert.deepEqual(
    rows().map((row) => row.dataset.listKey),
    ['far'],
  );
  assert.equal(list.querySelector('[data-list-range]').textContent, '1–1 of 1');
  rows()[0].click();
  assert.deepEqual(radio.calls.at(-1), ['select', 'far', true]);
});

test('Radio keeps its tuner in place while the directory loads, fails, then delivers degraded stations', async (t) => {
  const { $, radio } = await radioWithStations(t, 3);
  let loaded = [];
  radio.getLoadedRadioStations = () => loaded;
  radio.getRadioAcceptedCatalogSnapshot = () => ({ stations: [] });
  radio.emit({ acceptedCatalogGeneration: null });
  await nextTick();
  const card = $('[data-list-card=radio]');
  const fold = card.querySelector('#radio-panel');
  assert.ok(fold);
  assert.ok(card.querySelector('.view-context__dot--loading'));
  assert.doesNotMatch(card.textContent, /0 results/);
  radio.emit({ error: 'Radio directory unavailable' });
  await nextTick();
  assert.ok(card.querySelector('.view-context__dot--unavailable'));
  loaded = radio.stations;
  radio.emit({ degraded: true, error: null });
  await nextTick();
  assert.equal(card.querySelectorAll('[data-list-key]').length, 3);
  assert.ok(card.querySelector('.view-context__dot--degraded'));
  assert.equal(card.querySelector('#radio-panel'), fold);
});

/** Context open on the station list near Austin, Radio on (`playing`: a station heard). */
async function radioOnWithList(t, { playing = 'kut' } = {}) {
  const radio = radioLayer({ playing });
  const fixed = fixture(t, [
    { id: 'radio', name: 'Radio', enabled: true, records: [] },
  ]);
  const dm = fixed.cards.layerModule;
  fixed.cards.layerModule = (id) => (id === 'radio' ? radio : dm(id));
  fixed.cards.setView(localView());
  await nextTick();
  await turn();
  await nextTick();
  const pinned = usePinnedStore(fixed.pinia);
  t.after(() => pinned.unpin('radio:kut'));
  return { ...fixed, radio, pinned };
}

// A station's name is third-party text: Fly to goes to the station's own
// coordinates and never looks its name up as a place.
test("Radio's Fly to flies to the station's coordinates, not to a place named like it", async (t) => {
  const { $, radio, pinia } = await radioOnWithList(t);
  const calls = [];
  useOmnibarStore(pinia).connectRunner(async (name, args) => {
    calls.push([name, args]);
    return { ok: true };
  });
  t.after(() => useOmnibarStore(pinia).connectRunner(null));
  for (const name of ['JFK', 'Austin']) {
    const station = { ...radio.stations[0], name };
    radio.emit({ selected: station });
    await nextTick();
    [...document.querySelectorAll('.radio-stations button')]
      .find((button) => /Fly to/.test(button.textContent))
      .click();
    assert.deepEqual(
      calls.at(-1),
      ['fly_to_location', { latitude: station.lat, longitude: station.lon }],
      name,
    );
  }
  assert.ok(
    $('.radio-stations .nearby-lists__layer ul'),
    'the station list stays',
  );
});

const MINI_CONTROLS = [
  '.radio-mini__pin',
  '[aria-label="Previous filtered station"]',
  '.radio-mini__play',
  '[aria-label="Next filtered station"]',
  '.radio-mini__close',
  '.radio-volume__mute',
];
const miniControls = ($) =>
  MINI_CONTROLS.map((selector) => Boolean($(`.radio-mini ${selector}`)));

test('Radio on with the station list open: an unpinned station playing is in the mini player, live, with every control', async (t) => {
  const { $ } = await radioOnWithList(t);
  assert.ok($('.radio-stations .nearby-lists__layer ul'), 'the list is open');
  assert.match($('.radio-mini').textContent, /KUT 90\.5/);
  assert.equal($('.radio-mini .feed-dot').dataset.state, 'live');
  assert.deepEqual(
    miniControls($),
    MINI_CONTROLS.map(() => true),
  );
});

// Radio on, Context open as a panel on its station list, nothing selected:
// playing the nearest station brings the mini player at once, loading, with
// the list still in view, and it stays while the stream loads and plays.
test('Radio on, nothing selected: playing a station from the open list shows the mini player at once, loading, then live', async (t) => {
  const { $, radio } = await radioOnWithList(t, { playing: null });
  radio.emit({ selected: null, audioState: 'stopped', playingStationId: null });
  await nextTick();
  assert.ok($('.radio-stations .nearby-lists__layer ul'), 'the list is open');
  assert.equal($('.radio-mini'), null, 'nothing selected, nothing to show');
  document.querySelector('.radio-stations button[data-list-key]').click();
  await nextTick();
  assert.ok(
    $('.radio-stations .nearby-lists__layer ul'),
    'the list stays in view',
  );
  assert.ok($('.radio-mini'), 'shown as the station starts');
  assert.equal(
    $('.radio-mini .feed-dot').dataset.state,
    'loading',
    'not live while it loads',
  );
  assert.equal(
    $('.radio-mini .feed-dot').getAttribute('aria-label'),
    'Loading',
  );
  radio.emit({ audioState: 'playing' });
  await nextTick();
  assert.equal(
    $('.radio-mini .feed-dot').dataset.state,
    'live',
    'still shown, playing',
  );
  assert.deepEqual(
    miniControls($),
    MINI_CONTROLS.map(() => true),
  );
});

test('a station selected and paused or loading keeps the mini player with Radio on', async (t) => {
  const { $, radio } = await radioOnWithList(t, { playing: null });
  assert.match(
    $('.radio-mini').textContent,
    /KUT 90\.5/,
    'selected, not yet playing',
  );
  assert.equal($('.radio-mini .feed-dot'), null);
  radio.emit({ audioState: 'loading', playingStationId: 'kut' });
  await nextTick();
  assert.equal(
    $('.radio-mini .feed-dot').dataset.state,
    'loading',
    'loading is not live',
  );
  assert.equal(
    $('.radio-mini .feed-dot').getAttribute('aria-label'),
    'Loading',
  );
  radio.emit({ audioState: 'buffering' });
  await nextTick();
  assert.equal(
    $('.radio-mini .feed-dot').dataset.state,
    'loading',
    'nor is buffering',
  );
  radio.emit({ audioState: 'playing' });
  await nextTick();
  assert.equal($('.radio-mini .feed-dot').dataset.state, 'live');
  assert.equal($('.radio-mini .feed-dot').getAttribute('aria-label'), 'Live');
  radio.emit({ audioState: 'paused' });
  await nextTick();
  assert.equal($('.radio-mini .feed-dot').dataset.state, 'paused');
  assert.deepEqual(
    miniControls($),
    MINI_CONTROLS.map(() => true),
    'every control, whatever the state',
  );
});

test('Now playing and the mini player read one playback state, both ways', async (t) => {
  const { $, radio } = await radioOnWithList(t);
  const nowState = () => $('.radio-stations__state').textContent;
  const nowButton = () => $('.radio-stations__actions button').textContent;
  assert.match(nowState(), /Playing/);
  assert.match(nowButton(), /Pause/);
  assert.equal(
    $('.radio-mini__play').getAttribute('aria-label'),
    'Pause KUT 90.5',
  );
  // Pausing in the mini player.
  $('.radio-mini__play').click();
  await nextTick();
  assert.deepEqual(radio.calls.at(-1), ['pause']);
  assert.match(nowState(), /Paused/);
  assert.match(nowButton(), /Play/);
  assert.equal($('.radio-mini .feed-dot').dataset.state, 'paused');
  // Playing from Now playing.
  $('.radio-stations__actions button').click();
  await nextTick();
  assert.deepEqual(radio.calls.at(-1), ['play', 'kut']);
  assert.match(nowState(), /Loading/);
  assert.equal(
    $('.radio-mini .feed-dot').dataset.state,
    'loading',
    'Loading, as Now playing says',
  );
  assert.equal(
    $('.radio-mini__play').getAttribute('aria-label'),
    'Pause KUT 90.5',
  );
  // Pausing from Now playing; the mini player follows.
  radio.emit({ audioState: 'playing' });
  await nextTick();
  $('.radio-stations__actions button').click();
  await nextTick();
  assert.equal(
    $('.radio-mini__play').getAttribute('aria-label'),
    'Play KUT 90.5',
  );
  // Another station heard while KUT stays selected: neither says KUT plays.
  radio.emit({ audioState: 'playing', playingStationId: 'kutx' });
  await nextTick();
  assert.match(nowState(), /Ready/);
  assert.match(
    $('.radio-mini').textContent,
    /KUTX 98\.9/,
    'the player holds the station heard',
  );
});

test('the mini player steps only through matching stations while the Radio list shows', async (t) => {
  const { $, radio } = await radioOnWithList(t);
  contextSearchOpen.value = true;
  contextSearchText.value = '90.5';
  await nextTick();
  const previous = $('.radio-mini [aria-label="Previous filtered station"]');
  const next = $('.radio-mini [aria-label="Next filtered station"]');
  const transport = previous.closest('[role="group"]');
  assert.equal(next.closest('[role="group"]'), transport);
  const privacy = document.getElementById(
    transport.getAttribute('aria-describedby'),
  );
  assert.match(privacy.textContent, /broadcasters.*IP address/);
  assert.equal(previous.disabled, true);
  assert.equal(next.disabled, true);
  contextSearchText.value = 'KUT';
  await nextTick();
  next.click();
  assert.deepEqual(radio.calls.at(-1), ['cycle', 1, ['kut', 'kutx'], true]);
});

test('the mini player’s Pin toggles, and unpinning never stops the station', async (t) => {
  const { $, radio, pinned, pinia } = await radioOnWithList(t);
  const display = useDisplayStore(pinia);
  display.publishPhoneShell({ enabled: true, sheet: null });
  const chrome = usePanelChromeStore(pinia);
  const owner = chrome.connect({
    reveal(id) {
      if (id === 'global-context-panel')
        display.publishPhoneShell({ enabled: true, sheet: 'context' });
    },
  });
  chrome.publish(owner, 'global-context-panel', { collapsed: false });
  t.after(() => chrome.detach(owner));
  await nextTick();
  const pin = () => $('.radio-mini__pin');
  assert.equal(pin().getAttribute('aria-pressed'), 'false');
  assert.equal(
    pin().getAttribute('aria-label'),
    'Pin KUT 90.5 to the Pinned tab',
  );
  assert.equal(pin().title, pin().getAttribute('aria-label'));
  pin().click();
  await nextTick();
  assert.equal(pinned.isPinned('radio:kut'), true);
  assert.equal(display.phoneShell.sheet, 'context');
  assert.ok($('.pinned-grid [data-pin-key="radio:kut"]'));
  assert.equal(pin().getAttribute('aria-pressed'), 'true');
  assert.equal(pin().disabled, false, 'still a button');
  assert.equal(pin().getAttribute('aria-label'), 'Unpin KUT 90.5');
  assert.equal(pin().title, pin().getAttribute('aria-label'));
  const before = radio.calls.length;
  pin().click();
  await nextTick();
  assert.equal(pinned.isPinned('radio:kut'), false);
  assert.deepEqual(radio.calls.slice(before), [], 'no stop or pause');
  assert.equal(radio.state().audioState, 'playing');
  assert.equal(
    $('.radio-mini .feed-dot').dataset.state,
    'live',
    'the player stays',
  );
  // Pinned during this playback, it stays kept through Radio off.
  radio.turnOff();
  await settle();
  assert.equal(radio.state().audioState, 'playing');
  assert.equal($('.radio-mini .feed-dot').dataset.state, 'live');
});

test('a station never pinned while it played stops with Radio off, and the player goes', async (t) => {
  const { $, radio } = await radioOnWithList(t);
  radio.turnOff();
  await settle();
  assert.equal(radio.state().audioState, 'stopped');
  assert.equal($('.radio-mini'), null);
});

test('Close stops the station heard and puts the player away, pinned or not', async (t) => {
  const { $, radio, pinned } = await radioOnWithList(t);
  $('.radio-mini__close').click();
  await nextTick();
  assert.deepEqual(radio.calls.at(-1), ['stop']);
  assert.equal($('.radio-mini'), null);
  // Pinned: Close still stops it.
  radio.playStation('kut');
  pinned.pin({
    key: 'radio:kut',
    kind: 'station',
    title: 'KUT 90.5',
    icon: 'radio',
    identity: { layerId: 'radio', id: 'kut' },
  });
  await nextTick();
  assert.ok($('.radio-mini'), 'back as the station plays again');
  $('.radio-mini__close').click();
  await nextTick();
  assert.deepEqual(radio.calls.at(-1), ['stop']);
  assert.equal($('.radio-mini'), null);
  assert.equal(radio.state().playingStationId, null);
});

test('Close from the keyboard hands focus to Context, which stays', async (t) => {
  const { $ } = await radioOnWithList(t);
  const close = $('.radio-mini__close');
  close.focus();
  close.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
  await nextTick();
  await nextTick();
  assert.equal($('.radio-mini'), null);
  assert.ok(
    document.activeElement?.closest('#global-context-panel'),
    `focus is in Context, not on ${document.activeElement?.tagName}`,
  );
});

test('keyboard Close returns to the phone tab bar when Context is covered', async (t) => {
  const { $, pinia, radio } = await radioOnWithList(t);
  const display = useDisplayStore(pinia);
  const host = document.body.appendChild(document.createElement('div'));
  const bar = createApp(PhoneTabBar).use(pinia);
  bar.mount(host);
  t.after(() => {
    bar.unmount();
    host.remove();
  });
  const tabs = [
    { sheet: 'layers', label: 'Layers', icon: 'layers' },
    { sheet: 'more', label: 'More', icon: 'more_horiz' },
  ];
  for (const sheet of ['more', null]) {
    display.publishPhoneShell({ enabled: true, sheet, tabs });
    radio.playStation('kut');
    await nextTick();
    const close = $('.radio-mini__close');
    close.focus();
    close.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
    await nextTick();
    await nextTick();
    assert.equal($('.radio-mini'), null);
    assert.equal(
      document.activeElement?.dataset.mobileSheet,
      sheet ?? 'layers',
    );
    assert.equal(display.phoneShell.sheet, sheet);
  }
});

test('where nothing hovers, the mini player’s speaker is a volume disclosure and Mute is inside', async (t) => {
  const realMatchMedia = globalThis.matchMedia;
  globalThis.matchMedia = (query) => ({
    matches: query === '(hover: none)',
    media: query,
  });
  t.after(() => (globalThis.matchMedia = realMatchMedia));
  const { $ } = await radioOnWithList(t);
  const speaker = $('.radio-mini .radio-volume > .radio-volume__mute');
  assert.equal(speaker.getAttribute('aria-label'), 'Radio volume');
  assert.equal(speaker.getAttribute('aria-expanded'), 'false');
  assert.equal(speaker.hasAttribute('aria-pressed'), false);
  speaker.click();
  await nextTick();
  assert.equal(speaker.getAttribute('aria-expanded'), 'true');
  const mute = $('.radio-mini .radio-volume__slider .radio-volume__mute');
  assert.equal(mute.getAttribute('aria-label'), 'Mute radio');
  assert.equal(mute.getAttribute('aria-pressed'), 'false');
});

test('volume: Now playing, the mini player and the Tuner fold set one user volume, and mute and unmute together', async (t) => {
  const { $, radio, pinia } = await radioOnWithList(t);
  // As RadioControls answers it: the layer's params, persisted, then the
  // layer's state (the fold presents the same state).
  const persisted = [];
  const owner = useRadioStore(pinia).connect({
    setRadioVolume(percent) {
      persisted.push(percent / 100);
      radio.emit({ volume: percent / 100 });
    },
  });
  t.after(() => useRadioStore(pinia).detach(owner));
  const nowSlider = () => $('.radio-stations__volume .radio-volume__range');
  const miniSlider = () => $('.radio-mini .radio-volume__range');
  const slide = (input, value) => {
    input.value = String(value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  assert.equal(nowSlider().getAttribute('aria-label'), 'Volume, 80%');
  assert.equal(miniSlider().getAttribute('aria-label'), 'Volume, 80%');
  slide(nowSlider(), 40);
  await nextTick();
  assert.equal(miniSlider().value, '40', 'the mini player follows Now playing');
  assert.equal(miniSlider().getAttribute('aria-label'), 'Volume, 40%');
  slide(miniSlider(), 65);
  await nextTick();
  assert.equal(nowSlider().value, '65', 'Now playing follows the mini player');
  // The fold's slider is the same action.
  slide($('#radio-volume'), 30);
  await nextTick();
  assert.equal(nowSlider().value, '30');
  assert.equal(miniSlider().value, '30');
  assert.deepEqual(persisted, [0.4, 0.65, 0.3]);
  // Mute in the mini player mutes both; unmute in Now playing brings 30 back.
  const miniMute = $('.radio-mini .radio-volume__mute');
  assert.equal(miniMute.getAttribute('aria-label'), 'Mute radio');
  miniMute.click();
  await nextTick();
  const nowMute = $('.radio-stations__volume .radio-volume__mute');
  assert.equal(nowMute.getAttribute('aria-pressed'), 'true');
  assert.equal(nowMute.getAttribute('aria-label'), 'Unmute radio');
  assert.equal(nowSlider().value, '0');
  nowMute.click();
  await nextTick();
  assert.equal(miniSlider().value, '30');
  assert.equal(
    $('.radio-mini .radio-volume__mute').getAttribute('aria-pressed'),
    'false',
  );
  assert.deepEqual(persisted, [0.4, 0.65, 0.3, 0, 0.3]);
  // Voice ducking lowers what is heard, never the volume shown.
  radio.emit({ voiceDucked: true, effectiveVolume: 0 });
  await nextTick();
  assert.equal(nowSlider().value, '30');
  assert.equal(miniSlider().value, '30');
  assert.equal(
    $('.radio-mini .radio-volume__mute').getAttribute('aria-pressed'),
    'false',
  );
});

test('volume: unmute after sliding down to zero brings back the level the slide started from', async (t) => {
  const { $, radio, pinia } = await radioOnWithList(t);
  const owner = useRadioStore(pinia).connect({
    setRadioVolume(percent) {
      radio.emit({ volume: percent / 100 });
    },
  });
  t.after(() => useRadioStore(pinia).detach(owner));
  const nowSlider = () => $('.radio-stations__volume .radio-volume__range');
  const slide = (input, value) => {
    input.value = String(value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const slider = nowSlider();
  slider.focus();
  for (const value of [60, 40, 20, 3, 1, 0]) {
    slide(slider, value);
    await nextTick();
  }
  slider.blur();
  $('.radio-stations__volume .radio-volume__mute').click();
  await nextTick();
  assert.equal(nowSlider().value, '80', 'the level before the slide');
  // A slide elsewhere (the Tuner fold) ending on a level too low to hear
  // brings back half volume.
  for (const value of [1, 0]) {
    slide($('#radio-volume'), value);
    await nextTick();
  }
  $('.radio-stations__volume .radio-volume__mute').click();
  await nextTick();
  assert.equal(nowSlider().value, '50');
});

// Expanded to the full-height column, Context covers the corner: the same
// mini player moves to the column's foot, inside Context, the station
// playing on, and goes back to the corner as it was when Context shrinks.
const expandButton = () =>
  document.querySelector(
    '#global-context-panel .context-dock-btn[aria-label$="full-height column"], #global-context-panel .context-dock-btn[aria-label^="Shrink Context"]',
  );
test('expanding Context moves the mini player to the column’s foot without stopping the station; shrinking takes it back', async (t) => {
  const { $, radio } = await radioOnWithList(t);
  const mini = $('.radio-mini');
  assert.ok(
    mini.closest('.context-corner'),
    'in the corner while a station plays',
  );
  expandButton().click();
  await nextTick();
  assert.equal(expandButton().getAttribute('aria-pressed'), 'true', 'expanded');
  assert.equal(
    document.querySelectorAll('.radio-mini').length,
    1,
    'one player, never two',
  );
  assert.equal($('.radio-mini'), mini, 'the same player, moved');
  assert.ok(
    mini.closest('#global-context-panel #context-mini-foot'),
    'at the foot of the column',
  );
  assert.equal(mini.closest('.context-corner'), null, 'not in the corner');
  assert.equal($('#context-mini-foot').style.display, '', 'its foot shows');
  assert.equal(radio.state().audioState, 'playing', 'the station plays on');
  assert.equal(
    radio.calls.some(([name]) => /stop|pause/i.test(name)),
    false,
    'nothing stopped it',
  );
  expandButton().click();
  await nextTick();
  assert.equal(document.querySelectorAll('.radio-mini').length, 1);
  assert.equal($('.radio-mini'), mini, 'still the same player');
  assert.ok(
    mini.closest('.context-corner'),
    'back in the corner once Context shrinks',
  );
  assert.equal(
    $('#context-mini-foot').style.display,
    'none',
    'the foot is put away',
  );
  assert.equal(mini.dataset.state, 'live', 'still live');
});

test('while expanded the mini player at the column’s foot controls playback', async (t) => {
  const { $, radio } = await radioOnWithList(t);
  expandButton().click();
  await nextTick();
  const foot = () => $('#context-mini-foot .radio-mini');
  assert.ok(foot(), 'in the column');
  assert.deepEqual(
    MINI_CONTROLS.map((selector) => Boolean(foot().querySelector(selector))),
    MINI_CONTROLS.map(() => true),
    'every control there',
  );
  foot().querySelector('.radio-mini__play').click();
  await nextTick();
  assert.ok(
    radio.calls.some(([name]) => /pause|toggle/.test(name)),
    'Pause reached the station',
  );
  assert.equal(radio.state().audioState, 'paused');
  assert.equal(foot().dataset.state, 'paused');
  foot().querySelector('.radio-mini__play').click();
  await nextTick();
  assert.ok(
    radio.calls.some(([name, id]) => name === 'play' && id === 'kut'),
    'and Play starts it again',
  );
  assert.equal(foot().dataset.state, 'loading');
  foot().querySelector('[aria-label="Next filtered station"]').click();
  await nextTick();
  foot().querySelector('.radio-mini__close').click();
  await nextTick();
  assert.equal(
    $('.radio-mini'),
    null,
    'Close takes it away from the column too',
  );
  expandButton().click();
  await nextTick();
});

// Radio's source is chosen on its Data Layers row; Context shows only that
// source, with no switch or tabs of its own.
test('Context shows only the Radio source chosen on its row: the stations, or the local receiver', async (t) => {
  const { $, radio } = await radioOnWithList(t, { playing: null });
  assert.ok(
    $('.radio-stations .nearby-lists__layer ul'),
    'the internet stations',
  );
  assert.equal($('.local-receiver'), null);
  radio.emit({
    enabled: false,
    source: 'local',
    localReceiver: true,
    selected: null,
    audioState: 'stopped',
    playingStationId: null,
  });
  await nextTick();
  assert.equal(
    $('.radio-stations .nearby-lists__layer ul'),
    null,
    'no station list',
  );
  assert.equal(
    $('.radio-stations:not(.local-receiver)'),
    null,
    'no Now playing for a station',
  );
  const local = $('.local-receiver');
  assert.ok(local, 'the local receiver instead');
  assert.match(local.textContent, /LOCAL RTL-SDR/);
  assert.match(local.textContent, /CONNECT/);
  assert.equal(
    document.querySelectorAll(
      '#global-context-panel [data-chip-id^="radio-source"], #global-context-panel [role="tab"][id*="radio"]',
    ).length,
    0,
    'no switch or tabs in Context',
  );
  assert.equal(
    $('#global-context-panel #sdr-radio-card'),
    null,
    'the full card stays on the row',
  );
  radio.emit({ enabled: true, source: 'internet', localReceiver: false });
  await nextTick();
  assert.ok($('.radio-stations .nearby-lists__layer ul'), 'the stations again');
  assert.equal($('.local-receiver'), null);
});

// Under an open Context the dock and the mini player stand at the foot of
// the column, wherever the panel above them ends, and the panel gives up
// their height: neither measures the other, so a dock arriving lays the
// column out once. Until the panel has made room they wait unseen rather
// than show over its last rows.
test('under an open Context the corner stands at the column’s foot, whatever the panel’s height, and waits unseen until the panel makes room', async (t) => {
  const { $, pinia, close, open } = await radioOnWithList(t);
  const corner = $('.context-corner');
  const stack = $('#right-context-rail');
  const panel = $('#global-context-panel');
  assert.ok(
    corner.querySelector('.radio-mini'),
    'something stands in the corner',
  );
  const FOOT = 700;
  const HEIGHT = 37;
  stack.dataset.columnBottom = String(FOOT);
  Object.defineProperty(corner, 'offsetHeight', {
    configurable: true,
    get: () => HEIGHT,
  });
  corner.getBoundingClientRect = () => {
    const bottom =
      globalThis.innerHeight - parseFloat(corner.style.bottom || '0');
    return {
      left: 1218,
      right: 1548,
      width: 330,
      top: bottom - HEIGHT,
      bottom,
      height: HEIGHT,
    };
  };
  let panelBottom = 600;
  panel.getBoundingClientRect = () => ({
    left: 1218,
    right: 1548,
    width: 330,
    top: 150,
    bottom: panelBottom,
    height: panelBottom - 150,
  });
  const measure = async () => {
    globalThis.dispatchEvent(new Event('resize'));
    await new Promise((resolve) => setTimeout(resolve, 20));
  };
  const docked = useDockedStore(pinia);
  docked.dock({
    key: 'cctv:cam1',
    kind: 'camera',
    title: 'Camera',
    identity: { layerId: 'cctv', id: 'cam1' },
  });
  t.after(() => docked.close());
  close();
  await nextTick();
  await measure();
  assert.ok(corner.querySelector('.docked-view'));
  assert.ok(corner.classList.contains('context-corner--mini-first'));
  open();
  await nextTick();
  await measure();
  assert.equal(corner.classList.contains('context-corner--mini-first'), false);
  const standing = corner.style.bottom;
  assert.equal(
    standing,
    `${globalThis.innerHeight - FOOT}px`,
    'on the column’s foot',
  );
  assert.equal(corner.style.top, 'auto');
  assert.match(
    stack.dataset.cornerReserve,
    /^\d+$/,
    'the panel gives up its height',
  );
  assert.equal(corner.classList.contains('context-corner--settling'), false);
  // The panel still running down over it (the column not yet laid out):
  // the corner stays where it is, unseen.
  panelBottom = FOOT - 10;
  await measure();
  assert.equal(
    corner.style.bottom,
    standing,
    'its place does not follow the panel',
  );
  assert.ok(
    corner.classList.contains('context-corner--settling'),
    'unseen meanwhile',
  );
  // The panel has made room: seen, still in the same place.
  panelBottom = FOOT - HEIGHT - 8;
  await measure();
  assert.equal(corner.style.bottom, standing);
  assert.equal(corner.classList.contains('context-corner--settling'), false);
});

// The mini player's slider opens in the top layer, placed from the speaker:
// above it where the window has room, else to its left, never off screen;
// it closes on Escape and on a click elsewhere.
test('the mini player’s volume slider opens over Context, above the speaker or beside it, and closes on Escape or a click elsewhere', async (t) => {
  const { $ } = await radioOnWithList(t);
  const box = $('.radio-mini .radio-volume');
  const speaker = $('.radio-mini .radio-volume__mute');
  const popup = $('.radio-mini .radio-volume__slider');
  assert.equal(popup.getAttribute('popover'), 'manual', 'a top-layer popover');
  const rect = (left, top, width, height) => () => ({
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
  });
  popup.getBoundingClientRect = rect(0, 0, 144, 40);
  // Room above: it opens above, its right edge on the speaker's.
  speaker.getBoundingClientRect = rect(700, 700, 28, 28);
  speaker.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
  await nextTick();
  assert.ok(box.classList.contains('is-open'), 'focus opens it');
  assert.equal(popup.dataset.side, 'above');
  assert.equal(popup.style.top, `${700 - 40 - 6}px`);
  assert.equal(popup.style.left, `${728 - 144}px`);
  speaker.getBoundingClientRect = rect(420, 20, 28, 28);
  globalThis.dispatchEvent(new Event('resize'));
  await nextTick();
  assert.equal(popup.dataset.side, 'left');
  assert.equal(popup.style.left, `${420 - 144 - 6}px`);
  escKey(box);
  await nextTick();
  assert.equal(box.classList.contains('is-open'), false, 'Escape closes it');
  // No room above: to the left, centred on the speaker, inside the window.
  speaker.getBoundingClientRect = rect(700, 20, 28, 28);
  speaker.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
  await nextTick();
  assert.equal(popup.dataset.side, 'left');
  assert.equal(popup.style.left, `${700 - 144 - 6}px`);
  assert.equal(popup.style.top, `${20 + 14 - 20}px`, 'centred on the speaker');
  speaker.getBoundingClientRect = rect(700, 2, 28, 8);
  escKey(box);
  speaker.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
  await nextTick();
  assert.equal(popup.style.top, '8px', 'kept inside the window');
  document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
  await nextTick();
  assert.equal(
    box.classList.contains('is-open'),
    false,
    'a click elsewhere closes it',
  );
});

test('the compact Radio slider stays open on pointer exit while it has keyboard focus', async (t) => {
  const { $ } = await radioOnWithList(t);
  const box = $('.radio-mini .radio-volume');
  const slider = box.querySelector('.radio-volume__range');
  box.dispatchEvent(new MouseEvent('mouseenter'));
  await nextTick();
  slider.focus();
  assert.ok(document.activeElement === slider);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  box.dispatchEvent(new MouseEvent('mouseleave'));
  t.mock.timers.tick(201);
  await nextTick();
  assert.equal(box.classList.contains('is-open'), true);
  slider.blur();
  await nextTick();
  assert.equal(box.classList.contains('is-open'), false);
});

// Expanded, the mini player is inside Context: an Esc that closes its open
// slider is the slider's alone.
test('while expanded, Esc in the mini player’s open volume slider closes only the slider', async (t) => {
  const { $ } = await radioOnWithList(t);
  expandButton().click();
  await nextTick();
  contextSearchOpen.value = true;
  await nextTick();
  const box = $('#context-mini-foot .radio-volume');
  const speaker = box.querySelector('.radio-volume__mute');
  speaker.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
  await nextTick();
  assert.ok(box.classList.contains('is-open'), 'the slider is open');
  assert.equal(box.hasAttribute('data-owns-escape'), true);
  await new Promise((resolve) => setTimeout(resolve, 5));
  escKey(box.querySelector('.radio-volume__range'));
  await nextTick();
  assert.equal(box.classList.contains('is-open'), false, 'the slider closes');
  assert.equal(contextSearchOpen.value, true, 'the search stays open');
  assert.equal(
    box.hasAttribute('data-owns-escape'),
    false,
    'closed, Esc is Context’s again',
  );
  assert.equal(escKey(speaker), true);
  assert.equal(
    contextSearchOpen.value,
    false,
    'the next Esc closes the search',
  );
});

// The panel's own Esc (PanelChrome binds it on the way up) must not also
// collapse Context for the Esc that closed the slider.
test('while expanded, Esc in the mini player’s open volume slider leaves Context open', async (t) => {
  const { $, close } = await radioOnWithList(t);
  expandButton().click();
  await nextTick();
  const panel = $('#global-context-panel');
  let collapses = 0;
  const disclosure = bindPanelDisclosure({
    panel,
    onEscape: (event) =>
      collapsePanelOnEscape(event, {
        panel,
        onChange: (collapsed) => {
          if (collapsed) collapses += 1;
          close();
        },
      }),
  });
  t.after(() => disclosure.destroy());
  assert.equal(panel.classList.contains('collapsed'), false, 'Context is open');
  const box = $('#context-mini-foot .radio-volume');
  const speaker = box.querySelector('.radio-volume__mute');
  speaker.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
  await nextTick();
  assert.ok(box.classList.contains('is-open'), 'the slider is open');
  await new Promise((resolve) => setTimeout(resolve, 5));
  escKey(box.querySelector('.radio-volume__range'));
  await nextTick();
  assert.equal(box.classList.contains('is-open'), false, 'the slider closes');
  assert.equal(collapses, 0, 'the panel’s Esc does not run');
  assert.equal(
    panel.classList.contains('collapsed'),
    false,
    'Context stays open',
  );
  assert.equal(
    expandButton()?.getAttribute('aria-pressed'),
    'true',
    'and expanded',
  );
  // With the slider closed, the next Esc is the panel's.
  escKey(speaker);
  await nextTick();
  assert.equal(collapses, 1, 'the next Esc collapses Context');
});

test('on touch, the first tap on the mini player’s speaker opens its slider and keeps it open; the next tap closes it', async (t) => {
  const realMatch = globalThis.matchMedia;
  globalThis.matchMedia = (query) => ({
    matches: query === '(hover: none)',
    media: query,
    addEventListener() {},
    removeEventListener() {},
  });
  t.after(() => (globalThis.matchMedia = realMatch));
  const { $ } = await radioOnWithList(t);
  const box = $('.radio-mini .radio-volume');
  const speaker = $('.radio-mini .radio-volume__mute');
  // A tap: press, the focus it gives, then its click.
  speaker.dispatchEvent(new Event('pointerdown', { bubbles: true }));
  speaker.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
  speaker.click();
  await nextTick();
  assert.ok(box.classList.contains('is-open'), 'the first tap leaves it open');
  // The speaker already has focus: the next tap is a press and a click.
  speaker.dispatchEvent(new Event('pointerdown', { bubbles: true }));
  speaker.click();
  await nextTick();
  assert.equal(
    box.classList.contains('is-open'),
    false,
    'a second tap closes it',
  );
  // Focus from the keyboard still opens it.
  speaker.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  speaker.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
  await nextTick();
  assert.ok(box.classList.contains('is-open'), 'keyboard focus opens it');
});

test('a station’s category shows as a chip coloured as its marker; its tag moves to the meta line; no tags, no chip', async (t) => {
  // The layer's own classifier, labels and colours.
  const layer = createRadioLayer({
    source: {},
    services: {
      ground: {},
      picking: { unregisterPickOwner() {} },
      globe: {},
      render: { governorRequestRender() {} },
      overlays: {
        clearOverlaySource() {},
        setOverlaySourceVisible() {},
        setOverlayEntries() {},
      },
    },
  });
  t.after(() => layer.destroy());
  const radio = radioLayer({ playing: 'kutx' });
  radio.stations[1].tags = ['chiptune', 'music'];
  radio.radioStationCategoryId = layer.radioStationCategoryId;
  radio.radioCategoryColor = layer.radioCategoryColor;
  radio.emit({
    selected: radio.stations[1],
    categories: layer.buildRadioCategories(radio.stations),
  });
  const { $, cards } = fixture(t, [
    { id: 'radio', name: 'Radio', enabled: true, records: [] },
  ]);
  const dm = cards.layerModule;
  cards.layerModule = (id) => (id === 'radio' ? radio : dm(id));
  cards.setView(localView());
  await nextTick();
  await turn();
  await nextTick();
  assert.equal(
    $('.radio-stations__now-head strong').textContent,
    'KUTX 98.9',
    'the title is the name alone',
  );
  const chip = $('.radio-stations__meta .radio-category');
  assert.equal(chip.textContent, 'Music');
  assert.equal(
    chip.style.getPropertyValue('--radio-category'),
    layer.radioCategoryColor('music'),
  );
  assert.match(
    $('.radio-stations__meta-text').textContent,
    /^chiptune\b/,
    'the tag after the category',
  );
  // The distance is its own part of the line, kept whole while the details
  // before it give way with an ellipsis.
  assert.match($('.radio-stations__meta-distance').textContent, /\d\s*km$/);
  assert.equal(
    $('.radio-stations__meta-text').title,
    $('.radio-stations__meta-text').textContent,
    'the whole line on hover',
  );
  const dots = ['kut', 'kutx'].map((id) =>
    $(
      `[data-list-card=radio] [data-list-key=${id}] .radio-category-dot`,
    ).getAttribute('aria-label'),
  );
  assert.deepEqual(dots, ['News', 'Music'], 'each row says its category');
  assert.equal(
    $('.radio-mini__icon').style.color !== '',
    true,
    'the mini player’s glyph takes the colour',
  );
  // No tags: no chip, never "Other".
  radio.stations[1].tags = [];
  radio.emit({ selected: { ...radio.stations[1] } });
  await nextTick();
  assert.equal($('.radio-stations__meta .radio-category'), null);
  assert.doesNotMatch($('.radio-stations__meta').textContent, /Other/);
});

test('on a phone, Esc in Context is left to the sheet, which closes first', async (t) => {
  const { $, cards } = fixture(t, [flightsOn([flight('test01', 30.3, -97.7)])]);
  cards.select({ layerId: 'flights', id: 'test01' }, { follow: false });
  await nextTick();
  document.body.classList.add('mobile-shell');
  t.after(() => document.body.classList.remove('mobile-shell'));
  assert.equal(escKey($('.entity-card__action--pin')), false);
  assert.ok(cards.card, 'the pick stays for the sheet to close first');
});

test('on a phone, Esc in the search field closes the search', async (t) => {
  const { $ } = fixture(t, [flightsOn([])]);
  contextSearchOpen.value = true;
  await nextTick();
  document.body.classList.add('mobile-shell');
  t.after(() => document.body.classList.remove('mobile-shell'));
  // Vue ignores an event stamped in the same millisecond its listener was attached.
  await new Promise((resolve) => setTimeout(resolve, 5));
  escKey($('.context-search__input'));
  assert.equal(contextSearchOpen.value, false);
});

const settleTicks = async () => {
  for (let i = 0; i < 4; i += 1) await nextTick();
};

test('the Lists tab going while it has focus hands focus to the tab that shows', async (t) => {
  const { $, pinia } = fixture(t, [flightsOn([])]);
  t.after(resetContextLists);
  const pinned = usePinnedStore(pinia);
  pinned.pin({
    key: 'flights:x',
    kind: 'item',
    title: 'X',
    icon: 'flight',
    identity: { layerId: 'flights', id: 'x' },
  });
  t.after(() => pinned.unpin('flights:x'));
  setContextListPresence('weather', { count: 2 });
  showContextList('weather');
  await settleTicks();
  $('#context-tab-lists').focus();
  setContextListPresence('weather', null);
  await settleTicks();
  assert.equal($('#context-tab-lists'), null);
  assert.equal(document.activeElement?.id, `context-tab-${pinned.tab}`);
});

for (const [scenario, trigger, target] of [
  [
    'clearing a camera with Escape from the last Inspect tab',
    '#context-tab-inspect',
    '#global-context-panel [data-rail-scroller][tabindex="-1"]',
  ],
  [
    'removing the focused Camera settings tab',
    '#context-tab-camera',
    '#global-context-panel [data-rail-scroller][tabindex="-1"]',
  ],
  [
    'removing Camera settings with a focused tool',
    '#cctv-tools-slot #cctv-projection-btn',
    '#context-tab-inspect',
  ],
]) {
  test(`${scenario} keeps focus in Context`, async (t) => {
    const camera = { id: 'cam1', name: 'I-35 @ 12th', lat: 30.27, lon: -97.73 };
    const cams = {
      id: 'cctv',
      name: 'Cameras',
      enabled: true,
      records: [camera],
      module: {
        frameUrlForCamera: (id) => ({
          url: `/frame/${id}.jpg`,
          refreshMs: 10_000,
        }),
      },
    };
    const { $, cards, pinia, notifyLayers } = fixture(t, [cams]);
    useCctvStore(pinia).publish(
      presentCctvPanel({ enabled: true, activeCameraId: 'cam1' }, true),
    );
    cards.select({ layerId: 'cctv', id: 'cam1' }, { fly: false });
    await settleTicks();
    if (trigger.startsWith('#cctv-tools-slot')) {
      t.after(resetContextLists);
      setContextListPresence('weather', { count: 1 });
      $('#context-tab-camera').click();
      await settleTicks();
    }
    const control = $(trigger);
    control.focus();
    assert.ok(document.activeElement === control);
    if (trigger === '#context-tab-inspect') {
      assert.equal(escKey(control), true);
    } else {
      cams.enabled = false;
      notifyLayers();
    }
    await settleTicks();
    assert.equal($('#context-tab-camera'), null);
    assert.ok($(target) && document.activeElement === $(target));
  });
}

test('Undo from the keyboard focuses the pin put back, or the Pinned tab', async (t) => {
  const { $, pinia } = fixture(t, [flightsOn([])]);
  const pinned = usePinnedStore(pinia);
  pinned.pin({
    key: 'flights:x',
    kind: 'item',
    title: 'X',
    icon: 'flight',
    identity: { layerId: 'flights', id: 'x' },
  });
  t.after(() => pinned.isPinned('flights:x') && pinned.unpin('flights:x'));
  pinned.show('pinned');
  await settleTicks();
  $('.pinned-grid__unpin').dispatchEvent(
    new MouseEvent('click', { bubbles: true, detail: 0 }),
  );
  await settleTicks();
  const undo = $('.pin-undo-notice button');
  assert.equal(document.activeElement, undo);
  undo.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
  await settleTicks();
  assert.ok(pinned.isPinned('flights:x'));
  // The last unpin left Pinned for Inspect, so its tab takes focus.
  assert.equal(document.activeElement, $('#context-tab-pinned'));
  // With Pinned still showing, the tile put back takes it.
  pinned.pin({
    key: 'flights:y',
    kind: 'item',
    title: 'Y',
    icon: 'flight',
    identity: { layerId: 'flights', id: 'y' },
  });
  t.after(() => pinned.isPinned('flights:y') && pinned.unpin('flights:y'));
  pinned.show('pinned');
  await settleTicks();
  pinned.unpin('flights:x');
  await settleTicks();
  $('.pin-undo-notice button').focus();
  $('.pin-undo-notice button').dispatchEvent(
    new MouseEvent('click', { bubbles: true, detail: 0 }),
  );
  await settleTicks();
  assert.equal(
    document.activeElement?.closest('.pinned-grid__tile')?.dataset.pinKey,
    'flights:x',
  );
});

test('turning Weather on from Data Layers shows its list in Context', async (t) => {
  const { $, cards, pinia, notifyLayers } = fixture(t, [flightsOn([])]);
  t.after(resetContextLists);
  const chrome = usePanelChromeStore(pinia);
  const owner = chrome.connect({});
  t.after(() => chrome.detach(owner));
  chrome.publish(owner, 'global-context-panel', { collapsed: false });
  chrome.publish(owner, 'data-panel', { collapsed: false });
  await settleTicks();
  cards.allLayers();
  await settleTicks();
  notifyLayers({
    type: 'visibility',
    layerId: 'weather-radar',
    enabled: true,
    origin: 'user',
  });
  assert.equal(cards.lastDirectOn?.layerId, 'weather-radar');
  setContextListPresence('weather', { count: 2 });
  await settleTicks();
  assert.equal($('#context-tab-lists').getAttribute('aria-selected'), 'true');
  assert.notEqual($('#context-lists').style.display, 'none');
  assert.notEqual($('#context-list-weather').style.display, 'none');
  assert.equal(chrome.panels['data-panel'].collapsed, false);
});

test('each Lists sub-tab controls a tab panel that names it', async (t) => {
  const { $, pinia } = fixture(t, [flightsOn([])]);
  t.after(resetContextLists);
  useSpaceMissionsStore(pinia).setEnabled(true);
  setContextListPresence('weather', { count: 2 });
  setContextListPresence('news', { count: 3 });
  showContextList('weather');
  await settleTicks();
  const tabs = [
    ...document.querySelectorAll('.context-list-tabs [role="tab"]'),
  ];
  assert.deepEqual(
    tabs.map((tab) => tab.id),
    ['context-list-tab-weather', 'context-list-tab-news'],
  );
  for (const tab of tabs) {
    const pane = document.getElementById(tab.getAttribute('aria-controls'));
    assert.ok(pane, `${tab.id} controls a pane in the page`);
    assert.equal(pane.getAttribute('role'), 'tabpanel');
    assert.equal(pane.getAttribute('aria-labelledby'), tab.id);
  }
  assert.ok($('#context-lists'));
});

test('turning Radio on brings Inspect forward and keeps the pick; a station picked on the globe takes its place', async (t) => {
  const { $, cards, pinia, letGone } = fixture(t, [
    flightsOn([flight('test01', 30.3, -97.7)]),
  ]);
  const pinned = usePinnedStore(pinia);
  pinned.pin({
    key: 'flights:x',
    kind: 'item',
    title: 'X',
    icon: 'flight',
    identity: { layerId: 'flights', id: 'x' },
  });
  t.after(() => pinned.unpin('flights:x'));
  pinned.show('pinned');
  cards.select({ layerId: 'flights', id: 'test01' }, { follow: false });
  await nextTick();
  pinned.show('pinned');
  document.dispatchEvent(new CustomEvent('gev:radio-show-stations'));
  await nextTick();
  assert.equal(pinned.tab, 'inspect');
  assert.equal(
    cards.card?.identity.id,
    'test01',
    'the pick (and any follow) stays',
  );
  pinned.show('pinned');
  await nextTick();
  const cockpit = useCockpitStore(pinia);
  cockpit.publishPresence({ active: true });
  document.dispatchEvent(
    new CustomEvent('gev:radio-selected', { detail: { stationId: 'kut' } }),
  );
  await nextTick();
  assert.equal(
    cards.card?.identity.id,
    'test01',
    'Cockpit retains its passenger flight',
  );
  assert.equal(pinned.tab, 'pinned');
  assert.deepEqual(
    letGone,
    [],
    'the ambient pick does not release the aircraft',
  );
  cockpit.publishPresence({ active: false });
  document.dispatchEvent(
    new CustomEvent('gev:radio-selected', { detail: { stationId: 'kut' } }),
  );
  await nextTick();
  assert.equal(
    cards.card,
    null,
    'a station picked on the globe is the new pick',
  );
  assert.equal($('#context-tab-inspect').getAttribute('aria-selected'), 'true');
});

test('every card: three buttons at most and an Ask icon; Follow for what moves, Fly to for what does not', async (t) => {
  const { $, cards, asked } = fixture(t, [
    flightsOn([flight('test01', 30.3, -97.7)]),
    {
      id: 'earthquakes',
      name: 'Earthquakes',
      enabled: true,
      records: [
        { id: 'q1', usgsId: 'q1', magnitude: 4.2, lat: 30.2, lon: -97.6 },
      ],
    },
  ]);
  const labels = () =>
    [
      ...document.querySelectorAll('#entity-card .entity-card__actions button'),
    ].map(
      (button) =>
        button.textContent.trim() || button.getAttribute('aria-label'),
    );
  cards.select({ layerId: 'flights', id: 'test01' }, { follow: false });
  await nextTick();
  assert.deepEqual(labels().slice(0, 2), ['navigationFollow', 'keepPin']);
  assert.match(labels()[2], /^Ask GEV about TEST01$/);
  assert.equal(labels().length, 3, 'no Fly to, no TR-3B, no long Ask button');
  $('.entity-card__action--ask-icon').click();
  assert.deepEqual(
    asked,
    [{ key: cards.card.key, title: 'TEST01' }],
    'the Ask icon opens Chat with this item',
  );
  cards.select({ layerId: 'earthquakes', id: 'q1' }, { fly: false });
  await nextTick();
  assert.deepEqual(labels().slice(0, 2), ['my_locationFly to', 'keepPin']);
  assert.ok(
    $('.entity-card__action-row .entity-card__action--primary'),
    'Fly to leads when nothing else does',
  );
});

// The source line's age is a number in the locale's own form.
test('a card’s source line words its age with the locale’s number format', async (t) => {
  const observedMs = Date.now() - 1500 * 86_400_000;
  const { $, cards } = fixture(t, [
    {
      id: 'earthquakes',
      name: 'Earthquakes',
      enabled: true,
      records: [
        { id: 'q1', title: 'M4 quake', lat: 30.3, lon: -97.7, observedMs },
      ],
    },
  ]);
  cards.select({ layerId: 'earthquakes', id: 'q1' }, { fly: false });
  await nextTick();
  assert.match(
    $('.entity-card__head .entity-card__source-line')?.textContent || '',
    /1,500 d ago/,
  );
});

test('a card has one source line under its name, its key numbers, then Nearby before More details', async (t) => {
  const { $, cards } = fixture(t, [
    flightsOn(
      [
        {
          ...flight('test01', 30.3, -97.7),
          speedMps: 200,
          heading: 71,
          verticalRateMps: 0,
        },
        flight('next01', 30.31, -97.71),
        flight('far01', 31.8, -97.7),
      ],
      { source: 'OpenSky' },
    ),
  ]);
  cards.select({ layerId: 'flights', id: 'test01' }, { follow: false });
  await nextTick();
  const line = $('.entity-card__head .entity-card__source-line');
  assert.ok(line, 'one small source line in the header');
  assert.match(line.textContent, /OpenSky/);
  const tiles = [
    ...document.querySelectorAll('#entity-card .entity-card__tile span'),
  ].map((span) => span.textContent);
  assert.deepEqual(
    tiles,
    ['Altitude', 'Speed', 'Heading'],
    'altitude, speed and heading, live; the climb rate stays a fact',
  );
  const nearby = $('#entity-card .nearby-lists');
  const more = $('#entity-card .entity-card__more');
  assert.ok(nearby && more);
  assert.match(
    $('#entity-card .nearby-lists__title').textContent,
    /^Nearby · 250 km$/,
  );
  assert.ok(
    nearby.compareDocumentPosition(more) & Node.DOCUMENT_POSITION_FOLLOWING,
    'Nearby, then More details',
  );
  assert.equal($('#entity-card .spot-conditions__weather'), null);
  const slider = $('#entity-card .spot-conditions__radius input');
  assert.equal(slider.getAttribute('aria-valuetext'), '250 km');
  assert.equal(
    slider.closest('.spot-conditions__radius').nextElementSibling,
    nearby,
  );
  assert.ok(nearby.querySelector('[data-row-key="flights:far01"]'));
  slider.value = '2';
  slider.dispatchEvent(new window.Event('input', { bubbles: true }));
  await nextTick();
  assert.equal(slider.getAttribute('aria-valuetext'), '100 km');
  assert.match(
    nearby.querySelector('.nearby-lists__title').textContent,
    /^Nearby · 100 km$/,
  );
  assert.equal(nearby.querySelector('[data-row-key="flights:far01"]'), null);
  assert.ok(nearby.querySelector('[data-row-key="flights:next01"]'));
  assert.match(more.textContent, /Data source.*OpenSky/s);
});

test("Nearby on a card lists the picked item's own layer first", async (t) => {
  const { $, cards } = fixture(t, [
    flightsOn([flight('plane01', 30.28, -97.75)]),
    {
      id: 'ais-live-vessels',
      name: 'Live Vessels',
      enabled: true,
      records: [
        { id: 'b1', mmsi: 'b1', name: 'PICKED', lat: 30.27, lon: -97.74 },
        { id: 'b2', mmsi: 'b2', name: 'OTHER BOAT', lat: 30.4, lon: -97.9 },
      ],
    },
  ]);
  cards.select({ layerId: 'ais-live-vessels', id: 'b1' }, { fly: false });
  await nextTick();
  const order = [
    ...document.querySelectorAll('#entity-card .nearby-lists__layer'),
  ].map((list) => list.dataset.layer);
  assert.deepEqual(order, ['ais-live-vessels', 'flights']);
});

test('nothing picked: the time reads local and UTC, and there is only counts and one Nearby section', async (t) => {
  const { $, cards } = fixture(t, [flightsOn([flight('far01', 35, -90)])]);
  cards.setView(localView());
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

test('a vessel drawn with a model shows it on top, the map beside it; with no model, the map alone', async (t) => {
  await withFleet(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const active = [];
  const { $, cards } = fixture(
    t,
    [
      {
        id: 'ais-live-vessels',
        name: 'Live Vessels',
        enabled: true,
        records: [
          {
            id: 'boat01',
            mmsi: '366000001',
            name: 'BOAT',
            shipType: 'Cargo',
            lat: 30.28,
            lon: -97.74,
          },
        ],
      },
    ],
    {
      previews: {
        ...STUB_PREVIEWS,
        model: (_host, _spec, { onReady }) => {
          onReady();
          return {
            setActive: (value) => active.push(value),
            update() {},
            destroy() {},
          };
        },
      },
    },
  );
  cards.select({ layerId: 'ais-live-vessels', id: 'boat01' }, { fly: false });
  await nextTick();
  await turn();
  await nextTick();
  assert.equal($('.entity-hero').dataset.hero, 'model');
  assert.ok($('.entity-hero .aircraft-hero'), 'the model draws while paused');
  assert.equal(
    Boolean($('.entity-hero .close-up-map')),
    false,
    'the map is made only once it is picked',
  );
  const switches = [
    ...document.querySelectorAll(
      '#entity-card .entity-card__preview-switch button',
    ),
  ];
  assert.deepEqual(
    switches.map((button) => button.title),
    ['3D model', 'Map', 'Play preview'],
  );
  assert.equal(
    switches[2].getAttribute('aria-label'),
    'Play preview',
    'the card starts paused',
  );
  assert.equal(active.at(-1), false, 'the model does not rotate');
  t.mock.timers.tick(HERO_AUTOPLAY_MS * 2);
  await nextTick();
  assert.equal(
    switches[0].getAttribute('aria-pressed'),
    'true',
    'the first view stays until Play',
  );
  switches[2].click();
  await nextTick();
  assert.equal(active.at(-1), true, 'Play starts model rotation');
  switches[2].click();
  await nextTick();
  assert.equal(active.at(-1), false, 'Pause stops model rotation');
  switches[2].click();
  await nextTick();
  t.mock.timers.tick(HERO_AUTOPLAY_MS - 1);
  await nextTick();
  assert.equal(
    switches[0].getAttribute('aria-pressed'),
    'true',
    'Play starts a fresh view timer',
  );
  t.mock.timers.tick(1);
  await nextTick();
  assert.equal(
    switches[1].getAttribute('aria-pressed'),
    'true',
    'the next view follows the timer',
  );
  assert.equal(active.at(-1), false, 'the hidden model stops');
  switches[1].click();
  await nextTick();
  assert.equal(
    switches[1].getAttribute('aria-pressed'),
    'true',
    'the map, picked',
  );
  cards.card = { ...cards.card, lat: null, lon: null };
  await nextTick();
  assert.equal(
    $('button[aria-label="Map"]'),
    null,
    'without a position only the model remains',
  );
  const play = $('.entity-card__preview-play');
  assert.ok(play, 'a lone model still offers Play');
  play.click();
  await nextTick();
  assert.equal(
    active.at(-1),
    true,
    'Play rotates the lone model without a view timer',
  );
  resetFleetModelSet();
  cards.clear();
  await nextTick();
  cards.select({ layerId: 'ais-live-vessels', id: 'boat01' }, { fly: false });
  await nextTick();
  assert.equal(
    $('.entity-hero').dataset.hero,
    'map',
    'no model set loaded: the close-up map',
  );
});

test('an aircraft without a photo, route or model shows a close-up map, never its icon', async (t) => {
  const { $, cards } = fixture(t, [flightsOn([flight('test01', 30.3, -97.7)])]);
  cards.select({ layerId: 'flights', id: 'test01' }, { follow: false });
  await nextTick();
  await turn();
  await nextTick();
  assert.equal($('.entity-hero').dataset.hero, 'map');
  assert.equal(Boolean($('.entity-hero__placeholder')), false);
});

test('Camera settings follows only the camera that owns the selected card', async (t) => {
  const camera = { id: 'wanted', name: 'Saved camera', ...HERE };
  const { $, cards, pinia } = fixture(t, [
    {
      id: 'cctv',
      name: 'Cameras',
      enabled: true,
      records: [camera],
      module: { selectCamera: () => false },
    },
  ]);
  const state = useCctvStore(pinia);
  const active = (id) =>
    state.publish(
      presentCctvPanel({ enabled: true, activeCameraId: id }, true),
    );
  active('other');
  cards.select({ layerId: 'cctv', id: camera.id }, { fly: false });
  await settleTicks();
  $('#context-tab-camera').click();
  await settleTicks();
  assert.equal(
    Boolean($('#cctv-tools-slot')),
    false,
    'selection failed and the other camera stays active',
  );
  active(camera.id);
  $('#context-tab-camera').click();
  await settleTicks();
  assert.ok($('#cctv-tools-slot'));
  assert.equal(state.settingsCameraId, camera.id);
  active('other');
  await settleTicks();
  assert.equal(
    Boolean($('#cctv-tools-slot')),
    false,
    'a quiet selection change closes the tools',
  );
  assert.equal(state.settingsCameraId, null);
});

test('Camera settings fills its tab, and empties it, while another root renders in the same flush', async (t) => {
  const camera = { id: 'cam-tools', name: 'Tools camera', ...HERE };
  const { $, cards, pinia } = fixture(t, [
    {
      id: 'cctv',
      name: 'Cameras',
      enabled: true,
      records: [camera],
      module: { selectCamera: () => true },
    },
  ]);
  const state = useCctvStore(pinia);
  state.publish(
    presentCctvPanel({ enabled: true, activeCameraId: camera.id }, true),
  );
  // CctvControls repaints the Québec overlay, a root of its own, from a
  // watcher outside any component when the settings camera changes.
  // render() on a mounted root runs the pending post watchers at once,
  // before Context has rendered the tab.
  const host = document.createElement('div');
  renderVue(h('span'), host);
  const stop = watch(
    () => [state.settingsCameraId, state.settingsVisible],
    () => renderVue(h('span', String(state.settingsCameraId)), host),
  );
  t.after(() => {
    stop();
    renderVue(null, host);
  });
  cards.select({ layerId: 'cctv', id: camera.id }, { fly: false });
  await settleTicks();
  $('#context-tab-camera').click();
  await settleTicks();
  assert.equal($('#context-tab-camera').getAttribute('aria-selected'), 'true');
  assert.ok(
    $('#context-tab-panel #cctv-tools-slot #cctv-tools'),
    'the tools are in the tab',
  );
  $('#context-tab-inspect').click();
  await settleTicks();
  assert.equal($('#cctv-tools-slot'), null);
  assert.ok($('.cctv-tools-home #cctv-tools'), 'the tools are home, not lost');
  $('#context-tab-camera').click();
  await settleTicks();
  assert.ok(
    $('#context-tab-panel #cctv-tools-slot #cctv-tools'),
    'and in the tab again',
  );
});

test('the Camera settings guide reveals the phone Context sheet before targeting its tab', async (t) => {
  const camera = { id: 'cam1', name: 'Street camera', ...HERE };
  const { $, cards, pinia } = fixture(
    t,
    [{ id: 'cctv', name: 'Cameras', enabled: true, records: [camera] }],
    { startOpen: false },
  );
  const chrome = usePanelChromeStore(pinia);
  const display = useDisplayStore(pinia);
  const calls = [];
  const token = chrome.connect({
    reveal: (id) => {
      calls.push(['reveal', id]);
      display.publishPhoneShell({ enabled: true, sheet: 'context' });
      chrome.publish(token, id, { collapsed: false });
    },
    toggle: (id) => calls.push(['toggle', id]),
  });
  t.after(() => chrome.detach(token));
  chrome.publish(token, 'global-context-panel', { collapsed: true });
  display.publishPhoneShell({ enabled: true, sheet: 'layers' });
  const step = layerSettingsGuide({ id: 'cctv', shown: 'Cameras' }).at(-1);

  await step.prepare();
  assert.deepEqual(calls, [], 'without a camera the guide leaves Layers open');
  assert.equal(step.skip(), true);

  useCctvStore(pinia).publish(
    presentCctvPanel({ enabled: true, activeCameraId: camera.id }, true),
  );
  cards.select({ layerId: 'cctv', id: camera.id }, { fly: false });
  await nextTick();
  assert.equal($('#context-tab-camera'), null);

  await step.prepare();
  assert.deepEqual(calls, [['reveal', 'global-context-panel']]);
  assert.equal(display.phoneShell.sheet, 'context');
  assert.equal(step.skip(), false);
  assert.deepEqual(step.targets(), [$('#context-tab-camera')]);
  assert.equal($('#context-tab-camera').getAttribute('aria-selected'), 'true');
  assert.equal(cards.card?.identity.id, camera.id);
  const state = useCctvStore(pinia);
  const publishAdjust = (calibrationMode) =>
    state.publish(
      presentCctvPanel(
        {
          enabled: true,
          activeCameraId: camera.id,
          activeCamera: camera,
          calibrationMode,
        },
        true,
      ),
    );
  publishAdjust(true);
  await nextTick();
  const adjust = $('#cctv-tools-slot #cctv-adjust-btn');
  assert.equal(adjust.getAttribute('aria-pressed'), 'true');
  adjust.addEventListener('click', () => publishAdjust(false), { once: true });
  const sheetButton = document.body.appendChild(
    document.createElement('button'),
  );
  t.after(() => sheetButton.remove());
  sheetButton.focus();
  display.publishPhoneShell({ enabled: true, sheet: 'layers' });
  await nextTick();
  assert.equal(
    Boolean($('#cctv-tools-slot')),
    false,
    'expanded Context is off screen',
  );
  assert.equal($('.cctv-tools-home #cctv-adjust-btn') === adjust, true);
  assert.equal(adjust.getAttribute('aria-pressed'), 'false');
  assert.equal(document.activeElement === sheetButton, true);
  display.publishPhoneShell({ enabled: true, sheet: 'context' });
  await nextTick();
  assert.equal($('#cctv-tools-slot #cctv-adjust-btn') === adjust, true);
  assert.equal(adjust.getAttribute('aria-pressed'), 'false');
});

test('a camera card: Fly to, Pin and Dock in the row; its tools are a Camera settings tab; docking never pins', async (t) => {
  const camera = { id: 'cam1', name: 'I-35 @ 12th', lat: 30.27, lon: -97.73 };
  const { $, cards, pinia } = fixture(t, [
    {
      id: 'cctv',
      name: 'Cameras',
      enabled: true,
      records: [camera],
      module: {
        frameUrlForCamera: (id) => ({
          url: `/frame/${id}.jpg`,
          refreshMs: 10_000,
        }),
        cameraDetails: () => ({
          name: camera.name,
          city: 'Austin',
          provider: 'TxDOT',
          credit: 'City of Austin',
          feedType: 'image',
          headingDeg: 0,
          fovDeg: 40,
          rangeM: 120,
          refreshMs: 10_000,
        }),
      },
    },
    flightsOn([flight('test01', 30.3, -97.7)]),
  ]);
  // The camera is the active one (CctvControls publishes this).
  useCctvStore(pinia).publish(
    presentCctvPanel({ enabled: true, activeCameraId: 'cam1' }, true),
  );
  cards.select({ layerId: 'cctv', id: 'cam1' }, { fly: false });
  await nextTick();
  await nextTick();
  const tiles = [
    ...document.querySelectorAll('#entity-card .entity-card__tile'),
  ].map((tile) => [
    tile.querySelector('span').textContent,
    tile.querySelector('strong').textContent,
  ]);
  assert.deepEqual(tiles, [
    ['City', 'Austin'],
    ['Field of view', '40°'],
    ['Range', '120 m'],
  ]);
  // The provider is named plainly as the source; the feed is its own fact;
  // facing and refresh, not in the row, are here too.
  const more = $('#entity-card .entity-card__more').textContent;
  assert.match(more, /Feed\s*Image/);
  assert.match(more, /Data source\s*TxDOT/);
  assert.match(more, /Facing\s*N/);
  assert.match(more, /Refresh\s*10 s/);
  assert.doesNotMatch(
    more,
    /City|Field of view|Range/,
    'nothing in the row again under More details',
  );
  // The source line names the provider and the frame's age, not its refresh.
  assert.doesNotMatch(
    $('#entity-card .entity-card__source-line')?.textContent || '',
    /10 s/,
  );
  assert.match(
    $('#entity-card .entity-card__subtitle').textContent,
    /^Austin · 30\.27, -97\.73$/,
  );
  // Three buttons and the Ask icon; the dock is one of the buttons, not an
  // icon on the image.
  const row = [
    ...document.querySelectorAll(
      '#entity-card .entity-card__action-row button',
    ),
  ];
  assert.deepEqual(
    row.map((button) => button.textContent.trim() || 'ask'),
    ['my_locationFly to', 'keepPin', 'picture_in_picture_altDock', 'ask'],
  );
  assert.equal($('.entity-hero__dock'), null, 'no dock icon on a camera image');
  // The camera's tools are a Camera settings tab beside Inspect, not part of
  // the card.
  assert.equal($('#entity-card #cctv-tools'), null, 'no tools on the card');
  assert.equal(
    $('#entity-card .cctv-tools__summary'),
    null,
    'no Camera tools fold',
  );
  const tabNames = () =>
    [
      ...document.querySelectorAll(
        '#context-body > .context-pin-tabs [role="tab"]',
      ),
    ].map((tab) => tab.textContent.trim());
  assert.deepEqual(tabNames(), ['Inspect', 'Camera settings']);
  $('#context-tab-camera').click();
  await nextTick();
  await nextTick();
  assert.equal($('#context-tab-camera').getAttribute('aria-selected'), 'true');
  assert.ok(
    !$('#context-tab-view #entity-card'),
    'the card gives way to the tab',
  );
  assert.ok(
    $('#context-tab-panel #cctv-tools-slot #cctv-tools'),
    'the tools are in the tab',
  );
  // A search puts the tools away; clearing it brings them back.
  contextSearchOpen.value = true;
  contextSearchText.value = 'zzz';
  await nextTick();
  await nextTick();
  assert.ok($('.cctv-tools-home #cctv-tools'), 'home while searching');
  contextSearchText.value = '';
  closeContextSearch();
  await nextTick();
  await nextTick();
  assert.ok(
    $('#context-tab-panel #cctv-tools-slot #cctv-tools'),
    'back in the tab',
  );
  // Inspect again: the tools go home and the card is back.
  $('#context-tab-inspect').click();
  await nextTick();
  await nextTick();
  assert.ok($('.cctv-tools-home #cctv-tools'), 'home on Inspect');
  assert.ok($('#entity-card'), 'the card is back');
  // Voice or search asking for camera settings shows the tab.
  document.dispatchEvent(new CustomEvent(CAMERA_SETTINGS_EVENT));
  await nextTick();
  await nextTick();
  await nextTick();
  assert.equal($('#context-tab-camera').getAttribute('aria-selected'), 'true');
  $('#context-tab-inspect').click();
  await nextTick();
  // Dock: pressed while docked, and pressing again undocks.
  const dock = () => $('.entity-card__action--dock');
  dock().click();
  await nextTick();
  assert.equal(dock().getAttribute('aria-pressed'), 'true');
  assert.match(dock().textContent, /Docked/);
  const docked = $('.context-corner .docked-view');
  assert.ok(docked, 'docked bottom right');
  assert.match(docked.textContent, /I-35 @ 12th/);
  assert.equal(
    docked.querySelector('img').getAttribute('src'),
    '/frame/cam1.jpg',
  );
  // Credited under its picture as its card's source line names it; the dock
  // keeps who it is from, for when Cameras goes off.
  assert.equal(
    docked.querySelector('.docked-view__credit')?.textContent,
    'TxDOT · City of Austin',
  );
  assert.deepEqual(useDockedStore(pinia).view.source, {
    provider: 'TxDOT',
    credit: 'City of Austin',
  });
  assert.equal(usePinnedStore(pinia).pins.length, 0, 'docking never pins');
  dock().click();
  await nextTick();
  assert.equal($('.docked-view'), null, 'pressing Docked undocks');
  dock().click();
  await nextTick();
  // Inspect stays free: another pick keeps the dock, and the tools go home.
  cards.select({ layerId: 'flights', id: 'test01' }, { follow: false });
  await nextTick();
  await nextTick();
  assert.ok($('.docked-view'), 'the camera stays docked');
  assert.ok($('.cctv-tools-home #cctv-tools'), 'the tools stay home');
  assert.equal(
    $('#context-tab-camera'),
    null,
    'no Camera settings tab off a camera',
  );
  cards.select({ layerId: 'cctv', id: 'cam1' }, { fly: false });
  await nextTick();
  assert.ok($('#context-tab-camera'), 'the tab is back with the camera card');
  cards.select({ layerId: 'flights', id: 'test01' }, { follow: false });
  await nextTick();
  $('.docked-view').querySelector('button').click();
  await nextTick();
  assert.equal(cards.card.identity.id, 'cam1', 'back in Context');
  assert.equal(useDockedStore(pinia).view, null, 'and no longer docked');
  // Its pin keeps who the feed is from, to credit its still.
  $('.entity-card__action--pin').click();
  await nextTick();
  assert.deepEqual(usePinnedStore(pinia).pins[0]?.source, {
    provider: 'TxDOT',
    credit: 'City of Austin',
  });
});

test('a docked camera whose layer goes off says it is out of feed, not live', async (t) => {
  let frames = true;
  const camera = { id: 'cam1', name: 'I-35 @ 12th', lat: 30.27, lon: -97.73 };
  const { $, pinia } = fixture(t, [
    {
      id: 'cctv',
      name: 'Cameras',
      enabled: true,
      records: [camera],
      module: {
        frameUrlForCamera: (id) =>
          frames ? { url: `/frame/${id}.jpg`, refreshMs: 10_000 } : null,
      },
    },
  ]);
  useDockedStore(pinia).dock({
    key: 'cctv:cam1',
    kind: 'camera',
    title: camera.name,
    identity: { layerId: 'cctv', id: 'cam1' },
  });
  await nextTick();
  // Live once its frame has loaded, not before.
  assert.equal($('.docked-view__tag').textContent, 'Docked · loading');
  $('.docked-view img').dispatchEvent(new Event('load'));
  await nextTick();
  assert.match($('.docked-view__tag').textContent, /live/);
  frames = false;
  await new Promise((resolve) => setTimeout(resolve, 2100));
  await nextTick();
  assert.equal($('.docked-view img'), null, 'no stale frame');
  assert.match($('.docked-view__tag').textContent, /out of feed/);
});

test('a docked camera is not shown twice: its own card has a Docked bar, and Show here undocks it', async (t) => {
  const camera = { id: 'cam1', name: 'I-35 @ 12th', lat: 30.27, lon: -97.73 };
  const { $, cards, pinia } = fixture(t, [
    {
      id: 'cctv',
      name: 'Cameras',
      enabled: true,
      records: [camera],
      module: {
        frameUrlForCamera: (id) => ({
          url: `/frame/${id}.jpg`,
          refreshMs: 10_000,
        }),
      },
    },
  ]);
  cards.select({ layerId: 'cctv', id: 'cam1' }, { fly: false });
  await nextTick();
  assert.ok($('#entity-card .cctv-preview'), 'the feed shows on the card');
  $('.entity-card__action--dock').click();
  await nextTick();
  assert.equal(
    $('#entity-card .cctv-preview'),
    null,
    'not a second time on the card',
  );
  assert.ok($('.docked-view img'), 'the dock shows it');
  // The bar says what the dock says: loading until its frame loads, then live.
  assert.match(
    $('#entity-card .entity-hero--docked').textContent,
    /Docked · loading/,
  );
  assert.equal(
    $('#entity-card .entity-hero--docked .feed-dot').dataset.state,
    'loading',
  );
  $('.docked-view img').dispatchEvent(new Event('load'));
  await nextTick();
  assert.match(
    $('#entity-card .entity-hero--docked').textContent,
    /Docked · bottom right/,
  );
  assert.equal(
    $('#entity-card .entity-hero--docked .feed-dot').dataset.state,
    'live',
  );
  $('.entity-hero__docked-show').click();
  await nextTick();
  assert.equal(useDockedStore(pinia).view, null, 'Show here undocks');
  assert.ok(
    $('#entity-card .cctv-preview'),
    'and the feed is back on the card',
  );
});

// A camera's enlarged view takes its own Esc. With the panel's Esc (as
// PanelChrome binds it) and the map's (entityContextBridge) both bound, one
// Esc closes the view and does nothing else, with focus on the page (Safari
// and Firefox leave a clicked button unfocused) or on the button that
// opened it (Chrome focuses it).
test('Esc with a camera’s enlarged view open closes only the view, from the page or from its button', async (t) => {
  const camera = { id: 'cam1', name: 'I-35 @ 12th', lat: 30.27, lon: -97.73 };
  const { $, cards, pinia, close, dataManager } = fixture(t, [
    {
      id: 'cctv',
      name: 'Cameras',
      enabled: true,
      records: [camera],
      module: {
        frameUrlForCamera: (id) => ({
          url: `/frame/${id}.jpg`,
          refreshMs: 10_000,
        }),
        cameraDetails: () => ({
          name: camera.name,
          city: 'Austin',
          provider: 'TxDOT',
          feedType: 'image',
          refreshMs: 10_000,
        }),
      },
    },
  ]);
  const viewer = { scene: { pick: () => null, drillPick: () => [] } };
  const input = fakeInput(viewer);
  const disconnect = installEntityContext({
    viewer,
    getDataManager: dataManager,
    pinia,
  });
  t.after(() => {
    disconnect();
    input.destroy();
  });
  const panel = $('#global-context-panel');
  let collapses = 0;
  const disclosure = bindPanelDisclosure({
    panel,
    onEscape: (event) =>
      collapsePanelOnEscape(event, {
        panel,
        onChange: (collapsed) => {
          if (!collapsed) return;
          collapses += 1;
          close();
        },
      }),
  });
  t.after(() => disclosure.destroy());
  const cctv = useCctvStore(pinia);
  cctv.publish(
    presentCctvPanel({ enabled: true, activeCameraId: 'cam1' }, true),
  );
  cards.select({ layerId: 'cctv', id: 'cam1' }, { fly: false });
  cctv.setFrame({ cameraId: 'cam1', src: '/frame/cam1.jpg' });
  await nextTick();
  await nextTick();
  const expand = () => $('#entity-card .cctv-preview__expand');
  const popup = () => document.querySelector('.cctv-popup');
  const effects = () => ({
    popup: Boolean(popup()),
    card: cards.card?.identity.id ?? null,
    collapses,
  });

  expand().click();
  await nextTick();
  assert.ok(popup(), 'the view is open');
  assert.equal(
    popup().hasAttribute('data-owns-escape'),
    true,
    'and owns its Esc',
  );
  assert.equal(escKey(document.body), true);
  await nextTick();
  assert.deepEqual(
    effects(),
    { popup: false, card: 'cam1', collapses: 0 },
    'from the page: the view closes, the card stays',
  );

  expand().click();
  await nextTick();
  assert.ok(popup());
  assert.equal(escKey(expand()), true);
  await nextTick();
  assert.deepEqual(
    effects(),
    { popup: false, card: 'cam1', collapses: 0 },
    'from its button: the view closes, Context stays open',
  );
  assert.equal(panel.contains(expand()), true);

  // With the view closed, the next Esc is Context's again: the pick clears.
  assert.equal(escKey(expand()), true);
  await nextTick();
  assert.deepEqual(effects(), { popup: false, card: null, collapses: 0 });
});

test('a camera card refreshes in place: nothing remounts, and the scrollbar thumb waits for the pointer', async (t) => {
  const camera = { id: 'cam1', name: 'I-35 @ 12th', lat: 30.27, lon: -97.73 };

  const { $, cards, pinia } = fixture(t, [
    {
      id: 'cctv',
      name: 'Cameras',
      enabled: true,
      records: [camera],
      module: {
        cameraDetails: () => ({
          name: camera.name,
          city: 'Austin',
          feedType: 'image',
          headingDeg: 0,
          fovDeg: 40,
          rangeM: 120,
          refreshMs: 1000,
        }),
      },
    },
  ]);
  cards.select({ layerId: 'cctv', id: 'cam1' }, { fly: false });
  await nextTick();
  const cctv = useCctvStore(pinia);
  cctv.publish(
    presentCctvPanel({ enabled: true, activeCameraId: 'cam1' }, true),
  );
  const refresh = (n) =>
    cctv.setFrame({
      cameraId: 'cam1',
      src: '/frame/cam1.jpg?n=' + n,
      hasFrame: true,
    });
  refresh(1);
  await nextTick();
  const card = $('#entity-card');
  const frame = $('.cctv-preview__frame');
  const scroller = $('.global-context-panel-inner');
  assert.ok(scroller);
  scroller.scrollTop = 140;
  assert.equal(
    frame.querySelector('img').getAttribute('src'),
    '/frame/cam1.jpg?n=1',
  );
  refresh(2);
  await nextTick();
  assert.equal($('#entity-card'), card, 'the card is the same element');
  assert.equal(
    $('.cctv-preview__frame'),
    frame,
    'so is its picture box, which keeps its 16:9 height',
  );
  assert.equal(
    frame.querySelector('img').getAttribute('src'),
    '/frame/cam1.jpg?n=2',
  );
  assert.equal(
    scroller.scrollTop,
    140,
    'the scroll position survives the frame update',
  );
  const { readFile } = await import('node:fs/promises');
  const css = await readFile(
    new URL('./styles/layers.css', import.meta.url),
    'utf8',
  );
  assert.match(
    css,
    /\.global-context-panel-inner:not\(:hover\):not\(:focus-within\) \{\s*scrollbar-color: transparent transparent;/,
  );
});

test('the tab row is one line: Inspect holds its start, the other tabs scroll beside it, and arrows move across both', async (t) => {
  const camera = { id: 'cam1', name: 'I-35 @ 12th', lat: 30.27, lon: -97.73 };
  const { $, cards, pinia } = fixture(t, [
    {
      id: 'cctv',
      name: 'Cameras',
      enabled: true,
      records: [camera],
      module: {
        frameUrlForCamera: (id) => ({
          url: `/frame/${id}.jpg`,
          refreshMs: 10_000,
        }),
      },
    },
  ]);
  usePinnedStore(pinia).pin({
    key: 'place:a',
    kind: 'place',
    title: 'Zilker Park',
    icon: 'location_on',
    identity: { layerId: 'place', id: 'a' },
  });
  useCctvStore(pinia).publish(
    presentCctvPanel({ enabled: true, activeCameraId: camera.id }, true),
  );
  cards.select({ layerId: 'cctv', id: 'cam1' }, { fly: false });
  await nextTick();
  await nextTick();
  const row = $('#context-body > .context-pin-tabs--main');
  assert.equal(row.getAttribute('role'), 'tablist');
  assert.equal(
    row.firstElementChild.id,
    'context-tab-inspect',
    'Inspect leads, outside the strip',
  );
  const strip = row.querySelector('.context-pin-tabs__strip');
  assert.deepEqual(
    [...strip.querySelectorAll('[role="tab"]')].map((tab) => tab.id),
    ['context-tab-camera', 'context-tab-pinned'],
  );
  // Arrows go from Inspect into the strip and on.
  const inspect = $('#context-tab-inspect');
  inspect.focus();
  inspect.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
  );
  await nextTick();
  await nextTick();
  assert.equal($('#context-tab-camera').getAttribute('aria-selected'), 'true');
  assert.equal(document.activeElement?.id, 'context-tab-camera');
});

test('the live dot is a dot wherever it is: never stretched by the row it sits in', (t) => {
  const css = styleFixture(
    t,
    ['entity-card'],
    '<div class="entity-hero--docked"><span class="feed-dot"></span><span class="label">Camera</span></div>',
  );
  const dot = css('.feed-dot');
  assert.equal(dot.flex, '0 0 auto');
  assert.ok(parseFloat(dot.width) > 0);
  assert.equal(dot.height, dot.width);
  assert.equal(dot.minWidth, dot.width);
  assert.equal(dot.maxWidth, dot.width);
  assert.equal(css('.label').flexGrow, '1');
});

test('the dock sits in the column under Context, which gives up that room, and takes it back when the dock closes', async (t) => {
  const camera = { id: 'cam1', name: 'I-35 @ 12th', lat: 30.27, lon: -97.73 };
  const { pinia } = fixture(t, [
    {
      id: 'cctv',
      name: 'Cameras',
      enabled: true,
      records: [camera],
      module: {
        frameUrlForCamera: (id) => ({
          url: `/frame/${id}.jpg`,
          refreshMs: 10_000,
        }),
      },
    },
  ]);
  // The test DOM lays nothing out: the panel and the dock report their boxes.
  const panel = document.getElementById('global-context-panel');
  const stack = document.getElementById('right-context-rail');
  const corner = document.querySelector('.context-corner');
  panel.getBoundingClientRect = () => ({
    left: 1218,
    right: 1548,
    top: 100,
    bottom: 520,
    width: 330,
    height: 420,
  });
  stack.style.rowGap = '8px';
  Object.defineProperty(corner, 'offsetHeight', {
    configurable: true,
    get: () => (corner.querySelector('.docked-view') ? 186 : 0),
  });
  const settle = async () => {
    await nextTick();
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 5));
  };
  const windowResize = t.mock.fn();
  globalThis.addEventListener('resize', windowResize);
  t.after(() => globalThis.removeEventListener('resize', windowResize));
  const docked = useDockedStore(pinia);
  docked.dock({
    key: 'cctv:cam1',
    kind: 'camera',
    title: camera.name,
    identity: { layerId: 'cctv', id: 'cam1' },
  });
  await settle();
  assert.ok(corner.classList.contains('context-corner--column'));
  assert.equal(corner.style.top, '528px', 'one gap under the panel');
  assert.equal(corner.style.width, '330px', 'as wide as the panel');
  assert.equal(
    stack.dataset.cornerReserve,
    '194',
    'the column keeps room for it',
  );
  docked.close();
  await settle();
  assert.equal(
    stack.dataset.cornerReserve,
    undefined,
    'Context takes its height back',
  );
  assert.equal(
    windowResize.mock.callCount(),
    0,
    'only the right rail needs to relayout',
  );
});

// These fixture URLs always serve their registered camera image; carry that
// response's source alongside the frame, as the production reader does.
function cameraFrameFixture(url) {
  return {
    url,
    refreshMs: 10_000,
    readImage: async () => ({
      url,
      sourceKind: 'upstream-image',
      release() {},
    }),
  };
}

test('a docked camera stays live with Cameras off, and so does its pin; other pins pause, and closing the dock pauses it', async (t) => {
  const cams = [
    { id: 'cam1', name: 'LP 410 at Culebra', lat: 29.47, lon: -98.6 },
    { id: 'cam2', name: 'I-10 at Wurzbach', lat: 29.53, lon: -98.56 },
  ];
  const cctv = {
    id: 'cctv',
    name: 'Cameras',
    enabled: true,
    records: cams,
    module: {
      frameUrlForCamera: (id) => cameraFrameFixture(`/frame/${id}.jpg`),
    },
  };
  const { $, cards, pinia, notifyLayers } = fixture(t, [
    cctv,
    flightsOn([flight('test01', 30.3, -97.7)]),
  ]);
  // The test DOM cannot draw images: each frame the dock shows is kept as this.
  _setFrameStillCaptureForTest(async () => 'data:image/jpeg;base64,DOCKED');
  t.after(() => _setFrameStillCaptureForTest(null));
  const docked = useDockedStore(pinia);
  const pinned = usePinnedStore(pinia);
  const tile = (key) =>
    $(`.pinned-grid__tile[data-kind="camera"]:nth-child(${key})`);
  for (const camera of cams) {
    cards.select({ layerId: 'cctv', id: camera.id }, { fly: false });
    await nextTick();
    pinned.pin({
      key: `cctv:${camera.id}`,
      kind: 'camera',
      title: camera.name,
      icon: 'videocam',
      identity: {
        layerId: 'cctv',
        id: camera.id,
        label: camera.name,
        lat: camera.lat,
        lon: camera.lon,
      },
      still: `data:image/jpeg;base64,PIN-${camera.id}`,
    });
  }
  cards.select({ layerId: 'cctv', id: 'cam1' }, { fly: false });
  await nextTick();
  $('.entity-card__action--dock').click();
  cards.select({ layerId: 'flights', id: 'test01' }, { follow: false });
  await nextTick();
  $('.docked-view img').dispatchEvent(new Event('load'));
  await turn();
  // Cameras off in Data Layers: the dock keeps its one feed.
  cctv.enabled = false;
  notifyLayers();
  await new Promise((resolve) => setTimeout(resolve, 2100));
  await nextTick();
  assert.match($('.docked-view__tag').textContent, /Docked · live/);
  assert.equal($('.docked-view .feed-dot').dataset.state, 'live');
  assert.equal(
    $('.docked-view img').getAttribute('src'),
    '/frame/cam1.jpg',
    'still reading its feed',
  );
  assert.equal(cctv.enabled, false, 'never turned back on');
  // Its pin mirrors the dock; the other pin pauses on its last frame.
  pinned.show('pinned');
  await nextTick();
  assert.equal(tile(1).querySelector('.feed-dot').dataset.state, 'live');
  assert.equal(tile(1).querySelector('.paused-chip'), null);
  assert.equal(
    pinned.stillOf('cctv:cam1'),
    'data:image/jpeg;base64,DOCKED',
    "the dock's latest frame",
  );
  assert.match(tile(2).querySelector('.paused-chip').textContent, /Paused/);
  assert.equal(
    tile(2).querySelector('.paused-chip').getAttribute('title'),
    'Cameras off · last frame',
  );
  assert.equal(pinned.stillOf('cctv:cam2'), 'data:image/jpeg;base64,PIN-cam2');
  // Closing the dock pauses its pin, on the last frame the dock showed.
  $('.docked-view button[title="Close"]').click();
  await nextTick();
  assert.match(tile(1).querySelector('.paused-chip').textContent, /Paused/);
  assert.equal(pinned.stillOf('cctv:cam1'), 'data:image/jpeg;base64,DOCKED');
});

test('a docked camera whose feed fails or drops out says so on its pin and its card, as the dock does, never live', async (t) => {
  let frames = true;
  const camera = { id: 'cam1', name: 'I-35 @ 12th', lat: 30.27, lon: -97.73 };
  const { $, cards, pinia } = fixture(t, [
    {
      id: 'cctv',
      name: 'Cameras',
      enabled: true,
      records: [camera],
      module: {
        frameUrlForCamera: (id) =>
          frames ? { url: `/frame/${id}.jpg`, refreshMs: 10_000 } : null,
      },
    },
  ]);
  _setFrameStillCaptureForTest(async () => 'data:image/jpeg;base64,DOCKED');
  t.after(() => _setFrameStillCaptureForTest(null));
  const pinned = usePinnedStore(pinia);
  cards.select({ layerId: 'cctv', id: 'cam1' }, { fly: false });
  await nextTick();
  pinned.pin({
    key: 'cctv:cam1',
    kind: 'camera',
    title: camera.name,
    icon: 'videocam',
    identity: { layerId: 'cctv', id: 'cam1' },
  });
  $('.entity-card__action--dock').click();
  await nextTick();
  const dockDot = () => $('.docked-view .feed-dot');
  const cardDot = () => $('#entity-card .entity-hero--docked .feed-dot');
  const cardBar = () => $('#entity-card .entity-hero--docked').textContent;
  const pinDot = () => $('.pinned-grid__tile[data-kind="camera"] .feed-dot');
  // The pin is on the Pinned tab and the card on Inspect: each is read in turn.
  const pinSays = async () => {
    pinned.show('pinned');
    await nextTick();
    const dot = pinDot();
    const said = {
      state: dot?.dataset.state,
      label: dot?.getAttribute('aria-label'),
      chip: Boolean($('.pinned-grid .paused-chip')),
    };
    pinned.show('inspect');
    await nextTick();
    return said;
  };
  $('.docked-view img').dispatchEvent(new Event('load'));
  await nextTick();
  assert.equal(dockDot().dataset.state, 'live');
  assert.equal(cardDot().dataset.state, 'live');
  assert.deepEqual(await pinSays(), {
    state: 'live',
    label: 'Docked · live',
    chip: false,
  });

  // The frame fails: the dock, the card and the pin all say it is unavailable.
  $('.docked-view img').dispatchEvent(new Event('error'));
  await nextTick();
  assert.equal(
    $('.docked-view__tag').textContent,
    'Docked · frame unavailable',
  );
  assert.equal(dockDot().dataset.state, 'lost');
  assert.equal(cardDot().dataset.state, 'lost');
  assert.equal(
    cardDot().getAttribute('aria-label'),
    'Docked · frame unavailable',
  );
  assert.match(cardBar(), /Docked · frame unavailable/);
  assert.doesNotMatch(cardBar(), /bottom right/);
  assert.deepEqual(await pinSays(), {
    state: 'lost',
    label: 'Docked · frame unavailable',
    chip: false,
  });

  // Out of its feed altogether: the same on all three.
  frames = false;
  await new Promise((resolve) => setTimeout(resolve, 2100));
  await nextTick();
  assert.match($('.docked-view__tag').textContent, /out of feed/);
  assert.equal(cardDot().dataset.state, 'lost');
  assert.match(cardBar(), /Docked · out of feed/);
  assert.deepEqual(await pinSays(), {
    state: 'lost',
    label: 'Docked · out of feed',
    chip: false,
  });
});

test('a docked camera whose stream stalls shows the dock’s stalled state on its pin and card', async (t) => {
  const camera = { id: 'cam1', name: 'I-35 @ 12th', lat: 30.27, lon: -97.73 };
  const { $, cards, pinia } = fixture(t, [
    {
      id: 'cctv',
      name: 'Cameras',
      enabled: true,
      records: [camera],
      module: {
        frameUrlForCamera: (id) => ({
          url: `/frame/${id}.jpg`,
          refreshMs: 10_000,
        }),
      },
    },
  ]);
  const pinned = usePinnedStore(pinia);
  const docked = useDockedStore(pinia);
  cards.select({ layerId: 'cctv', id: 'cam1' }, { fly: false });
  await nextTick();
  pinned.pin({
    key: 'cctv:cam1',
    kind: 'camera',
    title: camera.name,
    icon: 'videocam',
    identity: { layerId: 'cctv', id: 'cam1' },
  });
  $('.entity-card__action--dock').click();
  await nextTick();
  // What the dock publishes when its stream stalls (dockedCamera.test.mjs
  // drives the stream itself).
  docked.setFeed('cctv:cam1', 'paused', 'Docked · stalled');
  await nextTick();
  const bar = $('#entity-card .entity-hero--docked');
  assert.equal(bar.querySelector('.feed-dot').dataset.state, 'paused');
  assert.match(bar.textContent, /Docked · stalled/);
  pinned.show('pinned');
  await nextTick();
  const dot = $('.pinned-grid__tile[data-kind="camera"] .feed-dot');
  assert.equal(dot.dataset.state, 'paused');
  assert.equal(dot.getAttribute('title'), 'Docked · stalled');
});

test('unpinning from the keyboard moves focus to the next pin, then the previous, then Undo; a pointer unpin leaves it be', async (t) => {
  const { $, pinia } = fixture(t, [flightsOn([])]);
  const pinned = usePinnedStore(pinia);
  for (const [id, title] of [
    ['a', 'Zilker Park'],
    ['b', 'Barton Springs'],
    ['c', 'Mount Bonnell'],
  ])
    pinned.pin({
      key: `place:${id}`,
      kind: 'place',
      title,
      icon: 'location_on',
      identity: { layerId: 'place', id },
    });
  pinned.show('pinned');
  await nextTick();
  const unpin = (title) =>
    $(`.pinned-grid__unpin[aria-label="Unpin ${title}"]`);
  const byKeyboard = (button) =>
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
  const settle = async () => {
    await nextTick();
    await nextTick();
  };
  // The first: focus moves to the next pin's unpin button.
  unpin('Zilker Park').focus();
  byKeyboard(unpin('Zilker Park'));
  await settle();
  assert.equal(document.activeElement, unpin('Barton Springs'));
  // The last in the list: to the one before it.
  unpin('Mount Bonnell').focus();
  byKeyboard(unpin('Mount Bonnell'));
  await settle();
  assert.equal(document.activeElement, unpin('Barton Springs'));
  // A pointer unpin leaves focus where the pointer left it.
  pinned.pin({
    key: 'place:d',
    kind: 'place',
    title: 'Deep Eddy',
    icon: 'location_on',
    identity: { layerId: 'place', id: 'd' },
  });
  await nextTick();
  const before = document.activeElement;
  unpin('Deep Eddy').dispatchEvent(
    new MouseEvent('click', { bubbles: true, detail: 1 }),
  );
  await settle();
  assert.equal(document.activeElement, before, 'a pointer unpin moves nothing');
  // The very last pin: the Pinned tab goes, and focus lands on Undo, which
  // the notice then holds while focus is on it.
  byKeyboard(unpin('Barton Springs'));
  await settle();
  assert.equal($('#context-tab-pinned'), null);
  const undo = $('.pin-undo-notice button');
  assert.equal(document.activeElement, undo);
  assert.match($('.pin-undo-notice').textContent, /Unpinned Barton Springs/);
  undo.click();
  await nextTick();
  assert.deepEqual(
    pinned.pins.map((pin) => pin.key),
    ['place:b'],
  );
  t.after(() =>
    pinned.pins.map((pin) => pin.key).forEach((key) => pinned.unpin(key)),
  );
});

test('Clear all from the keyboard moves focus to Undo', async (t) => {
  const { $, pinia } = fixture(t, [flightsOn([])]);
  const pinned = usePinnedStore(pinia);
  pinned.pin({
    key: 'place:a',
    kind: 'place',
    title: 'Zilker Park',
    icon: 'location_on',
    identity: { layerId: 'place', id: 'a' },
  });
  pinned.pin({
    key: 'place:b',
    kind: 'place',
    title: 'Barton Springs',
    icon: 'location_on',
    identity: { layerId: 'place', id: 'b' },
  });
  pinned.show('pinned');
  await nextTick();
  const clear = $('.pinned-grid__clear');
  clear.focus();
  clear.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
  await nextTick();
  await nextTick();
  assert.equal(pinned.pins.length, 0);
  assert.equal(document.activeElement, $('.pin-undo-notice button'));
  assert.match($('.pin-undo-notice').textContent, /Unpinned 2 items/);
  t.after(() => pinned.clearNotice());
});

test('when its card cannot open, ⤢ keeps the dock and says so', async (t) => {
  applicationI18n();
  t.after(() => setLocale('en'));
  const { $, cards, pinia } = fixture(t, [flightsOn([])]);
  const docked = useDockedStore(pinia);
  docked.dock({
    key: 'cockpit:flights:gone1',
    kind: 'cockpit',
    title: 'GONE1',
    identity: { layerId: 'flights', id: 'gone1' },
  });
  cards.open = () => {};
  await nextTick();
  $('.docked-view button').click();
  await nextTick();
  await nextTick();
  assert.ok(docked.view, 'the dock stays');
  const notice = $('.docked-view__notice');
  assert.equal(notice.textContent, 'Could not open this in Context');
  setLocale('es');
  await nextTick();
  assert.equal(notice.textContent, 'No se pudo abrir en Contexto');
});

test('a dock transfer on a phone keeps the dock until Context is shown', async (t) => {
  const body = document.body;
  body.classList.add('mobile-shell');
  t.after(() => {
    body.classList.remove('mobile-shell');
    delete body.dataset.mobileSheet;
  });
  let revealAllowed = false;
  const { $, pinia } = fixture(
    t,
    [flightsOn([flight('test01', 30.3, -97.7)])],
    {
      openPanel: () => {
        if (revealAllowed) body.dataset.mobileSheet = 'context';
      },
    },
  );
  const docked = useDockedStore(pinia);
  docked.dock({
    key: 'flights:test01',
    kind: 'cockpit',
    title: 'TEST01',
    identity: { layerId: 'flights', id: 'test01' },
  });
  await nextTick();
  $('.docked-view button[title="Open in Context"]').click();
  await turn();
  assert.ok(docked.view, 'a hidden destination leaves the dock in place');
  revealAllowed = true;
  $('.docked-view button[title="Open in Context"]').click();
  await turn();
  assert.equal(body.dataset.mobileSheet, 'context');
  assert.ok($('#entity-card'));
  assert.equal(docked.view, null);
});

test('a docked cockpit view holds through a short feed gap, then says it is out of feed', async (t) => {
  const records = [flight('test01', 30.3, -97.7)];
  const { $, pinia } = fixture(t, [flightsOn(records)], {
    previews: STUB_PREVIEWS,
  });
  useDockedStore(pinia).dock({
    key: 'cockpit:flights:test01',
    kind: 'cockpit',
    title: 'TEST01',
    identity: { layerId: 'flights', id: 'test01' },
  });
  await nextTick();
  assert.ok($('.docked-view .flight-cockpit'), 'the cockpit view shows');
  assert.match($('.docked-view__tag').textContent, /live/);
  // Esri's credit, under the picture while the view shows.
  assert.match(
    $('.docked-view__credit')?.textContent || '',
    /^Powered by Esri — Source: Esri, Vantor/,
  );
  records.length = 0;
  await new Promise((resolve) => setTimeout(resolve, 2100));
  await nextTick();
  assert.ok(
    $('.docked-view .flight-cockpit'),
    'one missed read keeps the view',
  );
  await new Promise((resolve) => setTimeout(resolve, 4200));
  await nextTick();
  assert.equal($('.docked-view .flight-cockpit'), null);
  assert.match($('.docked-view__tag').textContent, /out of feed/);
  assert.equal($('.docked-view__credit'), null, 'no picture, no credit');
});

test('turning Flights off keeps the existing docked cockpit picture and pauses its renderer', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const records = [flight('test01', 30.3, -97.7)];
  const layer = flightsOn(records);
  const active = [];
  const updated = [];
  let destroyed = 0;
  const cockpit = (host, pose, events) => {
    const picture = host.appendChild(document.createElement('canvas'));
    const draw = (at) => {
      picture.dataset.latitude = String(at.lat);
    };
    draw(pose);
    events.onReady();
    return {
      setActive: (value) => active.push(value),
      update: (at) => {
        updated.push(at);
        draw(at);
      },
      destroy: () => {
        destroyed++;
        picture.remove();
      },
    };
  };
  const { $, pinia, notifyLayers } = fixture(t, [layer], {
    previews: { ...STUB_PREVIEWS, cockpit },
  });
  const docked = useDockedStore(pinia);
  docked.dock({
    key: 'cockpit:flights:test01',
    kind: 'cockpit',
    title: 'TEST01',
    identity: { layerId: 'flights', id: 'test01' },
  });
  await nextTick();
  const picture = $('.docked-view .flight-cockpit canvas');
  assert.ok(picture);
  assert.equal(picture.dataset.latitude, '30.3');
  assert.equal(active.at(-1), true);

  layer.enabled = false;
  records.length = 0;
  notifyLayers({ type: 'visibility', layerId: 'flights', enabled: false });
  await nextTick();
  t.mock.timers.tick(8_000);
  await nextTick();
  assert.ok(
    $('.docked-view .flight-cockpit canvas') === picture,
    'the same picture remains mounted',
  );
  assert.equal(picture.dataset.latitude, '30.3');
  assert.equal(active.at(-1), false);
  assert.equal(updated.length, 0);
  assert.equal(destroyed, 0);
  assert.match($('.docked-view .paused-chip').textContent, /Paused/);
  assert.match($('.docked-view__credit').textContent, /Esri/);

  records.push(flight('test01', 30.4, -97.7));
  layer.enabled = true;
  notifyLayers({ type: 'visibility', layerId: 'flights', enabled: true });
  await nextTick();
  assert.ok($('.docked-view .flight-cockpit canvas') === picture);
  assert.equal(active.at(-1), true);
  assert.equal(picture.dataset.latitude, '30.4');
  docked.close();
  await nextTick();
  assert.equal(destroyed, 1);
});

test('a docked cockpit view pauses while Cockpit, clean view or recording hides the corner, and runs again after', async (t) => {
  const active = [];
  const cockpitPreview = () => ({
    setActive: (on) => active.push(on),
    update() {},
    destroy() {},
  });
  const records = [flight('test01', 30.3, -97.7)];
  const { $, pinia } = fixture(t, [flightsOn(records)], {
    previews: { ...STUB_PREVIEWS, cockpit: cockpitPreview },
  });
  const docked = useDockedStore(pinia);
  docked.dock({
    key: 'cockpit:flights:test01',
    kind: 'cockpit',
    title: 'TEST01',
    identity: { layerId: 'flights', id: 'test01' },
  });
  await nextTick();
  assert.ok($('.docked-view .flight-cockpit'));
  assert.equal(active.at(-1), true, 'running while shown');
  for (const mode of ['cockpit-mode', 'ui-clean-view', 'recording-mode']) {
    t.after(() => document.body.classList.remove(mode));
    document.body.classList.add(mode);
    await turn();
    await nextTick();
    assert.equal(active.at(-1), false, `paused under ${mode}`);
    assert.equal(
      docked.feedOf('cockpit:flights:test01').text,
      'Docked · paused',
    );
    document.body.classList.remove(mode);
    await turn();
    await nextTick();
    assert.equal(active.at(-1), true, `running again after ${mode}`);
  }
});

test("a camera's row of figures fills a missing city, field of view or range from facing, refresh, then provider, and More details never repeats it", async (t) => {
  const camera = { id: 'cam1', name: 'US-183', lat: 30.27, lon: -97.73 };
  let details = {};
  const { $, cards, pinia } = fixture(t, [
    {
      id: 'cctv',
      name: 'Cameras',
      enabled: true,
      records: [camera],
      module: {
        findByQuery: (id) => (id === camera.id ? camera : null),
        cameraDetails: () => ({
          name: camera.name,
          city: null,
          provider: null,
          feedType: null,
          headingDeg: null,
          fovDeg: null,
          rangeM: null,
          refreshMs: 6_000,
          ...details,
        }),
      },
    },
  ]);
  const show = async (next) => {
    details = next;
    cards.clear();
    await nextTick();
    cards.select({ layerId: 'cctv', id: 'cam1' }, { fly: false });
    await nextTick();
    await nextTick();
    return {
      tiles: [
        ...document.querySelectorAll('#entity-card .entity-card__tile span'),
      ].map((span) => span.textContent),
      more: $('#entity-card .entity-card__more')?.textContent || '',
    };
  };
  // No field of view or range: facing and refresh take their places.
  const east = { city: 'Austin', provider: 'TxDOT', headingDeg: 90 };
  let shown = await show({ ...east, headingEstimated: false });
  const facingValue = () =>
    [...document.querySelectorAll('#entity-card .entity-card__tile')]
      .find((tile) => tile.querySelector('span').textContent === 'Facing')
      ?.querySelector('strong').textContent;
  assert.equal(facingValue(), 'E');
  const cameraStore = useCctvStore(pinia);
  cameraStore.setFrame({
    cameraId: 'cam1',
    currentSrc: 'pending.jpg',
    hasFrame: false,
  });
  await nextTick();
  const line = $('.entity-card__source-line');
  assert.equal(line.textContent, 'TxDOT');
  const settled = {
    cameraId: 'cam1',
    src: '/api/cctv/frame/cam1?ts=1',
    hasFrame: true,
    settledAt: Date.now() - 120000,
  };
  cameraStore.setFrame(settled);
  await nextTick();
  assert.equal(line.textContent, 'TxDOT');
  // A failed upstream refresh can deliver the same snapshot with a new decode time.
  cameraStore.setFrame({
    ...settled,
    src: '/api/cctv/frame/cam1?ts=2',
    settledAt: Date.now(),
  });
  await nextTick();
  assert.equal(line.textContent, 'TxDOT');
  assert.equal(
    line.classList.contains('entity-card__source-line--live'),
    false,
  );
  assert.deepEqual(shown.tiles, ['City', 'Facing', 'Refresh']);
  assert.match(shown.more, /Data source\s*TxDOT/);
  assert.doesNotMatch(shown.more, /City|Facing|Refresh/);
  await show({ ...east, headingEstimated: true });
  assert.equal(facingValue(), '~E');
  // Only a city: refresh, then the provider, stand in; the provider leaves
  // More details for the row.
  shown = await show({ city: 'Austin', provider: 'TxDOT' });
  assert.deepEqual(shown.tiles, ['City', 'Refresh', 'Provider']);
  assert.doesNotMatch(shown.more, /Data source|TxDOT|City|Refresh/);
  const provider = 'Servei Català de Trànsit';
  await show({ city: 'Austin', provider, credit: 'Ajuntament de Barcelona' });
  cameraStore.setFrame(settled);
  await nextTick();
  assert.match(
    $('.entity-card__source-line').textContent,
    /Servei Català de Trànsit · Ajuntament de Barcelona/,
  );
  await show({ city: 'Austin', provider, credit: provider });
  assert.equal(
    $('.entity-card__source-line').textContent.split(provider).length - 1,
    1,
  );
  // One figure is no row: it goes under More details.
  shown = await show({});
  assert.deepEqual(shown.tiles, []);
  assert.equal($('#entity-card .entity-card__tiles'), null);
  assert.match(shown.more, /Refresh\s*6 s/);
});

for (const [layerId, id, details, needle] of [
  [
    'satellites',
    '25544',
    { describeSatellite: () => ({ cosparId: '1998-067A' }) },
    '1998-067A',
  ],
  [
    'cctv',
    'cam1',
    { cameraDetails: () => ({ feedType: 'Snapshot feed' }) },
    'Snapshot feed',
  ],
]) {
  test('Context search finds displayed ' + layerId + ' details', async (t) => {
    const record = { id, name: id, latitude: 30, longitude: -97 };
    const { cards, $ } = fixture(t, [
      {
        id: layerId,
        enabled: true,
        records: [record],
        module: { findByQuery: () => record, ...details },
      },
    ]);
    cards.select({ layerId, id }, { fly: false });
    await nextTick();
    assert.ok($('.entity-card__facts')?.textContent.includes(needle));
    contextSearchOpen.value = true;
    contextSearchText.value = needle;
    await nextTick();
    assert.equal($('.entity-card__more[open] dd')?.textContent, needle);
    assert.equal($('.entity-card__no-match'), null);
  });
}

test('a camera card labels an image feed in the current language and preserves stream acronyms', async (t) => {
  setLocale('ja');
  t.after(() => setLocale('en'));
  const feedTypes = [
    ['image', '画像'],
    ['hls', 'HLS'],
    ['mjpeg', 'MJPEG'],
  ];
  const records = feedTypes.map(([id]) => ({
    id,
    name: id,
    lat: 30,
    lon: -97,
  }));
  const { $, cards } = fixture(t, [
    {
      id: 'cctv',
      enabled: true,
      records,
      module: { cameraDetails: (id) => ({ feedType: id }) },
    },
  ]);
  for (const [id, value] of feedTypes) {
    cards.select({ layerId: 'cctv', id }, { fly: false });
    await nextTick();
    assert.equal($('.entity-card__facts dd')?.textContent, value);
  }
});

test('the Street Level source line distinguishes an upload date from a capture date', async (t) => {
  const photos = ['added', 'captured'].map((capturedAtSource) => ({
    id: `kartaview:${capturedAtSource}`,
    name: 'Street photo',
    lat: 30,
    lon: -97,
    provider: 'KartaView',
    capturedAt: Date.UTC(2024, 4, 1),
    capturedAtSource,
  }));
  const { $, cards } = fixture(t, [
    {
      id: 'street-level',
      enabled: true,
      records: photos,
      module: { photo: (id) => photos.find((photo) => photo.id === id) },
    },
  ]);
  const line = async (photo) => {
    cards.select({ layerId: 'street-level', id: photo.id }, { fly: false });
    await nextTick();
    return $('.entity-card__source-line')?.textContent;
  };
  assert.equal(await line(photos[1]), 'KartaView · May 1, 2024');
  assert.equal(await line(photos[0]), 'KartaView · Added: May 1, 2024');
});

test("a partner-supplied camera's card names its owner beside the provider", async (t) => {
  const camera = {
    id: 'cam1',
    name: 'Hwy 1 @ Willingdon',
    lat: 49.26,
    lon: -123.0,
  };
  let details = {};
  const { $, cards } = fixture(t, [
    {
      id: 'cctv',
      name: 'Cameras',
      enabled: true,
      records: [camera],
      module: {
        frameUrlForCamera: (id) => ({
          url: `/frame/${id}.jpg`,
          refreshMs: 10_000,
        }),
        cameraDetails: () => ({
          name: camera.name,
          refreshMs: 10_000,
          ...details,
        }),
      },
    },
  ]);
  const sourceLine = async (next) => {
    details = next;
    cards.clear();
    await nextTick();
    cards.select({ layerId: 'cctv', id: 'cam1' }, { fly: false });
    await nextTick();
    await nextTick();
    return $('#entity-card .entity-card__source-line')?.textContent || '';
  };
  assert.match(
    await sourceLine({ provider: 'DriveBC', credit: 'TransLink' }),
    /^DriveBC · TransLink/,
  );
  // A feed with no partner names only its provider.
  const plain = await sourceLine({ provider: 'DriveBC' });
  assert.match(plain, /^DriveBC/);
  assert.doesNotMatch(plain, /TransLink/);
});

test('a camera opened from its pin stays while Cameras is off, with its last frame', async (t) => {
  const camera = { id: 'cam1', name: 'I-35 @ 12th', lat: 30.27, lon: -97.73 };
  const layer = {
    id: 'cctv',
    name: 'Cameras',
    enabled: true,
    records: [camera],
    module: {
      frameUrlForCamera: (id) =>
        layer.enabled ? cameraFrameFixture(`/frame/${id}.jpg`) : null,
      cameraDetails: () => ({
        name: camera.name,
        city: 'Austin',
        feedType: 'image',
        headingDeg: 0,
        fovDeg: 40,
        rangeM: 120,
        refreshMs: 10_000,
      }),
    },
  };
  const flights = flightsOn([flight('test01', 30.3, -97.7)]);
  const { $, cards, pinia, notifyLayers } = fixture(t, [layer, flights]);
  const pinned = usePinnedStore(pinia);
  // The saved frame (the test DOM cannot draw one): data, never the URL.
  _setFrameStillCaptureForTest(
    async ({ url }) => `data:image/jpeg;base64,${btoa(url)}`,
  );
  t.after(() => _setFrameStillCaptureForTest(null));
  const saved = `data:image/jpeg;base64,${btoa('/frame/cam1.jpg')}`;
  cards.select({ layerId: 'cctv', id: 'cam1' }, { fly: false });
  await nextTick();
  $('.entity-card__action--pin').click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
  pinned.show('pinned');
  await nextTick();
  assert.equal(
    pinned.stillOf('cctv:cam1') || pinned.stillOf(cards.card.key),
    saved,
    'the pin keeps the frame it saved',
  );
  // Cameras turned off: an ordinary pick closes, but the pin stays.
  cards.clear();
  layer.enabled = false;
  layer.records = [];
  notifyLayers();
  await nextTick();
  $('.pinned-grid__open').click();
  await nextTick();
  assert.equal(cards.card?.identity.id, 'cam1', 'the pin opens its card');
  assert.equal(
    $('#context-tab-camera'),
    null,
    'Camera settings are hidden while Cameras is off',
  );
  const selection = cards.selectionGeneration();
  document.dispatchEvent(new CustomEvent(CAMERA_SETTINGS_EVENT));
  await nextTick();
  assert.equal(
    cards.selectionGeneration(),
    selection,
    'a settings request leaves the saved selection alone',
  );
  assert.equal(cards.fromPin, true, 'the card keeps its pin origin');
  await new Promise((resolve) => setTimeout(resolve, 2100));
  await nextTick();
  assert.equal(
    cards.card?.identity.id,
    'cam1',
    'still there after a refresh tick',
  );
  assert.equal(
    $('.entity-hero img')?.getAttribute('src'),
    saved,
    'the same saved still',
  );
  assert.match($('.entity-hero .paused-chip').textContent, /Paused/);
  assert.equal(
    $('.entity-hero .paused-chip').getAttribute('title'),
    'Cameras off · last frame',
  );
  assert.deepEqual(
    [...document.querySelectorAll('#entity-card .entity-card__tile span')].map(
      (span) => span.textContent,
    ),
    ['City', 'Field of view', 'Range'],
    'the paused chip, not a status figure, says why',
  );
  assert.equal(layer.enabled, false, 'the layer is not turned back on');
  const cctv = useCctvStore(pinia);
  const picked = [];
  layer.module.selectCamera = (id) => {
    picked.push(id);
    cctv.publish(presentCctvPanel({ enabled: true, activeCameraId: id }, true));
    return true;
  };
  const enable = Promise.withResolvers();
  const omnibar = useOmnibarStore(pinia);
  omnibar.connect({
    layers: () => [layer],
    setLayer() {
      layer.enabled = true;
      layer.records = [camera];
      cctv.publish(
        presentCctvPanel({ enabled: true, activeCameraId: 'cam2' }, true),
      );
      cctv.setFrame({ cameraId: 'cam2', src: '/other.jpg', hasFrame: true });
      notifyLayers();
      return enable.promise;
    },
  });
  t.after(() => omnibar.connect(null));
  await nextTick();
  $('[data-enable-pinned-layer]').click();
  await nextTick();
  assert.equal(
    $('.entity-hero img')?.getAttribute('src'),
    saved,
    'keep the pin while another camera is active',
  );
  enable.resolve(true);
  await turn();
  assert.deepEqual(picked, ['cam1']);
  cctv.setFrame({ cameraId: 'cam1', currentSrc: '/first.jpg', loading: true });
  await nextTick();
  assert.equal($('.entity-hero img')?.getAttribute('src'), saved);
  cctv.setFrame({ cameraId: 'cam1', currentSrc: '/first.jpg', error: true });
  await nextTick();
  assert.equal($('.entity-hero img')?.getAttribute('src'), saved);
  cctv.setFrame({ cameraId: 'cam1', src: '/frame/cam1.jpg', hasFrame: true });
  await nextTick();
  assert.equal($('.entity-hero img')?.getAttribute('src'), '/frame/cam1.jpg');
  assert.equal($('.entity-hero .paused-chip'), null);
  // Camera settings can now open without losing the pin.
  $('#context-tab-camera').click();
  await nextTick();
  await nextTick();
  assert.equal($('#context-tab-camera').getAttribute('aria-selected'), 'true');
  assert.equal(cards.fromPin, true);
  layer.enabled = false;
  layer.records = [];
  notifyLayers();
  await nextTick();
  assert.equal($('#context-tab-camera'), null);
  assert.equal($('#context-tab-inspect').getAttribute('aria-selected'), 'true');
  assert.equal($('.entity-hero img')?.getAttribute('src'), saved);
  layer.enabled = true;
  notifyLayers();
  await nextTick();
  assert.equal(
    $('#context-tab-camera').getAttribute('aria-selected'),
    'false',
    'turning Cameras back on stays on Inspect',
  );
  // A card picked the ordinary way still closes with its layer.
  assert.equal(
    cards.select(
      {
        layerId: 'flights',
        id: 'test01',
        label: 'TEST01',
        lat: 30.3,
        lon: -97.7,
      },
      { follow: false },
    ),
    true,
  );
  assert.equal(cards.fromPin, false);
  flights.enabled = false;
  notifyLayers();
  cards.refresh();
  await nextTick();
  assert.equal(cards.card, null, 'an ordinary pick goes with its layer');
});

test('a stream camera pinned while its video connects keeps its first drawn frame, never a blank one', async (t) => {
  const camera = { id: 'cam9', name: 'US 113 @ US 9', lat: 38.68, lon: -75.4 };
  const snapshot = t.mock.fn(async () => ({
    sourceKind: 'upstream-image',
    url: 'blob:snapshot',
    release() {},
  }));
  const layer = {
    id: 'cctv',
    name: 'Cameras',
    enabled: true,
    records: [camera],
    module: {
      frameUrlForCamera: (id) => ({
        url: `/frame/${id}.svg`,
        readImage: snapshot,
        refreshMs: 10_000,
      }),
      cameraDetails: () => ({
        name: camera.name,
        feedType: 'hls',
        refreshMs: 10_000,
      }),
    },
  };
  const { $, cards, pinia } = fixture(t, [layer]);
  const cctv = useCctvStore(pinia);
  const active = { ...camera, isVideo: true };
  cctv.publish(
    presentCctvPanel(
      {
        enabled: true,
        count: 1,
        cameraIndex: [active],
        activeCameraId: 'cam9',
        activeCamera: active,
      },
      true,
    ),
  );
  await nextTick();
  // The live video's canvas, at home in the camera tools until a card shows it.
  if (!$('#cctv-video')) {
    const home = document.body.appendChild(document.createElement('div'));
    home.id = 'cctv-frame-wrap';
    home.appendChild(document.createElement('canvas')).id = 'cctv-video';
  }
  cctv.setLive(true);
  cctv.setLiveState('waiting');
  const saved = [];
  _setFrameStillCaptureForTest(async ({ shown, url }) => {
    saved.push({ shown: shown?.tagName || null, url });
    return 'data:image/jpeg;base64,DRAWN';
  });
  t.after(() => _setFrameStillCaptureForTest(null));
  cards.select({ layerId: 'cctv', id: 'cam9' }, { fly: false });
  await nextTick();
  await nextTick();
  assert.equal(
    $('#entity-card .cctv-preview__video canvas')?.id,
    'cctv-video',
    'the card shows the live canvas',
  );
  assert.equal(
    $('#entity-card .cctv-preview__wait')?.textContent,
    'Acquiring frame…',
  );
  $('.entity-card__action--pin').click();
  await turn();
  await nextTick();
  assert.deepEqual(
    saved,
    [],
    'nothing saved from a canvas that has drawn nothing',
  );
  $('.entity-card__action--pin').click();
  await nextTick();
  cctv.setLiveState('');
  await turn();
  assert.equal(
    snapshot.mock.callCount(),
    0,
    'unpinning cancels the pending first frame',
  );
  assert.deepEqual(saved, []);
  cctv.setLiveState('waiting');
  $('.entity-card__action--pin').click();
  await nextTick();
  cctv.setLiveState('playing');
  await turn();
  await nextTick();
  assert.deepEqual(
    saved.map((entry) => entry.shown),
    ['CANVAS'],
    'the drawn frame is saved',
  );
  assert.equal(
    usePinnedStore(pinia).stillOf(cards.card.key),
    'data:image/jpeg;base64,DRAWN',
  );
});

test('the card uses a host ride label only for the matching provider item', async (t) => {
  const { $, cards, pinia } = fixture(t, [
    {
      id: 'ground-transit',
      name: 'Transit',
      enabled: true,
      records: [{ id: 'bus-1', name: 'Route 8', ...HERE }],
    },
  ]);
  cards.canCockpit = () => true;
  cards.select({ layerId: 'ground-transit', id: 'bus-1' }, { fly: false });
  const cockpit = useCockpitStore(pinia);
  const pose = {
    entryAvailable: true,
    entryLayerId: 'ground-transit',
    entryId: 'bus-1',
    entryFace: { icon: 'directions_bus', label: 'Busfahreransicht' },
  };
  cockpit.publishPresence(pose);
  await nextTick();
  const lead = $('[data-entity-cockpit-entry]');
  assert.match(lead.textContent, /Busfahreransicht/);
  for (const other of [
    { entryId: 'bus-2' },
    { entryId: null },
    { entryLayerId: 'another-layer' },
  ]) {
    cockpit.publishPresence({ ...pose, ...other });
    await nextTick();
    assert.doesNotMatch(lead.textContent, /Busfahreransicht/);
  }
});

test('a camera pinned while its video connects never saves another camera picked meanwhile', async (t) => {
  const first = { id: 'cam9', name: 'US 113 @ US 9', lat: 38.68, lon: -75.4 };
  const second = { id: 'cam10', name: 'US 13 @ SR 1', lat: 38.7, lon: -75.5 };
  const layer = {
    id: 'cctv',
    name: 'Cameras',
    enabled: true,
    records: [first, second],
    module: {
      frameUrlForCamera: (id) => cameraFrameFixture(`/frame/${id}.svg`),
      cameraDetails: (id) => ({ name: id, feedType: 'hls', refreshMs: 10_000 }),
    },
  };
  const { $, cards, pinia } = fixture(t, [layer]);
  const cctv = useCctvStore(pinia);
  const activate = (camera) => {
    const active = { ...camera, isVideo: true };
    cctv.publish(
      presentCctvPanel(
        {
          enabled: true,
          count: 2,
          cameraIndex: [active],
          activeCameraId: camera.id,
          activeCamera: active,
        },
        true,
      ),
    );
  };
  activate(first);
  await nextTick();
  if (!$('#cctv-video')) {
    const home = document.body.appendChild(document.createElement('div'));
    home.id = 'cctv-frame-wrap';
    home.appendChild(document.createElement('canvas')).id = 'cctv-video';
  }
  cctv.setLive(true);
  cctv.setLiveState('waiting');
  const saved = [];
  _setFrameStillCaptureForTest(async ({ shown, url }) => {
    saved.push({ shown: shown?.tagName || null, url });
    return shown
      ? 'data:image/jpeg;base64,DRAWN'
      : `data:image/jpeg;base64,${btoa(url)}`;
  });
  t.after(() => _setFrameStillCaptureForTest(null));
  cards.select({ layerId: 'cctv', id: 'cam9' }, { fly: false });
  await nextTick();
  await nextTick();
  const pinKey = cards.card.key;
  $('.entity-card__action--pin').click();
  await turn();
  await nextTick();
  assert.deepEqual(saved, [], 'waiting for the first camera to draw');
  // The second camera is picked and draws before the first one did.
  activate(second);
  cards.select({ layerId: 'cctv', id: 'cam10' }, { fly: false });
  await nextTick();
  await nextTick();
  cctv.setLiveState('playing');
  await turn();
  await nextTick();
  assert.deepEqual(
    saved,
    [{ shown: null, url: '/frame/cam9.svg' }],
    'the first camera’s own frame is read instead',
  );
  assert.equal(
    usePinnedStore(pinia).stillOf(pinKey),
    `data:image/jpeg;base64,${btoa('/frame/cam9.svg')}`,
  );
});

test('a delayed camera capture cannot overwrite a replacement pin', async (t) => {
  const { $, cards, pinia } = fixture(t, [
    {
      id: 'cctv',
      name: 'Cameras',
      enabled: true,
      records: [{ id: 'cam1', name: 'I-35', ...HERE }],
      module: {
        frameUrlForCamera: () => cameraFrameFixture('/frame/cam1.jpg'),
      },
    },
  ]);
  const pinned = usePinnedStore(pinia);
  const first = Promise.withResolvers();
  let reads = 0;
  _setFrameStillCaptureForTest(() =>
    ++reads === 1 ? first.promise : Promise.resolve('new still'),
  );
  t.after(() => _setFrameStillCaptureForTest(null));
  cards.select({ layerId: 'cctv', id: 'cam1' }, { fly: false });
  await nextTick();
  const button = () => $('.entity-card__action--pin').click();
  button();
  await turn();
  assert.equal(reads, 1);
  button();
  await nextTick();
  button();
  await turn();
  assert.equal(pinned.stillOf(cards.card.key), 'new still');
  first.resolve('old still');
  await turn();
  assert.equal(pinned.stillOf(cards.card.key), 'new still');
});

test('a pinned camera is a still: its tile keeps the frame it had when pinned and nothing re-reads it', async (t) => {
  let frame = '/frame/cam1-a.jpg';
  const reads = [];
  const layer = {
    id: 'cctv',
    name: 'Cameras',
    enabled: true,
    records: [{ id: 'cam1', name: 'I-35 @ 12th', lat: 30.27, lon: -97.73 }],
    module: {
      frameUrlForCamera: (id) => {
        reads.push(id);
        return cameraFrameFixture(frame);
      },
    },
  };
  const { $, cards, pinia } = fixture(t, [layer]);
  const pinned = usePinnedStore(pinia);
  _setFrameStillCaptureForTest(
    async ({ url }) => `data:image/jpeg;base64,${btoa(url)}`,
  );
  t.after(() => _setFrameStillCaptureForTest(null));
  cards.select({ layerId: 'cctv', id: 'cam1' }, { fly: false });
  await nextTick();
  $('.entity-card__action--pin').click();
  t.after(() => pinned.unpin('cctv:cam1'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  cards.clear();
  frame = '/frame/cam1-b.jpg';
  pinned.show('pinned');
  await nextTick();
  reads.length = 0;
  const still = $('.pinned-grid__frame').getAttribute('src');
  assert.equal(
    still,
    `data:image/jpeg;base64,${btoa('/frame/cam1-a.jpg')}`,
    'the frame it had when pinned, saved',
  );
  assert.doesNotMatch(
    still,
    /^\/frame\//,
    'never a URL that would fetch a newer frame',
  );
  assert.equal(Boolean($('.pinned-grid__live')), false, 'no live dot');
  await new Promise((resolve) => setTimeout(resolve, 50));
  await nextTick();
  assert.deepEqual(reads, [], 'the grid asks for no frame');
});

test('Clear all unpins everything at once, and Undo puts every pin back with its still', async (t) => {
  const { $, pinia } = fixture(t, [flightsOn([])]);
  const pinned = usePinnedStore(pinia);
  pinned.pin({
    key: 'place:a',
    kind: 'place',
    title: 'Zilker Park',
    icon: 'location_on',
    identity: { layerId: 'place', id: 'a' },
    still: '/still/a.png',
  });
  pinned.pin({
    key: 'place:b',
    kind: 'place',
    title: 'Barton Springs',
    icon: 'location_on',
    identity: { layerId: 'place', id: 'b' },
    still: '/still/b.png',
  });
  pinned.show('pinned');
  await nextTick();
  assert.match($('.pinned-grid__head').textContent, /Pinned · 2\s*Clear all/);
  $('.pinned-grid__clear').click();
  await nextTick();
  assert.equal(pinned.pins.length, 0);
  assert.equal(
    $('#context-tab-pinned'),
    null,
    'the Pinned tab goes with the last pin',
  );
  assert.match($('.pin-undo-notice').textContent, /Unpinned 2 items/);
  $('.pin-undo-notice button').click();
  await nextTick();
  assert.deepEqual(
    pinned.pins.map((pin) => pin.key),
    ['place:a', 'place:b'],
    'back, in order',
  );
  assert.equal(pinned.stillOf('place:b'), '/still/b.png');
});

/**
 * Context with Radio off and its station KUT pinned on the Pinned tab. The
 * omnibar's setLayer records any attempt to turn a layer on; none is made
 * (`listed: false` leaves the station out of the catalogue).
 */
async function radioOffWithPinnedStation(t, { listed = true } = {}) {
  _resetPinnedStationForTest();
  t.after(() => _resetPinnedStationForTest());
  const radio = radioLayer();
  radio.emit({ enabled: false, presentationActive: false, selected: null });
  if (!listed) {
    const play = radio.playStation;
    radio.playStation = (id) =>
      id === 'kut' ? (radio.calls.push(['play', id]), false) : play(id);
  }
  const row = { id: 'radio', name: 'Radio', enabled: false, records: [] };
  const fixed = fixture(t, [flightsOn([flight('test01', 30.3, -97.7)]), row]);
  const { cards, pinia } = fixed;
  const dm = cards.layerModule;
  cards.layerModule = (id) => (id === 'radio' ? radio : dm(id));
  cards.setView({ center: HERE, heightM: 40_000 });
  const turnedOn = [];
  useOmnibarStore(pinia).connect({
    layers: () => [],
    setLayer: async (...args) => turnedOn.push(args),
  });
  t.after(() => useOmnibarStore(pinia).connect(null));
  const pinned = usePinnedStore(pinia);
  pinned.pin({
    key: 'radio:kut',
    kind: 'station',
    title: 'KUT 90.5',
    icon: 'radio',
    identity: { layerId: 'radio', id: 'kut' },
  });
  t.after(() => pinned.unpin('radio:kut'));
  pinned.show('pinned');
  // Context finds the Radio layer on its next look.
  await nextTick();
  await turn();
  await nextTick();
  return { ...fixed, radio, row, pinned, turnedOn };
}

const settle = async () => {
  for (let i = 0; i < 4; i++) {
    await turn();
    await nextTick();
  }
};

test('with Radio off, tapping a pinned station plays it and leaves Radio off; its tile and the mini player go live', async (t) => {
  const { $, radio, row, pinned, turnedOn } =
    await radioOffWithPinnedStation(t);
  assert.equal(
    $('.pinned-grid .paused-chip').getAttribute('title'),
    'Radio off',
  );
  const tile = $('.pinned-grid__open');
  assert.equal(tile.getAttribute('title'), 'Play KUT 90.5');
  assert.match(
    $('.pinned-grid').textContent,
    /broadcasters, who see your IP address/,
  );
  assert.match($('.pinned-grid').textContent, /Tap a station to play it/);
  tile.click();
  await settle();
  assert.deepEqual(
    radio.calls.at(-1),
    ['play', 'kut'],
    'played from the catalogue',
  );
  assert.deepEqual(turnedOn, [], 'nothing turned on');
  assert.equal(row.enabled, false);
  assert.equal(radio.state().enabled, false);
  assert.equal(pinned.tab, 'pinned', 'Pinned stays: there is no station list');
  radio.emit({ audioState: 'playing' });
  await nextTick();
  assert.equal($('.pinned-grid .feed-dot').dataset.state, 'live');
  assert.equal($('.radio-mini .feed-dot').dataset.state, 'live');
});

test('a pinned station whose stream fails shows the error in the mini player and its tile', async (t) => {
  const { $, radio } = await radioOffWithPinnedStation(t);
  $('.pinned-grid__open').click();
  await settle();
  radio.emit({
    audioState: 'error',
    audioError: 'Broadcaster stream is unavailable or blocked by the browser.',
  });
  await nextTick();
  assert.match(
    $('.pinned-grid .paused-chip').getAttribute('title'),
    /unavailable or blocked/,
  );
  assert.match(
    $('.radio-mini').textContent,
    /KUT 90\.5/,
    'the player stays to say so',
  );
  assert.equal($('.radio-mini .feed-dot').dataset.state, 'lost');
  assert.match(
    $('.radio-mini__name').getAttribute('title'),
    /unavailable or blocked/,
  );
});

test('with only a pin and Radio off, the mini player is ready to play the pinned station in one tap, Radio left off', async (t) => {
  const { $, radio, turnedOn, close } = await radioOffWithPinnedStation(t);
  close();
  await nextTick();
  const mini = $('.radio-mini');
  assert.ok(mini, 'the pinned station keeps the player');
  assert.match(mini.textContent, /KUT 90\.5/);
  assert.equal(mini.getAttribute('aria-label'), 'Radio station');
  assert.equal(mini.querySelector('.feed-dot'), null, 'ready, not paused');
  assert.deepEqual(
    miniControls($),
    MINI_CONTROLS.map(() => true),
    'every control is there',
  );
  assert.equal($('.radio-mini__pin').getAttribute('aria-pressed'), 'true');
  $('.radio-mini__play').click();
  await settle();
  assert.deepEqual(radio.calls.at(-1), ['play', 'kut']);
  assert.deepEqual(turnedOn, []);
  assert.equal(radio.state().enabled, false);
  radio.emit({ audioState: 'playing' });
  await nextTick();
  assert.equal($('.radio-mini .feed-dot').dataset.state, 'live');
});

test('with Local receiver chosen the mini player offers no pinned station; back on the internet stations it does', async (t) => {
  const { $, radio, close } = await radioOffWithPinnedStation(t);
  close();
  await nextTick();
  assert.ok($('.radio-mini'), 'ready to play the pin');
  radio.emit({ source: 'local', localReceiver: true });
  await nextTick();
  assert.equal($('.radio-mini'), null, 'only the local receiver');
  radio.emit({ source: 'internet', localReceiver: false });
  await nextTick();
  assert.match($('.radio-mini').textContent, /KUT 90\.5/);
});

test('with Radio off, Previous and Next step without turning Radio on, and are disabled with nothing to step through', async (t) => {
  const { $, radio, turnedOn, close } = await radioOffWithPinnedStation(t);
  close();
  await nextTick();
  $('[aria-label="Next filtered station"]').click();
  $('[aria-label="Previous filtered station"]').click();
  assert.deepEqual(radio.calls.slice(-2), [
    ['step', 1],
    ['step', -1],
  ]);
  assert.deepEqual(turnedOn, []);
  radio.emit({ filteredCount: 0 });
  await nextTick();
  const next = $('.radio-mini [aria-label="Next filtered station"]');
  const previous = $('.radio-mini [aria-label="Previous filtered station"]');
  assert.ok(next && previous, 'still there');
  assert.equal(next.disabled, true);
  assert.equal(previous.disabled, true);
});

test('with Radio off, Next on a paused pinned station shows the station stepped to, ready to play, and Play plays it', async (t) => {
  const { $, radio, close } = await radioOffWithPinnedStation(t);
  close();
  await nextTick();
  // As the layer steps with Radio off: a paused stream of the station left
  // behind is let go, and the selection moves on.
  radio.stepStationWhileOff = (direction) => {
    radio.calls.push(['step', direction]);
    radio.emit({
      audioState: 'stopped',
      playingStationId: null,
      selected: radio.stations[1],
    });
    return true;
  };
  $('.radio-mini__play').click();
  await settle();
  radio.emit({ audioState: 'playing' });
  await nextTick();
  $('.radio-mini__play').click();
  await nextTick();
  assert.equal(
    $('.radio-mini').getAttribute('aria-label'),
    'Radio playback: Paused',
  );
  assert.match($('.radio-mini').textContent, /KUT 90\.5/);
  $('[aria-label="Next filtered station"]').click();
  await nextTick();
  assert.match(
    $('.radio-mini').textContent,
    /KUTX 98\.9/,
    'the station stepped to',
  );
  assert.doesNotMatch($('.radio-mini').textContent, /KUT 90\.5/);
  assert.equal(
    $('.radio-mini').getAttribute('aria-label'),
    'Radio station',
    'ready to play',
  );
  $('.radio-mini__play').click();
  await nextTick();
  assert.deepEqual(
    radio.calls.at(-1),
    ['play', 'kutx'],
    'Play plays it, not the pin',
  );
});

test('the mini player’s name says what it is doing: playing, loading, paused or unavailable', async (t) => {
  const { $, radio } = await radioOnWithList(t);
  const label = () => $('.radio-mini').getAttribute('aria-label');
  const heading = () =>
    $('[data-list-card=radio] .view-context__block-name').textContent;
  assert.equal(label(), 'Radio playing');
  assert.equal(heading(), 'Radio · now playing');
  radio.emit({ audioState: 'loading' });
  await nextTick();
  assert.equal(label(), 'Radio playback: Loading');
  assert.equal(heading(), 'Radio');
  radio.emit({ audioState: 'paused' });
  await nextTick();
  assert.equal(label(), 'Radio playback: Paused');
  assert.equal(heading(), 'Radio');
  radio.emit({ audioState: 'error' });
  await nextTick();
  assert.equal(label(), 'Radio playback: Broadcaster stream unavailable');
  assert.equal(heading(), 'Radio');
  radio.emit({ audioState: 'stopped', playingStationId: null });
  await nextTick();
  assert.equal(label(), 'Radio station');
  assert.equal(heading(), 'Radio');
});

test('a pinned station plays on (or stays paused) through Radio off, Clear all, Context closing, tabs, another pick and camera moves', async (t) => {
  const { $, radio, cards, pinned, close } = await radioOffWithPinnedStation(t);
  radio.emit({ enabled: true, presentationActive: true });
  radio.playStation('kut');
  radio.emit({ audioState: 'playing' });
  await nextTick();
  const before = radio.calls.length;
  const live = () => {
    assert.equal(radio.state().audioState, 'playing');
    assert.equal($('.radio-mini .feed-dot').dataset.state, 'live');
  };
  radio.turnOff(); // Radio off, or Clear all
  await settle();
  live();
  pinned.show('inspect');
  await nextTick();
  pinned.show('pinned');
  await nextTick();
  live();
  cards.select({ layerId: 'flights', id: 'test01' }, { follow: false });
  await nextTick();
  live();
  cards.setView({ center: { lat: 31, lon: -98 }, heightM: 90_000 });
  await settle();
  live();
  close();
  await nextTick();
  live();
  assert.deepEqual(radio.calls.slice(before), [], 'no pause, stop or replay');
  // Paused, it stays paused through Radio off.
  radio.pause();
  radio.turnOff();
  await settle();
  assert.equal(radio.state().audioState, 'paused');
  assert.equal($('.radio-mini .feed-dot').dataset.state, 'paused');
});

test('a pinned station the catalogue does not hold says so on its tile', async (t) => {
  const { $, radio, close } = await radioOffWithPinnedStation(t, {
    listed: false,
  });
  $('.pinned-grid__open').click();
  await settle();
  assert.deepEqual(radio.calls.at(-1), ['play', 'kut']);
  assert.match(
    $('.pinned-grid .paused-chip').getAttribute('title'),
    /KUT 90\.5 is not in the station directory right now/,
  );
  close();
  await nextTick();
  $('.radio-mini__play').click();
  await nextTick();
  assert.match(
    $('.radio-mini [role="status"]')?.textContent || '',
    /KUT 90\.5 is not in the station directory right now/,
  );
  radio.emit({ selected: radio.stations[1] });
  await nextTick();
  assert.equal($('.radio-mini [role="status"]'), null);
});

test('with Radio on, tapping a pinned station plays it on Inspect without touching the layer', async (t) => {
  _resetPinnedStationForTest();
  t.after(() => _resetPinnedStationForTest());
  const radio = radioLayer();
  const { cards, pinia } = fixture(t, [
    flightsOn([flight('test01', 30.3, -97.7)]),
    { id: 'radio', name: 'Radio', enabled: true, records: [] },
  ]);
  const dm = cards.layerModule;
  cards.layerModule = (id) => (id === 'radio' ? radio : dm(id));
  const turnedOn = [];
  useOmnibarStore(pinia).connect({
    layers: () => [],
    setLayer: async (...args) => turnedOn.push(args),
  });
  t.after(() => useOmnibarStore(pinia).connect(null));
  const pinned = usePinnedStore(pinia);
  pinned.pin({
    key: 'radio:kutx',
    kind: 'station',
    title: 'KUTX 98.9',
    icon: 'radio',
    identity: { layerId: 'radio', id: 'kutx' },
  });
  t.after(() => pinned.unpin('radio:kutx'));
  cards.select({ layerId: 'flights', id: 'test01' }, { follow: false });
  await nextTick();
  await turn();
  pinned.show('pinned');
  await nextTick();
  radio.emit({ source: 'local' });
  await nextTick();
  const tile = document.querySelector('.pinned-grid__open');
  tile.focus();
  tile.click();
  await settle();
  assert.equal(pinned.tab, 'pinned');
  assert.equal(cards.card?.identity.id, 'test01');
  assert.equal(document.activeElement === tile, true);
  assert.match(
    document.querySelector('.pinned-grid [role="status"]')?.textContent || '',
    /Internet stations/,
  );
  assert.equal(
    radio.calls.some(([action]) => action === 'play'),
    false,
  );
  radio.emit({ source: 'internet' });
  await nextTick();
  document.querySelector('.pinned-grid__open').click();
  await settle();
  assert.deepEqual(turnedOn, []);
  assert.equal(pinned.tab, 'inspect');
  assert.equal(cards.card, null, 'the pick is let go for the station list');
  assert.deepEqual(radio.calls.at(-1), ['play', 'kutx']);
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
            { layerId: 'local-firms', count: 38, at: Date.now() },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    return new Response('', { status: 503 });
  };
  const { $, cards, notifyLayers } = fixture(
    t,
    [satellites, flights, { id: 'local-firms', enabled: false, records: [] }],
    { fetchImpl },
  );
  cards.setView({ center: { lat: 0, lon: 0 }, heightM: 20_000_000 });
  await settleInspectorIndex();
  await turn();
  await nextTick();
  const tiles = () => [
    ...document.querySelectorAll(
      '.view-context__tiles--counts .view-context__tile',
    ),
  ];
  assert.deepEqual(
    tiles().map((tile) => tile.dataset.layer),
    ['satellites', 'local-firms'],
    'registered free layers only',
  );
  assert.match(tiles()[0].textContent, /1,272/);
  assert.match(tiles()[1].textContent, /Fire detections/);
  assert.match(tiles()[1].title, /last 24 h/);
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
  await settleInspectorIndex();
  assert.equal(
    $('.view-context__block[data-layer="satellites"] strong').textContent,
    '1,272',
    'the enabled satellite layer shows its worldwide total at globe height',
  );
  satellites.enabled = false;
  notifyLayers();
  await settleInspectorIndex();
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

test('turning layers off keeps their observed counts separate from worldwide counts', async (t) => {
  const flights = flightsOn([flight('near01', 30.28, -97.74)], {
    coverage: '250nm regional fallback',
  });
  const military = {
    id: 'military',
    name: 'Military Flights',
    enabled: true,
    records: [flight('mil01', 30.29, -97.74)],
    stats: { count: 17, lastUpdate: Date.now() },
  };
  const library = {
    id: 'lib-review',
    name: 'Custom source',
    enabled: true,
    records: [flight('lib01', 30.29, -97.74)],
    stats: { count: 1, lastUpdate: Date.now() },
  };
  let asks = 0;
  const { $, cards, notifyLayers, pinia, dataManager, replaceManager } =
    fixture(t, [flights, military, library], {
      fetchImpl: async (url) => {
        if (String(url).includes('/api/layer-counts')) asks++;
        return new Response('', { status: 503 });
      },
    });
  const manager = dataManager();
  const activityListeners = new Set();
  replaceManager({
    ...manager,
    getAll: () => manager.getAll().filter(({ id }) => manager.layers.has(id)),
    subscribeActivity(listener) {
      activityListeners.add(listener);
      return () => activityListeners.delete(listener);
    },
  });
  cards.syncDataManager();
  cards.setView({ center: { lat: 0, lon: 0 }, heightM: 20_000_000 });
  await settleInspectorIndex();
  assert.ok($('.view-context__block[data-layer="flights"]'));
  assert.equal(asks, 1, 'the globe requests the worldwide count');

  for (const layer of [flights, military, library]) {
    layer.enabled = false;
    layer.stats = { count: 0, lastUpdate: null };
  }
  notifyLayers();
  await nextTick();
  const cachedTile = (id) =>
    $(`.view-context__tiles--counts [data-layer="${id}"]`);
  const sectionTitle = (tile) =>
    tile.parentElement.previousElementSibling.textContent;
  for (const [id, count] of [
    ['flights', '1'],
    ['military', '17'],
    ['lib-review', '1'],
  ]) {
    const tile = cachedTile(id);
    assert.equal(tile.querySelector('strong').textContent, count);
    assert.equal(sectionTitle(tile), 'Last loaded counts');
  }
  assert.equal(asks, 1);

  const counts = useLayerCountsStore(pinia);
  counts.publish({
    ...counts.state,
    counts: { flights: { count: 8000, at: Date.now() } },
  });
  await nextTick();
  assert.equal(
    cachedTile('flights').querySelector('strong').textContent,
    '8,000',
  );
  assert.equal(sectionTitle(cachedTile('flights')), 'Worldwide, last known');
  assert.equal(sectionTitle(cachedTile('military')), 'Last loaded counts');
  assert.equal(
    document.querySelectorAll(
      '.view-context__tiles--counts [data-layer="flights"]',
    ).length,
    1,
  );
  assert.equal(
    asks,
    1,
    'neither the loaded fallback nor the server update asks again',
  );

  const registrationChanged = () => {
    for (const listener of activityListeners)
      listener({ type: 'registrations', layerId: library.id });
  };
  registrationChanged();
  await nextTick();
  assert.ok(cachedTile(library.id), 'keeps the count while still registered');
  const libraryEntry = manager.layers.get(library.id);
  manager.layers.delete(library.id);
  registrationChanged();
  await nextTick();
  assert.ok(!cachedTile(library.id), 'drops the removed layer count');
  manager.layers.set(library.id, libraryEntry);
  registrationChanged();
  await nextTick();
  assert.ok(
    !cachedTile(library.id),
    're-adding does not restore the old count',
  );
  assert.equal(
    cachedTile('military').querySelector('strong').textContent,
    '17',
  );
  assert.equal(asks, 1);
});

test('pinning the Inspector view preserves its camera pose and centre', async (t) => {
  const { $, cards, pinia } = fixture(t, [flightsOn([])]);
  const pose = {
    lat: 30.5,
    lon: -97.4,
    height: 800,
    heading: 35,
    pitch: -25,
    roll: 0,
  };
  cards.setView({ center: HERE, heightM: pose.height, pose });
  await nextTick();
  const pin = $('.view-context__pin');
  assert.ok(pin);
  pin.click();
  await nextTick();
  const store = usePinnedStore(pinia);
  assert.equal(store.pins.length, 1);
  assert.deepEqual(store.pins[0].pose, pose);
  assert.equal(store.pins[0].identity.lat, HERE.lat);
  assert.equal(store.pins[0].identity.lon, HERE.lon);
  assert.equal(pin.getAttribute('aria-pressed'), 'true');

  const context = useContextStore(pinia);
  store.show('pinned');
  assert.equal(context.inspectorTab, 'pinned');
  globalThis.dispatchEvent(new CustomEvent('gev:context-show-view'));
  assert.equal(context.inspectorTab, 'pinned');
  globalThis.dispatchEvent(
    new CustomEvent('gev:context-show-view', { detail: { inspect: true } }),
  );
  assert.equal(context.inspectorTab, 'inspect');
  await nextTick();
  pin.click();
  await nextTick();
  assert.equal(store.pins.length, 0);
});

// Bounded: without the hand-off this test must fail by name, not hang.
test(
  'when the last visible flight leaves, keyboard focus stays in the view',
  { timeout: 10_000 },
  async (t) => {
    const flights = flightsOn([flight('near01', 30.31, -97.74)]);
    const { $, cards } = fixture(t, [flights]);
    cards.setView(localView());
    await settleInspectorIndex();
    const nearby = '.view-context .nearby-lists';
    const row = $(`${nearby} [data-row-key]`);
    assert.ok(row, 'one Nearby row');
    row.focus();
    assert.ok(document.activeElement === row);
    // The aircraft leaves; the next read of the view finds nothing nearby.
    flights.records = [];
    flights.stats = {
      ...flights.stats,
      count: 0,
      lastUpdate: flights.stats.lastUpdate + 1,
    };
    cards.setView(localView({ ...HERE }));
    await nextTick();
    assert.ok(
      $(`${nearby} [data-row-key]`) === row && document.activeElement === row,
      'the pending replacement keeps both the old row and its focus',
    );
    await settleInspectorIndex();
    assert.ok(!$(nearby), 'the settled empty Inspector section is gone');
    assert.ok($('.view-context').contains(document.activeElement));

    cards.setView({ center: HERE, heightM: 6_000_000 });
    await settleInspectorIndex();
    assert.ok($('.view-context').contains(document.activeElement));
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
    await settleInspectorIndex();
    const first = $(
      '.view-context__block[data-layer="flights"] [data-row-key]',
    );
    first.focus();
    assert.ok(document.activeElement === first);
    // The nearest aircraft leaves with the next snapshot.
    flights.records = [flight('mid01', 10, 10)];
    flights.stats = {
      ...flights.stats,
      count: 1,
      lastUpdate: flights.stats.lastUpdate + 1,
    };
    cards.setView({ ...GLOBE });
    await settleInspectorIndex();
    await nextTick();
    const row = $('.view-context__block[data-layer="flights"] [data-row-key]');
    assert.match(row.textContent, /MID01/);
    assert.ok(document.activeElement === row, 'the row now in its place');
  },
);

test('switching zoom modes preserves the focused item or moves focus to the view', async (t) => {
  const flights = flightsOn([flight('near01', 30.31, -97.74)]);
  const { $, cards, notifyLayers, replaceManager } = fixture(t, [flights], {
    useInspector: true,
  });
  const nearby = '.nearby-lists [data-row-key]';
  const atGlobe = '.view-context__blocks [data-row-key]';
  cards.setView(localView());
  await settleInspectorIndex();
  $(nearby).focus();
  assert.ok(document.activeElement === $(nearby));

  cards.setView({ center: HERE, heightM: 6_000_000 });
  await settleInspectorIndex();
  assert.ok(
    document.activeElement === $(atGlobe),
    'the same item owns focus in the globe view',
  );
  cards.setView(localView());
  await settleInspectorIndex();
  assert.ok(
    document.activeElement === $(nearby),
    'the same item owns focus again in Nearby',
  );

  const globe = { center: HERE, heightM: 6_000_000 };
  cards.setView(globe);
  await settleInspectorIndex();
  assert.ok(document.activeElement === $(atGlobe));
  flights.enabled = false;
  notifyLayers();
  cards.setView({ ...globe });
  await settleInspectorIndex();
  assert.ok(
    document.activeElement === $('.view-context'),
    'the view owns focus when the last layer closes',
  );

  flights.enabled = true;
  notifyLayers();
  await settleInspectorIndex();
  $(atGlobe).focus();
  replaceManager({ layers: new Map(), getAll: () => [] });
  cards.pulseInspector();
  await nextTick();
  assert.ok(
    document.activeElement === $('.view-context'),
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
    assert.ok(
      !$('.view-context__blocks .view-context__block'),
      'the unmatched globe group is gone',
    );
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

test('a same-view index refresh keeps settled rows up until the replacement publishes', async (t) => {
  const earthquakes = {
    id: 'earthquakes',
    name: 'Earthquakes',
    enabled: true,
    records: [{ id: 'one', name: 'Initial quake', ...HERE }],
    stats: { count: 1, recordsRevision: 1 },
  };
  const { $, cards, notifyLayers } = fixture(t, [earthquakes]);
  cards.setView(localView());
  await settleInspectorIndex();
  const row = () => $('[data-row-layer="earthquakes"]');
  const initial = row();
  assert.match(initial.textContent, /Initial quake/);

  earthquakes.records = [{ id: 'two', name: 'Updated quake', ...HERE }];
  earthquakes.stats = { ...earthquakes.stats, recordsRevision: 2 };
  notifyLayers({ type: 'refresh', layerId: 'earthquakes' });
  await nextTick();
  assert.equal(row(), initial, 'pending index keeps the previous visible row');
  await settleInspectorIndex();
  assert.match(row().textContent, /Updated quake/);

  earthquakes.stats = { ...earthquakes.stats, recordsRevision: 3 };
  notifyLayers({ type: 'refresh', layerId: 'earthquakes' });
  setContextRadiusKm(50);
  await nextTick();
  assert.equal(
    Boolean(row()),
    false,
    'a changed radius cannot reuse a pending answer',
  );
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
  cards.setView(localView());
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

test('a departed satellite moves from Overhead to Closest within ten seconds', async (t) => {
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
  cards.setView(localView());
  await nextTick();
  const group = () => $('.nearby-lists__layer[data-layer="satellites"]');
  assert.match(group()?.textContent ?? '', /SAT/);

  position = { ...HERE, lat: HERE.lat + 20 };
  // The feed revision stays unchanged while the satellite moves away.
  await advance(1_900);
  assert.ok(group(), 'the early pulse reuses the cached rows');
  await advance(4_000);
  await advance(4_000);
  assert.match(
    group().closest('.nearby-lists').querySelector('h4').textContent,
    /Closest to view/,
  );
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
    await settleInspectorIndex();
  };

  cards.setView({ center: HERE, heightM: 20_000_000 });
  await settleInspectorIndex();
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
  state.selectedId = null;
  state.selectedRow = null;
  t.mock.timers.tick(4_000);
  await publish();
  assert.equal(total(), '1');
  assert.equal(block().querySelectorAll('[data-row-key]').length, 1);
});

test('selecting a Nearby sighting keeps its record until the card closes', async (t) => {
  const now = Date.now();
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now });
  const owl = {
    ...HERE,
    stableId: 'inat:1',
    commonName: 'Barred Owl',
    obscured: true,
    observedAt: now - 2 * 86_400_000 + 1_000,
  };
  const state = {
    enabled: true,
    rows: new Map([[owl.stableId, owl]]),
    renderedRows: [],
    lastUpdate: now,
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
  const { $, cards, flown, replaceManager } = fixture(t, [wildlife]);
  cards.setView(localView());
  await settleInspectorIndex();
  const row = $(
    '.nearby-lists__layer[data-layer="wildlife-sightings"] [data-row-key]',
  );
  row.click();
  await nextTick();
  assert.equal(cards.card.title, 'Barred Owl');
  assert.deepEqual(flown, [cards.card.key]);

  const newState = { ...state, rows: new Map(state.rows), contextRecord: null };
  const replacement = createWildlifeControls({
    state: newState,
    services: { now: Date.now },
    parts: {},
  }).methods;
  const newRow = { ...wildlife, module: replacement };
  replaceManager({
    layers: new Map([[wildlife.id, newRow]]),
    getAll: () => [newRow],
  });
  cards.syncDataManager();
  assert.equal(state.contextRecord, null);
  t.mock.timers.tick(2_000);
  await nextTick();
  assert.equal(cards.lost, false);
  assert.equal(replacement.getAnalystRecords().length, 1);
  newState.rows.clear();
  cards.refresh();
  assert.equal(cards.lost, false);
  assert.equal(replacement.getAnalystRecords().length, 1);
  const identity = cards.card.identity;
  assert.equal(cards.select(identity), true);
  assert.equal(
    replacement.getAnalystRecords().length,
    1,
    'reselecting preserves the record',
  );
  assert.equal(
    state.selectedId,
    undefined,
    'row selection does not pick a marker',
  );
  cards.clear();
  assert.equal(replacement.getAnalystRecords().length, 0);
});

test('the globe count stays through a refresh and clears for a new enable', async (t) => {
  const flights = flightsOn([flight('visible01', HERE.lat, HERE.lon)], {
    count: 123,
  });
  const { $, cards, notifyLayers } = fixture(t, [flights]);
  const total = () =>
    $('.view-context__block[data-layer="flights"] strong')?.textContent;
  cards.setView({ center: HERE, heightM: 20_000_000 });
  await settleInspectorIndex();
  assert.equal(total(), '1');

  flights.stats = { ...flights.stats, count: 0, loading: true };
  notifyLayers();
  await settleInspectorIndex();
  assert.equal(total(), '1');

  flights.enabled = false;
  notifyLayers();
  await settleInspectorIndex();
  assert.equal(total(), undefined);
  flights.enabled = true;
  flights.records = [];
  flights.stats = { count: 0, lastUpdate: null, loading: true };
  notifyLayers();
  await settleInspectorIndex();
  assert.equal(total(), 'Loading');
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
  await settleInspectorIndex();
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
  assert.equal(
    block().querySelector('strong').textContent,
    '5',
    'all five records are loaded',
  );
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
  assert.equal(
    block().querySelector('strong').textContent,
    '1',
    'only FAR02 matches in view',
  );
  contextSearchText.value = '';
  await nextTick();
  assert.equal(
    block().querySelector('strong').textContent,
    '5',
    'clearing search restores the loaded count',
  );
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
  cards.setView(localView());
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
        // Outside its coverage, as the layer says at this centre.
        getValueAt: () => ({
          value: null,
          reason: 'No station within 50 km',
          outsideCoverage: true,
        }),
      },
    },
  ]);
  cards.setView(localView());
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
  const wind = $('.view-context__tile--value[data-layer="wind"]');
  assert.ok(wind, 'a value tile for the field layer');
  assert.equal(
    wind.parentElement.previousElementSibling?.textContent,
    'At the centre of the view',
  );
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
  assert.match($('[data-row-layer="flights"]').textContent, /NEAR01/);
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

// A selected flight away from the centre of the view, with field layers.
const AIRCRAFT = { lat: 30.4, lon: -97.5 };
const fieldLayer = (id, name, getValueAt, extra = {}) => ({
  id,
  name,
  enabled: true,
  stats: { count: 0, lastUpdate: Date.now() },
  ...extra,
  module: { getAnalystRecords: undefined, getValueAt },
});
async function selectedFlightWith(t, fields) {
  const context = fixture(t, [
    flightsOn([
      flight('near01', AIRCRAFT.lat, AIRCRAFT.lon),
      // Farther from the view centre, near the aircraft: its Nearby row.
      flight('near02', AIRCRAFT.lat + 0.05, AIRCRAFT.lon + 0.05),
    ]),
    ...fields,
  ]);
  context.cards.setView(localView());
  await settleInspectorIndex();
  context.$(NEAREST).click();
  await nextTick();
  assert.equal(context.cards.card?.identity.id, 'near01');
  return context;
}
const conditionRow = (layerId) =>
  document.querySelector(`.spot-conditions__fields [data-layer="${layerId}"]`);

test('a selected flight shows Conditions here: GNSS integrity read at the aircraft, not the view centre', async (t) => {
  const asked = [];
  const { $ } = await selectedFlightWith(t, [
    fieldLayer('gnss-integrity', 'GNSS integrity', (lat, lon) => {
      asked.push([lat, lon]);
      return lat === AIRCRAFT.lat && lon === AIRCRAFT.lon
        ? {
            value: 'Low interference',
            detail: 'Flight reports',
            at: Date.now() - 20 * 60_000,
          }
        : { value: 'View centre reading' };
    }),
  ]);
  const group = $('.spot-conditions__fields');
  assert.ok(group, 'a Conditions here group on the card');
  assert.match(group.querySelector('h4')?.textContent ?? '', /Conditions here/);
  assert.ok(group.querySelector('ul > li'), 'its rows are a list');
  const row = conditionRow('gnss-integrity');
  assert.match(
    row.querySelector('.spot-conditions__field-name').textContent,
    /GNSS integrity/i,
  );
  assert.equal(
    row.querySelector('.spot-conditions__field-value').textContent.trim(),
    'Low interference',
  );
  assert.equal(
    row.querySelector('.spot-conditions__field-detail').textContent,
    'Flight reports',
  );
  assert.equal(
    row.querySelector('.spot-conditions__field-age').textContent,
    'Updated 20 min ago',
  );
  assert.ok(row.querySelector('.material-symbols-outlined'), 'its layer icon');
  // No legend band in this reading: no colour, and not shown as empty.
  assert.equal(row.dataset.level, undefined);
  assert.equal(row.querySelector('.spot-conditions__field-swatch'), null);
  assert.ok(!row.classList.contains('spot-conditions__field--empty'));
  assert.doesNotMatch(row.textContent, /View centre reading/);
  assert.deepEqual(asked.at(-1), [AIRCRAFT.lat, AIRCRAFT.lon]);
  // It sits just above the Nearby lists.
  const nearby = $('.spot-conditions .nearby-lists');
  assert.ok(nearby);
  assert.ok(
    group.compareDocumentPosition(nearby) & Node.DOCUMENT_POSITION_FOLLOWING,
  );
  contextSearchOpen.value = true;
  contextSearchText.value = 'near02';
  await nextTick();
  assert.ok(!conditionRow('gnss-integrity'));
  contextSearchText.value = 'flight reports';
  await nextTick();
  assert.ok(conditionRow('gnss-integrity'));
});

test('the selected broadcaster does not use one of four nearby alert slots', async (t) => {
  const { cards } = fixture(t, [
    flightsOn(
      Array.from({ length: 5 }, (_, i) => ({
        ...flight('alert0' + i, AIRCRAFT.lat + i * 0.02, AIRCRAFT.lon),
        warning: 'Fixture advisory',
      })),
    ),
  ]);
  cards.select({ layerId: 'flights', id: 'alert00' }, { follow: false });
  await nextTick();
  const alerts = [
    ...document.querySelectorAll(
      '#entity-card .spot-conditions__hazard--alert .spot-conditions__row-title',
    ),
  ];
  assert.deepEqual(
    alerts.map((row) => row.textContent.toLowerCase()),
    ['alert01', 'alert02', 'alert03', 'alert04'],
  );
});

test('a cached field retains its band and names the stale feed', async (t) => {
  await selectedFlightWith(t, [
    fieldLayer(
      'air-quality',
      'Air Quality',
      () => ({
        value: 'AQHI 7',
        level: 'high',
        color: '#ffaa55',
      }),
      { stats: { count: 2, stale: true } },
    ),
  ]);
  const row = conditionRow('air-quality');
  assert.equal(row.dataset.level, 'high');
  assert.match(row.textContent, /Stale/);
  assert.match(row.textContent, /AQHI 7/);
});

test('Conditions here says No reading here for an empty reading, and the feed state for a failed read', async (t) => {
  await selectedFlightWith(t, [
    fieldLayer('gnss-integrity', 'GNSS integrity', () => null),
    fieldLayer('wind', 'Wind', () => ({ readFailed: true }), {
      stats: { count: 0, lastUpdate: Date.now(), stale: true },
    }),
  ]);
  const gnss = conditionRow('gnss-integrity');
  assert.match(gnss.textContent, /No reading here/);
  assert.doesNotMatch(gnss.textContent, /—/);
  assert.ok(gnss.classList.contains('spot-conditions__field--empty'));
  assert.equal(gnss.dataset.level, undefined);
  assert.equal(gnss.querySelector('.spot-conditions__field-swatch'), null);
  const wind = conditionRow('wind');
  assert.match(wind.textContent, /Stale/);
  assert.doesNotMatch(wind.textContent, /No reading here|—/);
  assert.ok(wind.classList.contains('spot-conditions__field--failed'));
  // The feed state's dot, as the Inspector shows it, beside its words.
  const dot = wind.querySelector('.view-context__dot');
  assert.ok(dot.classList.contains('view-context__dot--stale'));
  assert.equal(dot.getAttribute('aria-hidden'), 'true');
});

test('Conditions here shows a GNSS reading in its legend band: colour and the band words', async (t) => {
  const BANDS = [
    ['high', 'Low-accuracy score > 10%'],
    ['medium', 'Low-accuracy score 2–10%'],
    ['low', 'Low-accuracy score < 2%'],
  ];
  let reading = null;
  const { notifyLayers } = await selectedFlightWith(t, [
    fieldLayer('gnss-integrity', 'GNSS integrity', () => reading),
    fieldLayer('air-quality', 'Air Quality', () => ({
      value: 'AQHI 7 · High',
      detail: 'Hamilton · 3 km',
      level: 'high',
      color: airQualityColor('high'),
    })),
  ]);
  for (const [level, words] of BANDS) {
    reading = {
      value: words,
      detail: '3 of 9 aircraft reported low accuracy',
      level,
      color: GNSS_LEVEL_COLORS[level],
    };
    notifyLayers();
    await nextTick();
    const row = conditionRow('gnss-integrity');
    assert.equal(row.dataset.level, level);
    assert.equal(
      row.style.getPropertyValue('--field-band'),
      GNSS_LEVEL_COLORS[level],
    );
    // The colour is never alone: the band's words sit beside it.
    const value = row.querySelector('.spot-conditions__field-value');
    assert.equal(value.textContent.trim(), words);
    const swatch = value.querySelector('.spot-conditions__field-swatch');
    assert.equal(swatch.getAttribute('aria-hidden'), 'true');
  }
  const air = conditionRow('air-quality');
  assert.equal(air.dataset.level, 'high');
  assert.equal(
    air.style.getPropertyValue('--field-band'),
    airQualityColor('high'),
  );
  assert.match(air.textContent, /AQHI 7 · High/);
  // A colour that is not a plain hex colour is not used.
  reading = { value: 'Low-accuracy score < 2%', level: 'low', color: 'red;x' };
  notifyLayers();
  await nextTick();
  const row = conditionRow('gnss-integrity');
  assert.equal(row.dataset.level, undefined);
  assert.equal(row.querySelector('.spot-conditions__field-swatch'), null);
  assert.match(row.textContent, /Low-accuracy score < 2%/);
});

test('Conditions here leaves out a field layer that is off, and the whole group with none on', async (t) => {
  const gnss = fieldLayer('gnss-integrity', 'GNSS integrity', () => ({
    value: 'Low interference',
  }));
  const wind = fieldLayer('wind', 'Wind', () => ({ value: '20 km/h from W' }), {
    enabled: false,
  });
  const { $, notifyLayers } = await selectedFlightWith(t, [gnss, wind]);
  assert.ok(conditionRow('gnss-integrity'));
  assert.equal(conditionRow('wind'), null, 'no row for a layer that is off');
  gnss.enabled = false;
  notifyLayers();
  await nextTick();
  assert.equal(
    $('.spot-conditions__fields'),
    null,
    'no group without field layers on',
  );
  assert.ok($('.spot-conditions .nearby-lists'), 'Nearby stays');
});

test('Conditions here shows Air Quality only inside its coverage', async (t) => {
  let air = {
    value: 'AQHI 3 · Low',
    detail: 'Toronto · 2 km',
    level: 'low',
    color: airQualityColor('low'),
  };
  const { $, notifyLayers } = await selectedFlightWith(t, [
    fieldLayer('gnss-integrity', 'GNSS integrity', () => ({
      value: 'Low interference',
    })),
    fieldLayer('air-quality', 'Air Quality', () => air),
  ]);
  assert.match(conditionRow('air-quality').textContent, /AQHI 3 · Low/);
  // Inside coverage, no station near: the reason in place of a value.
  air = { value: null, reason: 'No station within 50 km' };
  notifyLayers();
  await nextTick();
  const empty = conditionRow('air-quality');
  assert.match(
    empty.querySelector('.spot-conditions__field-value').textContent,
    /—/,
  );
  assert.match(empty.textContent, /No station within 50 km/);
  // Outside coverage (Chicago): no row at all, the GNSS row stays.
  air = {
    value: null,
    reason: 'No station within 50 km',
    outsideCoverage: true,
  };
  notifyLayers();
  await nextTick();
  assert.equal(conditionRow('air-quality'), null);
  assert.ok(conditionRow('gnss-integrity'));
  assert.doesNotMatch(
    $('.spot-conditions__fields').textContent,
    /No reading here|No station/,
  );
});

test('Conditions here has no group when every field reading is outside coverage', async (t) => {
  const { $ } = await selectedFlightWith(t, [
    fieldLayer('air-quality', 'Air Quality', () => ({
      value: null,
      reason: 'No station within 50 km',
      outsideCoverage: true,
    })),
  ]);
  assert.equal($('.spot-conditions__fields'), null);
  assert.ok($('.spot-conditions .nearby-lists'), 'Nearby stays');
});

test("Conditions here leaves out the selected item's own layer", async (t) => {
  const station = {
    id: 'eccc:Chatham',
    provider: 'eccc',
    scale: 'AQHI',
    value: 2,
    band: 'low',
    name: 'Chatham',
    lat: HERE.lat,
    lon: HERE.lon,
  };
  const { cards } = fixture(t, [
    {
      id: 'air-quality',
      name: 'Air Quality',
      enabled: true,
      records: [station],
      stats: { count: 1, lastUpdate: Date.now() },
      module: {
        getValueAt: () => ({ value: 'AQHI 2 · Low', detail: 'Chatham · 0 km' }),
      },
    },
    fieldLayer('gnss-integrity', 'GNSS integrity', () => ({
      value: 'Low interference',
    })),
  ]);
  cards.select({
    layerId: 'air-quality',
    id: station.id,
    label: 'Chatham',
    lat: station.lat,
    lon: station.lon,
    record: station,
  });
  await nextTick();
  assert.equal(conditionRow('air-quality'), null, 'not the card again');
  assert.ok(conditionRow('gnss-integrity'), 'other layers stay');
});

const airQualityColor = (band) =>
  usAqiBand({ low: 40, moderate: 60, high: 170, 'very-high': 220 }[band]).color;

// A Toronto view, zoomed in, with Air Quality and GNSS integrity on.
const aqStation = (id, lat, lon, value, band) => ({
  id: `eccc:${id}`,
  provider: 'eccc',
  scale: 'AQHI',
  value,
  band,
  name: id,
  lat,
  lon,
});
const realAirQuality = (readings = []) =>
  createAirQualityLayer({
    source: {
      definitions: [
        {
          id: 'regional',
          title: 'Regional',
          network: 'Regional',
          parameters: ['PM2.5'],
        },
      ],
      getSnapshot: async () => onAqiPeriods(readings),
    },
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
  });

test('Within: a layer with items and a reading here has one tile, the reading leading and its count under it', async (t) => {
  const { $, cards, dataManager, notifyLayers } = fixture(t, [
    {
      id: 'air-quality',
      name: 'Air Quality',
      enabled: true,
      records: [
        aqStation('North', HERE.lat + 0.05, HERE.lon, 2, 'low'),
        aqStation('South', HERE.lat - 0.05, HERE.lon, 3, 'low'),
      ],
      stats: { count: 2, lastUpdate: Date.now() },
      module: {
        getValueAt: () => ({
          value: 'AQHI 2 · Low',
          detail: 'North · 6 km',
          stale: true,
          at: Date.now() - 3 * 3_600_000,
          level: 'low',
          color: airQualityColor('low'),
        }),
      },
    },
  ]);
  cards.setView(localView());
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
  const tiles = document.querySelectorAll(
    '.view-context__tile[data-layer="air-quality"]',
  );
  assert.equal(tiles.length, 1, 'one tile, not a count and a reading');
  const [tile] = tiles;
  assert.equal(
    tile.querySelector('.view-context__dot').getAttribute('aria-label'),
    'Stale',
  );
  const pill = tile.querySelector('strong.field-pill');
  assert.equal(pill.textContent.trim(), 'AQHI 2 · Low');
  assert.equal(pill.dataset.level, 'low');
  assert.equal(
    pill.style.getPropertyValue('--field-band'),
    airQualityColor('low'),
  );
  assert.equal(
    tile.querySelector('.view-context__tile-count').textContent,
    '2 stations',
  );
  assert.match(tile.textContent, /North · 6 km/);
  assert.equal(tile.getAttribute('title'), 'North · 6 km');
  assert.equal($('.view-context__tile--value strong:not(.field-pill)'), null);
  const layer = dataManager().layers.get('air-quality');
  layer.stats = { ...layer.stats, degraded: true };
  notifyLayers();
  await nextTick();
  assert.equal(
    tile.querySelector('.view-context__dot').getAttribute('aria-label'),
    'Degraded',
  );

  let status = { loading: true };
  t.mock.method(cards, 'inspectorGroups', () => [
    {
      layerId: 'air-quality',
      scope: 'none',
      count: null,
      items: [],
      ...status,
    },
  ]);
  for (const [state, label] of [
    [{ loading: true }, 'Loading'],
    [{ readFailed: true }, 'Unavailable'],
  ]) {
    status = state;
    const view = localView();
    cards.setView({ ...view, center: { ...HERE, lat: HERE.lat + 0.01 } });
    await nextTick();
    const reading = $('.view-context__tile--value[data-layer="air-quality"]');
    assert.equal(
      reading.querySelector('.field-pill').textContent,
      'AQHI 2 · Low',
    );
    assert.equal(reading.querySelector('[role="status"]')?.textContent, label);
  }
});

test('Within: with no reading here, the count tile stays as it was', async (t) => {
  const { $, cards } = fixture(t, [
    {
      id: 'air-quality',
      name: 'Air Quality',
      enabled: true,
      records: [aqStation('North', HERE.lat + 0.05, HERE.lon, 2, 'low')],
      stats: { count: 1, lastUpdate: Date.now() },
      module: {
        getValueAt: () => ({ value: null, reason: 'No station within 50 km' }),
      },
    },
  ]);
  cards.setView(localView());
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
  const count = $(
    '.view-context__tile:not(.view-context__tile--value)[data-layer="air-quality"]',
  );
  assert.equal(count.querySelector('strong').textContent, '1');
  assert.equal(count.querySelector('.view-context__tile-count'), null);
  const value = $('.view-context__tile--value[data-layer="air-quality"]');
  assert.match(value.querySelector('strong').textContent, /—/);
  assert.match(value.textContent, /No station within 50 km/);
});

test('Within: a GNSS reading is its band pill, the score name under it', async (t) => {
  const { $, cards } = fixture(t, [
    fieldLayer('gnss-integrity', 'GNSS integrity', () => ({
      value: 'Low-accuracy score < 2%',
      short: '< 2%',
      measure: 'Low-accuracy score',
      detail: '1 of 9 aircraft reported low accuracy',
      level: 'low',
      color: GNSS_LEVEL_COLORS.low,
    })),
  ]);
  cards.setView(localView());
  await nextTick();
  const tile = $('.view-context__tile--value[data-layer="gnss-integrity"]');
  const strong = tile.querySelector('strong');
  assert.ok(strong.classList.contains('field-pill'));
  assert.equal(strong.textContent.trim(), '< 2%');
  assert.doesNotMatch(strong.textContent, /Low-accuracy score/);
  assert.equal(strong.dataset.level, 'low');
  assert.ok(strong.querySelector('.spot-conditions__field-swatch'));
  const smalls = [...tile.querySelectorAll('small')].map((n) => n.textContent);
  assert.ok(smalls.includes('Low-accuracy score'));
  assert.ok(smalls.includes('1 of 9 aircraft reported low accuracy'));
});

test('local GNSS shows sampled best-band areas without a worst-area list', async (t) => {
  const cells = [
    { id: 'a', ...HERE },
    { id: 'b', ...HERE },
  ];
  const { $, cards } = fixture(t, [
    {
      ...fieldLayer('gnss-integrity', 'GNSS integrity', () => null),
      module: {
        getAnalystRecords: undefined,
        getValueAt: () => null,
        getContextPopulation: () => cells,
        getContextSummary: ({ population }) => ({
          bands: [
            {
              label: '< 2%',
              count: population.length,
              color: GNSS_LEVEL_COLORS.low,
            },
          ],
          items: [],
          note: 'Sampled around views you visited',
        }),
      },
    },
  ]);
  const view = { ...localView(), heightM: 80_000 };
  const block = () => $('.view-context__summary[data-layer="gnss-integrity"]');
  cards.setView(view);
  await settleInspectorIndex();
  assert.ok(
    block(),
    'sampled areas remain visible when none is in a worse band',
  );
  assert.match(
    block().querySelector('.view-context__block-name').textContent,
    /GNSS integrity/i,
  );
  assert.equal(
    block().querySelector('.view-context__bar').getAttribute('aria-label'),
    '< 2% 2',
  );
  assert.match(block().textContent, /Sampled around views you visited/);
  assert.equal(block().querySelector('ul'), null);

  cards.setView({
    ...view,
    center: { lat: 0, lon: 0 },
    rect: { west: -1, east: 1, north: 1, south: -1 },
  });
  await settleInspectorIndex();
  assert.equal(block(), null, 'no sample summary outside the sampled area');
});

test('globe view: GNSS integrity counts its areas by band, says it is a sample, and its worst areas fly there', async (t) => {
  const summary = {
    headline: '214 areas',
    bands: [
      { id: 'low', label: '< 2%', color: GNSS_LEVEL_COLORS.low, count: 200 },
      {
        id: 'medium',
        label: '2–10%',
        color: GNSS_LEVEL_COLORS.medium,
        count: 10,
      },
      { id: 'high', label: '> 10%', color: GNSS_LEVEL_COLORS.high, count: 4 },
    ],
    itemsLabel: 'Least accurate sampled areas',
    items: [
      {
        key: 'gnss-integrity:cell-a',
        lead: '> 10%',
        level: 'high',
        color: GNSS_LEVEL_COLORS.high,
        text: '3 of 4 aircraft',
        lat: 33.1,
        lon: 35.2,
      },
    ],
    note: 'Sampled around views you visited',
  };
  const { $, cards, flown } = fixture(t, [
    {
      ...fieldLayer('gnss-integrity', 'GNSS integrity', () => null),
      module: {
        getAnalystRecords: undefined,
        getValueAt: () => null,
        getContextPopulation: () => summary.items,
        getContextSummary: () => summary,
      },
    },
  ]);
  cards.setView({ center: HERE, heightM: 20_000_000 });
  await settleInspectorIndex();
  const block = $('.view-context__block[data-layer="gnss-integrity"]');
  assert.equal(
    block.querySelector('.view-context__block-head strong').textContent,
    '214 areas',
  );
  assert.match(
    block.querySelector('.view-context__summary-caption').textContent,
    /Updated|Live|…/,
  );
  const parts = [...block.querySelectorAll('.view-context__bar span')];
  assert.deepEqual(
    parts.map((part) => part.style.getPropertyValue('--part-color')),
    [GNSS_LEVEL_COLORS.low, GNSS_LEVEL_COLORS.medium, GNSS_LEVEL_COLORS.high],
  );
  assert.deepEqual(
    parts.map((part) => Number(part.style.flexGrow).toFixed(3)),
    [200 / 214, 10 / 214, 4 / 214].map((n) => n.toFixed(3)),
  );
  assert.match(
    block.querySelector('.view-context__summary-note').textContent,
    /Sampled around views you visited/,
  );
  const list = block.querySelector('.view-context__summary-rows ul');
  assert.equal(list.getAttribute('aria-label'), 'Least accurate sampled areas');
  const row = list.querySelector('button');
  assert.equal(row.dataset.rowLayer, 'gnss-integrity');
  assert.match(row.textContent, /> 10%/);
  assert.match(row.textContent, /3 of 4 aircraft/);
  assert.equal(row.querySelector('.field-pill').dataset.level, 'high');
  row.click();
  await nextTick();
  assert.equal(cards.card?.layerId, 'place');
  assert.equal(cards.card?.lat, 33.1);
  assert.deepEqual(flown, [cards.card.key], 'flown to the area');
});

test('the Air Quality summary describes only the stations in view', async (t) => {
  const stations = [
    { name: 'Toronto', lon: HERE.lon, concentration: 3 },
    { name: 'Unrated', lon: HERE.lon + 3, concentration: 12 },
    { name: 'Vancouver', lon: HERE.lon - 3, concentration: 60 },
  ].map(({ name, lon, concentration }) => ({
    id: `regional:${name}`,
    provider: 'regional',
    stationId: name,
    name,
    lat: HERE.lat,
    lon,
    parameter: 'PM2.5',
    units: 'µg/m³',
    kind: 'observation',
    averagingMinutes: 60,
    observedMs: Date.now(),
    value: concentration,
    qualityFlagged: name === 'Unrated',
  }));
  const layer = realAirQuality(stations);
  const viewer = {};
  bindFakeDraw(viewer);
  layer.init(viewer);
  t.after(() => layer.destroy());
  layer.enable();
  assert.equal(await layer.update(), true);
  const { $, cards } = fixture(t, [
    {
      id: 'air-quality',
      name: 'Air Quality',
      enabled: true,
      module: layer,
      stats: layer.getStats(),
    },
  ]);
  const view = { ...localView(), heightM: 80_000 };
  cards.setView(view);
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
  const summary = () => $('.view-context__summary[data-layer="air-quality"]');
  assert.equal(
    $('.view-context__tile[data-layer="air-quality"] .view-context__tile-count')
      .textContent,
    '1 station',
  );
  assert.match(summary().textContent, /Stations rated: 1 of 1/);
  const parts = summary().querySelectorAll('.view-context__bar span');
  assert.equal(parts.length, 1);
  assert.equal(
    parts[0].style.getPropertyValue('--part-color'),
    airQualityColor('low'),
  );
  const rows = summary().querySelectorAll('.view-context__summary-rows button');
  assert.equal(rows.length, 1);
  assert.match(rows[0].textContent, /Toronto/);

  cards.setView({ ...view, rect: { ...view.rect, west: HERE.lon - 4 } });
  await nextTick();
  assert.match(summary().textContent, /Stations rated: 2 of 2/);

  const label = () => summary().querySelector('ul').getAttribute('aria-label');
  assert.equal(label(), 'Highest air-quality readings in view');
  setContextRadiusKm(500);
  cards.setView({ ...view, heightM: 15_000 });
  await settleInspectorIndex();
  assert.match(label(), /in view/i);
  $('button[data-scope-layer="air-quality"]').click();
  await nextTick();
  assert.match(summary().textContent, /Vancouver/);
  assert.match(label(), /Within 500 km/);
  assert.equal(
    summary().querySelector('.view-context__block-name').textContent,
    label(),
  );
  cards.setView({
    ...localView({ lat: HERE.lat, lon: HERE.lon + 3 }),
    heightM: 80_000,
  });
  await settleInspectorIndex();
  assert.match(summary()?.textContent ?? '', /Stations rated: 0 of 1/);
  assert.equal(summary().querySelector('.view-context__bar'), null);
  assert.equal(summary().querySelector('.view-context__summary-rows'), null);

  cards.setView({
    ...localView({ lat: 41.9, lon: 12.5 }),
    heightM: 80_000,
  });
  await settleInspectorIndex();
  const empty = $('.view-context__tile[data-layer="air-quality"]');
  assert.equal(
    empty.querySelector('.view-context__dot').getAttribute('aria-label'),
    'Live',
  );
  assert.equal(empty.querySelector('strong').textContent, '0');
  assert.equal(empty.querySelector('.view-context__bar'), null);
  assert.equal(empty.querySelector('[data-row-key]'), null);
});

test('globe Air Quality search shows only matching stations and restores the mixed-rated summary when cleared', async (t) => {
  const readings = [
    ['Requested Station', 5, false],
    ['Other Rated Station', 45, false],
    ['Other Unrated Station', 12, true],
  ].map(([name, value, qualityFlagged], index) => ({
    id: `regional:${index}`,
    provider: 'regional',
    stationId: String(index),
    name,
    lat: HERE.lat + index * 0.01,
    lon: HERE.lon,
    parameter: 'PM2.5',
    units: 'µg/m³',
    kind: 'observation',
    averagingMinutes: 60,
    observedMs: Date.now(),
    value,
    qualityFlagged,
  }));
  const layer = realAirQuality(readings);
  const viewer = {};
  bindFakeDraw(viewer);
  layer.init(viewer);
  t.after(() => layer.destroy());
  layer.enable();
  assert.equal(await layer.update(), true);
  const { $, cards } = fixture(t, [
    {
      id: 'air-quality',
      name: 'Air Quality',
      enabled: true,
      module: layer,
      stats: layer.getStats(),
    },
  ]);
  cards.setView({ ...localView(), heightM: 20_000_000 });
  await settleInspectorIndex();

  const block = () => $('.view-context__block[data-layer="air-quality"]');
  assert.match(block()?.textContent ?? '', /Stations rated: 2 of 3/);
  contextSearchOpen.value = true;
  contextSearchText.value = 'Requested Station';
  await nextTick();

  assert.ok(block());
  assert.equal(
    block().querySelector('.view-context__block-head strong').textContent,
    '1',
  );
  assert.match(block().getAttribute('aria-label'), /In view · 1/);
  assert.deepEqual(
    [
      ...block().querySelectorAll(
        '.view-context__block-rows .nearby-lists__name',
      ),
    ].map((row) => row.textContent),
    ['Requested Station'],
  );
  assert.doesNotMatch(
    block().textContent,
    /Other Rated Station|Other Unrated Station|Stations rated:/,
  );
  contextSearchText.value = '';
  await nextTick();
  assert.match(block()?.textContent ?? '', /Stations rated: 2 of 3/);
});

test('Air Quality in Context lists the worst readings in view by band, and a row opens and flies to the station', async (t) => {
  const north = aqStation('North', HERE.lat + 0.05, HERE.lon, 4, 'moderate');
  const records = [
    north,
    aqStation('South', HERE.lat - 0.05, HERE.lon, 2, 'low'),
  ];
  const summary = {
    caption: '2 stations reporting',
    bands: [
      { id: 'low', label: 'Low', color: airQualityColor('low'), count: 1 },
      {
        id: 'moderate',
        label: 'Moderate',
        color: airQualityColor('moderate'),
        count: 1,
      },
      { id: 'high', label: 'High', color: airQualityColor('high'), count: 0 },
      {
        id: 'very-high',
        label: 'Very High',
        color: airQualityColor('very-high'),
        count: 0,
      },
    ],
    itemsLabel: 'Highest air-quality readings in view',
    items: [
      {
        key: north.id,
        lead: 'AQHI 4',
        level: 'moderate',
        color: airQualityColor('moderate'),
        text: 'North · Moderate',
        lat: north.lat,
        lon: north.lon,
        record: north,
      },
    ],
    note: 'Canada only · ECCC AQHI network',
  };
  const { $, cards, flown } = fixture(t, [
    {
      id: 'air-quality',
      name: 'Air Quality',
      enabled: true,
      records,
      stats: { count: 2, lastUpdate: Date.now() },
      module: {
        getValueAt: () => ({ value: null, reason: 'No station within 50 km' }),
        getContextPopulation: () => records,
        getContextSummary: () => summary,
      },
    },
  ]);
  cards.setView({ ...localView(), heightM: 300_000 });
  await nextTick();
  await settleInspectorIndex();
  const section = $('.view-context__summary[data-layer="air-quality"]');
  assert.ok(section, 'its scoped reporting list');
  assert.match(section.textContent, /2 stations reporting/);
  assert.match(section.textContent, /Canada only · ECCC AQHI network/);
  const parts = [...section.querySelectorAll('.view-context__bar span')];
  assert.equal(parts.length, 2, 'bands with stations only');
  assert.equal(
    parts[1].style.getPropertyValue('--part-color'),
    airQualityColor('moderate'),
  );
  const row = section.querySelector('.view-context__summary-rows button');
  assert.equal(
    section.querySelector('ul').getAttribute('aria-label'),
    'Highest air-quality readings in view',
  );
  assert.match(row.querySelector('.field-pill').textContent, /AQHI 4/);
  assert.match(row.textContent, /North · Moderate/);
  row.click();
  await nextTick();
  assert.equal(cards.card?.layerId, 'air-quality');
  assert.equal(cards.card?.identity.id, north.id);
  assert.deepEqual(flown, [cards.card.key], 'flown to the station');
  // At globe view the same list sits in the layer's block.
  cards.clear();
  cards.setView({ center: HERE, heightM: 20_000_000 });
  await nextTick();
  const block = $('.view-context__block[data-layer="air-quality"]');
  assert.ok(block.querySelector('.view-context__summary-rows button'));
  assert.match(block.textContent, /Canada only/);
});

test('an air-quality station card leads with its reading on the computed US AQI scale', async (t) => {
  const layer = realAirQuality();
  const station = {
    id: 'aqi:Chatham',
    provider: 'regional',
    name: 'Chatham',
    parameter: 'aqi',
    scale: 'US AQI',
    value: 40,
    aqi: { index: 40 },
    lat: HERE.lat,
    lon: HERE.lon,
  };
  const { $, cards } = fixture(t, [
    {
      id: 'air-quality',
      name: 'Air Quality',
      enabled: true,
      records: [station],
      stats: { count: 1, lastUpdate: Date.now() },
      module: {
        getValueAt: () => null,
        describeReading: (record) => layer.describeReading(record),
      },
    },
  ]);
  cards.select({
    layerId: 'air-quality',
    id: station.id,
    label: 'Chatham',
    lat: station.lat,
    lon: station.lon,
    record: station,
  });
  await nextTick();
  const hero = $('#entity-card .reading-hero');
  assert.ok(hero, 'one hero reading');
  assert.equal(hero.getAttribute('aria-label'), 'US AQI 40, Good');
  assert.equal(
    hero.style.getPropertyValue('--field-band'),
    airQualityColor('low'),
  );
  assert.match(
    hero.querySelector('.reading-hero__value').textContent,
    /US AQI\s*40/,
  );
  assert.equal(hero.querySelector('.field-pill').textContent.trim(), 'Good');
  const segments = [...hero.querySelectorAll('.reading-hero__scale span')];
  assert.deepEqual(
    segments.map((segment) => segment.getAttribute('title')),
    [
      'Good',
      'Moderate',
      'Unhealthy for Sensitive Groups',
      'Unhealthy',
      'Very Unhealthy',
      'Hazardous',
    ],
  );
  assert.ok(hero.querySelector('.reading-hero__marker'));
  assert.equal($('#entity-card .entity-card__tiles'), null);
});

test('a selected card has no Conditions here group without field layers', async (t) => {
  const { $ } = await selectedFlightWith(t, []);
  assert.ok($('.spot-conditions'));
  assert.equal($('.spot-conditions__fields'), null);
});

test('an active search keeps the Data Layers action when no layers are suggested', async (t) => {
  const { $, cards, pinia } = fixture(t, [{ id: 'wind', enabled: true }]);
  const action = t.mock.method(usePanelChromeStore(pinia), 'act');
  cards.setView(localView());
  await nextTick();
  assert.equal($('.view-context__pointer'), null);
  contextSearchOpen.value = true;
  contextSearchText.value = 'wind';
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

test('a globe breakdown and count update together when visible records change', async (t) => {
  const flights = flightsOn([
    { ...flight('one', 1, 1), aircraftClass: 'airliner' },
    { ...flight('two', 2, 2), aircraftClass: 'airliner' },
    { ...flight('three', 3, 3), aircraftClass: 'fastjet' },
  ]);
  const { $, cards, notifyLayers } = fixture(t, [flights]);
  cards.setView({ center: { lat: 0, lon: 0 }, heightM: 20_000_000 });
  await settleInspectorIndex();
  assert.ok($('.view-context__block[data-layer="flights"] .view-context__bar'));
  flights.records = flights.records.slice(0, 1);
  flights.stats = { count: 1, lastUpdate: Date.now() };
  notifyLayers();
  await settleInspectorIndex();
  assert.equal(
    $('.view-context__block[data-layer="flights"] strong').textContent,
    '1',
  );
  assert.match(
    $(
      '.view-context__block[data-layer="flights"] .view-context__bar',
    ).getAttribute('aria-label'),
    /Airliners 1/,
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
  cards.setView({ ...localView(), heightM: 120_000 });
  await settleInspectorIndex();
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

test("folded, Context's name opens it, as its ◀ button does", async (t) => {
  const { $, pinia, close } = fixture(t, [flightsOn([])]);
  const chrome = usePanelChromeStore(pinia);
  const acted = [];
  const act = chrome.act;
  chrome.act = (...args) => acted.push(args);
  t.after(() => {
    chrome.act = act;
  });
  close();
  await nextTick();
  const name = $('#global-context-panel .context-title-open');
  assert.ok(name, 'folded, the name is a button');
  assert.equal(name.tagName, 'BUTTON');
  name.click();
  assert.deepEqual(acted, [['toggle', 'global-context-panel']]);
});

test('folded, opening Context from its name by keyboard moves focus to the expanded header', async (t) => {
  const { $, pinia, close, open } = fixture(t, [flightsOn([])]);
  const chrome = usePanelChromeStore(pinia);
  const act = chrome.act;
  // As PanelChrome answers it: the panel opens.
  chrome.act = (name, id) => {
    if (name === 'toggle' && id === 'global-context-panel') open();
  };
  t.after(() => {
    chrome.act = act;
  });
  close();
  await nextTick();
  const name = $('#global-context-panel .context-title-open');
  name.focus();
  name.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
  await nextTick();
  await nextTick();
  assert.equal($('#global-context-panel .context-title-open'), null);
  assert.ok(
    document.activeElement?.closest('#global-context-panel .ui-panel__head'),
    `focus is in the header, not on ${document.activeElement?.tagName}`,
  );
});

test('closing Context releases the old camera list host and reopening keeps the list', async (t) => {
  const { $, close, open } = fixture(t, [
    {
      id: 'cctv',
      name: 'Cameras',
      enabled: true,
      records: [],
      stats: { count: 0, loading: true },
    },
  ]);
  await nextTick();
  await nextTick();

  const list = $('[data-list-card="cctv"]');
  assert.ok(list);
  const oldHost = list.parentElement;
  assert.ok(oldHost.closest('#context-body'));
  close();
  await nextTick();
  await nextTick();

  assert.equal(oldHost.isConnected, false);
  assert.equal(oldHost.childNodes.length, 0);
  assert.equal(list.isConnected, true);
  assert.ok(list.closest('[hidden]'));

  open();
  await nextTick();
  await nextTick();
  assert.equal($('[data-list-card="cctv"]'), list);
  assert.ok(list.closest('#context-body'));
});

test('a layer turned on at globe view shows its block at once, as Loading, not at the next refresh', async (t) => {
  const cameras = {
    id: 'cctv',
    name: 'CCTV',
    enabled: false,
    records: [],
    stats: { count: 0, loading: true },
  };
  const { $, cards, notifyLayers } = fixture(t, [
    flightsOn([flight('near01', 28.1, -80)]),
    cameras,
  ]);
  cards.setView({ center: { lat: 28, lon: -80 }, heightM: 18_000_000 });
  await nextTick();
  assert.equal($('[data-list-card="cctv"]'), null);
  cameras.enabled = true;
  notifyLayers();
  await nextTick();
  const block = $('[data-list-card="cctv"]');
  assert.ok(block, 'the block shows without waiting for the refresh');
  assert.match(block.textContent, /Loading/);

  cameras.records = [
    { id: 'near', name: 'Near camera', lat: 28, lon: -80 },
    { id: 'far', name: 'Far camera', lat: -28, lon: 100 },
  ];
  cameras.stats = { count: 32, lastUpdate: Date.now() };
  notifyLayers();
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
  assert.equal(block.querySelector('strong').textContent, '2');
  assert.match(block.textContent, /Near camera/);
  assert.match(block.textContent, /Far camera/);
  contextSearchOpen.value = true;
  contextSearchText.value = 'Far camera';
  await settleInspectorIndex();
  assert.match(block.textContent, /Far camera/);
  assert.doesNotMatch(block.textContent, /Near camera/);
  assert.equal($('.view-context__empty'), null);
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
  const style = document.createElement('style');
  style.textContent = fs.readFileSync(
    new URL('./styles/spot-conditions.css', import.meta.url),
    'utf8',
  );
  document.head.append(style);
  t.after(() => style.remove());
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const reads = [];
  const brief = async (lat, lon) => {
    reads.push([lat, lon]);
    return {
      weather: {
        observedAt: new Date().toISOString(),
        timeZone: 'America/Chicago',
        utcOffsetSeconds: -21600,
        source: 'open-meteo',
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
  const flights = flightsOn([flight('near01', DENVER.lat + 0.05, DENVER.lon)]);
  const { $, point, notifyLayers } = fixture(t, [flights], {
    brief,
    fetchImpl,
  });
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
  const assertSourceChip = (reading) => {
    const [chip] = document.querySelectorAll(
      'a[href="https://open-meteo.com/"]',
    );
    assert.equal(
      document.querySelectorAll('a[href="https://open-meteo.com/"]').length,
      1,
    );
    assert.ok(
      reading.contains(chip),
      'the chip is next to the weather reading',
    );
    assert.equal(chip.textContent.trim(), 'Open-Meteo');
    assert.equal(
      chip.getAttribute('aria-label'),
      'Weather data by Open-Meteo.com',
    );
    assert.equal(chip.getAttribute('translate'), 'no');
  };
  assertSourceChip(block.querySelector('.spot-conditions__weather-now'));
  const factsGrid = block.querySelector('.spot-conditions__weather-facts');
  assert.equal(getComputedStyle(factsGrid).display, 'grid');
  const facts = Object.fromEntries(
    [...factsGrid.querySelectorAll('div')].map((node) => [
      node.querySelector('dt').textContent,
      node.querySelector('dd').textContent,
    ]),
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
  // The weather reading precedes the visible layer counts.
  assert.ok(
    block.compareDocumentPosition($('.view-context__tiles')) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  );
  assert.equal(reads.length, 1, 'one weather read for the time and the block');
  assert.deepEqual(
    fetched.filter((url) => /weather|regional/.test(url)),
    [],
    'no request of its own',
  );

  flights.enabled = false;
  notifyLayers();
  await nextTick();
  assert.match(
    $('.view-context__tiles--facts .view-context__tile strong').textContent,
    /18 °C/,
  );
  assertSourceChip($('.view-context__tiles--facts .view-context__tile'));
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

test('Nearby names a remembered photo with no title as its card does, in the language shown', async (t) => {
  t.after(() => setLocale('en'));
  const untitled = {
    id: 'mapillary:3640240722906662',
    name: null,
    lat: HERE.lat,
    lon: HERE.lon,
    provider: 'Mapillary',
  };
  const titled = {
    ...untitled,
    id: 'mapillary:7',
    name: 'Congress Ave',
    lat: HERE.lat + 0.001,
  };
  const { $, cards } = fixture(t, [
    {
      id: 'street-level',
      name: 'Street Level',
      enabled: true,
      records: [untitled, titled],
      stats: { count: 2 },
    },
  ]);
  const rect = { west: -98, south: 29, east: -97, north: 31 };
  cards.setView({ center: HERE, heightM: 40_000, rect });
  await settleInspectorIndex();
  const shown = () =>
    [
      ...document.querySelectorAll(
        '[data-row-layer="street-level"] .nearby-lists__name',
      ),
    ].map((name) => [name.textContent, name.getAttribute('title')]);
  const rows = shown();
  assert.ok(rows.length, 'Nearby lists the photos');
  assert.ok(
    rows.every(([words]) => !words.includes('3640240722906662')),
    JSON.stringify(rows),
  );
  assert.ok(rows.some(([words]) => words === 'Street-level photo'));
  assert.ok(rows.some(([words]) => words === 'Congress Ave'));
  for (const [words, title] of rows)
    if (title !== null)
      assert.equal(title, words, 'its tooltip reads the same');

  setLocale('de');
  cards.setView({ center: HERE, heightM: 40_001, rect });
  await settleInspectorIndex();
  const translated = shown();
  assert.ok(
    translated.some(([words]) => words === 'Foto auf Straßenebene'),
    JSON.stringify(translated),
  );
  assert.ok(translated.some(([words]) => words === 'Congress Ave'));

  cards.select({ layerId: 'street-level', id: untitled.id }, { follow: false });
  await nextTick();
  assert.equal(
    cards.card?.title,
    'Street-level photo',
    'the card is unchanged',
  );
});

test('switching Street Level cards withdraws only the previous pending request', async (t) => {
  const photo = {
    id: 'mapillary:1',
    name: 'Congress Ave',
    lat: 30.27,
    lon: -97.74,
  };
  const near = { ...photo, id: 'mapillary:2', name: 'Sixth Street' };
  const { cards, pinia } = fixture(t, [
    {
      id: 'street-level',
      name: 'Street Level',
      enabled: true,
      records: [photo, near],
      stats: { count: 2 },
    },
  ]);
  const closed = [];
  let withdrawn = 0;
  useStreetLevelStore(pinia).attach({
    closePhoto: (id, options) =>
      closed.push({ id, pendingOnly: options?.pendingOnly }),
    withdrawPhoto: () => withdrawn++,
  });
  cards.select({ layerId: 'street-level', id: near.id }, { follow: false });
  await nextTick();
  cards.select({ layerId: 'street-level', id: photo.id }, { follow: false });
  await nextTick();
  assert.deepEqual(closed, [{ id: near.id, pendingOnly: true }]);
  assert.equal(withdrawn, 0, "another photo's card closes no photo");
});

test("Context holds the street-level viewer's home: the open photo's card takes it, and unmounting lets it go", async (t) => {
  const photo = {
    id: 'mapillary:1',
    name: 'Congress Ave',
    lat: 30.27,
    lon: -97.74,
  };
  const { $, cards, pinia, open, unmount } = fixture(t, [
    {
      id: 'street-level',
      name: 'Street Level',
      enabled: true,
      records: [photo],
      stats: { count: 1 },
    },
  ]);
  const home = $('.sl-viewer-home');
  const wrap = $('#sl-viewer-wrap');
  assert.ok(home, 'an offscreen home beside Context');
  assert.equal(home.getAttribute('aria-hidden'), 'true');
  assert.ok(home.hasAttribute('inert'));
  assert.ok(home.contains(wrap), 'the viewer waits in its home');
  // The photo is open and its card shows in an open Context.
  useStreetLevelStore(pinia).publish({
    enabled: true,
    viewer: { open: true, photo: { id: photo.id }, renderMode: 'letterbox' },
  });
  open();
  cards.select({ layerId: 'street-level', id: photo.id }, { follow: false });
  await nextTick();
  await nextTick();
  const slot = $('#sl-viewer-slot');
  assert.ok(slot, "the photo's card has its slot");
  assert.ok(wrap.parentElement === slot, 'the viewer moves onto the card');

  usePinnedStore(pinia).pin({
    key: 'place:test',
    kind: 'place',
    title: 'Test',
    icon: 'place',
    identity: { layerId: 'place', id: 'test' },
  });
  await nextTick();
  const context = useContextStore(pinia);
  $('#context-tab-pinned').click();
  await nextTick();
  await nextTick();
  assert.equal(context.inspectorTab, 'pinned');
  assert.ok(home.contains(wrap), 'Pinned returns the viewer home');
  globalThis.dispatchEvent(
    new CustomEvent('gev:context-show-view', { detail: { inspect: true } }),
  );
  await nextTick();
  await nextTick();
  assert.equal(context.inspectorTab, 'inspect');
  assert.ok(
    wrap.parentElement?.id === slot.id,
    'Inspector restores the same viewer',
  );

  // Unmounted, Context lets its home go: the viewer goes back under it and
  // nothing moves it again.
  unmount();
  assert.ok(home.contains(wrap), 'the viewer is back in its home');
  const loose = document.body.appendChild(document.createElement('div'));
  loose.id = 'sl-viewer-slot';
  t.after(() => loose.remove());
  placeStreetLevelViewer();
  assert.equal(loose.childElementCount, 0, 'no viewer comes back to a slot');
});

test('a stowed dock refuses a pinned photo without losing the tab, card or keyboard focus', async (t) => {
  const photos = ['A', 'B'].map((name) => ({
    id: 'mapillary:' + name,
    name,
    lat: 30,
    lon: -97,
  }));
  const { $, cards, pinia } = fixture(
    t,
    [
      {
        id: 'street-level',
        name: 'Street Level',
        enabled: true,
        records: photos,
      },
    ],
    { useInspector: true },
  );
  const identity = (i) => ({ layerId: 'street-level', ...photos[i] });
  cards.select(identity(0));
  const docked = useDockedStore(pinia);
  docked.dock({
    key: cards.card.key,
    title: 'A',
    kind: 'street',
    identity: identity(0),
  });
  await settle();
  const pinned = usePinnedStore(pinia);
  pinned.pin({
    key: 'street-level:mapillary:B',
    title: 'B',
    icon: 'streetview',
    kind: 'street',
    identity: identity(1),
  });
  pinned.show('pinned');
  await nextTick();
  docked.setStowed(true);
  const tile = $('.pinned-grid__open');
  tile.focus();
  tile.click();
  await nextTick();
  assert.equal(pinned.tab, 'pinned');
  assert.equal(cards.card?.identity.id, photos[0].id);
  assert.equal(docked.view.identity.id, photos[0].id);
  assert.equal(document.activeElement === tile, true);
  assert.match($('.pinned-grid [role="status"]')?.textContent || '', /dock/i);
});

test('a photo pinned and docked from its card keeps its credit after eviction', async (t) => {
  const photo = {
    id: 'panoramax:A',
    name: 'Street photo',
    lat: 30,
    lon: -97,
    still: '/photo.jpg',
    creator: 'Ana',
    license: 'CC BY-SA 4.0',
  };
  let remembered = photo;
  const { $, cards, pinia } = fixture(t, [
    {
      id: 'street-level',
      name: 'Street Level',
      enabled: true,
      records: [photo],
      module: { photo: () => remembered, providerCredit: () => 'Panoramax' },
    },
  ]);
  useStreetLevelStore(pinia).publish({
    enabled: true,
    viewer: { open: true, photo: { id: photo.id } },
  });
  cards.select({ layerId: 'street-level', id: photo.id });
  await nextTick();
  $('.entity-card__action--pin').click();
  $('.entity-card__action--dock').click();
  remembered = null;
  const docked = useDockedStore(pinia);
  assert.equal(docked.view?.streetImage?.license, photo.license);
  // Re-pinning after eviction recovers the retained image and its credit together.
  $('.entity-card__action--pin').click();
  $('.entity-card__action--pin').click();
  usePinnedStore(pinia).show('pinned');
  await nextTick();
  assert.equal($('.pinned-grid__frame')?.getAttribute('src'), photo.still);
  assert.equal(
    $('.pinned-grid__photo-credit')?.textContent,
    'Panoramax · Image by Ana · CC BY-SA 4.0',
  );
});

test('another pick protects dock ownership and a settled pin, but withdraws a pin-only pending load', async (t) => {
  const photo = {
    id: 'mapillary:1',
    name: 'Congress Ave',
    lat: 30.27,
    lon: -97.74,
  };
  let loading = false;
  const { cards, pinia } = fixture(t, [
    {
      id: 'street-level',
      name: 'Street Level',
      enabled: true,
      records: [photo],
      stats: { count: 1 },
      module: { getUIState: () => ({ street: { loading } }) },
    },
    flightsOn([flight('test01', 30.3, -97.7)]),
  ]);
  const identity = { layerId: 'street-level', id: photo.id };
  const key = `street-level:${photo.id}`;
  const street = useStreetLevelStore(pinia);
  street.publish({
    enabled: true,
    viewer: { open: true, photo: { id: photo.id } },
  });
  let withdrawals = 0;
  let pauses = 0;
  street.attach({
    withdrawPhoto: () => withdrawals++,
    stopPlayback: () => pauses++,
  });
  const pinned = usePinnedStore(pinia);
  pinned.pin({
    key,
    kind: 'street',
    title: photo.name,
    identity,
    still: 'https://example.invalid/saved.jpg',
  });
  const pickFlight = () =>
    cards.select({ layerId: 'flights', id: 'test01' }, { follow: false });
  const pickPhoto = () => cards.select(identity, { follow: false });

  pickPhoto();
  await nextTick();
  pickFlight();
  assert.equal(
    withdrawals,
    0,
    'the settled pinned photo keeps its live viewer',
  );
  assert.equal(pauses, 1, 'the hidden sequence stops with its pin intact');
  pickPhoto();
  street.setExpanded(true);
  pickFlight();
  assert.equal(pauses, 1, 'the expanded viewer is still visible');
  street.setExpanded(false);
  assert.equal(pauses, 2, 'leaving the expanded viewer hides the sequence');
  pickPhoto();
  await nextTick();
  loading = true;
  pickFlight();
  assert.equal(withdrawals, 1, 'a pin alone cannot retain another live load');
  assert.equal(pinned.stillOf(key), 'https://example.invalid/saved.jpg');

  pickPhoto();
  await nextTick();
  const docked = useDockedStore(pinia);
  docked.dock({ key, kind: 'street', title: photo.name, identity });
  docked.setStowed(true);
  const dockPauses = pauses;
  pickFlight();
  assert.equal(pauses, dockPauses, 'the dock still owns playback');
  assert.equal(withdrawals, 1, 'the Street Level dock owns the pending load');
  assert.equal(docked.view?.key, key);
  assert.equal(cards.card?.layerId, 'flights');
});

test('picking something else closes a shown photo and shows the new card; open ground keeps it', async (t) => {
  const photo = {
    id: 'mapillary:1',
    name: 'Congress Ave',
    lat: 30.27,
    lon: -97.74,
  };
  const { $, cards, pinia } = fixture(t, [
    {
      id: 'street-level',
      name: 'Street Level',
      enabled: true,
      records: [photo],
      stats: { count: 1 },
    },
    flightsOn([flight('test01', 30.3, -97.7)]),
  ]);
  const closed = [];
  let withdrawn = 0;
  useStreetLevelStore(pinia).attach({
    closePhoto: (id, options) =>
      closed.push({ id, pendingOnly: options?.pendingOnly }),
    withdrawPhoto: () => withdrawn++,
  });
  // A flight picked over the photo's card closes the photo, and the
  // flight's card takes Context.
  cards.select({ layerId: 'street-level', id: photo.id }, { follow: false });
  await nextTick();
  cards.select({ layerId: 'flights', id: 'test01' }, { follow: false });
  await nextTick();
  assert.equal(withdrawn, 1);
  assert.equal(cards.card?.layerId, 'flights');
  assert.ok($('#entity-card'), "the flight's card shows");
  // A click on open ground selects nothing new: only a pending load is
  // cancelled, and a photo already showing stays open.
  cards.select({ layerId: 'street-level', id: photo.id }, { follow: false });
  await nextTick();
  cards.clear();
  await nextTick();
  // The photo card's close button closes the photo.
  cards.select({ layerId: 'street-level', id: photo.id }, { follow: false });
  await nextTick();
  $('#entity-card .entity-card__close').click();
  await nextTick();
  assert.equal(cards.card, null);
  assert.deepEqual(closed, [
    { id: photo.id, pendingOnly: true },
    { id: photo.id, pendingOnly: false },
  ]);

  const docked = useDockedStore(pinia);
  const identity = { layerId: 'street-level', id: photo.id };
  cards.select(identity, { follow: false });
  await nextTick();
  docked.dock({
    key: cards.card.key,
    kind: 'street',
    title: photo.name,
    identity,
  });
  cards.select({ layerId: 'flights', id: 'test01' }, { follow: false });
  await nextTick();
  assert.equal(docked.view?.identity.id, photo.id);
  assert.equal(closed.length, 2, 'another pick leaves the docked photo alone');

  cards.select(identity, { follow: false });
  await nextTick();
  $('#entity-card .entity-card__close').click();
  await nextTick();
  await nextTick();
  assert.equal(
    docked.view,
    null,
    'the photo card’s Close also dismisses its dock',
  );
  assert.deepEqual(closed.slice(2), [{ id: photo.id, pendingOnly: undefined }]);
  assert.equal(withdrawn, 1, 'only the flight closed the photo');
});

test('Escape or open ground keeps an ordinary photo open but stops its sequence', async (t) => {
  const photo = {
    id: 'mapillary:1',
    name: 'Congress Ave',
    lat: 30.27,
    lon: -97.74,
  };
  const { cards, pinia } = fixture(t, [
    {
      id: 'street-level',
      name: 'Street Level',
      enabled: true,
      records: [photo],
      stats: { count: 1 },
    },
  ]);
  const identity = { layerId: 'street-level', id: photo.id };
  const actions = [];
  useStreetLevelStore(pinia).attach({
    closePhoto: (id, options) =>
      actions.push(['closePhoto', id, options?.pendingOnly === true]),
    stopPlayback: () => actions.push(['stopPlayback']),
  });
  cards.select(identity, { follow: false });
  await nextTick();
  cards.clear();
  await nextTick();
  assert.deepEqual(actions, [['closePhoto', photo.id, true], ['stopPlayback']]);

  actions.length = 0;
  cards.select(identity, { follow: false });
  await nextTick();
  cards.clear({ dismiss: true });
  await nextTick();
  assert.deepEqual(
    actions,
    [['closePhoto', photo.id, false]],
    '× closes it; nothing is left to stop',
  );

  actions.length = 0;
  useDockedStore(pinia).dock({
    key: `street-level:${photo.id}`,
    kind: 'street',
    title: photo.name,
    identity,
  });
  cards.select(identity, { follow: false });
  await nextTick();
  cards.clear();
  await nextTick();
  assert.deepEqual(actions, [], 'the dock keeps showing and playing its photo');
});

test('on a phone a new pick closes the photo and shows its card in the Context sheet, without reopening the photo', async (t) => {
  const photo = {
    id: 'mapillary:1',
    name: 'Congress Ave',
    lat: 30.27,
    lon: -97.74,
  };
  const body = document.body;
  t.after(() => {
    body.classList.remove('mobile-shell');
    body.removeAttribute('data-mobile-sheet');
  });
  const { $, cards, pinia, open } = fixture(t, [
    {
      id: 'street-level',
      name: 'Street Level',
      enabled: true,
      records: [photo],
      stats: { count: 1 },
    },
    flightsOn([flight('test01', 30.3, -97.7)]),
  ]);
  body.classList.add('mobile-shell');
  body.setAttribute('data-mobile-sheet', 'context');
  const streetLevel = useStreetLevelStore(pinia);
  const show = (shown) =>
    streetLevel.publish({
      enabled: true,
      viewer: {
        open: shown,
        photo: shown ? { id: photo.id } : null,
        renderMode: 'letterbox',
      },
    });
  const closed = [];
  let withdrawn = 0;
  const reopened = [];
  streetLevel.attach({
    closePhoto: (id, options) => {
      closed.push({ id, pendingOnly: options?.pendingOnly });
      if (!options?.pendingOnly) show(false);
    },
    withdrawPhoto: () => {
      withdrawn++;
      show(false);
    },
    openPhoto: (id) => reopened.push(id),
  });
  show(true);
  open();
  cards.select({ layerId: 'street-level', id: photo.id }, { follow: false });
  await nextTick();
  await nextTick();
  assert.equal($('#sl-viewer-wrap').parentElement, $('#sl-viewer-slot'));
  cards.select({ layerId: 'flights', id: 'test01' }, { follow: false });
  await nextTick();
  await nextTick();
  assert.equal(withdrawn, 1);
  assert.deepEqual(closed, []);
  assert.equal(cards.card?.layerId, 'flights', "the flight's card shows");
  assert.equal(body.getAttribute('data-mobile-sheet'), 'context');
  assert.equal($('#sl-viewer-slot'), null, 'no photo slot on the new card');
  assert.ok(
    $('.sl-viewer-home').contains($('#sl-viewer-wrap')),
    'the closed viewer waits in its home',
  );
  assert.equal($('#sl-viewer-wrap').hidden, true, 'and stays closed');
  assert.deepEqual(reopened, [], 'nothing opens the photo again');
});

// A real Street Level layer and its controls behind Context, over a fake
// source whose viewer poses each image it opens, once `hold` lets it. Its
// photos are listed under the street-level row Context reads.
async function liveStreetLevel(t, pinia, { hold = null } = {}) {
  const provider = posingStreetLevelProvider('mapillary', {
    nearestImage: async () => 'A',
    beforePose: hold,
    positionOf: () => HERE,
  });
  const viewer = fakeCesiumViewer();
  viewer.canvas = viewer.scene.canvas;
  const layer = createStreetLevelLayer({ providers: [provider] });
  layer.init(viewer);
  layer.enable(viewer);
  const announced = [];
  const reopened = [];
  const openPhoto = layer.openPhoto;
  layer.openPhoto = (id, options) => {
    reopened.push(id);
    return openPhoto(id, options);
  };
  const controls = new StreetLevelControls({
    root: document.getElementById('sl-viewer-root'),
    layer,
    store: useStreetLevelStore(pinia),
    actions: {
      isEnabled: () => true,
      setEnabled() {},
      setParams() {},
      showToast() {},
      showPhoto: (photo) => announced.push(photo.id),
    },
  });
  controls.connect();
  t.after(() => {
    controls.destroy();
    layer.destroy();
  });
  await turn();
  return { layer, announced, reopened };
}

test(
  'leaving Data Layers during the Google SDK load withdraws the paid location lookup',
  { timeout: 5000 },
  async (t) => {
    const pinia = applicationPinia();
    const { $ } = fixture(t, [], { startOpen: false, pinia });
    const display = useDisplayStore(pinia);
    const body = document.body;
    const selectSheet = (sheet) => {
      body.setAttribute('data-mobile-sheet', sheet);
      display.publishPhoneShell({ enabled: true, sheet });
    };
    body.classList.add('mobile-shell');
    selectSheet('layers');
    t.after(() => {
      body.classList.remove('mobile-shell');
      body.removeAttribute('data-mobile-sheet');
      display.publishPhoneShell({ enabled: false, sheet: null });
    });
    const started = Promise.withResolvers();
    const sdk = Promise.withResolvers();
    const lookups = [];
    const library = {
      StreetViewService: class {
        getPanorama({ location }) {
          lookups.push(location);
          return Promise.resolve({ data: null });
        }
      },
      StreetViewSource: { GOOGLE: 'GOOGLE', OUTDOOR: 'OUTDOOR' },
      StreetViewPreference: { NEAREST: 'NEAREST' },
    };
    t.after(() => sdk.resolve(library));
    const google = createGoogleProvider({
      getApiKey: () => 'fixture',
      loader: {
        authFailed: () => false,
        onAuthFailure: () => () => {},
        importLibrary() {
          started.resolve();
          return sdk.promise;
        },
      },
    });
    const viewer = fakeCesiumViewer({ view: true });
    const layer = createStreetLevelLayer({ providers: [google] });
    layer.attachMapStackController({
      getActiveId: () => google.requiresMapStack,
    });
    layer.init(viewer);
    layer.enable(viewer);
    const shell = {
      services: { streetLevelLayer: layer },
      _streetLevelViewer: $('#sl-viewer-root'),
    };
    StyleManager.prototype._initStreetLevelControls.call(shell);
    t.after(() => {
      shell._streetLevelControls.destroy();
      shell._streetLevelPhotoUnsubscribe?.();
      layer.destroy();
    });
    await turn();
    layer.setProviderEnabled('google', true);
    await turn();
    const open = () => {
      const chip = layer
        .getRowControls()
        .chips.find(({ id }) => id === 'sl-open-nearest');
      assert.equal(chip?.disabled, false);
      return chip.onClick();
    };
    const opening = open();
    await started.promise;
    selectSheet('context');
    sdk.resolve(library);
    await opening;
    await turn();
    assert.equal(lookups.length, 0, 'an abandoned OPEN sends no location');
    selectSheet('layers');
    await open();
    assert.equal(
      lookups.length,
      1,
      'a subsequent OPEN on the same sheet reaches the adapter',
    );
  },
);

test(
  'paid Street Level loads in a visible Inspector and is retired if the phone sheet changes before mount',
  { timeout: 5000 },
  async (t) => {
    const body = document.body;
    const { $, open } = fixture(t, [], {
      startOpen: false,
      pinia: applicationPinia(),
    });
    body.classList.add('mobile-shell', 'ui-clean-view');
    body.setAttribute('data-mobile-sheet', 'layers');
    t.after(() => {
      body.classList.remove('mobile-shell', 'ui-embed', 'ui-clean-view');
      body.removeAttribute('data-mobile-sheet');
    });

    const started = Promise.withResolvers();
    const sdk = Promise.withResolvers();
    t.after(sdk.resolve);
    const provider = posingStreetLevelProvider('google', {
      nearestImage: async () => 'A',
      positionOf: () => HERE,
    });
    provider.billedPerImage = true;
    const create = provider.create;
    let constructions = 0;
    provider.create = (context) => {
      const instance = create(context);
      instance.viewer.mount = async (_target, { isVisible }) => {
        started.resolve(isVisible);
        await sdk.promise;
        if (!isVisible()) throw new Error('Context is hidden');
        constructions++;
      };
      return instance;
    };

    const viewer = fakeCesiumViewer();
    viewer.canvas = viewer.scene.canvas;
    const layer = createStreetLevelLayer({ providers: [provider] });
    layer.init(viewer);
    layer.enable(viewer);
    const shell = {
      services: { streetLevelLayer: layer },
      _streetLevelViewer: $('#sl-viewer-root'),
      setPanelCollapsed: (_id, collapsed) => {
        if (!collapsed) open();
      },
      _revealContextInspector: StyleManager.prototype._revealContextInspector,
      revealPanel: () => body.setAttribute('data-mobile-sheet', 'context'),
      setCleanView: StyleManager.prototype.setCleanView,
      toggleCleanView: StyleManager.prototype.toggleCleanView,
      exitContextSelectionView: StyleManager.prototype.exitContextSelectionView,
      contextSelectionCover: StyleManager.prototype.contextSelectionCover,
      _scheduleLeftPanelLayout() {},
    };
    StyleManager.prototype._initStreetLevelControls.call(shell);
    t.after(() => {
      shell._streetLevelControls.destroy();
      shell._streetLevelPhotoUnsubscribe?.();
      layer.destroy();
    });
    await turn();
    layer.setProviderEnabled('google', true);
    // Happy DOM has no layout. Give the visible phone rail and its viewer
    // overlapping boxes so the real paid-mount visibility guard can run.
    const wrap = $('#sl-viewer-wrap');
    t.mock.method(
      wrap,
      'getBoundingClientRect',
      () => new DOMRect(10, 100, 320, 200),
    );
    t.mock.method(
      $('#right-context-rail'),
      'getBoundingClientRect',
      () => new DOMRect(0, 80, 360, 500),
    );
    const opening = layer.openNearest(HERE, { frame: false });
    const isVisible = await Promise.race([
      started.promise,
      opening.then(() => null),
    ]);
    assert.equal(
      typeof isVisible,
      'function',
      'the provider must enter its visible mount',
    );
    assert.equal(wrap.parentElement?.id, 'sl-viewer-loading-slot');
    assert.equal(isVisible(), true);
    assert.equal(body.classList.contains('ui-clean-view'), false);
    body.setAttribute('data-mobile-sheet', 'layers');
    sdk.resolve();
    assert.equal(await opening, false);
    assert.equal(constructions, 0);
    assert.equal(layer.settledPhotoId(), null);
    assert.equal(body.getAttribute('data-mobile-sheet'), 'layers');

    assert.equal(await layer.openNearest(HERE, { frame: false }), true);
    assert.equal(constructions, 1);
    assert.equal(layer.settledPhotoId(), 'google:A');

    layer.closeViewer();
    body.classList.remove('mobile-shell');
    body.classList.add('ui-embed', 'ui-clean-view');
    assert.equal(await layer.openNearest(HERE, { frame: false }), true);
    assert.equal(wrap.classList.contains('sl-viewer-wrap-embed'), true);
    assert.equal(wrap.parentElement?.tagName, 'BODY');
  },
);

const liveStreetRow = (live) => ({
  id: 'street-level',
  name: 'Street Level',
  enabled: true,
  stats: { count: 1 },
  module: { getAnalystRecords: () => live.layer?.getAnalystRecords() ?? [] },
});

for (const phone of [false, true]) {
  test(`${phone ? 'on a phone, ' : ''}picking a flight closes a photo opened with Context closed, which has no card, and shows the flight's card`, async (t) => {
    const body = document.body;
    t.after(() => {
      body.classList.remove('mobile-shell');
      body.removeAttribute('data-mobile-sheet');
    });
    const fx = fixture(t, [flightsOn([flight('test01', 30.3, -97.7)])], {
      startOpen: false,
      // As the app reveals Context for a pick: on a phone, its sheet.
      openPanel: () => {
        if (phone) body.setAttribute('data-mobile-sheet', 'context');
        fx.open();
      },
    });
    if (phone) {
      body.classList.add('mobile-shell');
      body.setAttribute('data-mobile-sheet', 'layers');
    }
    const { layer, reopened } = await liveStreetLevel(t, fx.pinia);
    // A click on a street-level line: the photo opens, and no card shows it.
    assert.equal(await layer.openNearest(HERE, { frame: false }), true);
    await turn();
    assert.equal(layer.settledPhotoId(), 'mapillary:A');
    assert.equal(fx.cards.card, null);
    fx.cards.select({ layerId: 'flights', id: 'test01' }, { explicit: true });
    await nextTick();
    await turn();
    assert.equal(layer.settledPhotoId(), null, 'the photo is closed');
    assert.equal(layer.getUIState().street.open, false);
    assert.equal(fx.cards.card?.layerId, 'flights');
    assert.ok(fx.$('#entity-card'), "the flight's card shows");
    assert.equal(fx.$('#sl-viewer-slot'), null, 'no photo slot on it');
    assert.equal(fx.$('#sl-viewer-wrap').hidden, true, 'the viewer is closed');
    assert.deepEqual(reopened, [], 'nothing opens the photo again');
    if (phone)
      assert.equal(
        body.getAttribute('data-mobile-sheet'),
        'context',
        'the Context sheet shows, not Cameras',
      );
  });
}

for (const phone of [false, true])
  for (const priorCard of [false, true])
    test(`${phone ? 'on a phone, ' : ''}a photo still loading when a flight is picked never opens after it (${priorCard ? 'a photo card shown before' : 'no Street Level card'})`, async (t) => {
      const body = document.body;
      t.after(() => {
        body.classList.remove('mobile-shell');
        body.removeAttribute('data-mobile-sheet');
      });
      const live = {};
      const fx = fixture(
        t,
        [liveStreetRow(live), flightsOn([flight('test01', 30.3, -97.7)])],
        {
          startOpen: priorCard,
          openPanel: () => {
            if (phone) body.setAttribute('data-mobile-sheet', 'context');
            fx.open();
          },
        },
      );
      if (phone) {
        body.classList.add('mobile-shell');
        body.setAttribute(
          'data-mobile-sheet',
          priorCard ? 'context' : 'layers',
        );
      }
      const held = Promise.withResolvers();
      const started = Promise.withResolvers();
      t.after(held.resolve);
      Object.assign(
        live,
        await liveStreetLevel(t, fx.pinia, {
          hold: async (imageId) => {
            if (imageId !== 'B') return;
            started.resolve();
            await held.promise;
          },
        }),
      );
      const { layer, announced } = live;
      if (priorCard) {
        // Photo A shows on its card in Context.
        assert.equal(
          await layer.openImage('mapillary', 'A', { frame: false }),
          true,
        );
        fx.cards.select(
          { layerId: 'street-level', id: 'mapillary:A' },
          { follow: false },
        );
        await nextTick();
        await turn();
        assert.equal(fx.cards.card?.layerId, 'street-level');
      }
      // A click on another line: photo B starts loading.
      const opening = layer.openImage('mapillary', 'B', { frame: false });
      await started.promise;
      assert.equal(layer.photoOpening(), true);
      fx.cards.select({ layerId: 'flights', id: 'test01' }, { explicit: true });
      await nextTick();
      held.resolve();
      assert.equal(await opening, false, 'the load is withdrawn');
      await turn();
      assert.equal(layer.settledPhotoId(), null, 'no photo settles');
      assert.equal(layer.getUIState().street.open, false);
      assert.ok(!announced.includes('mapillary:B'), 'nor is it announced');
      assert.ok(
        !layer.getAnalystRecords().some((photo) => photo.id === 'mapillary:B'),
        'nor listed',
      );
      assert.equal(
        fx.cards.card?.layerId,
        'flights',
        "the flight's card stays",
      );
      if (phone)
        assert.equal(body.getAttribute('data-mobile-sheet'), 'context');
    });

test('a click on open ground, map Escape and a refresh of the same card keep a photo; another flight closes it', async (t) => {
  const live = {};
  const fx = fixture(
    t,
    [
      liveStreetRow(live),
      flightsOn([
        flight('test01', 30.3, -97.7),
        flight('test02', 30.31, -97.71),
      ]),
    ],
    { useInspector: true },
  );
  Object.assign(live, await liveStreetLevel(t, fx.pinia));
  const { layer } = live;
  // A photo on its card; open ground (and map Escape, which clears the
  // same way) lets go of the card and keeps the photo.
  assert.equal(await layer.openImage('mapillary', 'A', { frame: false }), true);
  for (const clear of [fx.clickGround, () => escKey(document.body)]) {
    fx.cards.select(
      { layerId: 'street-level', id: 'mapillary:A' },
      { follow: false },
    );
    await nextTick();
    assert.ok(fx.cards.card);
    clear();
    await nextTick();
    await turn();
    assert.equal(fx.cards.card, null);
    assert.equal(layer.settledPhotoId(), 'mapillary:A');
  }
  // A flight's card, then a photo opened under it: the card refreshing, or
  // the same flight picked again, keeps the photo.
  fx.cards.select({ layerId: 'flights', id: 'test01' }, { follow: false });
  await nextTick();
  assert.equal(await layer.openImage('mapillary', 'B', { frame: false }), true);
  fx.cards.refresh();
  fx.cards.select({ layerId: 'flights', id: 'test01' }, { follow: false });
  await nextTick();
  await turn();
  assert.equal(layer.settledPhotoId(), 'mapillary:B');
  // Another flight is a new pick: the photo closes.
  fx.cards.select({ layerId: 'flights', id: 'test02' }, { follow: false });
  await nextTick();
  await turn();
  assert.equal(layer.settledPhotoId(), null);
});

test("a street-level photo's card moving on to the next image keeps Context's tab; a new pick shows its card", async (t) => {
  const photo = {
    id: 'mapillary:1',
    name: 'Congress Ave',
    lat: 30.27,
    lon: -97.74,
  };
  const next = { ...photo, id: 'mapillary:2', name: 'Sixth Street' };
  const { $, cards, pinia } = fixture(t, [
    {
      id: 'street-level',
      name: 'Street Level',
      enabled: true,
      records: [photo, next],
      stats: { count: 2 },
    },
    flightsOn([flight('test01', 30.3, -97.7)]),
  ]);
  cards.select({ layerId: 'street-level', id: photo.id }, { follow: false });
  await nextTick();
  usePinnedStore(pinia).pin({
    key: cards.card.key,
    identity: cards.card.identity,
    title: photo.name,
    icon: 'streetview',
  });
  await nextTick();
  $('#context-tab-pinned').click();
  cards.advance({ layerId: 'street-level', id: next.id });
  await nextTick();
  assert.equal(
    $('#context-tab-pinned').getAttribute('aria-selected'),
    'true',
    'the walk keeps the tab',
  );
  cards.select({ layerId: 'flights', id: 'test01' }, { follow: false });
  await nextTick();
  assert.equal(
    $('#context-tab-inspect').getAttribute('aria-selected'),
    'true',
    'a new pick shows its card',
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
    off('recent-imagery', 'Recent Imagery'),
  ];
  const providerRequests = [];
  const { $, cards, pinia } = fixture(t, layers, {
    useInspector: false,
    fetchImpl: async (url) => {
      if (!String(url).includes('/wikidata_cities/'))
        providerRequests.push(String(url));
      return new Response('', { status: 503 });
    },
  });
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
  const suggestionIds = () =>
    [...document.querySelectorAll('.view-context__suggest-item')].map(
      (node) => node.dataset.layer,
    );
  const named = suggestionIds();
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
  const junctionCity = {
    center: { lat: 38.7048, lon: -96.5982 },
    heightM: 57_991,
    groundFootprint: true,
  };
  cards.setView(junctionCity);
  await nextTick();
  const nearbySuggestions = ['flights', 'satellites', 'recent-imagery'];
  assert.deepEqual(suggestionIds(), nearbySuggestions);
  assert.equal(
    $('.view-context__pointer:not(.view-context__suggest-open)'),
    null,
  );
  assert.deepEqual(
    finder.inputs().picked,
    named,
    'zoom does not change the Finder',
  );
  $('.view-context__suggest-open').click();
  assert.deepEqual(finder.inputs().picked, nearbySuggestions);
  assert.ok(layers.every((layer) => !layer.enabled));

  contextSearchOpen.value = true;
  contextSearchText.value = 'station';
  await nextTick();
  assert.deepEqual(suggestionIds(), []);
  assert.ok($('.view-context__pointer'));
  closeContextSearch();

  cards.setView({ ...junctionCity, groundFootprint: false });
  await nextTick();
  assert.equal($('.view-context__suggest-open'), null);
  acted.length = 0;
  $('.view-context__pointer').click();
  assert.deepEqual(finder.inputs().picked, []);
  assert.equal(finder.narrowed, false);
  assert.deepEqual(acted, [
    ['reveal', 'data-panel'],
    ['toggle', 'data-panel'],
  ]);
  assert.deepEqual(
    providerRequests,
    [],
    'suggesting and opening layers never ask their providers',
  );
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

test('opening Suggested keeps its filter when the phone closes Context', async (t) => {
  const { $, cards, close, pinia } = fixture(
    t,
    [{ id: 'satellites', name: 'Satellites', enabled: false }],
    { useInspector: true },
  );
  cards.setView({ center: HERE, heightM: 20_000_000 });
  await nextTick();
  assert.equal($('.view-context__suggest-item')?.dataset.layer, 'satellites');

  const chrome = usePanelChromeStore(pinia);
  const act = chrome.act;
  t.mock.method(chrome, 'act', (name, panelId) => {
    if (name === 'reveal' && panelId === 'data-panel') close();
    return act(name, panelId);
  });
  $('.view-context__suggest-open').click();

  assert.equal(cards.inspector.shown, false);
  assert.deepEqual(useLayerFinderStore(pinia).selection.picked, ['satellites']);
});

test('the globe breakdown follows a replacement manager with the same layer', async (t) => {
  const original = flightsOn([
    { ...flight('near01', 30.28, -97.74), aircraftClass: 'airliner' },
    { ...flight('near02', 30.28, -97.75), aircraftClass: 'helicopter' },
  ]);
  const { $, cards, replaceManager, point } = fixture(t, [original], {
    useInspector: true,
  });
  point(HERE, 20_000_000);
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
  const breakdown = () => $('.view-context__bar-key')?.textContent ?? '';
  assert.match(breakdown(), /Airliner/);

  const replacement = flightsOn([
    { ...flight('near03', 30.28, -97.74), aircraftClass: 'cargo' },
    { ...flight('near04', 30.28, -97.75), aircraftClass: 'glider' },
  ]);
  replaceManager({
    layers: new Map([
      ['flights', { module: { getAnalystRecords: () => replacement.records } }],
    ]),
    getAll: () => [replacement],
  });
  cards.pulseInspector();
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();

  assert.match(breakdown(), /Cargo/);
  assert.doesNotMatch(breakdown(), /Airliner/);
});

test('the visible Inspector samples and publishes metadata once for rows, suggestions and counts', async (t) => {
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
  const readRows = t.mock.method(cards, 'allLayers');
  const publishRows = t.mock.method(cards, 'publishInspectorRows');
  const assertSamples = (expected, message) => {
    assert.equal(readRows.mock.callCount(), expected, message);
    assert.equal(publishRows.mock.callCount(), expected, message);
  };
  const setHeight = (heightM) => cards.setView({ center: HERE, heightM });
  setHeight(40_000);
  await turn();
  open();
  await nextTick();
  assertSamples(1);
  assert.ok($('.view-context [data-layer="flights"]'));
  const counts = useLayerCountsStore(pinia);
  assert.deepEqual(counts.state.counts, {});

  setHeight(50_000);
  await nextTick();
  assertSamples(1, 'local camera movement does not resample metadata');
  cards.pulseInspector();
  await nextTick();
  assertSamples(2);
  assert.deepEqual(counts.state.counts, {});

  close();
  await nextTick();
  notifyLayers();
  cards.pulseInspector();
  await nextTick();
  assertSamples(2, 'hidden refresh does not resample metadata');
  open();
  await nextTick();
  assertSamples(3);

  const rows = [{ id: 'satellites', name: 'Satellites', enabled: false }];
  replaceManager({ layers: new Map(), getAll: () => rows });
  setHeight(20_000_000);
  await turn();
  assertSamples(4);
  assert.equal($('.view-context__suggest-item')?.dataset.layer, 'satellites');
  assert.equal($('.view-context__suggest-item[data-layer="flights"]'), null);
  assert.equal(asks, 1, 'settling at globe height requests counts once');
  const layerHost = document.body.appendChild(document.createElement('div'));
  const layersApp = createApp(LayerPanelsView).use(pinia);
  layersApp.mount(layerHost);
  t.after(() => layersApp.unmount());
  const list = layerHost.querySelector('#data-toggles');
  const layerPanel = new LayerPanel({
    finder: createLayerFinder(),
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
    'the following pulse shares the globe request cooldown',
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
  assert.equal(asks, 1, 'an enabled worldwide layer admits the globe count');

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
  cards.setView(localView());
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

test('Inspector replies respect Clean View before its visibility observer runs', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const weather = Promise.withResolvers();
  const counts = Promise.withResolvers();
  let weatherSignal;
  let countsSignal;
  const { cards, pinia, point } = fixture(t, [], {
    brief: (_lat, _lon, { signal }) => {
      weatherSignal = signal;
      return weather.promise;
    },
    getCounts: ({ signal }) => {
      countsSignal = signal;
      return counts.promise;
    },
  });
  t.after(() => document.body.classList.remove('ui-clean-view'));
  point(HERE);
  await nextTick();
  t.mock.timers.tick(400);
  assert.equal(weatherSignal?.aborted, false);
  assert.equal(countsSignal?.aborted, false);

  weather.resolve({ weather: { temperatureC: 31 } });
  // Let the store's promise wrapper queue the weather owner's continuation.
  await Promise.resolve();
  await Promise.resolve();
  counts.resolve({ counts: [{ layerId: 'flights', count: 31 }] });
  document.body.classList.add('ui-clean-view');
  assert.equal(cards.inspector.shown, true, 'the observer has yet to run');
  await turn();

  assert.deepEqual([weatherSignal.aborted, countsSignal.aborted], [true, true]);
  assert.equal(cards.viewWeather.reading, null);
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

  const display = useDisplayStore(pinia);
  display.publishPhoneShell({ enabled: true, sheet: 'layers' });
  await nextTick();
  now += 60 * 60_000;
  display.publishPhoneShell({ enabled: true, sheet: 'context' });
  await nextTick();
  assert.match(clock(), /15:00/);
  assert.match(tile(), /3 h ago/);
  assert.match(tile(), /17/);
});

test('hiding or replacing the mounted Inspector cancels its weather and count requests', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  t.after(resetContextLists);
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
    delete document.visibilityState;
  });
  const counts = useLayerCountsStore(pinia);
  t.after(resetContextLists);
  setContextListPresence('weather', { count: 1 });
  const transitions = [
    [
      () => $('#context-tab-lists').click(),
      () => $('#context-tab-inspect').click(),
      true,
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
        contextSearchStyles(t);
        const style = document.createElement('style');
        style.textContent = fs.readFileSync(
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
  cards.setView(localView());
  await nextTick();
  const marks = $('.view-context__tile--value[data-layer="sea-marks"]');
  assert.ok(marks, 'the overlay has a tile');
  assert.notEqual(
    marks.parentElement.previousElementSibling?.textContent,
    'At the centre of the view',
    'overlays have no point-reading heading',
  );
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

test('every layer that is on has a tile at every zoom, a reason in place of a 0, and the Missions count heads its list', async (t) => {
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
    roster: {
      entries: Array.from({ length: 23 }, (_, index) => ({
        id: String(index),
        index,
        label: `Mission ${index}`,
      })),
    },
    mission: null,
  });
  cards.setView(localView());
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
  const missionTiles = (selector) =>
    [...document.querySelectorAll(selector)].filter((el) =>
      ['rocket-launches', 'space-missions'].includes(el.dataset.layer),
    );
  assert.equal(
    missionTiles('.view-context__tile').length,
    0,
    'its list replaces the tile',
  );
  assert.equal(
    Boolean($('.nearby-lists__layer[data-layer="rocket-launches"]')),
    false,
    'no second Nearby group',
  );
  // The flight is outside Overhead range but remains available under Closest.
  assert.match(
    $('.view-context__tile[data-layer="flights"]').getAttribute('aria-label'),
    /Closest to view · 1$/,
  );
  assert.match(
    $('.view-context__tile[data-layer="bikeshare"] strong').textContent,
    /Zoom in to see bikes/,
  );
  assert.equal($('.nearby-missions h4 strong').textContent, '23');
  cards.setView({ center: HERE, heightM: 18_000_000 });
  await nextTick();
  assert.match(
    $('.view-context__block[data-layer="bikeshare"] strong').textContent,
    /Zoom in to see bikes/,
    'the same rule at the globe',
  );
  assert.equal($('.nearby-missions h4 strong').textContent, '23');
  assert.equal(
    missionTiles('.view-context__block').length,
    0,
    'its list replaces the block',
  );
});

test('Space Missions alone is a layer that is on, and its roster carries the mission index feed state', async (t) => {
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
  cards.setView(localView());
  await nextTick();
  assert.equal(
    Boolean($('.view-context__tiles--counts')),
    false,
    'not the nothing-on view',
  );
  assert.doesNotMatch($('.view-context').textContent, /No layers on/);
  const heading = $('.nearby-missions h4');
  assert.ok(heading, 'its roster heading');
  assert.doesNotMatch(
    heading.textContent,
    /\b0\b/,
    'never a bare 0 for a failed index',
  );
  assert.notEqual(
    heading.querySelector('.view-context__dot').getAttribute('aria-label'),
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

test('a stale mission index marks the roster stale, keeping its count', async (t) => {
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
    roster: {
      entries: Array.from({ length: 23 }, (_, index) => ({
        id: String(index),
        index,
        label: `Mission ${index}`,
      })),
    },
    mission: null,
  });
  cards.setView(localView());
  await nextTick();
  const heading = $('.nearby-missions h4');
  assert.equal(heading.querySelector('strong').textContent, '23');
  assert.equal(
    heading.querySelector('.view-context__dot').getAttribute('aria-label'),
    'Stale',
  );
  assert.ok(
    document.querySelector('.view-context__problem'),
    'its stale line shows',
  );
});

test('turning off Missions restores focus from its Inspect roster', async (t) => {
  const { $, pinia } = fixture(t, [flightsOn([])]);
  const missions = useSpaceMissionsStore(pinia);
  const outside = document.body.appendChild(document.createElement('button'));
  t.after(() => outside.remove());
  const pinned = usePinnedStore(pinia);
  t.after(() => pinned.unpin('flights:x'));
  for (const hasTabs of [false, true]) {
    if (hasTabs)
      pinned.pin({
        key: 'flights:x',
        kind: 'item',
        title: 'X',
        icon: 'flight',
      });
    for (const focusInRoster of [true, false]) {
      missions.setEnabled(true);
      missions.publish({
        roster: { entries: [{ id: 'm1', index: 0, label: 'Mission' }] },
        mission: null,
      });
      await settleTicks();
      const target = focusInRoster
        ? $('.nearby-missions [data-list-key]')
        : outside;
      target.focus();
      assert.equal(document.activeElement === target, true);
      missions.setEnabled(false);
      await settleTicks();
      assert.equal(Boolean($('.nearby-missions')), false);
      const fallback =
        $('#context-tab-inspect') ??
        $('#global-context-panel .cyber-panel-body');
      assert.ok(
        document.activeElement === (focusInRoster ? fallback : outside),
      );
    }
  }
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

test('switching phone sheets pauses the mounted Inspector retry clock', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'] });
  let reads = 0;
  const { $, pinia, point } = fixture(
    t,
    [flightsOn([flight('a1', 30.3, -97.7)])],
    {
      brief: async () => {
        reads++;
        return null;
      },
    },
  );
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
  const display = useDisplayStore(pinia);
  display.publishPhoneShell({ enabled: true, sheet: 'layers' });
  await nextTick();
  await advance(60_000);
  assert.equal(
    $('.view-context'),
    mounted,
    'the phone sheet keeps Inspector mounted',
  );
  assert.equal(
    reads,
    1,
    'time on another sheet does not count toward the retry',
  );

  display.publishPhoneShell({ enabled: true, sheet: 'context' });
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

test('the view stops its refresh ticks while Context shows another tab', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'] });
  let reads = 0;
  const { $, pinia, point } = fixture(
    t,
    [flightsOn([flight('a1', 30.3, -97.7)])],
    {
      brief: async () => {
        reads++;
        return null;
      },
    },
  );
  const advance = async (ms) => {
    t.mock.timers.tick(ms);
    await nextTick();
    await turn();
  };
  const pinned = usePinnedStore(pinia);
  pinned.pin({
    key: 'flights:a1',
    kind: 'item',
    title: 'A1',
    identity: { layerId: 'flights', id: 'a1' },
  });
  point(HERE);
  await nextTick();
  await advance(400);
  assert.equal(reads, 1, 'the spot weather is read once the view settles');

  $('#context-tab-pinned').click();
  await nextTick();
  assert.equal($('.view-context'), null, 'Pinned unmounts Inspector');
  await advance(16 * 4000);
  await advance(400);
  assert.equal(reads, 1, 'no retry while another tab is shown');

  $('#context-tab-inspect').click();
  await nextTick();
  assert.ok($('.view-context'), 'Inspect remounts Inspector');
  await advance(16 * 4000);
  await advance(400);
  assert.equal(reads, 2, 'the read comes once the view is shown again');
});

test('Radio on with no station picked: the place, then Radio, then Nearby; no worldwide counts or pointer', async (t) => {
  const radio = radioLayer();
  radio.emit({ selected: null });
  const { $, cards } = fixture(t, [
    { id: 'radio', name: 'Radio', enabled: true, records: [] },
  ]);
  const dm = cards.layerModule;
  cards.layerModule = (id) => (id === 'radio' ? radio : dm(id));
  cards.setView({ center: HERE, heightM: 40_000 });
  await nextTick();
  await turn();
  await nextTick();
  const view = $('.view-context');
  const title = view.querySelector('.view-context__title');
  const stations = view.querySelector('.radio-stations');
  assert.ok(title && stations, 'the place and Radio are one view');
  assert.ok(
    title.compareDocumentPosition(stations) & Node.DOCUMENT_POSITION_FOLLOWING,
    'the place first',
  );
  assert.match(
    $('.radio-stations__idle').textContent,
    /No station selected · pick one to play/,
  );
  assert.equal(
    $('.view-context__tiles--counts'),
    null,
    'no worldwide count tiles while a layer is on',
  );
  assert.doesNotMatch(
    view.textContent,
    /Turn on layers/,
    'no pointer to Data Layers',
  );
  assert.doesNotMatch(view.textContent, /No layers on/);
  // The privacy note is a line under the list, not in the tuner fold.
  assert.equal(
    Boolean(stations.querySelector(':scope > .radio-stations__privacy')),
    true,
  );
  assert.equal(Boolean($('#radio-panel .radio-stations__privacy')), false);
});

test('Radio lists the loaded catalog with tag controls and leaves Nearby radius alone', async (t) => {
  const radio = radioLayer();
  radio.emit({
    selected: null,
    categories: [
      { id: 'all', label: 'All' },
      ...[
        'news',
        'talk',
        'weather',
        'music',
        'sport',
        'jazz',
        'rock',
        'pop',
      ].map((id) => ({ id, label: id })),
    ],
  });
  const { $, cards } = fixture(t, [
    { id: 'radio', name: 'Radio', enabled: true, records: [] },
  ]);
  const dm = cards.layerModule;
  cards.layerModule = (id) => (id === 'radio' ? radio : dm(id));
  setContextRadiusKm(250);
  cards.setView({
    center: HERE,
    heightM: 80_000,
    groundFootprint: true,
    rect: { west: -99, east: -96, south: 29, north: 32 },
  });
  await nextTick();
  await turn();
  await nextTick();
  assert.equal(
    $('.radio-stations .context-list-card__head strong').textContent,
    '3',
  );
  assert.match(
    $('.radio-stations .nearby-lists__layer ul').textContent,
    /FAR FM/,
  );
  assert.equal($('.radio-stations__widen'), null);
  assert.equal(contextRadiusKm.value, 250);
  const chips = [
    ...document.querySelectorAll('.radio-stations .city-filter__strip button'),
  ];
  assert.deepEqual(
    chips.map((button) => button.textContent.trim()),
    ['All', 'news', 'talk', 'weather', 'music', 'sport', 'jazz', 'rock', 'pop'],
  );
  assert.ok($('.radio-stations .city-filter__toggle'), 'one expansion control');
});

test('Pinned and Lists hide station controls and release the Inspect live player', async (t) => {
  const station = { id: '42424', name: 'Test Station', ...HERE };
  const { $, cards, pinia } = fixture(t, [
    { id: 'satellites', enabled: true, records: [station] },
  ]);
  t.after(resetContextLists);
  const pinned = usePinnedStore(pinia);
  pinned.pin({
    key: 'saved-place',
    kind: 'place',
    title: 'Saved place',
    icon: 'location_on',
  });
  setContextListPresence('weather', { count: 1 });

  const liveStore = useLiveStore(pinia);
  const events = new EventTarget();
  const players = [];
  const live = new LiveControls({
    store: liveStore,
    actions: { getLayer: () => null },
    globalRef: events,
    refreshMs: 0,
    streams: [
      {
        id: 'test-feed',
        videoId: 'AAAAAAAAAAA',
        title: 'Test Station feed',
        owner: 'Test provider',
        subjects: ['satellites:42424'],
      },
    ],
    createPlayer({ onChange }) {
      const player = {
        onChange,
        removed: false,
        destroy() {
          this.removed = true;
        },
      };
      players.push(player);
      return player;
    },
  });
  t.after(() => live.destroy());
  cards.select({ layerId: 'satellites', id: station.id }, { fly: false });
  useStationStore(pinia).publish({
    title: station.name,
    subject: station.name,
    mode: 'automatic',
    zoom: { offered: false },
  });
  events.dispatchEvent(
    new CustomEvent('gev:awareness-subject-selected', {
      detail: { layerId: 'satellites', id: station.id, label: station.name },
    }),
  );
  const chrome = usePanelChromeStore(pinia);
  const token = chrome.connect({});
  t.after(() => chrome.detach(token));
  for (const id of ['global-context-panel', 'station-panel', 'live-panel'])
    chrome.publish(token, id, { collapsed: false });
  await nextTick();

  for (const tab of ['pinned', 'lists']) {
    assert.equal($('#station-panel').hidden, false);
    assert.equal($('#live-panel').hidden, false);
    $('#live-play-btn').click();
    players.at(-1).onChange({ state: 'playing' });
    await nextTick();
    assert.equal(liveStore.view.state, 'playing');
    $(`#context-tab-${tab}`).click();
    await nextTick();
    assert.equal($('#station-panel').hidden, true);
    assert.equal($('#live-panel').hidden, true);
    assert.equal(players.at(-1).removed, true);
    assert.equal(liveStore.view.state, 'idle');
    assert.equal(cards.card?.identity.id, station.id);
    $('#context-tab-inspect').click();
    await nextTick();
    assert.equal(liveStore.view.state, 'idle', 'returning never auto-plays');
    assert.equal(cards.card?.identity.id, station.id);
  }
  assert.equal(players.length, 2, 'each player came from one explicit Play');
});

test('with Context closed, the collapsible sections are already in the page for PanelChrome', async (t) => {
  // PanelChrome finds collapsible panels once, at startup, by their collapse
  // buttons; Context starts closed, so a section that mounts only while it
  // is open would never be registered and its +/- would do nothing.
  const { $, close } = fixture(t, []);
  close();
  await nextTick();
  assert.equal(
    $('#global-context-panel').classList.contains('collapsed'),
    true,
  );
  const targets = [
    ...document.querySelectorAll('.panel-collapse-btn[data-collapse-target]'),
  ].map((button) => button.dataset.collapseTarget);
  // Radio has no collapsible section of its own here: its stations are in
  // Context and its tuner is a fold that moves under the station list.
  for (const id of ['station-panel', 'live-panel']) {
    assert.ok(targets.includes(id), `${id} is there to be registered`);
    // The space station's STATION and LIVE sections follow the lists.
    assert.equal(
      $('#context-lists').compareDocumentPosition(document.getElementById(id)) &
        Node.DOCUMENT_POSITION_FOLLOWING,
      Node.DOCUMENT_POSITION_FOLLOWING,
      `${id} comes after the lists`,
    );
  }
});

test('a pinned aircraft whose layer is off opens flown to where it was, not followed', async (t) => {
  const flights = flightsOn([flight('test01', 30.3, -97.7)]);
  const { $, cards, followed, flown, pinia, notifyLayers } = fixture(t, [
    flights,
  ]);
  const requested = [];
  let outcome = false;
  const publishVisibility = (enabled) => {
    flights.enabled = enabled;
    notifyLayers({ type: 'visibility', layerId: 'flights', enabled });
  };
  const omnibar = useOmnibarStore(pinia);
  omnibar.connect({
    layers: () => [flights],
    async setLayer(id, enabled) {
      requested.push([id, enabled]);
      const result = await outcome;
      if (result) publishVisibility(enabled);
      return result;
    },
  });
  t.after(() => omnibar.connect(null));
  flights.enabled = false;
  assert.equal(
    cards.open(
      {
        layerId: 'flights',
        id: 'test01',
        label: 'TEST01',
        lat: 30.3,
        lon: -97.7,
      },
      { fromPin: true },
    ),
    true,
  );
  await nextTick();
  assert.deepEqual(followed, [], 'nothing to follow with the layer off');
  assert.deepEqual(flown, ['flights:test01'], 'flown to its last position');
  assert.equal(
    $('[data-pinned-layer-hint]').textContent.trim(),
    'Turn on Live Flights for more context.',
  );
  const offered = [
    ...document.querySelectorAll('#entity-card .view-context__suggest-item'),
  ];
  assert.deepEqual(
    offered.map((layer) => layer.dataset.layer),
    ['flights'],
  );
  assert.deepEqual(requested, [], 'opening a pin did not turn anything on');
  const button = () => $('[data-enable-pinned-layer]');
  const failure = () => $('#entity-card .view-context__problem[role="status"]');
  button().click();
  await turn();
  assert.equal(failure()?.textContent, 'Data source unavailable');
  publishVisibility(true);
  await nextTick();
  publishVisibility(false);
  await nextTick();
  assert.ok(button());
  assert.equal(
    failure(),
    null,
    'a successful external enable clears the old error',
  );

  const delayed = Promise.withResolvers();
  outcome = delayed.promise;
  button().click();
  publishVisibility(true);
  await nextTick();
  publishVisibility(false);
  await nextTick();
  delayed.resolve(false);
  await turn();
  assert.equal(
    failure(),
    null,
    'an old request cannot restore the error after recovery',
  );

  outcome = true;
  button().click();
  await turn();
  assert.deepEqual(
    requested,
    Array.from({ length: 3 }, () => ['flights', true]),
  );
  assert.equal(cards.card.key, 'flights:test01');
  assert.equal($('[data-pinned-layer-hint]'), null);
  // With the layer on, a new selection can be followed.
  cards.clear();
  flights.enabled = true;
  cards.open({
    layerId: 'flights',
    id: 'test01',
    label: 'TEST01',
    lat: 30.3,
    lon: -97.7,
  });
  await nextTick();
  assert.deepEqual(followed, ['flights:test01']);
});

test('a pin from a removed layer still opens its saved card without an enable action', async (t) => {
  const { $, cards } = fixture(t, []);
  assert.equal(
    cards.open(
      {
        layerId: 'lib-retired-layer',
        id: 'saved1',
        label: 'Saved observatory',
        lat: HERE.lat,
        lon: HERE.lon,
      },
      { fromPin: true },
    ),
    true,
  );
  await nextTick();
  assert.match(
    $('#entity-card .entity-card__title').textContent,
    /Saved observatory/,
  );
  assert.match(
    $('[data-pinned-layer-hint]').textContent,
    /unavailable.*saved item/,
  );
  assert.equal($('#entity-card .view-context__suggest'), null);
  assert.equal($('[data-enable-pinned-layer]'), null);
});

test('whether a layer is off is read again when a layer changes, in views that stay open', async (t) => {
  const cameras = { id: 'cctv', name: 'Cameras', enabled: false, records: [] };
  const { cards, notifyLayers } = fixture(t, [cameras]);
  const off = computed(() => cards.layerOff('cctv'));
  assert.equal(off.value, true);
  cameras.enabled = true;
  notifyLayers();
  assert.equal(
    off.value,
    false,
    'a preview kept open sees Cameras come back on',
  );
});

test('a street photo card keeps Retry and cannot dock until the viewer accepts its own photo', async (t) => {
  const id = 'near:mapillary:30.27,-97.74';
  const photo = { id, name: 'Congress Ave', lat: 30.27, lon: -97.74 };
  const { $, cards, pinia } = fixture(t, [
    {
      id: 'street-level',
      name: 'Street Level',
      enabled: true,
      records: [photo],
    },
  ]);
  const street = useStreetLevelStore(pinia);
  const answer = Promise.withResolvers();
  street.attach({ openPhoto: () => answer.promise });
  street.publish({
    enabled: true,
    viewer: { open: true, photo: { id: 'mapillary:other' } },
  });
  cards.select({ layerId: 'street-level', id }, { follow: false });
  await nextTick();
  assert.equal(Boolean($('.entity-card__action--dock')), false);
  answer.resolve(false);
  await settle();
  assert.ok($('.sl-hero__retry'));
  assert.equal(Boolean($('.entity-card__action--dock')), false);
  assert.equal(useDockedStore(pinia).view, null);
});

test('the accepted docked street photo keeps its still and credit after another pick and layer shutdown', async (t) => {
  const photo = {
    id: 'mapillary:A',
    name: 'Congress Ave',
    lat: 30.27,
    lon: -97.74,
    still: 'data:image/png;base64,AA==',
    creator: 'Alex',
    license: 'CC BY-SA 4.0',
  };
  const layer = {
    id: 'street-level',
    name: 'Street Level',
    enabled: true,
    records: [photo],
    module: {
      photo: (id) => (layer.enabled && id === photo.id ? photo : null),
      providerCredit: () => 'Mapillary',
    },
  };
  const { $, cards, pinia, notifyLayers } = fixture(t, [
    layer,
    flightsOn([flight('near01', 30.28, -97.74)]),
  ]);
  const street = useStreetLevelStore(pinia);
  street.publish({
    enabled: true,
    viewer: { open: true, photo: { id: photo.id } },
  });
  const identity = { layerId: 'street-level', id: photo.id };
  cards.select(identity, { follow: false });
  await nextTick();
  $('.entity-card__action--dock').click();
  await nextTick();
  const dock = useDockedStore(pinia);
  assert.ok($('#sl-docked-slot'));
  dock.setStowed(true);
  await nextTick();
  assert.equal(Boolean($('.docked-view__frame img')), false);
  cards.select({ layerId: 'flights', id: 'near01' }, { follow: false });
  layer.enabled = false;
  notifyLayers({ type: 'visibility', layerId: layer.id, enabled: false });
  street.publish({ enabled: false, viewer: { open: false, photo: null } });
  await nextTick();
  assert.equal(Boolean($('.docked-view__frame img')), false);
  assert.equal(dock.view.streetImage.url, photo.still);
  dock.setStowed(false);
  await nextTick();
  assert.equal($('.docked-view__frame img')?.getAttribute('src'), photo.still);
  assert.equal(
    $('.docked-view__credit')?.textContent,
    'Mapillary · Image by Alex · CC BY-SA 4.0',
  );
  assert.equal(useDockedStore(pinia).view.identity.id, photo.id);
  $('.docked-view__frame img').dispatchEvent(new Event('error'));
  await nextTick();
  assert.equal(Boolean($('.docked-view__frame img')), false);
  assert.equal(Boolean($('.docked-view__credit')), false);
  assert.equal(
    $('.docked-view .paused-chip').getAttribute('aria-label'),
    'Paused: Layer off',
  );
  assert.equal(
    cards.select(useDockedStore(pinia).view.identity, {
      fromPin: true,
      follow: false,
    }),
    true,
  );
  await nextTick();
  const undock = $('.entity-card__action--dock');
  assert.equal(undock?.getAttribute('aria-pressed'), 'true');
  undock.click();
  assert.equal(useDockedStore(pinia).view, null);
});

test('a pin opened with Street Level off shows its saved credit and date, and asks for no remote still', async (t) => {
  const photo = {
    id: 'panoramax:A',
    name: 'Rue du Dôme',
    lat: 48.58,
    lon: 7.75,
    providerId: 'panoramax',
    provider: 'Panoramax',
    capturedAt: Date.UTC(2023, 5, 6),
    capturedAtPrecision: 'day',
    still: 'https://panoramax.invalid/A.jpg',
    creator: 'Ana',
    license: 'Licence Ouverte 2.0',
  };
  const layer = {
    id: 'street-level',
    name: 'Street Level',
    enabled: true,
    records: [photo],
    module: {
      photo: (id) => (layer.enabled && id === photo.id ? photo : null),
      providerCredit: () => 'Panoramax',
    },
  };
  const { $, cards, pinia, notifyLayers } = fixture(t, [layer]);
  const street = useStreetLevelStore(pinia);
  street.publish({ enabled: true, viewer: { open: false, photo: null } });
  cards.select({ layerId: 'street-level', id: photo.id }, { follow: false });
  await nextTick();
  $('.entity-card__action--pin').click();
  cards.clear();
  layer.enabled = false;
  notifyLayers({ type: 'visibility', layerId: layer.id, enabled: false });
  street.publish({ enabled: false, viewer: { open: false, photo: null } });
  usePinnedStore(pinia).show('pinned');
  await nextTick();
  assert.equal($('.pinned-grid__frame'), null, 'the tile asks nothing');
  $('.pinned-grid__open').click();
  await nextTick();
  assert.equal($('.sl-hero__still img'), null, 'nor does the card');
  assert.match(
    $('.sl-hero .paused-chip')?.getAttribute('aria-label') ?? '',
    /Street Level off/,
  );
  assert.equal(
    $('.sl-hero__credit')?.textContent,
    'Panoramax · Image by Ana · Licence Ouverte 2.0',
  );
  assert.equal(
    $('.entity-card__source-line').textContent.trim(),
    'Panoramax · Jun 6, 2023',
  );
});

test('a docked street-level photo that another item replaces closes, unless its card shows it', async (t) => {
  const { cards, pinia } = fixture(t, [
    {
      id: 'street-level',
      name: 'Street Level',
      enabled: true,
      records: [
        { id: 'mapillary:1', name: 'Congress Ave', lat: 30.27, lon: -97.74 },
      ],
      stats: { count: 1 },
    },
    flightsOn([flight('near01', 30.28, -97.74)]),
  ]);
  const streetLevel = useStreetLevelStore(pinia);
  const closed = [];
  const act = streetLevel.act;
  streetLevel.act = (name, ...args) =>
    name === 'closePhoto' ? closed.push(args[0]) : act(name, ...args);
  t.after(() => {
    streetLevel.act = act;
  });
  const docked = useDockedStore(pinia);
  const photo = {
    key: 'street-level:mapillary:1',
    kind: 'street',
    title: 'Congress Ave',
    identity: { layerId: 'street-level', id: 'mapillary:1' },
  };
  // Its card showing: replacing the dock leaves the photo open.
  cards.select(
    { layerId: 'street-level', id: 'mapillary:1' },
    { follow: false },
  );
  await nextTick();
  docked.dock({ ...photo, key: cards.card.key });
  await nextTick();
  docked.dock({
    key: 'cctv:cam1',
    kind: 'camera',
    title: 'Cam',
    identity: { layerId: 'cctv', id: 'cam1' },
  });
  await nextTick();
  assert.deepEqual(closed, []);
  // Its card gone: the replaced photo closes with the dock.
  cards.select({ layerId: 'flights', id: 'near01' }, { follow: false });
  await nextTick();
  closed.length = 0;
  docked.dock({ ...photo, key: 'street-level:mapillary:1' });
  await nextTick();
  docked.dock({
    key: 'cctv:cam1',
    kind: 'camera',
    title: 'Cam',
    identity: { layerId: 'cctv', id: 'cam1' },
  });
  await nextTick();
  assert.deepEqual(closed, ['mapillary:1']);
});

test('a dock replacement keeps the original card, dock slot, and one busy announcement', async (t) => {
  const a = {
    id: 'mapillary:A',
    name: 'Congress Ave',
    lat: HERE.lat,
    lon: HERE.lon,
  };
  const { $, cards, pinia } = fixture(t, [
    { id: 'street-level', name: 'Street Level', enabled: true, records: [a] },
  ]);
  const streetLevel = useStreetLevelStore(pinia);
  const docked = useDockedStore(pinia);
  const publish = (loading) =>
    streetLevel.publish({
      enabled: true,
      dockPhotoLoading: loading,
      viewer: { open: true, photo: { id: a.id }, renderMode: 'letterbox' },
    });
  let cancelled = false;
  streetLevel.attach({
    cancelDockedPhoto: () => {
      cancelled = true;
      publish(false);
    },
  });
  cards.select({ layerId: 'street-level', id: a.id }, { follow: false });
  docked.dock({
    key: 'street-level:mapillary:A',
    kind: 'street',
    title: a.name,
    identity: { layerId: 'street-level', id: a.id },
  });
  publish(false);
  await nextTick();
  await nextTick();
  const frame = $('.docked-view__frame');
  const holder = $('#sl-docked-slot');
  publish(true);
  await nextTick();
  assert.equal(cards.card.identity.id, a.id);
  assert.equal(frame.getAttribute('aria-busy'), 'true');
  assert.match($('.docked-view__status').textContent, /Loading photo/);
  assert.equal(
    $('#sl-docked-slot'),
    holder,
    'the host holds its existing place in the dock',
  );
  assert.equal($('#sl-viewer-wrap').parentElement, holder);
  $('.docked-view__cancel-photo').click();
  await nextTick();
  assert.equal(cancelled, true);
  assert.equal(cards.card.identity.id, a.id);
  assert.equal(frame.hasAttribute('aria-busy'), false);
  assert.equal($('.docked-view__status').textContent, '');
  assert.equal($('#sl-docked-slot'), holder);
});

test('the dock says when a replacement photo did not load or a pick waits on the restore', async (t) => {
  const a = {
    id: 'mapillary:A',
    name: 'Congress Ave',
    lat: HERE.lat,
    lon: HERE.lon,
  };
  const { $, cards, pinia } = fixture(t, [
    { id: 'street-level', name: 'Street Level', enabled: true, records: [a] },
  ]);
  const streetLevel = useStreetLevelStore(pinia);
  const docked = useDockedStore(pinia);
  const publish = (state) =>
    streetLevel.publish({
      enabled: true,
      dockPhotoLoading: false,
      dockPhotoNotice: null,
      viewer: { open: true, photo: { id: a.id }, renderMode: 'letterbox' },
      ...state,
    });
  cards.select({ layerId: 'street-level', id: a.id }, { follow: false });
  docked.dock({
    key: 'street-level:mapillary:A',
    kind: 'street',
    title: a.name,
    identity: { layerId: 'street-level', id: a.id },
  });
  publish();
  await nextTick();
  const status = $('.docked-view__status');
  assert.equal(status.getAttribute('role'), 'status');
  assert.equal(status.textContent, '');
  // On a phone with the Context sheet hidden, Open in Context fails.
  document.body.classList.add('mobile-shell');
  t.after(() => document.body.classList.remove('mobile-shell'));
  $('.docked-view button[title="Open in Context"]').click();
  await turn();
  assert.equal(
    $('.docked-view__notice').textContent,
    'Could not open this in Context',
  );
  publish({ dockPhotoLoading: true, dockPhotoNotice: 'restoring' });
  await nextTick();
  assert.equal(status.textContent, 'Still restoring the photo');
  publish({ dockPhotoNotice: 'failed' });
  await nextTick();
  assert.equal(status.textContent, 'Could not load that photo');
  const notice = $('.docked-view__notice');
  assert.equal(notice.textContent, status.textContent);
  assert.equal(notice.getAttribute('aria-hidden'), 'true');
  publish();
  await nextTick();
  assert.equal(status.textContent, '', 'the word goes when the layer drops it');
  assert.equal(
    $('.docked-view__notice').textContent,
    'Could not open this in Context',
  );
});

for (const still of [null, 'https://example.org/original-photo.jpg']) {
  const fallback = still ? 'with a still that cannot load' : 'without a still';
  test(`the dock reports an unavailable original photo ${fallback}`, async (t) => {
    const id = 'mapillary:A';
    const point = { lat: HERE.lat, lon: HERE.lon };
    const a = { id, name: 'Congress Ave', ...point };
    const identity = { layerId: 'street-level', id, ...point };
    const { $, cards, pinia, flown } = fixture(t, [
      {
        id: 'street-level',
        name: 'Street Level',
        enabled: true,
        records: [a],
        module: { photo: () => ({ ...a, still }) },
      },
    ]);
    const streetLevel = useStreetLevelStore(pinia);
    const docked = useDockedStore(pinia);
    const publish = (state = {}) =>
      streetLevel.publish({
        enabled: true,
        viewer: { open: true, photo: { id }, renderMode: 'letterbox' },
        ...state,
      });
    cards.select(identity, { follow: false });
    docked.dock({
      key: cards.card.key,
      kind: 'street',
      title: a.name,
      identity,
    });
    const sourceCard = cards.card;
    const dock = docked.view;
    const alert = () => $('.docked-view__frame [role="alert"]:not([hidden])');
    publish({ dockPhotoLoading: true, dockPhotoRestoring: true });
    await nextTick();
    assert.equal($('.docked-view__frame').getAttribute('aria-busy'), 'true');
    assert.equal(
      $('.docked-view__status').textContent,
      'Still restoring the photo',
    );
    assert.ok(!alert());

    publish({ dockPhotoUnavailable: true, dockPhotoNotice: 'failed' });
    await nextTick();
    const frame = $('.docked-view__frame');
    assert.equal(frame.hasAttribute('aria-busy'), false);
    assert.equal($('.docked-view__loading'), null);
    if (still) {
      const image = frame.querySelector('img');
      assert.equal(
        image.getAttribute('src'),
        still,
        'the original still is tried',
      );
      assert.ok(!alert(), 'a retained still can serve as the fallback');
      assert.equal(
        $('.docked-view__notice').textContent,
        'Could not load that photo',
      );
      image.dispatchEvent(new Event('error'));
      await nextTick();
      assert.equal(Boolean(frame.querySelector('img')), false);
    }

    assert.equal(alert()?.textContent, 'Image could not be opened');
    assert.equal(frame.querySelectorAll('[role="alert"]').length, 1);
    assert.equal(
      $('.docked-view__status').textContent,
      '',
      'no duplicate live status',
    );
    assert.equal(docked.view, dock);
    assert.equal(cards.card, sourceCard);
    assert.deepEqual(flown, []);

    publish({ dockPhotoUnavailable: true });
    await nextTick();
    assert.equal(
      alert()?.textContent,
      'Image could not be opened',
      'the error survives the transient notice',
    );

    publish();
    await nextTick();
    assert.ok(!alert(), 'the alert clears when the original becomes available');
    assert.ok($('#sl-docked-slot'));
  });
}

test('focus on Open or Close moves to Cancel while a docked photo loads, then back to Close', async (t) => {
  const a = {
    id: 'mapillary:A',
    name: 'Congress Ave',
    lat: HERE.lat,
    lon: HERE.lon,
  };
  const { $, cards, pinia } = fixture(t, [
    { id: 'street-level', name: 'Street Level', enabled: true, records: [a] },
  ]);
  const streetLevel = useStreetLevelStore(pinia);
  const docked = useDockedStore(pinia);
  const publish = (loading) =>
    streetLevel.publish({
      enabled: true,
      dockPhotoLoading: loading,
      viewer: { open: true, photo: { id: a.id }, renderMode: 'letterbox' },
    });
  cards.select({ layerId: 'street-level', id: a.id }, { follow: false });
  docked.dock({
    key: 'street-level:mapillary:A',
    kind: 'street',
    title: a.name,
    identity: { layerId: 'street-level', id: a.id },
  });
  publish(false);
  await nextTick();
  const [open, close] = document.querySelectorAll('.docked-view__head button');
  open.focus();
  publish(true);
  await nextTick();
  await nextTick();
  assert.ok(
    document.activeElement === $('.docked-view__cancel-photo'),
    'Open was disabled: Cancel takes focus',
  );
  publish(false);
  await nextTick();
  await nextTick();
  assert.ok(document.activeElement === close, 'Cancel went: Close takes focus');
  close.focus();
  publish(true);
  await nextTick();
  await nextTick();
  assert.ok(document.activeElement === $('.docked-view__cancel-photo'));
  // Focus elsewhere is left where it is.
  const elsewhere = document.body.appendChild(document.createElement('button'));
  t.after(() => elsewhere.remove());
  elsewhere.focus();
  publish(false);
  await nextTick();
  await nextTick();
  assert.ok(document.activeElement === elsewhere);
});

test('while the docked photo restores, Cancel goes, the dock says so, and focus waits on the frame', async (t) => {
  const a = {
    id: 'mapillary:A',
    name: 'Congress Ave',
    lat: HERE.lat,
    lon: HERE.lon,
  };
  const { $, cards, pinia } = fixture(t, [
    { id: 'street-level', name: 'Street Level', enabled: true, records: [a] },
  ]);
  const streetLevel = useStreetLevelStore(pinia);
  const docked = useDockedStore(pinia);
  const publish = (state = {}) =>
    streetLevel.publish({
      enabled: true,
      dockPhotoLoading: false,
      dockPhotoRestoring: false,
      viewer: { open: true, photo: { id: a.id }, renderMode: 'letterbox' },
      ...state,
    });
  cards.select({ layerId: 'street-level', id: a.id }, { follow: false });
  docked.dock({
    key: 'street-level:mapillary:A',
    kind: 'street',
    title: a.name,
    identity: { layerId: 'street-level', id: a.id },
  });
  publish();
  await nextTick();
  const [, close] = document.querySelectorAll('.docked-view__head button');
  const frame = $('.docked-view__frame');
  const slot = $('#sl-docked-slot');
  const step = slot.appendChild(document.createElement('button'));
  step.focus();
  assert.equal(slot.hasAttribute('inert'), false);
  publish({ dockPhotoLoading: true });
  await nextTick();
  await nextTick();
  assert.equal(slot.hasAttribute('inert'), true);
  assert.ok(document.activeElement === $('.docked-view__cancel-photo'));
  $('.docked-view__cancel-photo').focus();
  publish({ dockPhotoLoading: true, dockPhotoRestoring: true });
  await nextTick();
  await nextTick();
  assert.ok(!$('.docked-view__cancel-photo'), 'nothing left to cancel');
  assert.equal(
    $('.docked-view__status').textContent,
    'Still restoring the photo',
  );
  assert.match(
    $('.docked-view__loading').textContent,
    /Still restoring the photo/,
  );
  assert.equal(close.disabled, true);
  assert.equal(frame.getAttribute('aria-busy'), 'true');
  assert.ok(
    document.activeElement === frame,
    'focus is not stranded on a removed button',
  );
  publish();
  await nextTick();
  await nextTick();
  assert.ok(document.activeElement === close, 'restored: Close takes focus');
  assert.equal(slot.hasAttribute('inert'), false);
  assert.equal(frame.hasAttribute('tabindex'), false);
  // Focus on Close as a restore begins also waits on the frame.
  publish({ dockPhotoLoading: true, dockPhotoRestoring: true });
  await nextTick();
  await nextTick();
  assert.ok(document.activeElement === frame);
});

test('Fly to held by Tracking or Cockpit says so on the card for a few seconds', async (t) => {
  const { $, cards } = fixture(t, [
    {
      id: 'earthquakes',
      name: 'Earthquakes',
      enabled: true,
      records: [
        { id: 'q1', usgsId: 'q1', magnitude: 4.2, lat: 30.2, lon: -97.6 },
      ],
    },
  ]);
  cards.select({ layerId: 'earthquakes', id: 'q1' }, { fly: false });
  await nextTick();
  const note = () => $('#entity-card .entity-card__fly-note');
  const flyButton = () =>
    [
      ...document.querySelectorAll(
        '#entity-card .entity-card__action-row button',
      ),
    ].find((button) => /Fly to/.test(button.textContent));
  assert.equal(note().getAttribute('role'), 'status');
  assert.equal(note().textContent, '');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let answer = 'tracking-holds-view';
  cards.flyTo = () => answer;
  flyButton().click();
  await nextTick();
  assert.equal(note().textContent, 'Tracking holds the view');
  answer = 'cockpit-active';
  flyButton().click();
  await nextTick();
  assert.equal(note().textContent, 'Cockpit is active');
  t.mock.timers.tick(4000);
  await nextTick();
  assert.equal(note().textContent, '', 'it goes by itself');
  flyButton().click();
  await nextTick();
  answer = true;
  flyButton().click();
  await nextTick();
  assert.equal(note().textContent, '', 'a flight that goes clears it');
});

test(
  'a focused Nearby row that drops out hands focus to the row in its place',
  { timeout: 10_000 },
  async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const flights = flightsOn([
      flight('near01', 30.28, -97.74),
      flight('near02', 30.29, -97.74),
      flight('near03', 30.3, -97.74),
    ]);
    const { $, cards } = fixture(t, [flights]);
    cards.setView(localView());
    await settleInspectorIndex();
    const first = '.view-context .nearby-lists [data-row-key="flights:near01"]';
    const row = $(first);
    assert.ok(row, 'the nearest row shows');
    row.focus();
    assert.equal(document.activeElement?.dataset.rowKey, 'flights:near01');
    flights.records = flights.records.slice(1);
    flights.stats = {
      ...flights.stats,
      count: flights.records.length,
      lastUpdate: flights.stats.lastUpdate + 1,
    };
    t.mock.timers.tick(4000);
    await settleInspectorIndex();
    await nextTick();
    assert.equal(Boolean($(first)), false, 'the row went');
    assert.equal(
      document.activeElement?.dataset.rowKey,
      'flights:near02',
      'focus moved to the row now first',
    );
  },
);

test('a visible flight remains in the In view list as the camera moves closer', async (t) => {
  const { $, cards } = fixture(t, [
    flightsOn([flight('visible01', 35, -95), flight('outside01', 45, -80)]),
  ]);
  const previousRadius = contextRadiusKm.value;
  t.after(() => setContextRadiusKm(previousRadius));
  setContextRadiusKm(250);
  const rect = { west: -100, east: -90, south: 28, north: 38 };
  cards.setView({ center: HERE, rect, heightM: 2_000_000 });
  await settleInspectorIndex();
  const visible = () => $('.nearby-lists[aria-label="In view"]');
  assert.equal(
    $('.view-context__tile[data-layer="flights"] strong').textContent,
    '1',
  );
  assert.match(visible().textContent, /VISIBLE01/);
  assert.doesNotMatch(visible().textContent, /OUTSIDE01/);
  cards.setView({ center: { lat: 35, lon: -95 }, rect, heightM: 2_000_000 });
  await settleInspectorIndex();
  assert.ok(visible(), 'the same viewport scope applies close to the flight');
  assert.match(visible().textContent, /VISIBLE01/);
});

test('unselected layers share In view scope and selecting a card keeps Nearby local', async (t) => {
  const { $, cards, clickGround } = fixture(
    t,
    [
      flightsOn([flight('visible01', 35, -95)]),
      {
        id: 'earthquakes',
        name: 'Earthquakes',
        enabled: true,
        records: [{ id: 'q1', title: 'Local quake', ...HERE }],
      },
    ],
    { useInspector: true },
  );
  cards.setView({
    center: HERE,
    heightM: 2_000_000,
    rect: { west: -100, east: -90, south: 28, north: 38 },
  });
  await settleInspectorIndex();
  assert.ok(
    $('.nearby-lists[aria-label="In view"] [data-row-layer="earthquakes"]'),
  );
  assert.ok(
    $('.nearby-lists[aria-label="In view"] [data-row-layer="flights"]'),
  );
  cards.select({ layerId: 'earthquakes', id: 'q1' }, { fly: false });
  await nextTick();
  assert.ok($('.entity-card__head'));
  assert.equal($('.entity-card [data-row-layer="flights"]'), null);
  // The bridge clears the card when a clean click lands on open ground.
  clickGround();
  await nextTick();
  assert.ok(
    $('.nearby-lists[aria-label="In view"] [data-row-layer="earthquakes"]'),
  );
});

test('moving the Gulf viewport updates earthquake and vessel rows beyond the radius', async (t) => {
  const point = { lat: 28, lon: -95.72 };
  const previousRadius = contextRadiusKm.value;
  t.after(() => setContextRadiusKm(previousRadius));
  setContextRadiusKm(250);
  const { $, cards } = fixture(t, [
    {
      id: 'earthquakes',
      name: 'Earthquakes',
      enabled: true,
      records: [{ ...point, id: 'gulf-quake', magnitude: 4.4 }],
    },
    {
      id: 'ais-live-vessels',
      name: 'Live Vessels',
      enabled: true,
      records: [
        { ...point, id: 'boat01', mmsi: 'boat01', name: 'Gulf vessel' },
      ],
    },
  ]);
  const center = { lat: 24.84, lon: -95.72 };
  const rect = { west: -100, east: -90, south: 20, north: 30 };
  cards.setView({ center, rect, heightM: 1_000_000 });
  await settleInspectorIndex();
  for (const layer of ['earthquakes', 'ais-live-vessels']) {
    assert.equal(
      $(`.view-context__tile[data-layer="${layer}"] strong`).textContent,
      '1',
    );
    assert.ok(
      $(`.nearby-lists[aria-label="In view"] [data-row-layer="${layer}"]`),
    );
  }
  cards.setView({ center, rect: { ...rect, north: 26 }, heightM: 500_000 });
  await settleInspectorIndex();
  const quake = $('.view-context__tile[data-layer="earthquakes"]');
  assert.equal(quake.querySelector('strong').textContent, '1');
  assert.match(quake.getAttribute('aria-label'), /Closest to view/);
  assert.ok($('.nearby-lists [data-row-layer="earthquakes"]'));
  const vessels = $('.view-context__tile[data-layer="ais-live-vessels"]');
  assert.equal(vessels.querySelector('strong').textContent, '0');
  assert.match(vessels.getAttribute('aria-label'), /None in view/);
  assert.equal($('.nearby-lists [data-row-layer="ais-live-vessels"]'), null);
});

test('sending an attached public event reads its revised display title only while selected', async (t) => {
  const events = {
    id: 'earthquakes',
    name: 'Earthquakes',
    enabled: true,
    records: [{ id: 'event-a', place: 'Example Park', ...HERE }],
  };
  const { cards, pinia } = fixture(t, [events], { useInspector: true });
  const voice = useVoiceStore(pinia);
  let attachment;
  voice.connect({
    emit(event, detail) {
      if (event === 'chat-item') attachment = detail;
    },
  });
  t.after(() => voice.connect(null));
  cards.select({ layerId: 'earthquakes', id: 'event-a' }, { fly: false });
  cards.ask();
  assert.equal(attachment.name, 'Example Park');
  events.records = [{ ...events.records[0], place: 'Example Park Meadow' }];
  assert.equal(attachment.resolveLocation().name, 'Example Park Meadow');
  events.records = [{ ...events.records[0], place: 'event-a' }];
  assert.equal(attachment.resolveLocation().name, undefined);
  cards.clear();
  assert.equal(attachment.resolveLocation(), null);
});

test('the globe counts all loaded flights and samples visible aircraft', async (t) => {
  const { $, cards } = fixture(t, [
    flightsOn([
      flight('visible01', HERE.lat, HERE.lon),
      flight('offscreen03', HERE.lat, HERE.lon + 15),
      flight('hidden02', -HERE.lat, HERE.lon + 180),
    ]),
  ]);
  cards.setView({ center: HERE, heightM: 20_000_000, rect: localView().rect });
  await settleInspectorIndex();
  const block = $('.view-context__block[data-layer="flights"]');
  assert.equal($('.view-context__label').textContent, 'Layers');
  assert.equal($('.view-context').getAttribute('aria-label'), 'Globe view');
  assert.equal(block.querySelector('strong').textContent, '3');
  assert.match(block.getAttribute('aria-label'), /Loaded/);
  assert.match(block.textContent, /VISIBLE01/);
  assert.doesNotMatch(block.textContent, /HIDDEN02|OFFSCREEN03/);
});

test('an unmeasured local viewport does not show worldwide flight counts', async (t) => {
  const { $, cards } = fixture(t, [
    flightsOn([
      flight('visible01', HERE.lat, HERE.lon),
      flight('hidden02', -HERE.lat, HERE.lon + 180),
    ]),
  ]);
  const view = { center: HERE, heightM: 40_000, rect: WHOLE_GLOBE };
  const tile = () => $('.view-context__tile[data-layer="flights"] strong');
  cards.setView(view);
  await settleInspectorIndex();
  assert.equal(
    tile().textContent,
    '1',
    'whole-world bounds retain the horizon',
  );
  cards.setView({ ...view, groundFootprint: false });
  await settleInspectorIndex();
  assert.equal(tile().textContent, '1');
  assert.match(
    $('.nearby-lists [data-row-layer="flights"]').textContent,
    /VISIBLE01/,
  );
  cards.setView({ ...view, rect: localView().rect });
  await settleInspectorIndex();
  assert.equal(tile().textContent, '1');
});

test('with Space Missions on, a nearby launch adds no radius Rocket Launches group', async (t) => {
  const { $, cards, pinia } = fixture(t, [
    {
      id: 'satellites',
      name: 'Satellites',
      enabled: true,
      records: [{ noradId: '1', name: 'Overhead satellite', ...HERE }],
    },
    {
      id: 'rocket-launches',
      name: 'Rocket Launches',
      enabled: true,
      records: [{ id: 'launch', name: 'Local launch', ...HERE }],
    },
  ]);
  const missions = useSpaceMissionsStore(pinia);
  missions.setEnabled(true);
  missions.publish({ roster: { entries: [{}] }, mission: null });
  cards.setView(localView());
  await settleInspectorIndex();
  assert.equal($('.nearby-missions h4 strong').textContent, '1');
  assert.match(
    $('[data-row-layer="satellites"]').textContent,
    /Overhead satellite/,
  );
  assert.ok(!$('[data-row-layer="rocket-launches"]'));
  assert.ok(!$('.view-context__tile[data-layer="rocket-launches"]'));
});

test('the radius label switches independent nearby and overhead ranges and globe ignores them', async (t) => {
  const flights = flightsOn([
    { ...flight('shared', HERE.lat, HERE.lon), onGround: false },
  ]);
  flights.enabled = false;
  const earthquakes = {
    id: 'earthquakes',
    name: 'Earthquakes',
    enabled: false,
    records: [{ id: 'quake', lat: HERE.lat - 0.25, lon: HERE.lon }],
  };
  const satellites = [
    {
      noradId: '1',
      name: 'Near satellite',
      lat: HERE.lat - 0.5,
      lon: HERE.lon,
    },
    {
      noradId: '2',
      name: 'Far satellite',
      lat: HERE.lat + 3,
      lon: HERE.lon,
    },
  ];
  const overheadRecords = t.mock.fn(() => satellites);
  const viewRecords = t.mock.fn(() => satellites);
  const { $, cards, notifyLayers } = fixture(t, [
    flights,
    earthquakes,
    {
      id: 'satellites',
      name: 'Satellites',
      enabled: true,
      module: {
        getAnalystRecords: overheadRecords,
        getViewRecords: viewRecords,
      },
    },
  ]);
  setContextRadiusKm(100);
  setOverheadRangeKm(250);
  const rect = {
    west: -99,
    east: -96,
    south: HERE.lat - 0.1,
    north: HERE.lat + 4,
  };
  const rows = () => document.querySelectorAll('[data-row-layer="satellites"]');
  cards.setView({ center: HERE, rect, heightM: 40_000 });
  await settleInspectorIndex();
  const radius = () => $('.view-context__radius-label');
  assert.ok(
    overheadRecords.mock.callCount() > 0,
    'browsing reads the overhead catalog',
  );
  assert.equal(
    viewRecords.mock.callCount(),
    0,
    'browsing skips the viewport reader',
  );
  assert.equal(radius().textContent, 'Overhead range');
  assert.match(
    $('.view-context__tile[data-layer="satellites"]').getAttribute(
      'aria-label',
    ),
    /Overhead within 250 km · 1$/,
  );
  assert.equal(rows().length, 1);
  assert.match(rows()[0].textContent, /Near satellite/i);
  assert.equal($('.view-context__label').textContent, 'Layers');
  contextSearchOpen.value = true;
  contextSearchText.value = 'Near satellite';
  await settleInspectorIndex();
  assert.equal(
    rows().length,
    0,
    'a satellite outside the viewport does not match its overhead row',
  );
  assert.ok(
    viewRecords.mock.callCount() > 0,
    'a viewport search reads drawn positions',
  );
  assert.match($('.view-context__empty').textContent, /Nothing matches/);
  contextSearchText.value = '';
  closeContextSearch();
  await nextTick();
  assert.match(rows()[0].textContent, /Near satellite/i);

  setOverheadRangeKm(500);
  await nextTick();
  assert.equal(
    document.querySelectorAll('[data-row-layer="satellites"]').length,
    2,
  );
  flights.enabled = true;
  earthquakes.enabled = true;
  notifyLayers();
  await settleInspectorIndex();
  assert.match(radius().textContent, /Radius/);
  const slider = () => $('.view-context__radius input');
  assert.equal(slider().getAttribute('aria-valuetext'), '100 km');
  assert.match(
    $('.view-context__tile[data-layer="earthquakes"]').getAttribute(
      'aria-label',
    ),
    /Within 100 km · 1$/,
  );
  assert.match(
    $('.view-context__tile[data-layer="flights"]').getAttribute('aria-label'),
    /Overhead within 500 km · 1$/,
  );
  radius().click();
  await nextTick();
  assert.match(radius().textContent, /Overhead range/);
  assert.equal(slider().getAttribute('aria-valuetext'), '500 km');
  slider().value = '0';
  slider().dispatchEvent(new window.Event('input', { bubbles: true }));
  await nextTick();
  assert.match(
    $('.view-context__tile[data-layer="satellites"]').getAttribute(
      'aria-label',
    ),
    /Closest to view · 2$/,
  );
  assert.match(
    rows()[0].closest('.nearby-lists').querySelector('h4').textContent,
    /Closest to view/,
  );
  radius().click();
  await nextTick();
  assert.equal(slider().getAttribute('aria-valuetext'), '100 km');
  setOverheadRangeKm(500);
  await nextTick();
  assert.match(
    rows()[0].closest('.nearby-lists').querySelector('.nearby-lists__title')
      .textContent,
    /Overhead within 500 km/,
  );
  cards.setView({ center: HERE, rect: WHOLE_GLOBE, heightM: 20_000_000 });
  await settleInspectorIndex();
  setContextRadiusKm(250);
  await nextTick();
  assert.equal(radius(), null);
  assert.equal(rows().length, 2);
  assert.equal(
    rows()[0].closest('.view-context__block-rows').querySelector('p')
      .textContent,
    'Loaded',
  );
});

test('backgrounding pauses docked street playback and cockpit rendering', async (t) => {
  const priorHidden = Object.getOwnPropertyDescriptor(document, 'hidden');
  const setHidden = (hidden) => {
    Object.defineProperty(document, 'hidden', {
      value: hidden,
      configurable: true,
    });
    document.dispatchEvent(new Event('visibilitychange'));
  };
  setHidden(false);
  t.after(() => {
    if (priorHidden) Object.defineProperty(document, 'hidden', priorHidden);
    else delete document.hidden;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const active = [];
  const { $, cards, pinia } = fixture(
    t,
    [
      {
        id: 'street-level',
        name: 'Street Level',
        enabled: true,
        records: [
          { id: 'mapillary:1', name: 'Congress Ave', lat: 30.27, lon: -97.74 },
        ],
        stats: { count: 1 },
      },
      flightsOn([flight('near01', 30.28, -97.74)]),
    ],
    {
      previews: {
        cockpit: () => ({
          setActive: (value) => active.push(value),
          update() {},
          destroy() {},
        }),
      },
    },
  );
  const streetLevel = useStreetLevelStore(pinia);
  const actions = [];
  streetLevel.act = (name) => actions.push(name);
  const docked = useDockedStore(pinia);
  cards.select(
    { layerId: 'street-level', id: 'mapillary:1' },
    { follow: false },
  );
  await nextTick();
  docked.dock({
    key: cards.card.key,
    kind: 'street',
    title: 'Congress Ave',
    identity: cards.card.identity,
  });
  await nextTick();
  assert.ok(
    $('.entity-hero--docked'),
    'the selected card hands its photo to the dock',
  );
  docked.setStowed(true);
  await nextTick();
  assert.ok(
    actions.includes('stopPlayback'),
    'the stowed sequence stops even with its own card selected',
  );
  docked.setStowed(false);
  await nextTick();
  actions.length = 0;
  setHidden(true);
  await nextTick();
  assert.ok(actions.includes('stopPlayback'), 'a hidden street sequence stops');
  setHidden(false);
  await nextTick();
  docked.dock({
    key: 'flights:near01',
    kind: 'cockpit',
    title: 'NEAR01',
    identity: { layerId: 'flights', id: 'near01' },
  });
  await nextTick();
  assert.equal(active.at(-1), true, 'the visible cockpit renders');
  setHidden(true);
  await nextTick();
  assert.equal(active.at(-1), false, 'the background cockpit is inactive');
  setHidden(false);
  await nextTick();
  assert.equal(active.at(-1), true, 'the cockpit resumes when visible');
});

test('the card store hears layer changes from a data manager that arrives after it connects, and Radio attaches', async (t) => {
  // The app connects the store before its data manager exists.
  const pinia = createPinia();
  const cards = useEntityCardStore(pinia);
  let manager = null;
  cards.connect({ dataManager: () => manager });
  const host = document.body.appendChild(document.createElement('div'));
  const app = createApp({
    setup() {
      const { ui } = useRadioLayer();
      return () =>
        h('p', { id: 'radio-probe' }, ui.value?.enabled ? 'on' : 'off');
    },
  }).use(pinia);
  app.mount(host);
  t.after(() => {
    app.unmount();
    host.remove();
    cards.connect(null);
  });
  assert.equal(document.querySelector('#radio-probe').textContent, 'off');
  const listeners = new Set();
  const radio = {
    id: 'radio',
    name: 'Radio',
    enabled: true,
    module: { subscribe: (fn) => (fn({ enabled: true }), () => {}) },
  };
  manager = {
    layers: new Map([['radio', radio]]),
    isEnabled: () => true,
    getAll: () => [radio],
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  // Context reads the layers on its own tick; that read starts the listening.
  cards.allLayers();
  await Promise.resolve();
  await nextTick();
  assert.equal(listeners.size, 1, 'listening once the manager is there');
  assert.equal(
    document.querySelector('#radio-probe').textContent,
    'on',
    'Radio attaches without a layer change',
  );
  const before = cards.layerRevision;
  listeners.forEach((listener) =>
    listener({
      type: 'visibility',
      layerId: 'news',
      enabled: true,
      origin: 'user',
    }),
  );
  assert.ok(cards.layerRevision > before, 'a layer change is heard');
  assert.equal(cards.lastDirectOn?.layerId, 'news');
  cards.allLayers();
  assert.equal(listeners.size, 1, 'listened to once');
});

test('aircraft and satellite cards use bundled flags with a named fallback', async (t) => {
  const { $, cards } = fixture(t, [
    flightsOn([
      flight('a00001', 30, -97),
      { ...flight('f00001', 31, -97), originCountry: 'Cayman Islands' },
    ]),
    {
      id: 'satellites',
      enabled: true,
      records: [{ ...HERE, noradId: '42', name: 'Example' }],
      module: {
        describeSatellite: () => ({ owner: 'France', ownerCountryCode: 'FR' }),
      },
    },
  ]);
  const pick = async (layerId, id) => {
    cards.select({ layerId, id }, { follow: false });
    await nextTick();
  };
  const registration = () => $('.entity-card__subtitle [role="img"]');
  await pick('flights', 'f00001');
  assert.equal(registration()?.textContent, 'KY');
  assert.equal(registration().getAttribute('aria-label'), 'Cayman Islands');
  const failedSheet = {};
  preloadOwnerFlags({ createImage: () => failedSheet });
  await pick('flights', 'a00001');
  failedSheet.onerror();
  await turn();
  assert.equal(registration()?.textContent, 'US');
  assert.equal(registration().getAttribute('aria-label'), 'United States');
  const sheet = {};
  preloadOwnerFlags({ createImage: () => sheet });
  await pick('satellites', '42');
  sheet.onload();
  await turn();
  contextSearchOpen.value = true;
  contextSearchText.value = 'France';
  await nextTick();
  const owner = $('.entity-card__more[open] dd');
  assert.equal(owner?.textContent, 'France');
  assert.equal(
    owner.querySelector('[aria-hidden="true"]')?.style.backgroundPosition,
    ownerFlagStyle('FR').backgroundPosition,
  );
  contextSearchText.value = '🇫🇷';
  await nextTick();
  assert.equal($('.entity-card__more[open] dd')?.textContent, 'France');
  await pick('flights', 'a00001');
  assert.equal(
    registration()?.style.backgroundPosition,
    ownerFlagStyle('US').backgroundPosition,
  );
  assert.equal(registration().getAttribute('aria-label'), 'United States');
});

test('a sky-only viewport search reports no matches and retains a real feed outage', async (t) => {
  const flights = flightsOn([flight('near01', HERE.lat, HERE.lon)]);
  const { $, cards, notifyLayers } = fixture(t, [flights]);
  cards.setView({ ...localView(), groundFootprint: false });
  await settleInspectorIndex();
  assert.match($(NEAREST).textContent, /NEAR01/);
  contextSearchOpen.value = true;
  contextSearchText.value = 'near01';
  await nextTick();
  const status = () => $('.view-context__empty[role="status"]').textContent;
  assert.equal(status(), '0 results');
  flights.stats = { count: 0, status: 'unavailable', error: 'offline' };
  notifyLayers();
  await nextTick();
  assert.match(status(), /Unavailable layers: .*Flights/);
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

test('the passive Data Layers pointer is absent when layers are on without suggestions', async (t) => {
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
    assert.equal($('.view-context__pointer'), null, `at ${heightM} m`);
  }
});

test('quake scopes switch the count, rows and breakdown together and reset on a settled view', async (t) => {
  const records = [
    { id: 'visible', title: 'Visible quake', ...HERE, magnitude: 2 },
    {
      id: 'outer',
      title: 'Outer quake',
      lat: HERE.lat,
      lon: HERE.lon + 1.5,
      magnitude: 4,
    },
    {
      id: 'anchor',
      title: 'Anchor quake',
      lat: HERE.lat,
      lon: HERE.lon + 8,
      magnitude: 3,
    },
    {
      id: 'adjacent',
      title: 'Adjacent quake',
      lat: HERE.lat,
      lon: HERE.lon + 8.4,
      magnitude: 3,
    },
  ];
  const { $, cards } = fixture(t, [
    { id: 'earthquakes', name: 'Earthquakes', enabled: true, records },
  ]);
  setContextRadiusKm(250);
  const view = { ...localView(), heightM: 200000 };
  cards.setView(view);
  await settleInspectorIndex();
  const tile = () => $('.view-context__tile[data-layer="earthquakes"]');
  const action = () => tile().querySelector('button[data-scope-layer]');
  assert.match(tile().getAttribute('aria-label'), /In view · 1/);
  assert.match(action().textContent, /250 km · 2/);
  action().focus();
  action().click();
  await nextTick();
  assert.equal(document.activeElement, action());
  assert.match(tile().getAttribute('aria-label'), /250 km · 2/);
  assert.ok(tile().querySelector('[data-row-key="earthquakes:outer"]'));
  assert.ok(tile().querySelector('.view-context__bar[role="img"]'));
  cards.setView({ ...view, heightM: view.heightM + 500 });
  await settleInspectorIndex();
  assert.match(tile().getAttribute('aria-label'), /In view · 1/);

  cards.select({ layerId: 'earthquakes', id: 'anchor' }, { fly: false });
  await settleInspectorIndex();
  const selected = () => $('[data-spatial-layer="earthquakes"]');
  assert.match(selected().textContent, /Within 250 km of Anchor quake/);
  assert.ok(selected().querySelector('[data-row-key="earthquakes:adjacent"]'));
  assert.equal(
    selected().querySelector('[data-row-key="earthquakes:anchor"]'),
    null,
  );
  assert.equal(
    selected().querySelector('button[data-scope-layer]'),
    null,
    'equal counts',
  );
  setContextRadiusKm(25);
  await settleInspectorIndex();
  assert.match(selected().textContent, /In view/);
  assert.ok(selected().querySelector('[data-row-key="earthquakes:visible"]'));
  cards.setView(localView({ lat: 0, lon: 0 }));
  await settleInspectorIndex();
  assert.match(selected().textContent, /Closest to Anchor quake/);
  assert.ok(selected().querySelector('[data-row-key="earthquakes:adjacent"]'));
});

test('a scoped quake layer separates a real empty result, loading and failed reads', async (t) => {
  const layer = {
    id: 'earthquakes',
    name: 'Earthquakes',
    enabled: true,
    stats: { recordsRevision: 1 },
    records: [],
  };
  const { $, cards, notifyLayers } = fixture(t, [layer]);
  cards.setView(localView());
  await settleInspectorIndex();
  const tile = () => $('.view-context__tile[data-layer="earthquakes"]');
  assert.match(tile().getAttribute('aria-label'), /None in view · 0/);
  layer.stats = { loading: true, recordsRevision: 2 };
  notifyLayers();
  await settleInspectorIndex();
  assert.doesNotMatch(tile().getAttribute('aria-label'), /None in view| · 0/);
  layer.stats = { status: 'unavailable', recordsRevision: 3 };
  notifyLayers();
  await settleInspectorIndex();
  assert.match(tile().getAttribute('aria-label'), /Unavailable/);
  assert.equal(tile().querySelector('[data-scope-layer]'), null);
  cards.select(placeIdentity({ ...HERE, name: 'Austin', from: 'spot' }), {
    fly: false,
  });
  await settleInspectorIndex();
  const selected = () => $('[data-spatial-layer="earthquakes"]');
  assert.match(selected().textContent, /Unavailable/);
  layer.stats = { count: 0, recordsRevision: 4 };
  notifyLayers();
  await settleInspectorIndex();
  assert.match(selected().textContent, /None nearby/);
});

test('an inline Austin camera owns the single nearby flight count', async (t) => {
  const { $, cards, pinia } = fixture(t, [
    {
      id: 'cctv',
      name: 'Cameras',
      enabled: true,
      records: [{ id: 'austin', name: 'Austin camera', ...HERE }],
    },
    flightsOn([flight('near01', HERE.lat + 0.1, HERE.lon)]),
  ]);
  cards.setView(localView());
  await settleInspectorIndex();
  assert.ok($('.view-context__tile[data-layer="flights"]'));
  useCctvStore(pinia).publish(
    presentCctvPanel({ enabled: true, activeCameraId: 'austin' }, true),
  );
  cards.select({ layerId: 'cctv', id: 'austin' }, { fly: false });
  await settleInspectorIndex();
  assert.equal($('.view-context__tile[data-layer="flights"]'), null);
  const group = $('#entity-card .nearby-lists__layer[data-layer="flights"]');
  assert.ok(group);
  assert.equal(group.querySelector('.nearby-lists__count').textContent, '1');
  assert.ok(group.querySelector('[data-row-key="flights:near01"]'));
});

test('wrecks, incident evidence and place results share the scope switch with source-specific closest coverage', async (t) => {
  const points = [
    { id: 'first', name: 'First', ...HERE },
    { id: 'second', name: 'Second', lat: HERE.lat, lon: HERE.lon + 1.5 },
  ];
  const { $, cards } = fixture(t, [
    {
      id: 'bhote-koshi-2026',
      name: 'Bhote Koshi event',
      enabled: true,
      records: points,
    },
    {
      id: 'bhote-koshi-locator',
      name: 'Bhote Koshi locator',
      enabled: true,
      records: points,
    },
    { id: 'shipwrecks', name: 'Shipwrecks', enabled: true, records: points },
    { id: 'osm-places', name: 'OSM Places', enabled: true, records: points },
  ]);
  const view = { ...localView(), heightM: 200000 };
  cards.setView(view);
  setContextRadiusKm(250);
  await settleInspectorIndex();
  const tile = (id) => $('.view-context__tile[data-layer="' + id + '"]');
  for (const id of [
    'shipwrecks',
    'osm-places',
    'bhote-koshi-2026',
    'bhote-koshi-locator',
  ]) {
    assert.match(tile(id).getAttribute('aria-label'), /In view · 1/);
    tile(id).querySelector('button[data-scope-layer]').click();
    await nextTick();
    assert.match(tile(id).getAttribute('aria-label'), /250 km · 2/);
    assert.ok(tile(id).querySelector('[data-row-key="' + id + ':second"]'));
  }
  setContextRadiusKm(25);
  cards.setView({
    ...view,
    center: { lat: HERE.lat + 3, lon: HERE.lon },
    rect: { ...view.rect, south: HERE.lat + 2, north: HERE.lat + 4 },
  });
  await settleInspectorIndex();
  assert.match(
    tile('shipwrecks').getAttribute('aria-label'),
    /Closest to view · 2/,
  );
  assert.match(
    tile('osm-places').getAttribute('aria-label'),
    /None in view · 0/,
  );
});

for (const phone of [false, true]) {
  test(`an inline camera stays in reach when Radio and Missions are on (${phone ? 'phone' : 'desktop'})`, async (t) => {
    const camera = { id: 'austin', name: 'Austin camera', ...HERE };
    const { $, cards, pinia } = fixture(t, [
      { id: 'cctv', name: 'Cameras', enabled: true, records: [camera] },
      { id: 'radio', name: 'Radio', enabled: true, module: radioLayer() },
      {
        id: 'rocket-launches',
        name: 'Space Missions',
        enabled: true,
        records: [],
      },
    ]);
    if (phone)
      useDisplayStore(pinia).publishPhoneShell({
        enabled: true,
        sheet: 'context',
      });
    const missions = useSpaceMissionsStore(pinia);
    missions.setEnabled(true);
    missions.publish({ roster: { count: '0', entries: [] }, mission: null });
    cards.setView(localView());
    await settleInspectorIndex();

    const cameraList = () => $('[data-list-card="cctv"]');
    const radioList = () => $('[data-list-card="radio"]');
    const missionList = () => $('[data-list-card="space-missions"]');
    assert.ok(radioList()?.querySelector('[data-list-key="kut"]'));
    assert.ok(missionList());
    assert.ok(cameraList()?.querySelector('[data-list-key="austin"]'));

    cards.select({ layerId: 'cctv', id: camera.id }, { fly: false });
    await settleInspectorIndex();

    $('[aria-label="Search in Context"]').click();
    await nextTick();
    assert.equal(
      $('.context-search__input').placeholder,
      'Search Austin camera and nearby',
    );
    assert.ok(cameraList()?.querySelector('#entity-card'));
    assert.ok(!radioList(), 'the Radio roster is hidden during camera detail');
    assert.ok(
      !missionList(),
      'the Missions roster is hidden during camera detail',
    );
    cameraList().querySelector('button[aria-label="Close card"]').click();
    await settleInspectorIndex();

    assert.ok(cameraList()?.querySelector('[data-list-key="austin"]'));
    assert.ok(radioList()?.querySelector('[data-list-key="kut"]'));
    assert.ok(missionList());
  });
}

test('inline camera leaves the existing view group visible when its card has no nearby row', async (t) => {
  const { $, cards, pinia } = fixture(t, [
    {
      id: 'cctv',
      name: 'Cameras',
      enabled: true,
      records: [{ id: 'austin', name: 'Austin camera', ...HERE }],
    },
    flightsOn([flight('inview', HERE.lat + 5, HERE.lon)]),
  ]);
  setContextRadiusKm(25);
  cards.setView({
    ...localView({ lat: HERE.lat + 5, lon: HERE.lon }),
    heightM: 200000,
  });
  await settleInspectorIndex();
  useCctvStore(pinia).publish(
    presentCctvPanel({ enabled: true, activeCameraId: 'austin' }, true),
  );
  cards.select({ layerId: 'cctv', id: 'austin' }, { fly: false });
  await settleInspectorIndex();
  assert.ok($('#entity-card'));
  assert.equal(
    $('#entity-card .nearby-lists__layer[data-layer="flights"]'),
    null,
  );
  const tile = $('.view-context__tile[data-layer="flights"]');
  assert.match(tile.getAttribute('aria-label'), /In view · 1/);
  assert.ok($('.view-context [data-row-key="flights:inview"]'));
});

test('opening a News report reveals Lists on the phone and leaving the sheet hides its media', async (t) => {
  const { $, pinia } = fixture(t, [], { startOpen: false });
  setContextListPresence('news', { count: 1 });
  t.after(() => setContextListPresence('news', null));
  const display = useDisplayStore(pinia);
  const chrome = usePanelChromeStore(pinia);
  const calls = [];
  const token = chrome.connect({
    toggle: (id) => {
      calls.push(['toggle', id]);
      chrome.publish(token, id, { collapsed: false });
    },
    reveal: (id) => {
      calls.push(['reveal', id]);
      display.publishPhoneShell({ enabled: true, sheet: 'context' });
    },
  });
  t.after(() => chrome.detach(token));
  chrome.publish(token, 'global-context-panel', { collapsed: true });
  display.publishPhoneShell({ enabled: true, sheet: 'layers' });
  await nextTick();
  const host = $('#news-panel-body');
  assert.ok(host.hasAttribute('data-news-hidden'));
  globalThis.dispatchEvent(
    new CustomEvent('gev:context-show-view', { detail: { list: 'news' } }),
  );
  await nextTick();
  assert.deepEqual(calls, [
    ['toggle', 'global-context-panel'],
    ['reveal', 'global-context-panel'],
  ]);
  assert.equal($('#context-tab-lists').getAttribute('aria-selected'), 'true');
  assert.equal(host.hasAttribute('data-news-hidden'), false);
  display.publishPhoneShell({ enabled: true, sheet: 'layers' });
  await nextTick();
  assert.ok(host.hasAttribute('data-news-hidden'));
});

for (const sourceUnavailable of [true, false]) {
  test(`a saved card offers no inert action when ${sourceUnavailable ? 'its provider is unavailable' : 'the host cannot enable its layer'}`, async (t) => {
    const layer = flightsOn([], { sourceUnavailable });
    layer.enabled = false;
    const { $, cards, pinia } = fixture(t, [layer]);
    const controls = useOmnibarStore(pinia);
    controls.connect({
      layers: () => [layer],
      ...(sourceUnavailable && {
        setLayer: () => assert.fail('unexpected enable'),
      }),
    });
    t.after(() => controls.connect(null));
    assert.ok(
      cards.open(
        { layerId: 'flights', id: 'civil1', label: 'Training flight', ...HERE },
        { fromPin: true },
      ),
    );
    await nextTick();
    assert.ok($('[data-pinned-layer-hint]'));
    assert.equal(
      Boolean($('#entity-card .view-context__suggest button')),
      false,
    );
  });
}

test('a satellite card charts its own altitude and speed samples in orbital units', async (t) => {
  const { $, cards } = fixture(t, []);
  const item = {
    layerId: 'satellites',
    kind: 'satellite',
    icon: 'satellite_alt',
    key: 'synthetic-orbit-a',
    title: 'Synthetic weather satellite',
    fields: [],
    altitudeM: 400000,
    speedMps: 7600,
  };
  cards.card = item;
  await nextTick();
  cards.card = { ...item, altitudeM: 402000, speedMps: 7500 };
  cards.tick++;
  await nextTick();
  const graph = (trend) =>
    $(`#entity-card .altitude-graph[data-trend="${trend}"]`);
  assert.equal(graph('up')?.querySelector('strong').textContent, '402 km');
  assert.equal(graph('down')?.querySelector('strong').textContent, '7.50 km/s');
  cards.card = { ...item, key: 'synthetic-orbit-b', speedMps: null };
  await nextTick();
  assert.equal(graph('level')?.querySelector('strong').textContent, '400 km');
  assert.equal($('#entity-card').querySelectorAll('.altitude-graph').length, 1);
});

for (const kind of ['aircraft', 'vessel']) {
  test(`card search preserves the ${kind} trace until selection changes`, async (t) => {
    const { $, cards } = fixture(t, []);
    const item = {
      layerId: kind === 'aircraft' ? 'flights' : 'vessels',
      kind,
      icon: 'navigation',
      moving: true,
      key: 'training-a',
      title: 'Training A',
      fields: [],
      altitudeM: 800,
      speedMps: 8,
    };
    cards.card = item;
    await nextTick();
    cards.card = { ...item, altitudeM: 1000, speedMps: 12 };
    cards.tick++;
    await nextTick();
    const trace = () =>
      $(
        kind === 'aircraft'
          ? '#entity-card .altitude-graph__line'
          : '#entity-card .item-charts__row polyline',
      );
    assert.ok(trace());
    const shape = () =>
      trace()?.getAttribute(kind === 'aircraft' ? 'd' : 'points');
    const before = shape();
    contextSearchOpen.value = true;
    contextSearchText.value = 'port';
    await nextTick();
    cards.tick++;
    await nextTick();
    contextSearchText.value = '';
    await nextTick();
    assert.equal(shape(), before);
    cards.card = { ...item, key: 'training-b', title: 'Training B' };
    await nextTick();
    assert.equal(Boolean(trace()), false);
  });
}

test('a camera pin credits its operator only when the saved bytes came from that camera', async (t) => {
  const layer = {
    id: 'cctv',
    name: 'Cameras',
    enabled: true,
    records: ['historical', 'live'].map((id) => ({ id, name: id, ...HERE })),
    module: {
      cameraDetails: () => ({
        provider: 'Test City',
        credit: 'City camera operator',
      }),
      frameUrlForCamera: (id) => ({
        url: '/fixture/' + id,
        refreshMs: 10000,
        readImage: async () => ({
          url: 'blob:fixture-' + id,
          release() {},
          sourceKind: id === 'historical' ? 'streetview' : 'upstream-image',
        }),
      }),
    },
  };
  const { $, cards, pinia } = fixture(t, [layer]);
  const pinned = usePinnedStore(pinia);
  _setFrameStillCaptureForTest(async () => 'data:image/jpeg;base64,QQ==');
  t.after(() => _setFrameStillCaptureForTest(null));
  for (const id of ['historical', 'live']) {
    cards.select({ layerId: 'cctv', id }, { fly: false });
    await nextTick();
    $('.entity-card__action--pin').click();
    await turn();
  }
  cards.clear();
  pinned.show('pinned');
  await nextTick();
  const tile = (id) => $(`[data-pin-key="cctv:${id}"]`);
  assert.ok(tile('historical'));
  assert.equal(
    Boolean(tile('historical').querySelector('img,.pinned-grid__photo-credit')),
    false,
  );
  assert.ok(tile('live').querySelector('img'));
  assert.equal(
    tile('live').querySelector('.pinned-grid__photo-credit')?.textContent,
    'Test City · City camera operator',
  );
});

test('a docked Google panorama suppresses card and pin maps until it leaves view', async (t) => {
  const { cards, $, pinia } = fixture(t, [
    {
      id: 'earthquakes',
      name: 'Earthquakes',
      enabled: true,
      records: [{ id: 'q1', name: 'Training quake', magnitude: 3, ...HERE }],
    },
  ]);
  const street = useStreetLevelStore(pinia);
  const dock = useDockedStore(pinia);
  const pins = usePinnedStore(pinia);
  function open(provider) {
    const id = provider + ':a';
    street.publish({
      enabled: true,
      viewer: { open: true, photo: { id, providerId: provider } },
    });
    dock.dock({
      key: 'street-level:' + id,
      kind: 'street',
      title: 'Street photo',
      identity: { layerId: 'street-level', id },
    });
  }
  open('mapillary');
  cards.select({ layerId: 'earthquakes', id: 'q1' }, { fly: false });
  await nextTick();
  assert.equal($('#entity-card .entity-hero').dataset.hero, 'map');
  open('google');
  await nextTick();
  assert.ok($('#sl-docked-slot'));
  assert.ok($('#entity-card .entity-hero__placeholder'));
  assert.equal($('#entity-card .close-up-map'), null);
  $('.entity-card__action--pin').click();
  pins.show('pinned');
  await nextTick();
  const tile = () => $('.pinned-grid__tile');
  assert.ok(tile().querySelector('button'));
  assert.equal(tile().querySelector('canvas.card-map'), null);
  assert.equal($('.pinned-grid__credits'), null);
  dock.setStowed(true);
  await nextTick();
  assert.ok(tile().querySelector('canvas.card-map'));
  dock.setStowed(false);
  await nextTick();
  assert.equal(tile().querySelector('canvas.card-map'), null);
  open('panoramax');
  await nextTick();
  assert.ok(tile().querySelector('canvas.card-map'));
});
