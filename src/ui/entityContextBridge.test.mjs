import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { createPinia } from 'pinia';
import { nextTick, ref, watch } from 'vue';
import { installEntityContext } from './entityContextBridge.js';
import { createLayerCounts } from './layerCounts.js';
import { useEntityCardStore } from './stores/entityCard.js';
import { useLayerCountsStore } from './stores/layerCounts.js';
import { usePanelChromeStore } from './stores/panelChrome.js';
import { useSpaceMissionsStore } from './stores/spaceMissions.js';
import { bindRenderer } from '../render/rendererOf.js';
import { fakeInput } from '../input/testDoubles.mjs';
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

// Nearby opens a cable laid in pieces at its nearest piece: the card stays
// there and the camera flies there, not to the cable's first piece.
test('opening a far piece of a multi-piece cable from Nearby flies to that piece', async (t) => {
  const { readFileSync } = await import('node:fs');
  const { bindFakeDraw } = await import('../testSupport/fakeDrawPort.mjs');
  const { toLonLatH } = await import('../geo/ellipsoid.js');
  const { cableAnalystRecords } =
    await import('../layers/submarineCables/records.js');
  const { nearbyByLayer } = await import('../data/entityContext.js');
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
  const { unbind } = bindFakeDraw(viewer, {
    camera: {
      pose: () => ({ heading: 0, pitch: -1, roll: 0 }),
      on: () => () => {},
      followed: null,
      flyToBounds: (bounds) => flown.push(bounds),
    },
  });
  const input = fakeInput(viewer);
  const pinia = createPinia();
  const disconnect = installEntityContext({
    viewer,
    getDataManager: () => dataManager,
    pinia,
  });
  const store = useEntityCardStore(pinia);
  t.after(() => {
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
  const [list] = nearbyByLayer(dataManager, far, {
    radiusKm: 25,
    query: 'topaz',
  });
  assert.ok(store.select(list.items[0].identity, { fly: true }));
  assert.equal(store.card.lat, far.lat, 'the card stays at that piece');
  assert.equal(store.card.lon, far.lon);
  assert.equal(flown.length, 1, 'the camera flew once');
  const landed = toLonLatH(flown[0].center);
  assert.ok(Math.abs(landed.lat - far.lat) < 1e-6, `lat ${landed.lat}`);
  assert.ok(Math.abs(landed.lon - far.lon) < 1e-6, `lon ${landed.lon}`);
});

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

test('the first pre-flush sample includes a manager attached during bridge setup', async (t) => {
  const f = inspectorFixture(t);
  f.disconnect();
  f.show(true);
  f.replaceManager(null);
  f.connect();
  f.replaceManager([
    enabled('flights', { count: 17, lastUpdate: 2, scope: 'worldwide' }),
  ]);
  await setImmediate();
  assert.equal(f.store.inspectorRows[0].id, 'flights');
  assert.equal(f.countRequests.length, 0);
  assert.equal(
    f.samples,
    1,
    'subscribing does not sample the same entry twice',
  );
  assert.deepEqual(
    f.countStore.state.counts,
    {},
    'subscribing is not a feed update',
  );
  f.setRows(f.store.inspectorRows);
  await nextTick();
  assert.equal(f.countStore.state.counts.flights.count, 17);
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
  await Promise.resolve();
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
  f.setRows([
    enabled('flights', { count: 900, lastUpdate: 2, scope: 'worldwide' }),
  ]);
  await nextTick();
  await f.openAndRead();
  assert.deepEqual(
    f.countStore.state.counts,
    {},
    'entry alone does not save live totals',
  );
  f.store.pulseInspector();
  await nextTick();
  assert.equal(f.countStore.state.counts.flights.count, 900);
  f.setRows([]);
  await nextTick();
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
