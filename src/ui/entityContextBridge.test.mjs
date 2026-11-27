import '../testSupport/registerDom.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick, ref, watch } from 'vue';
import { OrbitController } from '../orbit.js';
import { bhoteKoshiPlaceRecords } from '../data/bhoteKoshiLocator.js';
import { INCIDENT_OVERVIEW_PLACES } from '../data/bhoteKoshiIncidentPlaces.js';
import { toLonLatH } from '../geo/ellipsoid.js';
import { createControls as createWildlifeControls } from '../layers/wildlifeSightings/controls.js';
import { normalizeInatObservations } from '../layers/wildlifeSightings/records.js';
import { LocationSearch } from './locationSearch.js';
import { NavigationController } from './navigationController.js';
import { controlCctv } from '../voice/gevActions.js';
import { CCTV_SELECTED_EVENT } from './cctvEvents.js';
import { installEntityContext } from './entityContextBridge.js';
import { createLayerCounts } from './layerCounts.js';
import { announcePlacePick, installPlacePick } from './placePick.js';
import { holdAirportPack } from '../testSupport/holdAirportPack.mjs';
import { useContextStore } from './stores/context.js';
import { useCockpitStore } from './stores/cockpit.js';
import { useEntityCardStore } from './stores/entityCard.js';
import { useLayerCountsStore } from './stores/layerCounts.js';
import { useOmnibarStore } from './stores/omnibar.js';
import { useDockedStore } from './stores/docked.js';
import { usePanelChromeStore } from './stores/panelChrome.js';
import { useSceneStore } from './stores/scenes.js';
import { useSpaceMissionsStore } from './stores/spaceMissions.js';
import { useVoiceStore } from './stores/voice.js';
import {
  STREET_LEVEL_PHOTO_EVENT,
  STREET_LEVEL_PHOTO_REQUEST_EVENT,
} from './streetLevelEvents.js';
import { fakeInput } from '../input/testDoubles.mjs';
import { fakeCameraPort } from '../testSupport/fakeCameraPort.mjs';
import { bindRenderer, findCamera } from '../render/rendererOf.js';
import { bindFakeDraw } from '../testSupport/fakeDrawPort.mjs';
import * as context from '../data/contextStore.js';
import { createEarthquakesLayer } from '../layers/earthquakes/index.js';
import {
  _resetSelectionForTest,
  claimSelection,
  currentSelection,
  releaseSelection,
} from '../data/clickSelect.js';
import {
  registerClickClaim,
  registerPickOwner,
  setClickCardHitTest,
  unregisterClickClaim,
  unregisterPickOwner,
} from '../data/pickRegistry.js';

const AUSTIN_AIRPORTS = [
  [
    'KAUS',
    'AUS',
    'Austin–Bergstrom International Airport',
    30.1945,
    -97.6699,
    'large',
    'Austin',
    'US',
    542,
    2,
  ],
];

// The card or label painted on top takes the click: Context names nothing
// under it, exact or nearby, an acting owner's item or a passive one, and
// keeps its own card. On open map it names what the click found.
test('Context names nothing under a card painted on top, and keeps its card', (t) => {
  const previous = globalThis.matchMedia;
  globalThis.matchMedia = () => ({ matches: true });
  t.after(() => {
    if (previous) globalThis.matchMedia = previous;
    else delete globalThis.matchMedia;
  });
  const fire = { set: 'test-fires:1', id: 'fire:1' };
  const plane = { set: 'test-planes:1', id: 'plane:1' };
  const route = { set: 'test-route:1', id: 'route:line' };
  registerPickOwner('test-fires', (id) => id === fire.id);
  registerPickOwner('test-planes', (id) => id === plane.id);
  registerPickOwner('test-route', (id) => id.startsWith('route:'));
  let cardOnTop = false;
  // The card on top at a click, as the host answers the pick registry.
  setClickCardHitTest(() =>
    cardOnTop ? { sourceId: 'earthquake-card', entryId: 'q' } : null,
  );
  t.after(() => {
    setClickCardHitTest(null);
    unregisterPickOwner('test-fires');
    unregisterPickOwner('test-planes');
    unregisterPickOwner('test-route');
  });
  let exact = null;
  let near = null;
  const viewer = {
    scene: {
      pick: () => (exact ? { id: exact } : null),
      drillPick: () => (near ? [{ id: near }] : []),
    },
  };
  const input = fakeInput(viewer);
  const pinia = createPinia();
  const dataManager = {
    isEnabled: () => true,
    layers: new Map(),
    getAll: () => [],
  };
  const disconnect = installEntityContext({
    viewer,
    getDataManager: () => dataManager,
    pinia,
  });
  t.after(() => {
    disconnect();
    input.destroy();
  });
  const store = useEntityCardStore(pinia);
  const named = [];
  let clears = 0;
  store.select = (identity) => named.push(identity.id);
  store.clear = () => clears++;
  const tap = (hitExact, hitNear) => {
    exact = hitExact;
    near = hitNear;
    named.length = 0;
    input.click();
    return [...named];
  };
  assert.deepEqual(tap(null, fire), ['fire:1'], 'open map: a near fire');
  assert.deepEqual(tap(route, null), ['route:line'], 'open map: a route');
  cardOnTop = true;
  assert.deepEqual(tap(null, fire), [], 'under a card: a near fire');
  assert.deepEqual(tap(fire, fire), [], 'under a card: an exact fire');
  assert.deepEqual(tap(plane, plane), [], 'under a card: an aircraft');
  assert.deepEqual(tap(route, null), [], 'under a card: a route');
  const cleared = clears;
  tap(null, null);
  assert.equal(clears, cleared, 'a card over open map is not open map');
});

// The card offers the orbital view only for a satellite that can be ridden;
// debris (a rocket body) leads with Follow instead. Aircraft keep the cockpit.
test('the satellite card offers and enters orbit only for its eligible subject', async (t) => {
  const viewer = { scene: { pick: () => null, drillPick: () => [] } };
  const input = fakeInput(viewer);
  const pinia = createPinia();
  const rideable = new Set(['25544']);
  const dataManager = {
    isEnabled: () => true,
    layers: new Map([
      [
        'satellites',
        { module: { cockpitEnterable: (id) => rideable.has(String(id)) } },
      ],
    ]),
    getAll: () => [],
  };
  const disconnect = installEntityContext({
    viewer,
    getDataManager: () => dataManager,
    pinia,
  });
  t.after(() => {
    disconnect();
    input.destroy();
  });
  const store = useEntityCardStore(pinia);
  const satellite = (id) => ({
    key: `satellites:${id}`,
    layerId: 'satellites',
    kind: 'satellite',
    identity: { layerId: 'satellites', id, record: { noradId: id } },
  });
  store.card = satellite('25544');
  assert.equal(store.canCockpit(), false, 'no action runner yet');
  useOmnibarStore(pinia).connectRunner(async () => ({ ok: true }));
  assert.equal(store.canCockpit(), true, 'the ISS can be ridden');
  assert.equal(store.canFollow(), true);
  store.card = satellite('26070');
  assert.equal(store.canCockpit(), false, 'debris cannot');
  assert.equal(store.canFollow(), true, 'debris is still followed');
  store.card = {
    key: 'flights:abc123',
    layerId: 'flights',
    kind: 'aircraft',
    identity: { layerId: 'flights', id: 'abc123' },
  };
  assert.equal(store.canCockpit(), true, 'an aircraft keeps its cockpit');

  t.mock.timers.enable({ apis: ['setTimeout'] });
  const cockpit = useCockpitStore(pinia);
  const entered = t.mock.fn();
  cockpit.connect({ enter: entered });
  const card = satellite('25544');
  store.card = card;
  const ready = (id) =>
    cockpit.publishPresence({
      entryAvailable: true,
      entryKind: 'satellite',
      entryId: id,
    });
  const poll = async () => {
    t.mock.timers.tick(100);
    await setImmediate();
  };

  ready('99999');
  store.cockpit();
  await setImmediate();
  await poll();
  assert.equal(entered.mock.callCount(), 0, 'another satellite is ready');
  ready('25544');
  await poll();
  assert.deepEqual(
    entered.mock.calls.map((call) => call.arguments),
    [[card.identity]],
  );

  ready('99999');
  store.cockpit();
  await setImmediate();
  store.card = satellite('26070');
  ready('25544');
  await poll();
  assert.equal(entered.mock.callCount(), 1, 'a new pick cancels the wait');
});

// A vessel, a train or a bus offers its own view (Bridge or Cab view) only
// while the Cockpit says that very item's layer can be entered; static items
// never do.
test('a moving item offers its own view only for the exact entry candidate', (t) => {
  const viewer = { scene: { pick: () => null, drillPick: () => [] } };
  const input = fakeInput(viewer);
  const pinia = createPinia();
  const dataManager = {
    isEnabled: () => true,
    layers: new Map(),
    getAll: () => [],
  };
  const disconnect = installEntityContext({
    viewer,
    getDataManager: () => dataManager,
    pinia,
  });
  t.after(() => {
    disconnect();
    input.destroy();
  });
  const store = useEntityCardStore(pinia);
  const cockpit = useCockpitStore(pinia);
  const item = (layerId, id) => ({
    key: `${layerId}:${id}`,
    layerId,
    kind: 'item',
    identity: { layerId, id },
  });
  store.card = item('ais-live-vessels', '366999000');
  cockpit.publishPresence({ entryAvailable: false, entryLayerId: null });
  assert.equal(
    store.canCockpit(),
    false,
    'not offered until it can be entered',
  );
  cockpit.publishPresence({
    entryAvailable: true,
    entryLayerId: 'ais-live-vessels',
    entryId: '366999000',
  });
  assert.equal(store.canCockpit(), true, 'the bridge view is offered');
  const asked = [];
  const identity = store.card.identity;
  cockpit.connect({ enter: (subject) => asked.push(subject) });
  store.cockpit();
  assert.deepEqual(asked, [identity], 'it asks Cockpit to enter this subject');
  store.card = item('ais-live-vessels', '366999001');
  assert.equal(
    store.canCockpit(),
    false,
    'another vessel in the same layer is not this item',
  );
  store.cockpit();
  assert.deepEqual(asked, [identity], 'the other vessel cannot request entry');
  store.card = item('rail', 'train-9');
  assert.equal(store.canCockpit(), false, 'another layer: not this item');
  cockpit.publishPresence({
    entryAvailable: true,
    entryLayerId: 'rail',
    entryId: 'train-9',
  });
  assert.equal(store.canCockpit(), true, 'the cab view is offered');
  store.card = item('fires', 'f1');
  assert.equal(store.canCockpit(), false, 'a fire never is');
});

// The card says Following only while the camera follows the card's own item,
// whoever started or ended the follow: taking hold shows at once, letting go
// once the follow has stayed off for a moment, and following something else
// is not following the card.
test("the card's Following matches what the camera follows", (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const viewer = { scene: { pick: () => null, drillPick: () => [] } };
  const { port } = fakeCameraPort();
  const listeners = new Set();
  let followed = null;
  const camera = {
    ...port,
    get followed() {
      return followed;
    },
    follow(target) {
      followed = target;
      for (const cb of [...listeners]) cb();
    },
    on(event, cb, options) {
      if (event !== 'followChanged') return port.on(event, cb, options);
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
  const unbind = bindRenderer(viewer, { camera });
  const input = fakeInput(viewer);
  const pinia = createPinia();
  const dataManager = {
    isEnabled: () => true,
    layers: new Map(),
    getAll: () => [],
  };
  const disconnect = installEntityContext({
    viewer,
    getDataManager: () => dataManager,
    pinia,
  });
  t.after(() => {
    disconnect();
    input.destroy();
    unbind();
  });
  const store = useEntityCardStore(pinia);
  store.card = {
    key: 'flights:abc123',
    layerId: 'flights',
    identity: { id: 'abc123' },
    title: 'UPS668',
  };
  assert.equal(store.isFollowing(), false, 'not before the camera follows');

  camera.follow({ key: 'flights:abc123' });
  assert.equal(store.isFollowing(), true, 'the camera follows the card');

  camera.follow(null);
  assert.equal(store.isFollowing(), true, 'a moment to take hold again');
  t.mock.timers.tick(300);
  assert.equal(store.isFollowing(), false, 'the camera let go');

  camera.follow({ key: 'flights:abc123' });
  camera.follow({ key: 'flights:other9' });
  t.mock.timers.tick(300);
  assert.equal(store.isFollowing(), false, 'following another plane');
});

// A vessel's layer announces its selection with the context store's id; the
// card names it by the vessel's own id, as a click on it does.
test('News list selection keeps article ownership while a globe selection opens its card', (t) => {
  const viewer = { scene: { pick: () => null, drillPick: () => [] } };
  const input = fakeInput(viewer);
  const pinia = createPinia();
  const disconnect = installEntityContext({
    viewer,
    pinia,
    getDataManager: () => ({ layers: new Map(), getAll: () => [] }),
  });
  t.after(() => {
    disconnect();
    input.destroy();
  });
  const select = t.mock.fn();
  useEntityCardStore(pinia).select = select;
  const record = {
    layerId: 'news',
    id: 'news-report:one',
    latitude: 1,
    longitude: 2,
  };
  globalThis.dispatchEvent(
    new CustomEvent('gev:entity-selected', {
      detail: { ...record, fromNewsList: true },
    }),
  );
  assert.equal(select.mock.callCount(), 0);
  globalThis.dispatchEvent(
    new CustomEvent('gev:entity-selected', { detail: record }),
  );
  assert.equal(select.mock.callCount(), 1);
});

test('a vessel announced by its layer is named by its own id', (t) => {
  const pinia = createPinia();
  const viewer = { scene: { pick: () => null, drillPick: () => [] } };
  const input = fakeInput(viewer);
  const dataManager = {
    isEnabled: () => true,
    layers: new Map(),
    getAll: () => [],
  };
  const revealContext = t.mock.fn();
  const disconnect = installEntityContext({
    viewer,
    getDataManager: () => dataManager,
    pinia,
    revealContext,
  });
  t.after(() => {
    disconnect();
    input.destroy();
  });
  const store = useEntityCardStore(pinia);
  const named = [];
  store.select = (identity) => named.push(identity.id);
  globalThis.dispatchEvent(
    new CustomEvent('gev:entity-selected', {
      detail: {
        layerId: 'ais-live-vessels',
        id: 'ais-5fdca702',
        properties: { vesselId: '5fdca702' },
        latitude: 1,
        longitude: 2,
      },
    }),
  );
  globalThis.dispatchEvent(
    new CustomEvent('gev:entity-selected', {
      detail: { layerId: 'fires', id: 'fire:1', latitude: 1, longitude: 2 },
    }),
  );
  const fire = { layerId: 'fires', id: 'fire:1' };
  store.card = { layerId: 'fires', identity: fire };
  globalThis.dispatchEvent(
    new CustomEvent('gev:entity-selected', { detail: fire }),
  );
  assert.equal(revealContext.mock.callCount(), 0, 'a feed echo stays quiet');
  registerClickClaim('fires', () => ({
    sourceId: fire.layerId,
    entryId: fire.id,
  }));
  t.after(() => unregisterClickClaim('fires'));
  input.click();
  assert.equal(
    revealContext.mock.callCount(),
    1,
    'picking the same label reveals its card',
  );
  assert.deepEqual(named, ['5fdca702', 'fire:1'], 'Back history is preserved');
});

test('Context keeps the selected source vessel when a different hull shares its MMSI', async (t) => {
  const { createApplicationVessels } =
    await import('../app/layers/aisLiveVessels.js');
  const mmsi = '123456789';
  const first = {
    id: 'hull-first',
    mmsi,
    name: 'First Hull',
    lat: 1,
    lon: 1,
    position: { x: 1, y: 2, z: 3 },
  };
  // A provider can use the MMSI as one row's id and another hull's attribute.
  const second = { ...first, id: mmsi, name: 'Second Hull', lon: 2 };
  const module = createApplicationVessels({});
  const row = { id: module.id, name: module.name, enabled: true, module };
  const dataManager = {
    isEnabled: () => true,
    layers: new Map([[row.id, row]]),
    getAll: () => [row],
  };
  module.testing._setVesselStateForTest({ records: [first, second] });
  registerPickOwner(row.id, (id) => id === second.id);
  t.after(() => unregisterPickOwner(row.id));
  const viewer = {
    scene: { pick: () => ({ id: { id: second.id } }), drillPick: () => [] },
  };
  const input = fakeInput(viewer);
  const pinia = createPinia();
  const chrome = usePanelChromeStore(pinia);
  const owner = chrome.connect({});
  chrome.publish(owner, 'global-context-panel', { collapsed: false });
  const disconnect = installEntityContext({
    viewer,
    getDataManager: () => dataManager,
    pinia,
  });
  t.after(() => {
    disconnect();
    input.destroy();
  });
  const store = useEntityCardStore(pinia);
  input.click();
  assert.equal(store.card.title, 'Second Hull');
  assert.equal(store.card.lon, 2);

  module.testing._setVesselStateForTest({ records: [first] });
  store.refresh();
  assert.equal(store.card.title, 'Second Hull');
  assert.equal(store.card.lon, 2);
  assert.equal(store.lost, true);

  // An untyped MMSI lookup still works for a caller with an old identity.
  assert.equal(store.select({ layerId: row.id, id: mmsi }), true);
  assert.equal(store.card.title, 'First Hull');

  module.testing._setVesselStateForTest({ records: [first, second] });
  const center = { lat: 1, lon: 1.5 };
  const expected = [`${row.id}:${first.id}`, `${row.id}:${second.id}`].sort();
  const keys = (items) => items.map((item) => item.key).sort();
  assert.deepEqual(keys(store.search(mmsi)), expected);
  assert.deepEqual(
    keys(store.nearbyLayers(center.lat, center.lon)[0].items),
    expected,
  );
  store.setView({ center, rect: { west: 0, south: 0, east: 3, north: 2 } });
  assert.deepEqual(keys(store.inView({ viewport: true })[0].items), expected);
});

for (const [id, keyed] of [
  ['geojson:park-7', false],
  ['geojson:number:7', false],
  ['geojson:number:7', true],
]) {
  test(`Nearby refresh preserves the ${keyed ? 'keyed' : 'ordinary'} ID ${id}`, (t) => {
    const park = {
      id,
      name: 'Cedar Park',
      lat: 30.27,
      lon: -97.74,
      ...(keyed ? { key: id } : {}),
    };
    const neighbor = { ...park, key: 'geojson:id:park-8' };
    const counterpart = { ...park, lon: park.lon + 0.002 };
    if (keyed) delete counterpart.key;
    else counterpart.key = id;
    let records = [park, neighbor];
    const row = {
      id: 'test-parks',
      name: 'Parks',
      enabled: true,
      module: { getAnalystRecords: () => records },
    };
    const dataManager = {
      layers: new Map([[row.id, row]]),
      getAll: () => [row],
      isEnabled: () => true,
    };
    const store = useEntityCardStore(createPinia());
    store.connect({ dataManager: () => dataManager });
    t.after(() => store.clear());

    assert.ok(store.select({ layerId: row.id, id }));
    assert.equal(store.card.basis, 'record', 'direct ID lookup still works');

    const [list] = store.nearbyLayers(park.lat, park.lon, { radiusKm: 5 });
    const selected = list.items.find((item) => item.identity.id === park.id);
    assert.ok(store.select(selected.identity));
    assert.equal(store.card.title, park.name);

    const nextLon = park.lon + 0.001;
    records = [{ ...park, lon: nextLon }, neighbor];
    store.refresh();
    assert.equal(store.lost, false);
    assert.equal(store.card.lon, nextLon);

    records = [neighbor, counterpart];
    store.refresh();
    assert.equal(
      store.lost,
      true,
      'a namesake with the same ID in a different record field cannot take over',
    );
    assert.equal(store.card.lon, nextLon);

    const restoredLon = park.lon - 0.001;
    records = [counterpart, { ...park, lon: restoredLon }];
    store.refresh();
    assert.equal(store.lost, false);
    assert.equal(store.card.lon, restoredLon);
  });
}

test('card Fly to uses the item selection owner and camera ownership policy', (t) => {
  const events = new EventTarget();
  for (const name of [
    'addEventListener',
    'removeEventListener',
    'dispatchEvent',
  ]) {
    const previous = globalThis[name];
    globalThis[name] = events[name].bind(events);
    t.after(() => {
      if (previous) globalThis[name] = previous;
      else delete globalThis[name];
    });
  }
  const viewer = { scene: { pick: () => null, drillPick: () => [] } };
  const input = fakeInput(viewer);
  const pinia = createPinia();
  const { port } = fakeCameraPort();
  let followed = null;
  let navigationHandoffs = 0;
  const revealContext = t.mock.fn();
  const flown = [];
  const selected = [];
  const camera = {
    ...port,
    get followed() {
      return followed;
    },
    flyToBounds: (...args) => flown.push(args),
  };
  const unbind = bindRenderer(viewer, { camera });
  let enabled = true;
  const manager = {
    isEnabled: () => enabled,
    getAll: () => [],
    layers: new Map([
      [
        'ais-live-vessels',
        {
          module: {
            getAnalystRecords: () => [
              {
                id: 'item-B',
                vesselId: 'item-B',
                name: 'SHIP B',
                lat: 52,
                lon: 1,
              },
            ],
            selectById: (id) => {
              selected.push(['vessel', id]);
              globalThis.dispatchEvent(
                new CustomEvent('gev:entity-selected', {
                  detail: {
                    layerId: 'ais-live-vessels',
                    id: `ais-${id}`,
                    properties: { vesselId: id },
                    latitude: 52,
                    longitude: 1,
                  },
                }),
              );
            },
          },
        },
      ],
      ['rail', { module: { focusTrain: (id) => selected.push(['rail', id]) } }],
      [
        'transit',
        { module: { focusVehicle: (id) => selected.push(['transit', id]) } },
      ],
      [
        'cctv',
        {
          module: {
            focusCamera: (id) => {
              selected.push(['camera', id]);
              return id === 'missing' ? 'no-active-camera' : 'focused';
            },
          },
        },
      ],
    ]),
  };
  const disconnect = installEntityContext({
    viewer,
    getDataManager: () => manager,
    pinia,
    revealContext,
    supersedeDeferredNavigation: () => {
      navigationHandoffs++;
    },
  });
  t.after(() => {
    disconnect();
    input.destroy();
    unbind();
    document.body.classList.remove('cockpit-mode');
  });
  const store = useEntityCardStore(pinia);
  const card = (layerId, id) => ({
    key: `${layerId}:${id}`,
    layerId,
    kind: 'item',
    identity: { layerId, id },
    lat: 52,
    lon: 1,
  });
  for (const layer of ['ais-live-vessels', 'rail', 'transit']) {
    store.card = card(layer, 'item-B');
    store.flyTo();
  }
  assert.equal(
    revealContext.mock.callCount(),
    0,
    'a vessel selection echo does not reveal Context',
  );
  assert.deepEqual(
    selected,
    [
      ['vessel', 'item-B'],
      ['rail', 'item-B'],
      ['transit', 'item-B'],
    ],
    'a Nearby/pinned card selects its own item before a ride is offered',
  );
  assert.equal(flown.length, 2, 'rail already focuses through its layer');
  manager.layers.get('rail').module.focusTrain = () => false;
  store.card = card('rail', 'missing');
  assert.equal(store.flyTo(), true);
  assert.equal(
    flown.length,
    3,
    'a missing train still flies to its saved position',
  );
  assert.equal(
    store.open(
      { layerId: 'ais-live-vessels', id: 'item-B' },
      { fromPin: true },
    ),
    true,
  );
  assert.equal(store.card.identity.id, 'item-B');
  assert.equal(
    store.fromPin,
    true,
    'the layer announcement preserves the pin ownership',
  );
  selected.length = 0;
  flown.length = 0;
  store.card = card('cctv', 'camera-B');
  navigationHandoffs = 0;
  followed = { key: 'flights:aircraft-A' };
  assert.equal(store.flyTo(), 'tracking-holds-view');
  followed = null;
  document.body.classList.add('cockpit-mode');
  assert.equal(store.flyTo(), 'cockpit-active');
  document.body.classList.remove('cockpit-mode');
  assert.deepEqual(
    selected,
    [],
    'refused focus does not call the camera layer',
  );
  assert.deepEqual(flown, [], 'refused focus never reaches the generic flight');
  assert.equal(
    navigationHandoffs,
    0,
    'a refused camera cannot take over navigation',
  );
  assert.equal(store.flyTo(), 'focused');
  assert.equal(
    navigationHandoffs,
    1,
    'a successful camera flight supersedes older work',
  );
  assert.deepEqual(
    selected,
    [['camera', 'camera-B']],
    'the live camera owns free-view focus',
  );
  store.card = card('cctv', 'missing');
  assert.equal(store.flyTo(), true);
  assert.equal(
    flown.length,
    1,
    'a missing camera still flies to its saved position',
  );
  selected.length = 0;
  flown.length = 0;
  enabled = false;
  manager.layers.set('flights', { module: {} });
  useOmnibarStore(pinia).connectRunner(async () => ({ ok: true }));
  store.card = card('flights', 'saved-aircraft');
  assert.equal(store.canFollow(), false, 'a disabled layer cannot follow');
  assert.equal(
    store.canCockpit(),
    false,
    'a disabled layer cannot enter Cockpit',
  );
  assert.equal(store.flyTo(), true, 'its saved position can still be framed');
  flown.length = 0;
  store.card = card('cctv', 'missing');
  store.flyTo();
  assert.equal(
    selected.length,
    0,
    'a pin with its layer off does not wake the camera',
  );
  assert.equal(
    flown.length,
    1,
    'an off-layer pin can still fly to its saved location',
  );
  flown.length = 0;
  navigationHandoffs = 0;
  manager.layers.get('cctv').module.selectCamera = (id) =>
    selected.push(['activate', id]);
  const pinned = {
    layerId: 'cctv',
    id: 'saved-camera',
    label: 'Saved camera',
    lat: 30.271,
    lon: -97.743,
  };
  assert.ok(store.open(pinned, { fromPin: true }));
  assert.equal(store.card.identity.id, pinned.id);
  assert.equal(store.fromPin, true);
  assert.equal(manager.isEnabled('cctv'), false);
  assert.deepEqual(
    selected,
    [],
    'reopening does not start a feed or focus a live camera',
  );
  assert.equal(flown.length, 1, 'reopening frames the saved position');
  const { lat, lon } = toLonLatH(flown[0][0].center);
  assert.ok(Math.abs(lat - pinned.lat) < 1e-6);
  assert.ok(Math.abs(lon - pinned.lon) < 1e-6);
  assert.equal(navigationHandoffs, 1);
});

test('aircraft card entry requires successful tracking and keeps the exact subject', async (t) => {
  const settle = () => setImmediate();
  const viewer = { scene: { pick: () => null, drillPick: () => [] } };
  const input = fakeInput(viewer);
  const pinia = createPinia();
  const disconnect = installEntityContext({
    viewer,
    pinia,
    getDataManager: () => null,
  });
  const store = useEntityCardStore(pinia);
  const asked = [];
  const otherPinia = createPinia();
  const other = t.mock.fn();
  useCockpitStore(pinia).connect({ enter: (subject) => asked.push(subject) });
  useCockpitStore(otherPinia).connect({ enter: other });
  t.after(() => {
    disconnect();
    input.destroy();
  });
  const identity = { layerId: 'flights', id: 'aabbcc' };
  const card = { key: 'flights:aabbcc', layerId: 'flights', identity };
  store.card = card;
  const commands = [];
  let result = { ok: false };
  useOmnibarStore(pinia).connectRunner(async (name) => {
    commands.push(name);
    return result;
  });
  store.cockpit();
  await settle();
  assert.deepEqual(commands, ['track_entity']);
  assert.deepEqual(asked, []);

  let finish;
  result = new Promise((resolve) => {
    finish = resolve;
  });
  store.cockpit();
  store.card = null;
  finish({ ok: true });
  await settle();
  assert.deepEqual(asked, [], 'closing the card cancels entry');

  store.card = card;
  const tracked = Promise.withResolvers();
  result = tracked.promise;
  store.cockpit();
  setActivePinia(otherPinia);
  tracked.resolve({ ok: true });
  await settle();
  assert.deepEqual(asked, [identity], 'entry carries the card identity');
  assert.equal(
    other.mock.callCount(),
    0,
    'entry belongs to the originating app',
  );
});

// These races use the same navigation generation for a Context action and
// an airport pick whose catalog request has started but has not settled.
function airportNavigationFixture(
  t,
  manager,
  camera = fakeCameraPort().port,
  navigationOptions = () => ({}),
) {
  const viewer = { scene: { pick: () => null, drillPick: () => [] } };
  const input = fakeInput(viewer);
  const pinia = createPinia();
  const flown = [];
  camera.flyToBounds = (bounds) => flown.push(bounds);
  const unbind = bindRenderer(viewer, { camera });
  const navigation = new NavigationController({
    viewer,
    tracking: {},
    clearLocation() {},
    cancelShareSelection: () => true,
    isCockpitActive: () => false,
  });
  const getDataManager = () => manager;
  const disconnect = installEntityContext({
    viewer,
    pinia,
    getDataManager,
    supersedeDeferredNavigation: () => navigation._stampNavigation(),
    ...navigationOptions(navigation),
  });
  const stopPlacePick = installPlacePick({
    pinia,
    getDataManager,
    subscribeCameraHandoff: (listener) =>
      navigation.subscribeCameraHandoff(listener),
  });
  const pack = holdAirportPack(t, AUSTIN_AIRPORTS);
  t.after(() => {
    stopPlacePick();
    disconnect();
    navigation.stop();
    input.destroy();
    unbind();
  });
  return { pinia, cards: useEntityCardStore(pinia), flown, ...pack };
}

test('an explicit Context card flight supersedes an airport pick still resolving', async (t) => {
  const manager = {
    isEnabled: () => false,
    getAll: () => [],
    layers: new Map(),
  };
  const { cards, flown, requested, release } = airportNavigationFixture(
    t,
    manager,
  );
  const key = 'places:current';
  cards.card = {
    key,
    layerId: 'places',
    kind: 'place',
    identity: { id: 'current' },
    lat: 48,
    lon: 2,
  };
  announcePlacePick({
    name: 'AUS',
    airport: 'AUS',
    latitude: 30.19,
    longitude: -97.67,
  });
  await requested;

  assert.equal(cards.flyTo(), true);
  release();
  await setImmediate();
  assert.equal(cards.card.key, key);
  assert.equal(flown.length, 1);
});

test('a pending Locate yields to a newer airport pick', (t) =>
  checkLocateOrder(t, true));
test('Locate supersedes an airport pick still resolving', (t) =>
  checkLocateOrder(t, false));

async function checkLocateOrder(t, locateFirst) {
  // One vessel that leaves its feed; its layer finds it on its track.
  let inFeed = true;
  const vessel = { id: 'v1', name: 'ARCADIA', lat: 1, lon: 10 };
  let finishLocate;
  const module = {
    getAnalystRecords: () => (inFeed ? [{ ...vessel }] : []),
    referenceOf: () => null,
    selectById() {},
    locate: async () => {
      if (locateFirst)
        await new Promise((resolve) => {
          finishLocate = resolve;
        });
      return { status: 'found', lat: 5, lon: 50 };
    },
  };
  const manager = {
    isEnabled: (id) => id === 'ais-live-vessels',
    getAll: () => [],
    layers: new Map([['ais-live-vessels', { module }]]),
  };
  t.after(() => {
    cards.clear();
    chrome.detach(owner);
  });
  const { pinia, cards, flown, requested, release } = airportNavigationFixture(
    t,
    manager,
  );
  const chrome = usePanelChromeStore(pinia);
  const owner = chrome.connect({});
  chrome.publish(owner, 'global-context-panel', { collapsed: false });
  assert.equal(cards.select({ layerId: 'ais-live-vessels', id: 'v1' }), true);
  const key = cards.card.key;
  inFeed = false;
  cards.refresh();
  assert.equal(cards.lost, true, 'out of its feed');
  const earlier = locateFirst ? cards.locate() : null;
  announcePlacePick({
    name: 'AUS',
    airport: 'AUS',
    latitude: 30.19,
    longitude: -97.67,
  });
  await requested;

  if (locateFirst) {
    finishLocate();
    await earlier;
    assert.equal(cards.finding, 'idle');
    assert.equal(flown.length, 0);
    release();
    await setImmediate();
    assert.equal(cards.card.identity.place.airport.ident, 'KAUS');
    return;
  }
  await cards.locate();
  assert.equal(flown.length, 1, 'Locate flies to where it was found');
  release();
  await setImmediate();
  assert.equal(
    cards.card.key,
    key,
    'the late airport pick does not take the card',
  );
  assert.equal(flown.length, 1, 'nor the camera');
}

test('Fly to on a train the rail layer focuses also supersedes an airport pick still resolving', async (t) => {
  const { port, emit } = fakeCameraPort();
  let followed = null;
  const camera = {
    ...port,
    get followed() {
      return followed;
    },
    follow(target) {
      followed = target;
      emit('followChanged');
    },
  };
  const order = [];
  const manager = {
    isEnabled: (id) => id === 'rail',
    getAll: () => [],
    layers: new Map([
      [
        'rail',
        {
          module: {
            focusTrain: (id) => {
              order.push(['focus', id]);
              followed = { key: `rail:${id}` };
              emit('followChanged');
              return true;
            },
          },
        },
      ],
    ]),
  };
  const { cards, flown, requested, release } = airportNavigationFixture(
    t,
    manager,
    camera,
    (navigation) => ({
      navigateToSelection: (fly) => {
        order.push(['handoff']);
        navigation._stampNavigation();
        return fly();
      },
      supersedeDeferredNavigation: () => {
        order.push(['supersede']);
        return navigation._stampNavigation();
      },
    }),
  );
  const key = 'rail:train-1';
  cards.card = {
    key,
    layerId: 'rail',
    kind: 'train',
    identity: { layerId: 'rail', id: 'train-1' },
    lat: 48,
    lon: 2,
  };
  announcePlacePick({
    name: 'AUS',
    airport: 'AUS',
    latitude: 30.19,
    longitude: -97.67,
  });
  await requested;

  assert.equal(cards.flyTo(), true);
  release();
  await setImmediate();
  assert.equal(cards.card.key, key, 'the late airport does not take over');
  assert.deepEqual(
    order,
    [['handoff'], ['focus', 'train-1']],
    'older navigation is retired before the train takes the camera, once',
  );
  assert.equal(flown.length, 0, 'the rail layer flies the camera itself');
  assert.equal(cards.following, key);
  cards.clear();
  assert.equal(followed, null, 'closing the card releases its train');
});

test('a pick refused while the dock restores its photo is not reported as taken', (t) => {
  const viewer = { scene: { pick: () => null, drillPick: () => [] } };
  const input = fakeInput(viewer);
  const pinia = createPinia();
  let restoring = true;
  const opened = [];
  const streetLevel = {
    getAnalystRecords: () => [
      { id: 'mapillary:A', name: 'A', lat: 47, lon: 2 },
      { id: 'mapillary:B', name: 'B', lat: 48, lon: 2 },
    ],
    hasDockedPhoto: () => true,
    dockedPhotoRestoring: () => restoring,
    openPhoto: (id) => {
      opened.push(id);
      return new Promise(() => {});
    },
  };
  const disconnect = installEntityContext({
    viewer,
    getDataManager: () => ({
      isEnabled: () => true,
      layers: new Map([['street-level', { module: streetLevel }]]),
      getAll: () => [],
    }),
    pinia,
  });
  t.after(() => {
    disconnect();
    input.destroy();
  });
  const original = { layerId: 'street-level', id: 'mapillary:A' };
  const dock = useDockedStore(pinia);
  dock.dock({
    key: 'street-level:mapillary:A',
    kind: 'street',
    title: 'A',
    identity: original,
  });
  const store = useEntityCardStore(pinia);
  assert.equal(store.select(original, { reveal: false }), true);
  const selected = store.card;
  const generation = store.selectionGeneration();
  const reveals = [];
  const dispatchEvent = globalThis.dispatchEvent;
  globalThis.dispatchEvent = (event) => {
    if (event.type === 'gev:context-show-view')
      reveals.push(event.detail?.inspect);
    return dispatchEvent?.(event);
  };
  t.after(() => {
    if (dispatchEvent) globalThis.dispatchEvent = dispatchEvent;
    else delete globalThis.dispatchEvent;
  });
  const photo = { id: original.id, lat: 47, lon: 2, requestId: 1 };
  document.dispatchEvent(
    new CustomEvent(STREET_LEVEL_PHOTO_REQUEST_EVENT, {
      detail: { requestId: photo.requestId },
    }),
  );
  document.dispatchEvent(
    new CustomEvent(STREET_LEVEL_PHOTO_EVENT, { detail: photo }),
  );
  assert.deepEqual(reveals, [], 'passive confirmation leaves the tab alone');
  document.dispatchEvent(
    new CustomEvent(STREET_LEVEL_PHOTO_EVENT, {
      detail: { ...photo, revealFromOpen: true },
    }),
  );
  assert.deepEqual(
    reveals,
    [true],
    'explicit OPEN reveals the same docked photo',
  );
  assert.equal(store.selectionGeneration(), generation);

  const pick = { layerId: 'street-level', id: 'mapillary:B' };
  assert.equal(store.open(pick, { follow: false }), false);
  assert.deepEqual(opened, [], 'the dock is not asked while it restores');
  assert.equal(dock.view?.key, selected.key);
  assert.equal(store.card, selected, 'the original card stays selected');
  assert.equal(store.selectionGeneration(), generation);

  restoring = false;
  assert.equal(store.open(pick), true);
  assert.deepEqual(opened, ['mapillary:B']);
  assert.equal(store.card, selected, 'the original card stays until commit');
});

// The map's Esc clears the pick only for an Esc nobody else took: not one
// already handled, not one from a control that takes its own Esc, and not
// while a dialog that owns its Esc is open.
test('the map’s Esc leaves the pick to an Esc another owner takes', (t) => {
  const viewer = { scene: { pick: () => null, drillPick: () => [] } };
  const input = fakeInput(viewer);
  const pinia = createPinia();
  const dataManager = {
    isEnabled: () => true,
    layers: new Map(),
    getAll: () => [],
  };
  const disconnect = installEntityContext({
    viewer,
    getDataManager: () => dataManager,
    pinia,
  });
  const extra = [];
  t.after(() => {
    disconnect();
    input.destroy();
    for (const element of extra) element.remove();
  });
  const store = useEntityCardStore(pinia);
  const key = 'street-level:mapillary:A';
  store.card = {
    key,
    layerId: 'street-level',
    identity: { id: 'mapillary:A' },
  };
  const esc = (target, { handled = false } = {}) => {
    const event = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    if (handled) event.preventDefault();
    target.dispatchEvent(event);
    return event;
  };
  const add = (attributes) => {
    const element = document.createElement('div');
    for (const [name, value] of Object.entries(attributes))
      element.setAttribute(name, value);
    extra.push(document.body.appendChild(element));
    return element;
  };

  esc(document.body, { handled: true });
  assert.equal(store.card?.key, key, 'an Esc already handled');
  const owner = add({ 'data-owns-escape': '' });
  esc(owner);
  assert.equal(
    store.card?.key,
    key,
    'an Esc from a control that takes its own',
  );
  const popup = add({ role: 'dialog', 'data-owns-escape': '' });
  esc(document.body);
  assert.equal(
    store.card?.key,
    key,
    'an Esc on the page while such a dialog is open',
  );
  popup.remove();
  owner.remove();
  const scenes = useSceneStore(pinia);
  scenes.publishPanel({ running: true });
  esc(document.body);
  assert.equal(store.card?.key, key, 'a playing scene owns this Escape');
  scenes.publishPanel({ running: false });
  assert.equal(esc(document.body).defaultPrevented, true);
  assert.equal(store.card, null, 'an unowned Esc clears the photo card');
  assert.equal(store.wasDismissed(key), false, 'Esc keeps the photo open');
});

// Nearby opens a cable laid in pieces at its nearest piece: the card stays
// there and the camera flies there, not to the cable's first piece.
test('opening a far piece of a multi-piece cable from Nearby flies to that piece', async (t) => {
  const { readFileSync } = await import('node:fs');
  const { bindFakeDraw } = await import('../testSupport/fakeDrawPort.mjs');
  const { cableAnalystRecords } =
    await import('../layers/submarineCables/records.js');
  const cableJson = JSON.parse(
    readFileSync(
      new URL(
        '../data/local_data/telegeography_submarine_cables/cable-geo.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  const state = {
    _enabled: true,
    _loaded: true,
    _cachedCableJson: cableJson,
    _cachedLandingJson: { features: [] },
  };
  const layerId = 'telegeography-submarine-cables';
  const layer = {
    id: layerId,
    name: 'Submarine Cables',
    enabled: true,
    module: { getAnalystRecords: () => cableAnalystRecords(state) },
  };
  const dataManager = {
    isEnabled: () => true,
    layers: new Map([[layerId, layer]]),
    getAll: () => [layer],
  };
  const flown = [];
  const viewer = { scene: { pick: () => null, drillPick: () => [] } };
  const orbit = new OrbitController(viewer);
  let followed = null;
  const { unbind } = bindFakeDraw(viewer, {
    frame: { on: () => () => {} },
    camera: {
      pose: () => ({ heading: 0, pitch: -1, roll: 0 }),
      on: () => () => {},
      get followed() {
        return followed;
      },
      follow(target) {
        followed = target;
      },
      release() {},
      cancelFlight() {},
      flyToBounds(bounds) {
        assert.equal(orbit.active, false, 'stop orbit before the card flight');
        assert.equal(
          followed,
          null,
          'release the previous follow target before the card flight',
        );
        flown.push(bounds);
      },
    },
  });
  const input = fakeInput(viewer);
  const pinia = createPinia();
  const navigation = new NavigationController({
    viewer,
    tracking: {
      flightsLayer: {},
      militaryFlightsLayer: {},
      satellitesLayer: {},
    },
    isCockpitActive: () => false,
    clearLocation() {},
    interruptCameraMotion() {},
    stopOrbit: () => orbit.stop(),
    cancelShareSelection: () => false,
    getDataManager: () => null,
  });
  const disconnect = installEntityContext({
    navigateToSelection: (fly) =>
      navigation._runExplicitNavigation('target', fly),
    viewer,
    getDataManager: () => dataManager,
    pinia,
  });
  const store = useEntityCardStore(pinia);
  t.after(() => {
    orbit.stop();
    store.clear();
    disconnect();
    input.destroy();
    unbind();
  });
  const topaz = cableAnalystRecords(state).find(
    (record) => record.name === 'Topaz',
  );
  const far = topaz.parts[1];
  assert.notDeepEqual(
    far,
    { lat: topaz.lat, lon: topaz.lon },
    'not its first piece',
  );
  const [list] = store.nearbyLayers(far.lat, far.lon, {
    radiusKm: 25,
    query: 'topaz',
  });
  const lookup = Promise.withResolvers();
  const search = new LocationSearch({
    begin: () => navigation._beginDeferredNavigation('location'),
    isCurrent: (ticket) => ticket === navigation._navigationGeneration,
    beforeFly: () => true,
    search: async (_query, { beforeFly }) => {
      const place = await lookup.promise;
      if (beforeFly()) flown.push(place);
      return place;
    },
  });
  t.after(() => search.destroy());
  orbit.start({ x: 6378137, y: 0, z: 0 });
  const pending = search.run('old destination');
  const ticket = navigation._navigationGeneration;
  assert.ok(store.select(list.items[0].identity));
  assert.equal(
    navigation._navigationGeneration,
    ticket,
    'selection alone leaves the lookup current',
  );
  assert.ok(orbit.active, 'passive selection leaves the active orbit alone');
  assert.ok(store.select(list.items[0].identity, { fly: true }));
  lookup.resolve({ label: 'old destination' });
  await pending;
  assert.equal(store.card.lat, far.lat, 'the card stays at that piece');
  assert.equal(store.card.lon, far.lon);
  assert.equal(flown.length, 1, 'the camera flew once');
  followed = { key: 'flights:other' };
  assert.ok(store.select(list.items[0].identity, { fly: true }));
  assert.equal(flown.length, 2, 'the row also takes over an active follow');
  const landed = toLonLatH(flown[0].center);
  assert.ok(Math.abs(landed.lat - far.lat) < 1e-6, `lat ${landed.lat}`);
  assert.ok(Math.abs(landed.lon - far.lon) < 1e-6, `lon ${landed.lon}`);
});

test('Ask withholds a pinned wildlife location when its source or exact observation is gone', (t) => {
  const nowMs = Date.UTC(2026, 10, 24, 12);
  const [sighting, replacement] = normalizeInatObservations(
    [
      {
        id: 1,
        geojson: { coordinates: [-97.743, 30.271] },
        observed_on: '2026-11-24',
        quality_grade: 'research',
        taxon: {
          name: 'Ardea herodias',
          preferred_common_name: 'Great Blue Heron',
        },
      },
      {
        id: 2,
        geojson: { coordinates: [-96.8, 31.1] },
        observed_on: '2026-11-24',
        quality_grade: 'research',
        taxon: {
          name: 'Ardea herodias',
          preferred_common_name: 'Great Blue Heron',
        },
      },
    ],
    { nowMs },
  );
  const state = {
    enabled: true,
    rows: new Map([[sighting.stableId, sighting]]),
  };
  const { methods } = createWildlifeControls({
    state,
    services: { now: () => nowMs },
    parts: {},
  });
  const id = 'wildlife-sightings';
  const layer = { id, enabled: true, module: methods };
  const manager = {
    layers: new Map([[id, layer]]),
    getAll: () => [layer],
    isEnabled: (layerId) => layerId === id && state.enabled,
  };
  const viewer = { scene: {} };
  const input = fakeInput(viewer);
  const pinia = createPinia();
  const disconnect = installEntityContext({
    viewer,
    pinia,
    getDataManager: () => manager,
  });
  const store = useEntityCardStore(pinia);
  const voice = useVoiceStore(pinia);
  t.after(() => {
    voice.connect(null);
    store.clear();
    disconnect();
    input.destroy();
  });
  let attachment;
  voice.connect({
    emit(event, detail) {
      if (event === 'chat-item') attachment = detail;
    },
  });
  const [group] = store.nearbyLayers(30.271, -97.743, { radiusKm: 25 });
  const pin = group.items[0].identity;
  assert.equal(pin.id, sighting.stableId);
  const saved = { ...pin };
  delete saved.record;
  assert.ok(store.open(saved, { fromPin: true }));
  store.ask();
  assert.ok(attachment.resolveLocation());
  state.enabled = false;
  layer.enabled = false;
  assert.equal(attachment.resolveLocation(), null);
  assert.equal(store.card.key, attachment.key);

  store.clear();
  state.enabled = true;
  layer.enabled = true;
  state.rows = new Map([[replacement.stableId, replacement]]);
  assert.ok(store.open(saved, { fromPin: true }));
  store.ask();
  assert.equal(
    attachment.resolveLocation(),
    null,
    'never send coordinates from the same-named observation',
  );
  assert.equal(store.card.identity.id, sighting.stableId);
  assert.equal(store.locationWithheld, true);

  state.rows.set(sighting.stableId, sighting);
  store.ask();
  assert.deepEqual(attachment.resolveLocation(), { lat: 30.271, lon: -97.743 });
  assert.equal(store.card.identity.id, sighting.stableId);
});

test('Nearby rows give the navigation owner the wildlife cell and locator pin frames', async (t) => {
  const nowMs = Date.UTC(2026, 10, 24, 12);
  const [sighting] = normalizeInatObservations(
    [
      {
        id: 1,
        geojson: { coordinates: [-97.743, 30.271] },
        obscured: true,
        observed_on: '2026-11-24',
        quality_grade: 'research',
      },
    ],
    { nowMs },
  );
  const { methods: wildlife } = createWildlifeControls({
    state: {
      enabled: true,
      rows: new Map([[sighting.stableId, sighting]]),
    },
    services: { now: () => nowMs },
    parts: {},
  });
  const place = INCIDENT_OVERVIEW_PLACES.find(
    ({ id }) => id === 'immediate-collapse-viewpoint',
  );

  for (const { id, module, center, height, radius, range } of [
    {
      id: 'wildlife-sightings',
      module: wildlife,
      center: { lat: 30.3, lon: -97.7 },
      height: 0,
      radius: 11_000,
      range: 60_000,
    },
    {
      id: 'bhote-koshi-locator',
      module: { getAnalystRecords: () => bhoteKoshiPlaceRecords([place]) },
      center: place,
      height: place.heightM,
      radius: 1,
      range: 8_000,
    },
  ]) {
    await t.test(id, (t) => {
      const viewer = { scene: {} };
      const input = fakeInput(viewer);
      const flights = [];
      const unbind = bindRenderer(viewer, {
        camera: {
          pose: () => ({ heading: 0 }),
          on: () => () => {},
          flyToBounds: (bounds, options) => flights.push({ bounds, options }),
        },
      });
      const layer = { id, enabled: true, module };
      const pinia = createPinia();
      const pendingFlights = [];
      const disconnect = installEntityContext({
        viewer,
        pinia,
        getDataManager: () => ({
          layers: new Map([[id, layer]]),
          getAll: () => [layer],
          isEnabled: () => true,
        }),
        navigateToSelection: (fly) => pendingFlights.push(fly),
      });
      const store = useEntityCardStore(pinia);
      t.after(() => {
        store.clear();
        disconnect();
        input.destroy();
        unbind();
      });
      const [list] = store.nearbyLayers(center.lat, center.lon, {
        radiusKm: 25,
      });
      assert.ok(store.select(list.items[0].identity, { fly: true }));
      assert.equal(
        flights.length,
        0,
        'the bridge lets the owner start the flight',
      );
      assert.equal(pendingFlights.length, 1);
      pendingFlights[0]();
      assert.equal(flights.length, 1);

      const { bounds, options } = flights[0];
      assert.equal(bounds.radius, radius);
      assert.equal(options.offset.range, range);
      const { lat, lon, height: atHeight } = toLonLatH(bounds.center);
      assert.ok(Math.abs(lat - center.lat) < 1e-6, `latitude ${lat}`);
      assert.ok(Math.abs(lon - center.lon) < 1e-6, `longitude ${lon}`);
      assert.ok(Math.abs(atHeight - height) < 1e-3, `height ${atHeight}`);
    });
  }
});

test('a quake row frames once and either pick releases its marker when the card leaves', async (t) => {
  const viewer = { scene: {} };
  const input = fakeInput(viewer);
  const flights = [];
  const marker = new Map();
  const { unbind } = bindFakeDraw(viewer, {
    camera: {
      pose: () => ({ heading: 0 }),
      on: () => () => {},
      flyToBounds: () => flights.push('Context'),
    },
  });
  const quake = { stableId: 'ak1', usgsId: 'ak1', lat: 30, lon: -97, mag: 4 };
  const earthquake = createEarthquakesLayer({
    source: {
      getSnapshot: async () => [
        quake,
        { ...quake, stableId: 'ak2', usgsId: 'ak2' },
      ],
    },
    overlayHost: {
      setEntries: (id, entries) => marker.set(id, entries),
      setVisible() {},
      clearSource: (id) => marker.delete(id),
    },
    context,
    focus: { requestWorldFocus: () => flights.push('globe') },
    ripples: {
      show: (target) => marker.set('contours', target.id),
      hide: () => marker.delete('contours'),
    },
  });
  const aircraft = { id: 'abc123', icao24: 'abc123', lat: 30, lon: -97 };
  const layers = [
    {
      id: 'earthquakes',
      name: 'Earthquakes',
      enabled: true,
      module: earthquake,
    },
    {
      id: 'flights',
      name: 'Flights',
      enabled: true,
      module: { getAnalystRecords: () => [aircraft] },
    },
  ];
  const dm = {
    layers: new Map(layers.map((layer) => [layer.id, layer])),
    getAll: () => layers,
    isEnabled: () => true,
  };
  const pinia = createPinia();
  const disconnect = installEntityContext({
    viewer,
    pinia,
    getDataManager: () => dm,
  });
  const store = useEntityCardStore(pinia);
  t.after(() => {
    store.clear();
    disconnect();
    earthquake.destroy();
    input.destroy();
    unbind();
  });

  earthquake.init(viewer);
  earthquake.enable(viewer);
  await earthquake.update(viewer);

  const row = store
    .nearbyLayers(30, -97)
    .find(({ layerId }) => layerId === 'earthquakes').items[0];
  const generation = store.selectionGeneration();
  assert.equal(store.open(row.identity, { fromPin: true }), true);
  assert.equal(store.selectionGeneration(), generation + 1);
  assert.equal(store.fromPin, true);
  assert.deepEqual(flights, ['Context']);
  assert.equal(marker.get('contours'), 'ak1');
  store.clear({ dismiss: true });
  await nextTick();
  assert.equal(marker.has('contours'), false);
  assert.deepEqual(marker.get('earthquake-card'), []);

  // The layer-owned map selection (same path as the magnitude label) can
  // replace a quake with a second one before Context releases the first.
  assert.equal(earthquake.pickById('earthquake:ak1'), true);
  assert.equal(earthquake.pickById('earthquake:ak2'), true);
  await nextTick();
  assert.equal(store.card?.identity.id, 'ak2');
  assert.equal(marker.get('contours'), 'ak2');

  assert.equal(store.select({ layerId: 'flights', id: 'abc123' }), true);
  await nextTick();
  assert.equal(store.card?.identity.id, 'abc123');
  assert.equal(marker.has('contours'), false);
  assert.deepEqual(marker.get('earthquake-card'), []);
});

test('an explicit moving row takes over a pending place flight, is selected in its layer and framed at its range', async (t) => {
  const viewer = { scene: {} };
  const input = fakeInput(viewer);
  const flights = [];
  const unbind = bindRenderer(viewer, {
    camera: {
      pose: () => ({ heading: 0 }),
      on: () => () => {},
      flyToBounds: () => flights.push('aircraft'),
    },
  });
  const aircraft = { id: 'abc123', icao24: 'abc123', lat: 30, lon: -97 };
  const picks = [];
  const layer = {
    id: 'flights',
    enabled: true,
    module: {
      getAnalystRecords: () => [aircraft],
      // The layer selects it, as a click on it does; the pick frames it.
      pickById: (id, options) => {
        picks.push([id, options.origin, options.center]);
        return true;
      },
    },
  };
  const dm = {
    layers: new Map([[layer.id, layer]]),
    getAll: () => [layer],
    isEnabled: () => true,
  };
  const pinia = createPinia();
  let generation = 0;
  const disconnect = installEntityContext({
    viewer,
    pinia,
    getDataManager: () => dm,
    navigateToSelection: (fly) => {
      generation++;
      return fly();
    },
  });
  const store = useEntityCardStore(pinia);
  t.after(() => {
    store.clear();
    disconnect();
    input.destroy();
    unbind();
  });
  const pending = Promise.withResolvers();
  const lookup = new LocationSearch({
    begin: () => ++generation,
    isCurrent: (ticket) => ticket === generation,
    beforeFly: () => true,
    search: async (_query, { beforeFly }) => {
      await pending.promise;
      if (beforeFly()) flights.push('place');
    },
  });
  t.after(() => lookup.destroy());
  const done = lookup.run('previous destination');
  const target = store.nearbyLayers(30, -97, { radiusKm: 25 })[0].items[0]
    .identity;
  assert.ok(store.select(target));
  assert.deepEqual(
    flights,
    [],
    'passive selection does not move the host camera',
  );
  assert.deepEqual(picks, [], 'nor selects it in its layer');
  assert.equal(generation, 1, 'the place lookup still owns its flight');
  assert.ok(store.select(target, { fly: true }));
  pending.resolve();
  await done;
  assert.deepEqual(
    picks,
    [['abc123', 'user', false]],
    'its layer selects it and leaves the camera to the pick',
  );
  assert.deepEqual(flights, ['aircraft'], 'framed at its range');
  const tracked = [];
  useOmnibarStore(pinia).connectRunner((name, args) =>
    tracked.push([name, args.query]),
  );
  assert.ok(store.select(target, { fly: true }));
  assert.deepEqual(tracked, [], 'a pick never follows, runner or not');
  assert.deepEqual(picks.length, 2);
  assert.deepEqual(flights, ['aircraft', 'aircraft']);
});

test('a vessel card offers Follow, which tracks it as for an aircraft, and says Following while the camera follows it', async (t) => {
  const viewer = { scene: {} };
  const input = fakeInput(viewer);
  let followed = null;
  const listeners = new Set();
  const unbind = bindRenderer(viewer, {
    camera: {
      pose: () => ({ heading: 0 }),
      on: (name, cb) => {
        if (name !== 'followChanged') return () => {};
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
      get followed() {
        return followed;
      },
      follow(target) {
        followed = target;
        for (const cb of [...listeners]) cb();
      },
      flyToBounds: () => {},
    },
  });
  const vessel = {
    id: 'v1',
    layerId: 'ais-live-vessels',
    label: 'NORTHERN STAR',
    latitude: 30,
    longitude: -97,
    properties: { vesselId: 'v1' },
  };
  const layer = {
    id: 'ais-live-vessels',
    enabled: true,
    module: { getAnalystRecords: () => [vessel] },
  };
  const dm = {
    layers: new Map([[layer.id, layer]]),
    getAll: () => [layer],
    isEnabled: () => true,
  };
  const pinia = createPinia();
  const disconnect = installEntityContext({
    viewer,
    pinia,
    getDataManager: () => dm,
  });
  const store = useEntityCardStore(pinia);
  t.after(() => {
    store.clear();
    disconnect();
    input.destroy();
    unbind();
  });
  const tracked = [];
  useOmnibarStore(pinia).connectRunner((name, args) =>
    tracked.push([name, args.query, args.layerId]),
  );
  assert.ok(
    store.select({
      layerId: 'ais-live-vessels',
      id: 'v1',
      label: 'NORTHERN STAR',
      lat: 30,
      lon: -97,
    }),
  );
  assert.equal(store.canFollow(), true, 'Follow is offered for a ship');
  store.follow();
  await setImmediate();
  assert.deepEqual(tracked, [['track_entity', 'v1', 'ais-live-vessels']]);
  assert.equal(Boolean(store.isFollowing()), false);
  // The layer follows it with the key naming it.
  findCamera(viewer).follow({
    key: 'ais-live-vessels:v1',
    position: () => null,
  });
  await setImmediate();
  assert.equal(Boolean(store.isFollowing()), true, 'Following');
});

test('a row its layer cannot select now is still framed', (t) => {
  const viewer = { scene: {} };
  const input = fakeInput(viewer);
  const flights = [];
  const unbind = bindRenderer(viewer, {
    camera: {
      pose: () => ({ heading: 0 }),
      on: () => () => {},
      flyToBounds: (sphere, options) => flights.push(options.offset.range),
    },
  });
  const aircraft = { id: 'abc123', icao24: 'abc123', lat: 30, lon: -97 };
  let answer = () => false;
  const layer = {
    id: 'flights',
    enabled: true,
    module: {
      getAnalystRecords: () => [aircraft],
      pickById: () => answer(),
    },
  };
  const dm = {
    layers: new Map([[layer.id, layer]]),
    getAll: () => [layer],
    isEnabled: () => true,
  };
  const pinia = createPinia();
  const disconnect = installEntityContext({
    viewer,
    pinia,
    getDataManager: () => dm,
  });
  const store = useEntityCardStore(pinia);
  t.after(() => {
    store.clear();
    disconnect();
    input.destroy();
    unbind();
  });
  const target = store.nearbyLayers(30, -97, { radiusKm: 25 })[0].items[0]
    .identity;
  // Gone from the layer's own feed though Context still has its card.
  assert.ok(store.select(target, { fly: true }));
  assert.equal(flights.length, 1, 'refused: framed all the same');
  answer = () => {
    throw new Error('layer going away');
  };
  assert.ok(store.select(target, { fly: true }));
  assert.equal(flights.length, 2, 'thrown: framed all the same');
});

test('closing the card deselects its item in its layer, followed or only selected', (t) => {
  _resetSelectionForTest();
  const viewer = { scene: {} };
  const input = fakeInput(viewer);
  let followed = null;
  const unbind = bindRenderer(viewer, {
    camera: {
      pose: () => ({ heading: 0 }),
      on: () => () => {},
      get followed() {
        return followed;
      },
      follow: (target) => (followed = target),
    },
  });
  const aircraft = { id: 'abc123', icao24: 'abc123', lat: 30, lon: -97 };
  const stops = [];
  const layer = {
    id: 'flights',
    enabled: true,
    module: {
      getAnalystRecords: () => [aircraft],
      stopTracking: (options) => {
        stops.push(options.origin);
        // A person's letting go: a layer that knows the globe view uses it.
        assert.equal(options.globeView, true);
        releaseSelection('flights', 'abc123');
      },
    },
  };
  const dm = {
    layers: new Map([[layer.id, layer]]),
    getAll: () => [layer],
    isEnabled: () => true,
  };
  const pinia = createPinia();
  const disconnect = installEntityContext({
    viewer,
    pinia,
    getDataManager: () => dm,
  });
  const store = useEntityCardStore(pinia);
  t.after(() => {
    disconnect();
    input.destroy();
    unbind();
    _resetSelectionForTest();
  });
  const target = store.nearbyLayers(30, -97, { radiusKm: 25 })[0].items[0]
    .identity;
  // A click selected it in its layer: the camera does not follow it.
  claimSelection('flights', 'abc123');
  assert.ok(store.select(target));
  store.clear();
  assert.deepEqual(stops, ['user'], 'the layer lets it go');
  // A card whose item another layer's selection replaced lets nothing go.
  claimSelection('flights', 'abc123');
  assert.ok(store.select(target));
  claimSelection('ais-live-vessels', 'v1');
  store.clear();
  assert.deepEqual(stops, ['user']);
});

for (const layerId of ['transit', 'rail', 'local-adsb']) {
  test(`closing a ${layerId} card deselects its item, never another of the layer's`, (t) => {
    _resetSelectionForTest();
    const viewer = { scene: {} };
    const input = fakeInput(viewer);
    const unbind = bindRenderer(viewer, {
      camera: {
        pose: () => ({ heading: 0 }),
        on: () => () => {},
        flyToBounds() {},
      },
    });
    // Two items; the layer's selection names them by its own keys.
    const items = [
      { id: 'LABEL 7', lat: 30, lon: -97 },
      { id: 'LABEL 9', lat: 30.001, lon: -97 },
    ];
    const keys = { 'LABEL 7': 'feed:vehicle-7', 'LABEL 9': 'feed:vehicle-9' };
    const cleared = [];
    const picked = [];
    const layer = {
      id: layerId,
      enabled: true,
      module: {
        getAnalystRecords: () => items,
        pickById: (id, options) => {
          picked.push([id, options.center]);
          claimSelection(layerId, keys[id]);
          return true;
        },
        isSelected: (id) => currentSelection()?.id === keys[id],
        clearSelection: () => {
          cleared.push(currentSelection()?.id);
          releaseSelection(layerId);
        },
      },
    };
    const dm = {
      layers: new Map([[layer.id, layer]]),
      getAll: () => [layer],
      isEnabled: () => true,
    };
    const pinia = createPinia();
    const disconnect = installEntityContext({
      viewer,
      pinia,
      getDataManager: () => dm,
    });
    const store = useEntityCardStore(pinia);
    t.after(() => {
      disconnect();
      input.destroy();
      unbind();
      _resetSelectionForTest();
    });
    const cardOf = (id) =>
      store
        .nearbyLayers(30, -97, { radiusKm: 25 })[0]
        ?.items.find((item) => item.identity.id === id)?.identity;
    // A clicked on the map; B's card opened without selecting it.
    claimSelection(layerId, 'feed:vehicle-7');
    assert.ok(store.select(cardOf('LABEL 9')));
    store.clear();
    assert.deepEqual(cleared, [], 'A stays selected');
    // B picked from a row: its layer selects it; its card's close lets it go.
    assert.ok(store.select(cardOf('LABEL 9'), { fly: true }));
    assert.deepEqual(picked, [['LABEL 9', false]]);
    store.clear();
    assert.deepEqual(cleared, ['feed:vehicle-9']);
  });
}

test('a quiet spell between thresholded changes keeps an active camera move unsettled', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const viewer = { scene: {} };
  const input = fakeInput(viewer);
  const events = new Map();
  const unbind = bindRenderer(viewer, {
    camera: {
      pose: () => ({ lat: 47, lon: -122, height: 40_000 }),
      viewRectangle: () => null,
      on(event, listener) {
        events.set(event, listener);
        return () => events.delete(event);
      },
    },
  });
  const pinia = createPinia();
  const store = useEntityCardStore(pinia);
  const chrome = usePanelChromeStore(pinia);
  const owner = chrome.connect({});
  chrome.publish(owner, 'global-context-panel', { collapsed: false });
  const settled = [];
  store.setView = (view, options) => {
    assert.equal(view.groundFootprint, false);
    settled.push(options.settled);
  };
  const disconnect = installEntityContext({
    viewer,
    pinia,
    getDataManager: () => null,
  });
  t.after(() => {
    disconnect();
    chrome.detach(owner);
    unbind();
    input.destroy();
  });
  t.mock.timers.tick(0);
  assert.deepEqual(settled, [true]);
  settled.length = 0;
  events.get('moveStart')?.();
  events.get('changed')();
  t.mock.timers.tick(1300);
  assert.ok(settled.length > 0);
  assert.ok(settled.every((value) => value === false));
  events.get('moveEnd')();
  assert.equal(settled.at(-1), true);

  events.get('changed')();
  t.mock.timers.tick(1300);
  assert.equal(
    settled.at(-1),
    true,
    'a jump without moveStart retains the quiet fallback',
  );
});

test('the view snapshot carries the screen corners when all four land', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const viewer = { scene: {} };
  const input = fakeInput(viewer);
  const events = new Map();
  const unbind = bindRenderer(viewer, {
    camera: {
      pose: () => ({ lat: 0, lon: 0, height: 40_000 }),
      viewRectangle: () => ({ west: -1, east: 1, south: -1, north: 1 }),
      on(event, listener) {
        events.set(event, listener);
        return () => events.delete(event);
      },
    },
  });
  const pinia = createPinia();
  const store = useEntityCardStore(pinia);
  const chrome = usePanelChromeStore(pinia);
  const owner = chrome.connect({});
  chrome.publish(owner, 'global-context-panel', { collapsed: false });
  let skyUntil = 0;
  const disconnect = installEntityContext({
    viewer,
    pinia,
    getDataManager: () => null,
    pickWorld: (_, x, y) =>
      x === 1 && y < skyUntil ? null : { lat: 1 - 2 * y, lon: 2 * x - 1 },
  });
  t.after(() => {
    disconnect();
    chrome.detach(owner);
    unbind();
    input.destroy();
  });
  t.mock.timers.tick(0);
  assert.deepEqual(store.view.corners, [
    { lat: 1, lon: -1 },
    { lat: -1, lon: -1 },
    { lat: -1, lon: 1 },
    { lat: 1, lon: 1 },
  ]);
  skyUntil = 0.25;
  events.get('moveEnd')();
  assert.deepEqual(store.view.corners, [
    { lat: 1, lon: -1 },
    { lat: -1, lon: -1 },
    { lat: -1, lon: 1 },
    { lat: 0.5, lon: 1, edge: true },
  ]);
  skyUntil = 1;
  events.get('moveEnd')();
  assert.equal(store.view.corners, null);
});

test('Lists and Pinned leave footprint and terrain reads to Inspect, while Omnibar still reads its centre', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pinia = createPinia();
  const tabs = useContextStore(pinia);
  const store = useEntityCardStore(pinia);
  const chrome = usePanelChromeStore(pinia);
  const owner = chrome.connect({});
  chrome.publish(owner, 'global-context-panel', { collapsed: false });
  const viewer = { scene: {} };
  const input = fakeInput(viewer);
  const { port, emit } = fakeCameraPort();
  let lon = 0;
  const picks = [];
  const sampleHeightNow = t.mock.fn(() => 250);
  let progress;
  const unbind = bindRenderer(viewer, {
    camera: port,
    query: { sampleHeightNow },
    globe: {
      on(_, cb) {
        progress = cb;
        return () => {};
      },
    },
  });
  const disconnect = installEntityContext({
    viewer,
    pinia,
    getDataManager: () => null,
    pickWorld: (_, x, y) => {
      picks.push([x, y]);
      return { lon: lon + x - 0.5, lat: y - 0.5 };
    },
  });
  const search = document.body.appendChild(document.createElement('input'));
  search.id = 'gev-omnibar-input';
  t.after(() => {
    disconnect();
    search.remove();
    chrome.detach(owner);
    unbind();
    input.destroy();
  });
  t.mock.timers.tick(0);
  assert.equal(picks.length, 5);
  assert.equal(store.view.groundM, 250);
  picks.length = 0;
  for (const tab of ['lists', 'pinned']) {
    tabs.setInspectorTab(tab);
    await nextTick();
    lon++;
    emit('moveEnd');
    progress({ terrainPending: 1 });
    progress({ terrainPending: 0 });
    assert.deepEqual(picks, []);
    assert.equal(sampleHeightNow.mock.callCount(), 1);
  }
  search.focus();
  assert.deepEqual(picks, [[0.5, 0.5]]);
  assert.equal(store.view.center.lon, 2);
  assert.equal(sampleHeightNow.mock.callCount(), 1);
  search.blur();
  picks.length = 0;
  lon++;
  tabs.setInspectorTab('inspect');
  await nextTick();
  assert.equal(picks.length, 5);
  assert.equal(store.view.center.lon, 3);
  assert.equal(store.view.corners.length, 4);
  assert.equal(store.view.groundM, 250);
});

test('a stationary Inspector resamples loaded terrain and distinguishes sea level from the ellipsoid', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const viewer = { scene: {} };
  const input = fakeInput(viewer);
  const pinia = createPinia();
  const chrome = usePanelChromeStore(pinia);
  const owner = chrome.connect({});
  chrome.publish(owner, 'global-context-panel', { collapsed: false });
  const store = useEntityCardStore(pinia);
  const port = fakeCameraPort().port;
  let ground = 0;
  let source = 'ellipsoid';
  let progress;
  const unbind = bindRenderer(viewer, {
    camera: port,
    query: {
      sampleHeightNow: () => ground,
      sampleHeight: async () => [{ height: ground, source }],
    },
    globe: {
      on(event, listener) {
        assert.equal(event, 'progress');
        progress = listener;
        return () => {
          progress = null;
        };
      },
    },
  });
  const disconnect = installEntityContext({
    viewer,
    pinia,
    getDataManager: () => null,
    pickWorld: () => ({ lat: 48, lon: 2 }),
  });
  t.after(() => {
    disconnect();
    chrome.detach(owner);
    input.destroy();
    unbind();
  });
  t.mock.timers.tick(0);
  await setImmediate();
  assert.equal(
    store.view.groundM,
    null,
    'ellipsoid fallback has no measured elevation',
  );

  async function settleTerrain(height, kind) {
    progress?.({ terrainPending: 2 });
    ground = height;
    source = kind;
    progress?.({ terrainPending: 0 });
    await setImmediate();
  }
  await settleTerrain(1250, 'terrain');
  assert.equal(store.view.groundM, 1250);
  await settleTerrain(0, 'ellipsoid');
  assert.equal(store.view.groundM, null);
  await settleTerrain(0, 'terrain');
  assert.equal(store.view.groundM, 0);
  disconnect();
  assert.equal(progress, null, 'disconnect releases the globe listener');
});

test('on a tilted globe view, what is in view is bounded by the camera, not the middle of the screen', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const viewer = { scene: {} };
  const input = fakeInput(viewer);
  // The camera is 5,000 km above (0, 0); the middle of the screen falls on
  // (0, 25).
  const unbind = bindRenderer(viewer, {
    camera: {
      pose: () => ({ lat: 0, lon: 0, height: 5_000_000 }),
      viewRectangle: () => null,
      on: () => () => {},
    },
  });
  const pinia = createPinia();
  const store = useEntityCardStore(pinia);
  const chrome = usePanelChromeStore(pinia);
  const owner = chrome.connect({});
  chrome.publish(owner, 'global-context-panel', { collapsed: false });
  const layer = {
    id: 'flights',
    name: 'Flights',
    enabled: true,
    stats: { lastUpdate: 1 },
    module: {
      getAnalystRecords: () => [
        {
          id: 'visible',
          icao24: 'visible',
          callsign: 'VISIBLE',
          lat: 0,
          lon: 25,
        },
        {
          id: 'occulted',
          icao24: 'occulted',
          callsign: 'OCCULTED',
          lat: 0,
          lon: 70,
        },
      ],
    },
  };
  const manager = {
    layers: new Map([[layer.id, layer]]),
    getAll: () => [layer],
    isEnabled: () => true,
  };
  const disconnect = installEntityContext({
    viewer,
    pinia,
    getDataManager: () => manager,
    pickWorld: () => ({ lat: 0, lon: 25 }),
  });
  t.after(() => {
    disconnect();
    chrome.detach(owner);
    unbind();
    input.destroy();
  });

  t.mock.timers.tick(0);
  assert.deepEqual(store.view.center, { lat: 0, lon: 25 });
  const horizonDegrees = (Math.acos(6371 / (6371 + 5000)) * 180) / Math.PI;
  assert.ok(horizonDegrees > 55 && horizonDegrees < 57);
  // The camera sees the middle of the screen. A point 70 degrees from the
  // ground under it is behind the Earth at every heading and tilt.
  assert.deepEqual(
    store.inView()[0].items.map((item) => item.identity.id),
    ['visible'],
  );
  const [inspector] = store.inView({
    viewport: true,
    breakdown: true,
    includeEmpty: true,
  });
  assert.deepEqual(
    inspector.items.map((item) => item.identity.id),
    ['visible'],
    'a centre hit with no rectangle still uses the visible horizon',
  );
});

test('an explicit camera step shows the card in Context', async (t) => {
  let active = 'cam-a';
  const flights = [];
  const viewer = { scene: { pick: () => null, drillPick: () => [] } };
  const input = fakeInput(viewer);
  const cameras = [
    { id: 'cam-a', name: 'A', lat: 30.2, lon: -97.7 },
    { id: 'cam-b', name: 'B', lat: 30.3, lon: -97.7 },
  ];
  const cctv = {
    id: 'cctv',
    name: 'Cameras',
    enabled: true,
    module: {
      getUIState: () => ({ activeCameraId: active, cameras }),
      focusNearest: () => active,
      selectCamera: (id) => id === active,
      focusCamera(id) {
        flights.push(id);
        return 'focused';
      },
      getAnalystRecords: () => cameras,
      findByQuery: (id) => cameras.find((camera) => camera.id === id),
    },
  };
  const pinia = createPinia();
  let reveals = 0;
  const dataManager = {
    isEnabled: (id) => id === 'cctv',
    layers: new Map([['cctv', cctv]]),
    getAll: () => [cctv],
  };
  const disconnect = installEntityContext({
    viewer,
    getDataManager: () => dataManager,
    pinia,
    revealContext: () => reveals++,
  });
  t.after(() => {
    disconnect();
    input.destroy();
    document.body.removeAttribute('data-mobile-sheet');
  });
  const store = useEntityCardStore(pinia);
  assert.equal(
    store.card,
    null,
    'the opening camera alone leaves Context closed',
  );
  document.body.setAttribute('data-mobile-sheet', 'layers');
  await controlCctv(dataManager, { action: 'nearest' });
  assert.equal(store.card?.key, 'cctv:cam-a', 'the card opens');
  assert.equal(reveals, 1, 'the Context sheet opens');
  document.body.removeAttribute('data-mobile-sheet');
  active = 'cam-b';
  await controlCctv(dataManager, { action: 'select', cameraQuery: 'cam-b' });
  assert.deepEqual(flights, ['cam-a', 'cam-b']);
  assert.equal(store.card?.key, 'cctv:cam-b');
  assert.equal(reveals, 2, 'the second pick also reveals Context');
  let viewEvents = 0;
  const showView = () => viewEvents++;
  globalThis.addEventListener('gev:context-show-view', showView);
  t.after(() =>
    globalThis.removeEventListener('gev:context-show-view', showView),
  );
  const generation = store.selectionGeneration();
  await controlCctv(dataManager, { action: 'select', cameraQuery: 'cam-b' });
  assert.equal(reveals, 3, 'an explicit re-pick reveals the existing card');
  assert.equal(store.selectionGeneration(), generation);
  assert.deepEqual(flights, ['cam-a', 'cam-b', 'cam-b']);
  assert.equal(viewEvents, 1, 'the re-pick brings the view tab forward');
});

// A camera opened from a list makes it the active camera; the layer's notice
// of that pick comes back to the bridge, which finds its card already
// showing and leaves it: the card is selected once, not twice.
test('a camera opened from a Context row keeps Context in front and is selected once', async (t) => {
  const rail = document.body.appendChild(document.createElement('div'));
  rail.className = 'ui-rail--right';
  const button = rail.appendChild(document.createElement('button'));
  button.className = 'ui-rail__item';
  button.dataset.railItem = 'global-context-panel';
  button.setAttribute('aria-pressed', 'true');
  button.onclick = () => button.setAttribute('aria-pressed', 'true');
  t.after(() => rail.remove());
  const viewer = { scene: { pick: () => null, drillPick: () => [] } };
  const input = fakeInput(viewer);
  const cameras = [
    { id: 'cam-a', name: 'A', lat: 30.2, lon: -97.7 },
    { id: 'cam-b', name: 'B', lat: 30.3, lon: -97.7 },
  ];
  let activeCameraId = 'cam-b';
  const selections = [];
  const cctv = {
    id: 'cctv',
    name: 'Cameras',
    enabled: true,
    module: {
      getUIState: () => ({ activeCameraId, cameras }),
      getAnalystRecords: () => cameras,
      findByQuery: (id) => cameras.find((camera) => camera.id === id),
      // The layer announces a pick at once, as its notify does.
      selectCamera(cameraId) {
        selections.push(cameraId);
        activeCameraId = cameraId;
        button.setAttribute('aria-pressed', 'false');
        document.dispatchEvent(
          new CustomEvent(CCTV_SELECTED_EVENT, { detail: { cameraId } }),
        );
      },
    },
  };
  const pinia = createPinia();
  const dataManager = {
    isEnabled: (id) => id === 'cctv',
    layers: new Map([['cctv', cctv]]),
    getAll: () => [cctv],
  };
  const disconnect = installEntityContext({
    viewer,
    getDataManager: () => dataManager,
    pinia,
  });
  t.after(() => {
    disconnect();
    input.destroy();
  });
  const store = useEntityCardStore(pinia);
  // The bridge's own selects: none, since the card is already showing.
  const select = store.select;
  let bridgeSelects = 0;
  store.select = (...args) => {
    bridgeSelects++;
    return select(...args);
  };
  assert.equal(store.open({ layerId: 'cctv', id: 'cam-a' }), true);
  assert.deepEqual(selections, ['cam-a']);
  assert.equal(store.card?.key, 'cctv:cam-a');
  assert.equal(bridgeSelects, 0, 'selected once, by open');
  assert.equal(button.getAttribute('aria-pressed'), 'true');
});

const countAnswer = (count) => ({
  counts: [{ layerId: 'flights', count, at: 10 }],
});
const reading = {
  temperatureC: 16,
  timeZone: 'America/Los_Angeles',
  utcOffsetSeconds: -28_800,
};

function inspectorFixture(
  t,
  { controlWeatherCompletion = false, onWeatherAbort } = {},
) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pinia = createPinia();
  const store = useEntityCardStore(pinia);
  const countStore = useLayerCountsStore(pinia);
  const chrome = usePanelChromeStore(pinia);
  const missions = useSpaceMissionsStore(pinia);
  const panel = chrome.connect({});
  chrome.publish(panel, 'global-context-panel', { collapsed: false });
  const viewer = { scene: {} };
  const input = fakeInput(viewer);
  const pose = { lat: 47, lon: -122, height: 40_000 };
  const cameraEvents = new Map();
  const unbind = bindRenderer(viewer, {
    camera: {
      pose: () => pose,
      viewRectangle: () => null,
      on(event, listener) {
        cameraEvents.set(event, listener);
        return () => cameraEvents.delete(event);
      },
    },
  });
  const weatherRequests = [];
  const countRequests = [];
  const countUpdates = [];
  const visibilityListeners = new Set();
  const weatherTimers = new Set();
  let elapsed = 0;
  const start = Date.now();
  t.mock.method(Date, 'now', () => start + elapsed);
  let samples = 0;
  function port(requests, fields) {
    const { promise, resolve } = Promise.withResolvers();
    requests.push({ ...fields, resolve });
    return promise;
  }
  const readWeather = (lat, lon, { signal }) => {
    if (onWeatherAbort && weatherRequests.length > 0)
      signal.addEventListener('abort', onWeatherAbort, { once: true });
    return port(weatherRequests, { lat, lon, signal });
  };
  // This fixture can resolve the exact promise awaited by the owner, before
  // the bridge's queued update. Other tests use the real store action.
  if (controlWeatherCompletion) store.readWeather = readWeather;
  function managerFor(rows) {
    const listeners = new Set();
    return {
      rows,
      getAll() {
        samples++;
        return this.rows;
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      revise(nextRows) {
        this.rows = nextRows;
        for (const notify of listeners) notify({ type: 'fixture' });
      },
    };
  }
  let manager = managerFor([]);
  let disconnect;
  function connect() {
    const counts = createLayerCounts({
      getCounts: ({ signal }) => port(countRequests, { signal }),
      readState: () => countStore.state,
      writeState: countStore.publish,
      readShown: () => store.inspector.shown,
      now: () => elapsed,
    });
    disconnect = installEntityContext({
      viewer,
      pinia,
      getDataManager: () => manager,
      spotWeather: readWeather,
      inspector: {
        counts: {
          ...counts,
          update(snapshot) {
            countUpdates.push(snapshot);
            return counts.update(snapshot);
          },
        },
        weatherClock: {
          nowMonotonic: () => elapsed,
          onPageVisibility(listener) {
            visibilityListeners.add(listener);
            return () => visibilityListeners.delete(listener);
          },
          setTimeout(callback, ms) {
            const timer = setTimeout(() => {
              weatherTimers.delete(timer);
              callback();
            }, ms);
            weatherTimers.add(timer);
            return timer;
          },
          clearTimeout(timer) {
            weatherTimers.delete(timer);
            clearTimeout(timer);
          },
        },
      },
    });
    return disconnect;
  }
  async function advance(ms) {
    elapsed += ms;
    t.mock.timers.tick(ms);
    await nextTick();
  }
  connect();
  t.after(() => {
    disconnect();
    chrome.detach(panel);
    unbind();
    input.destroy();
  });

  return {
    store,
    countStore,
    missions,
    pose,
    cameraEvents,
    weatherRequests,
    countRequests,
    countUpdates,
    visibilityListeners,
    weatherTimers,
    connect,
    get disconnect() {
      return disconnect;
    },
    setRows: (rows) => manager.revise(rows),
    replaceManager: (rows) => {
      manager = rows && managerFor(rows);
    },
    show: (shown) => store.setViewContextShown(shown, 1),
    get samples() {
      return samples;
    },
    advance,
    async openAndRead() {
      store.setViewContextShown(true, 1);
      await nextTick();
      await advance(0);
      await advance(400);
    },
  };
}

const enabled = (id, stats) => ({ id, enabled: true, stats });

test('a replacement bridge admits its initial count request after the mounted Inspector settles', async (t) => {
  const f = inspectorFixture(t);
  f.disconnect();
  f.show(true);
  const closeReplacement = f.connect();
  assert.equal(f.countRequests.length, 0, 'nothing asks during setup');
  f.show(false);
  await nextTick();
  assert.equal(f.countRequests.length, 0, 'a same-turn collapse wins');

  closeReplacement();
  f.show(true);
  f.connect();
  assert.equal(f.countRequests.length, 0);
  await nextTick();
  assert.equal(f.countRequests.length, 1, 'the unchanged shown view asks once');
});

test('the first Inspector read includes a manager attached during bridge setup', async (t) => {
  const f = inspectorFixture(t);
  f.disconnect();
  f.show(true);
  f.replaceManager(null);
  f.connect();
  f.replaceManager([enabled('flights', { count: 17, lastUpdate: 2 })]);
  await setImmediate();
  assert.equal(f.store.inspectorRows[0].id, 'flights');
  assert.equal(f.countRequests.length, 0);
  assert.equal(
    f.samples,
    1,
    'subscribing does not sample the same entry twice',
  );
  assert.deepEqual(f.countStore.state.counts, {});
  f.setRows(f.store.inspectorRows);
  await nextTick();
  assert.equal(f.store.inspectorRows[0].stats.count, 17);
  assert.deepEqual(f.countStore.state.counts, {});
});

test('Missions leaves the last known Satellite count alone while it owns the row', async (t) => {
  const f = inspectorFixture(t);
  await f.openAndRead();
  const [counts] = f.countRequests;
  counts.resolve({ counts: [{ layerId: 'satellites', count: 100, at: 1 }] });
  await setImmediate();
  assert.equal(f.countStore.state.counts.satellites.count, 100);

  f.missions.setEnabled(true);
  f.setRows([
    enabled('satellites', { count: 25, lastUpdate: 2, scope: 'worldwide' }),
  ]);
  await nextTick();
  assert.equal(f.countStore.state.counts.satellites.count, 100);

  f.missions.setEnabled(false);
  await nextTick();
  assert.equal(f.countStore.state.counts.satellites.count, 100);
  assert.equal(f.countRequests.length, 1);
});

test('counts admit only the settled Inspector state, and Directions does not fill it', async (t) => {
  const f = inspectorFixture(t);
  await nextTick();
  f.show(true);
  f.setRows([enabled('flights')]);
  await nextTick();
  assert.equal(
    f.countRequests.length,
    0,
    'the layer turning on wins over reopening',
  );
  assert.equal(
    f.samples,
    1,
    'rendering and count admission share the metadata sample',
  );

  f.setRows([]);
  f.show(false);
  await nextTick();
  assert.equal(
    f.countRequests.length,
    0,
    'hiding wins over the last layer turning off',
  );
  assert.equal(f.samples, 1, 'the hidden revision does not sample the manager');

  f.setRows([enabled('directions')]);
  f.show(true);
  await nextTick();
  assert.equal(f.countRequests.length, 1);
});

test('count admission waits for matching metadata when an earlier post callback reveals the Inspector', async (t) => {
  const f = inspectorFixture(t);
  await nextTick();
  const reveal = ref(false);
  t.after(watch(reveal, () => f.show(true), { flush: 'post' }));
  reveal.value = true;
  f.setRows([enabled('satellites')]);
  await nextTick();
  assert.equal(f.store.inspectorRows[0].id, 'satellites');
  assert.equal(
    f.countRequests.length,
    0,
    'hidden metadata cannot cause an empty count ask',
  );
});

test('count admission uses a manager replaced after the Inspector reads its rows', async (t) => {
  const f = inspectorFixture(t);
  f.disconnect();
  const replace = ref(false);
  t.after(
    watch(replace, () => f.replaceManager([enabled('satellites')]), {
      flush: 'post',
    }),
  );
  f.connect();
  await nextTick();
  t.after(
    watch(
      () => f.store.inspectorRows,
      () => {},
    ),
  );

  replace.value = true;
  f.show(true);
  await setImmediate();

  assert.equal(f.countRequests.length, 0);
  assert.equal(f.store.inspectorRows[0].id, 'satellites');
});

test('count admission follows the final visibility when post callbacks hide and reopen the Inspector', async (t) => {
  const f = inspectorFixture(t);
  await nextTick();
  const hide = ref(false);
  const reopen = ref(false);
  t.after(watch(hide, () => f.show(false), { flush: 'post' }));
  t.after(watch(reopen, () => f.show(true), { flush: 'post' }));
  hide.value = true;
  f.show(true);
  reopen.value = true;
  await nextTick();
  assert.equal(f.samples, 1, 'the net-visible state needs one metadata sample');
  assert.equal(
    f.countRequests.length,
    1,
    'the eligible sample needs no next pulse',
  );
});

test('a reopened Inspector uses the current globe rows when deciding whether to request counts', async (t) => {
  const f = inspectorFixture(t);
  await nextTick();
  const hide = ref(false);
  const reopen = ref(false);
  t.after(watch(hide, () => f.show(false), { flush: 'post' }));
  t.after(
    watch(
      reopen,
      () => {
        f.replaceManager([enabled('satellites')]);
        f.store.setView({ center: { lat: 0, lon: 0 }, heightM: 20_000_000 });
        f.show(true);
      },
      { flush: 'post' },
    ),
  );
  hide.value = true;
  f.show(true);
  reopen.value = true;
  await nextTick();
  assert.equal(f.store.inspectorRows[0].id, 'satellites');
  assert.equal(
    f.countRequests.length,
    1,
    'the enabled satellite layer can use its globe total',
  );
});

test('Radio and the Missions roster prevent a counts request; a pulse finds a silent manager replacement', async (t) => {
  const f = inspectorFixture(t);
  f.setRows([enabled('radio')]);
  f.show(true);
  await nextTick();
  assert.equal(f.countRequests.length, 0, 'Radio alone fills the Inspector');

  f.setRows([]);
  f.missions.setEnabled(true);
  await nextTick();
  assert.equal(
    f.countRequests.length,
    0,
    'the roster alone fills the Inspector',
  );

  f.setRows([enabled('flights')]);
  f.missions.setEnabled(false);
  await nextTick();
  f.replaceManager([]);
  await nextTick();
  assert.equal(f.countRequests.length, 0);
  assert.deepEqual(
    f.store.inspectorRows.map((row) => row.id),
    ['flights'],
  );

  f.store.pulseInspector();
  await nextTick();
  assert.deepEqual(f.store.inspectorRows, []);
  assert.equal(f.countRequests.length, 1);
  f.store.pulseInspector();
  await nextTick();
  assert.equal(
    f.countRequests.length,
    1,
    'an unchanged eligible pulse does not ask again',
  );
});

test('a same-center globe crossing refreshes metadata and pauses weather and admits the globe count', async (t) => {
  const f = inspectorFixture(t);
  f.setRows([enabled('flights')]);
  await f.openAndRead();
  assert.equal(f.weatherRequests.length, 1);
  assert.equal(f.countRequests.length, 0);

  f.replaceManager([]);
  f.pose.height = 6_000_000;
  f.cameraEvents.get('moveEnd')();
  await nextTick();
  assert.deepEqual(f.store.inspectorRows, []);
  assert.ok(f.weatherRequests[0].signal.aborted);
  assert.equal(f.countRequests.length, 1);
  f.store.pulseInspector();
  await nextTick();
  await f.advance(400);
  assert.equal(f.countRequests.length, 1);
  assert.equal(f.weatherRequests.length, 1);
});

test('counts recover from an observed coalesced hide; a delivered hide aborts pending weather', async (t) => {
  const f = inspectorFixture(t);
  await f.openAndRead();
  const [weather] = f.weatherRequests;
  const [count] = f.countRequests;
  count.resolve(countAnswer(700));
  // Settle the count while hidden, then reopen before Vue flushes the hide.
  queueMicrotask(() => f.show(true));
  f.show(false);
  await nextTick();

  assert.ok(count.signal.aborted);
  assert.equal(f.countStore.state.lastAttemptAt, null);
  assert.deepEqual(f.countStore.state.counts, {});
  assert.deepEqual(f.countUpdates, [{ shown: true, nothingOn: true }]);
  assert.equal(
    f.countRequests.length,
    1,
    'the completion cannot start its own retry',
  );

  f.store.pulseInspector();
  await nextTick();
  assert.equal(f.countRequests.length, 2, 'the next visible pulse can retry');
  f.store.pulseInspector();
  await nextTick();
  assert.equal(f.countRequests.length, 2);
  f.countRequests[1].resolve(countAnswer(900));
  await Promise.resolve();
  assert.equal(f.countStore.state.counts.flights.count, 900);

  weather.resolve({ weather: reading });
  f.show(false);
  await setImmediate();
  assert.ok(weather.signal.aborted);
  assert.equal(f.store.viewWeather?.reading ?? null, null);
  assert.equal(f.store.viewWeather?.zone ?? null, null);
  f.show(true);
  f.store.pulseInspector();
  await nextTick();
  await f.advance(400);
  assert.equal(f.countRequests.length, 2);
  assert.equal(f.weatherRequests.length, 2);
});

test('a weather result is fenced by live camera motion or a changed cell before Vue flushes', async (t) => {
  t.mock.method(performance, 'now', () => 100);
  const f = inspectorFixture(t, { controlWeatherCompletion: true });
  await f.openAndRead();
  const [moving] = f.weatherRequests;
  const published = f.store.view;
  moving.resolve({ weather: reading });
  f.pose.lat += 0.2;
  f.cameraEvents.get('changed')();
  assert.equal(
    f.store.view,
    published,
    'the camera snapshot is still throttled',
  );
  await nextTick();
  assert.ok(moving.signal.aborted);
  assert.equal(f.store.viewWeather?.reading ?? null, null);

  f.cameraEvents.get('moveEnd')();
  await nextTick();
  await f.advance(400);
  const [, oldCell] = f.weatherRequests;
  oldCell.resolve({ weather: reading });
  f.pose.lat += 0.2;
  f.cameraEvents.get('moveEnd')();
  await nextTick();
  assert.ok(oldCell.signal.aborted);
  assert.equal(f.store.viewWeather?.zone ?? null, null);

  await f.advance(400);
  const [, , current] = f.weatherRequests;
  assert.equal(current.lat, f.pose.lat);
  // A round trip coalesced before any owner callback preserves this request.
  f.pose.lat -= 0.2;
  f.cameraEvents.get('moveEnd')();
  f.pose.lat += 0.2;
  f.cameraEvents.get('moveEnd')();
  await nextTick();
  assert.equal(f.weatherRequests.length, 3);
  assert.equal(current.signal.aborted, false);
  current.resolve({ weather: reading });
  await setImmediate();
  assert.deepEqual(f.store.viewWeather.reading, reading);
});

test('invalid camera poses cannot restart weather after quiet or moveEnd', async (t) => {
  t.mock.method(performance, 'now', () => 100);
  const f = inspectorFixture(t);
  await f.openAndRead();
  const [oldWeather] = f.weatherRequests;
  const previous = f.store.view;
  f.pose.lat = NaN;
  f.cameraEvents.get('changed')();
  await nextTick();
  assert.ok(oldWeather.signal.aborted);
  await f.advance(1200);
  await f.advance(400);
  assert.equal(f.store.view, previous);
  assert.equal(
    f.weatherRequests.length,
    1,
    'quiet did not publish a usable pose',
  );

  f.cameraEvents.get('moveEnd')();
  await nextTick();
  await f.advance(400);
  assert.equal(f.weatherRequests.length, 1, 'moveEnd still has no usable pose');

  f.pose.lat = 48;
  f.cameraEvents.get('moveEnd')();
  await nextTick();
  await f.advance(400);
  assert.equal(f.weatherRequests.length, 2);
  assert.equal(f.weatherRequests[1].lat, 48);
});

test('a weather completion that sees cell B releases its slot even when delivery coalesces back to A', async (t) => {
  const f = inspectorFixture(t, { controlWeatherCompletion: true });
  await f.openAndRead();
  const [first] = f.weatherRequests;
  const a = f.pose.lat;
  const b = a + 0.2;
  const delivered = [];
  const published = [];
  t.after(
    watch(
      () => f.store.view,
      (view) => delivered.push(view.center.lat),
      { flush: 'post' },
    ),
  );
  t.after(
    watch(
      () => f.store.viewWeather,
      (weather) => published.push(weather),
      { flush: 'sync' },
    ),
  );

  let beforeDelivery;
  first.resolve({ weather: reading });
  queueMicrotask(() => {
    beforeDelivery = {
      lat: f.store.view.center.lat,
      aborted: first.signal.aborted,
      pending: f.store.viewWeather.pending,
    };
    f.pose.lat = a;
    f.cameraEvents.get('moveEnd')();
  });
  f.pose.lat = b;
  f.cameraEvents.get('moveEnd')();
  await nextTick();

  assert.deepEqual(beforeDelivery, { lat: b, aborted: true, pending: false });
  assert.deepEqual(delivered, [a]);
  assert.deepEqual(
    published.filter((snapshot) => snapshot.reading || snapshot.zone),
    [],
    'there is no transient reading or zone',
  );
  assert.equal(
    f.weatherRequests.length,
    1,
    'no request for the transient cell',
  );

  await f.advance(400);
  assert.deepEqual(
    f.weatherRequests.map(({ lat }) => lat),
    [a, a],
  );
  const [, retry] = f.weatherRequests;
  retry.resolve({ weather: reading });
  await setImmediate();
  assert.deepEqual(f.store.viewWeather.reading, reading);
});

test('an abort listener that disposes the bridge cannot restore its previous weather', async (t) => {
  let dispose;
  const f = inspectorFixture(t, { onWeatherAbort: () => dispose() });
  dispose = f.disconnect;
  await f.openAndRead();
  f.weatherRequests[0].resolve({ weather: reading });
  await setImmediate();
  assert.deepEqual(f.store.viewWeather.reading, reading);
  await f.advance(11 * 60_000);
  f.store.pulseInspector();
  await nextTick();
  await f.advance(400);
  assert.equal(f.weatherRequests.length, 2);
  assert.equal(f.store.viewWeather.pending, true);

  f.cameraEvents.get('moveStart')();
  await nextTick();
  assert.equal(f.weatherRequests[1].signal.aborted, true);
  assert.equal(f.store.viewWeather, null);
  assert.equal(f.cameraEvents.size, 0);
});

test('bridge replacement keeps saved counts, cancels both old requests, and waits for its own camera', async (t) => {
  const f = inspectorFixture(t);
  const disposeOld = f.disconnect;
  f.countStore.publish({
    ...f.countStore.state,
    counts: { flights: { count: 900, at: 10 } },
  });
  await f.openAndRead();
  const [oldWeather] = f.weatherRequests;
  const [oldCount] = f.countRequests;
  f.disconnect();
  assert.ok(oldWeather.signal.aborted);
  assert.ok(oldCount.signal.aborted);
  assert.equal(f.visibilityListeners.size, 0);
  assert.equal(f.cameraEvents.size, 0);
  assert.equal(f.store.viewWeather, null);
  assert.deepEqual(f.store.inspectorRows, []);
  assert.equal(f.countStore.state.counts.flights.count, 900);
  assert.equal(f.countStore.state.lastAttemptAt, null);

  f.pose.lat = NaN;
  f.connect();
  await f.advance(1000);
  assert.equal(
    f.weatherRequests.length,
    1,
    'a stale camera snapshot cannot admit weather',
  );
  assert.equal(
    f.countRequests.length,
    2,
    'the replacement can begin its own counts ask',
  );
  f.pose.lat = 48;
  f.cameraEvents.get('moveEnd')();
  await nextTick();
  await f.advance(400);
  const [, newWeather] = f.weatherRequests;
  const [, newCount] = f.countRequests;
  assert.equal(newWeather.lat, 48);
  newWeather.resolve({ weather: reading });
  newCount.resolve(countAnswer(1000));
  await setImmediate();

  oldWeather.resolve({ weather: { temperatureC: -99 } });
  oldCount.resolve(countAnswer(700));
  disposeOld();
  await setImmediate();
  assert.deepEqual(f.store.viewWeather.reading, reading);
  assert.equal(f.countStore.state.counts.flights.count, 1000);

  f.pose.lat = 49;
  f.cameraEvents.get('moveEnd')();
  await nextTick();
  assert.equal(f.weatherTimers.size, 1, 'new cell has a queued settle timer');
  f.disconnect();
  assert.equal(f.weatherTimers.size, 0);
  assert.equal(f.visibilityListeners.size, 0);
  const completedAttempt = f.countStore.state.lastAttemptAt;
  assert.notEqual(completedAttempt, null);
  f.connect();
  await nextTick();
  assert.equal(
    f.countRequests.length,
    2,
    'replacement respects the completed cooldown',
  );
  assert.equal(f.countStore.state.lastAttemptAt, completedAttempt);
  assert.equal(f.countStore.state.counts.flights.count, 1000);
});
