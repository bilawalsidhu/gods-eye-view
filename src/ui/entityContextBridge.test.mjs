import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { createPinia } from 'pinia';
import { nextTick, ref, watch } from 'vue';
import { OrbitController } from '../orbit.js';
import { bhoteKoshiPlaceRecords } from '../data/bhoteKoshiLocator.js';
import { INCIDENT_OVERVIEW_PLACES } from '../data/bhoteKoshiIncidentPlaces.js';
import { toLonLatH } from '../geo/ellipsoid.js';
import { createControls as createWildlifeControls } from '../layers/wildlifeSightings/controls.js';
import { normalizeInatObservations } from '../layers/wildlifeSightings/records.js';
import { LocationSearch } from './locationSearch.js';
import { NavigationController } from './navigationController.js';
import { installEntityContext } from './entityContextBridge.js';
import { createLayerCounts } from './layerCounts.js';
import { useEntityCardStore } from './stores/entityCard.js';
import { useLayerCountsStore } from './stores/layerCounts.js';
import { useOmnibarStore } from './stores/omnibar.js';
import { usePanelChromeStore } from './stores/panelChrome.js';
import { useSpaceMissionsStore } from './stores/spaceMissions.js';
import { bindRenderer, findCamera } from '../render/rendererOf.js';
import { fakeInput } from '../input/testDoubles.mjs';
import {
  _resetSelectionForTest,
  claimSelection,
  currentSelection,
  releaseSelection,
} from '../data/clickSelect.js';
import {
  registerPickOwner,
  setClickCardHitTest,
  unregisterPickOwner,
} from '../data/pickRegistry.js';

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
  const disconnect = installEntityContext({
    viewer,
    getDataManager: () => ({
      isEnabled: () => true,
      layers: new Map(),
      getAll: () => [],
    }),
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

// A vessel's layer announces its selection with the context store's id; the
// card names it by the vessel's own id, as a click on it does.
test('a vessel announced by its layer is named by its own id', (t) => {
  // The page's events, which Node lacks.
  const events = new EventTarget();
  for (const name of [
    'addEventListener',
    'removeEventListener',
    'dispatchEvent',
  ])
    globalThis[name] = events[name].bind(events);
  t.after(() => {
    for (const name of [
      'addEventListener',
      'removeEventListener',
      'dispatchEvent',
    ])
      delete globalThis[name];
  });
  const pinia = createPinia();
  const viewer = { scene: { pick: () => null, drillPick: () => [] } };
  const input = fakeInput(viewer);
  const disconnect = installEntityContext({
    viewer,
    getDataManager: () => ({
      isEnabled: () => true,
      layers: new Map(),
      getAll: () => [],
    }),
    pinia,
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
  assert.deepEqual(named, ['5fdca702', 'fire:1']);
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
  store.setView = (_, options) => settled.push(options.settled);
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
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
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
  let elapsed = 0;
  let samples = 0;
  function port(requests, fields) {
    const { promise, resolve } = Promise.withResolvers();
    requests.push({ ...fields, resolve });
    return promise;
  }
  const readWeather = (lat, lon, { signal }) => {
    if (onWeatherAbort)
      signal.addEventListener('abort', onWeatherAbort, { once: true });
    return port(weatherRequests, { lat, lon, signal });
  };
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

test('the first pre-flush sample includes a manager attached during bridge setup', async (t) => {
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

test('an unapplied count sample is reconsidered when post callbacks coalesce visibility', async (t) => {
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

test('a globe-only refresh updates an unapplied count sample when post callbacks coalesce visibility', async (t) => {
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
    0,
    'the updated metadata wins before admission',
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

test('a same-center globe crossing refreshes metadata and pauses weather without admitting counts', async (t) => {
  const f = inspectorFixture(t);
  f.setRows([enabled('flights')]);
  await f.openAndRead();
  assert.equal(f.weatherRequests.length, 1);
  assert.equal(f.countRequests.length, 0);

  f.replaceManager([]);
  f.pose.height = 5_000_000;
  f.cameraEvents.get('moveEnd')();
  await nextTick();
  assert.deepEqual(f.store.inspectorRows, []);
  assert.ok(f.weatherRequests[0].signal.aborted);
  assert.equal(f.countRequests.length, 0);
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
  const f = inspectorFixture(t, { onWeatherAbort: () => dispose?.() });
  await f.openAndRead();
  f.weatherRequests[0].resolve({ weather: reading });
  await setImmediate();
  assert.deepEqual(f.store.viewWeather.reading, reading);
  dispose = f.disconnect;
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
  f.disconnect();
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
