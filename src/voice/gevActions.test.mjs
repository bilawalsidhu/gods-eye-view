import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { CCTV_FOCUS_RESULT } from '../data/cctv.js';
import { getContextStore, registerEntityContext } from '../data/contextStore.js';
import { DataLayerManager } from '../data/manager.js';
import { getActiveCameraMotion, interruptCameraMotion, moveCamera } from '../cameraVerbs.js';
import { reassertNavigationHandoff, runExplicitNavigation } from '../navigationPolicy.js';
import { TR3B_CLASS } from '../data/tr3bRegistry.js';
import {
  controlCctv,
  createGevActionRunner,
  cctvVoiceFocusOutcome,
  formatTrackedEntityLabel,
  normalizeStackId,
} from './gevActions.js';
import { MAP_STACKS } from '../mapStackController.js';
import { readFileSync } from 'node:fs';

test('every live basemap is reachable by its own id — no enum value without a voice alias', () => {
  // B1 regression: a stack added to MAP_STACKS (and the set_map_stack enum)
  // without a matching STACK_ALIASES entry resolves to null and throws
  // "Unknown map stack" at the controller — a broken voice command for a
  // shipped basemap. Every live id must self-resolve.
  for (const stack of MAP_STACKS) {
    assert.equal(
      normalizeStackId(stack.id),
      stack.id,
      `set_map_stack '${stack.id}' has no self-mapping alias — voice selection would throw`,
    );
  }
  assert.equal(normalizeStackId('Azure Satellite'), 'azure-satellite');
  assert.equal(normalizeStackId('Azure Hybrid'), 'azure-hybrid');
  assert.equal(normalizeStackId('road map'), 'azure-streets');
  // And the voice tool's enum must equal the set of live ids — no drift either way.
  const config = readFileSync(new URL('./foundrySession.js', import.meta.url), 'utf8');
  const enumMatch = config.match(/enum: \[('azure-satellite'[^\]]*)\]/);
  assert.ok(enumMatch, 'set_map_stack enum literal must still be findable');
  const enumIds = enumMatch[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
  assert.deepEqual(
    [...enumIds].sort(),
    MAP_STACKS.map((s) => s.id).sort(),
    'the set_map_stack voice enum and MAP_STACKS must name exactly the same basemaps',
  );
});

test('track_entity narration names aircraft callsign → registration → icao24', () => {
  const found = { callsign: 'SWA696', registration: 'N123AB', icao24: 'ae1fa4' };
  assert.equal(formatTrackedEntityLabel(found, 'q'), 'SWA696');
  // A callsign-less contact must be spoken as its tail number, not the hex —
  // otherwise the voice says "ae1fa4" at a plane the UI is labelling N123AB.
  assert.equal(formatTrackedEntityLabel({ ...found, callsign: null }, 'q'), 'N123AB');
  assert.equal(formatTrackedEntityLabel({ ...found, callsign: '  ', registration: ' ' }, 'q'), 'ae1fa4');
  // Vessels and satellites carry no registration and keep their own links.
  assert.equal(formatTrackedEntityLabel({ name: 'EVER GIVEN', mmsi: 353136000 }, 'q'), 'EVER GIVEN');
  assert.equal(formatTrackedEntityLabel({ noradId: 25544 }, 'q'), '25544');
  assert.equal(formatTrackedEntityLabel(null, 'the ISS'), 'the ISS');
});

test('track_entity runner narrates a callsign-less aircraft by its registration', async () => {
  globalThis.window = globalThis.window || { clearTimeout, setTimeout, requestIdleCallback: null };
  // Only the layer lookup is stubbed — the runner reaches the real formatter
  // through its real wiring, so a broken hand-off fails this test.
  for (const layerId of ['flights', 'military']) {
    const { viewer, styleManager } = createVoiceNavigationHarness();
    let trackedId = null;
    const runner = createGevActionRunner({
      viewer,
      styleManager,
      dataManager: {
        layers: new Map([[layerId, { module: {
          findByQuery: () => ({
            icao24: 'ae1fa4',
            callsign: null,
            registration: 'N123AB',
            latitude: 30.19,
            longitude: -97.67,
            altitudeM: 10_668,
          }),
          trackById: (id) => { trackedId = id; return true; },
        } }]]),
        isEnabled: () => true,
        getAll: () => [],
      },
    });

    const result = await runner('track_entity', { query: 'N123AB', layerId });
    assert.equal(result.ok, true, `${layerId} must track the match`);
    assert.equal(
      result.label,
      'N123AB',
      `${layerId} narration must speak the registration, not the ICAO hex`,
    );
    assert.equal(trackedId, 'ae1fa4', `${layerId} must still TRACK by icao24`);
  }
});

function createVoiceNavigationHarness({ immersiveViewActive = false } = {}) {
  const order = [];
  let generation = 0;
  const position = Cesium.Cartesian3.fromDegrees(-97.74, 30.26, 500);
  const viewer = {
    trackedEntity: { id: 'prior-aircraft' },
    clock: { onTick: { addEventListener: () => () => {} } },
    scene: {
      canvas: {
        clientWidth: 1200,
        clientHeight: 800,
        addEventListener() {},
        removeEventListener() {},
      },
      globe: { getHeight: () => 0 },
      tweens: [],
    },
    camera: {
      moveEnd: { addEventListener() {} },
      positionWC: position,
      positionCartographic: Cesium.Cartographic.fromCartesian(position),
      heading: Cesium.Math.toRadians(28),
      pitch: Cesium.Math.toRadians(-45),
      cancelFlight() { order.push('cancel'); },
      flyToBoundingSphere() {
        order.push(`fly:${viewer.trackedEntity === undefined ? 'released' : 'owned'}`);
      },
      lookAtTransform() {},
    },
  };
  const styleManager = {
    runImmediateNavigation(noun, navigate, releaseOptions = undefined) {
      return runExplicitNavigation({
        immersiveViewActive,
        noun,
        stamp: () => {
          generation += 1;
          order.push(`stamp:${noun}`);
          return generation;
        },
        release: () => {
          order.push('release');
          viewer.trackedEntity = undefined;
          interruptCameraMotion('test-release');
          if (!releaseOptions?.preserveCameraFlight) viewer.camera.cancelFlight();
        },
        navigate,
      });
    },
    getDetectionState: () => ({ detectionMode: 'DENSE' }),
  };
  return {
    order,
    viewer,
    styleManager,
    currentGeneration: () => generation,
  };
}

test('zoom to globe adopts the shared visible reset route and returns its result', async () => {
  globalThis.window = globalThis.window || { clearTimeout, setTimeout, requestIdleCallback: null };
  const viewer = {
    clock: { onTick: { addEventListener: () => () => {} } },
    scene: { canvas: { addEventListener() {}, removeEventListener() {} } },
    camera: { moveEnd: { addEventListener() {} } },
  };
  const expected = {
    ok: true,
    action: 'zoom_to_globe',
    heightKm: 18000,
    centeredOn: { latitude: 30, longitude: -97 },
  };
  let calls = 0;
  const styleManager = {
    async resetToGlobeView() {
      calls += 1;
      return expected;
    },
  };
  const runner = createGevActionRunner({
    viewer,
    styleManager,
    dataManager: { layers: new Map(), getAll: () => [] },
  });
  assert.deepEqual(await runner('zoom_to_globe'), expected);
  assert.equal(calls, 1);
});

test('dependent voice navigation waits for the destination viewport to arrive', async () => {
  globalThis.window = globalThis.window || { clearTimeout, setTimeout, requestIdleCallback: null };
  const { viewer, styleManager } = createVoiceNavigationHarness();
  let completeFlight = null;
  viewer.camera.flyTo = (options) => { completeFlight = options.complete; };
  styleManager.runImmediateLocationNavigation = (navigate) => (
    styleManager.runImmediateNavigation('location', navigate)
  );
  const runner = createGevActionRunner({
    viewer,
    styleManager,
    dataManager: { layers: new Map(), getAll: () => [] },
  });
  let settled = false;
  const resultPromise = runner('fly_to_location', {
    locationId: 'austin',
    waitForArrival: true,
  }).then((result) => {
    settled = true;
    return result;
  });
  await Promise.resolve();
  assert.equal(settled, false, 'dependent tool calls must wait while the camera is flying');
  assert.equal(typeof completeFlight, 'function');
  completeFlight();
  const result = await resultPromise;
  assert.equal(result.ok, true);
  assert.equal(result.arrived, true);
});

test('nearest-aircraft voice action serializes layer enable, arrival, refresh, airborne query, and selection', async () => {
  globalThis.window = globalThis.window || { clearTimeout, setTimeout, requestIdleCallback: null };
  const { viewer, styleManager } = createVoiceNavigationHarness();
  const order = [];
  let completeFlight = null;
  viewer.camera.flyTo = (options) => {
    order.push('fly');
    completeFlight = options.complete;
  };
  styleManager.runImmediateLocationNavigation = (navigate) => (
    styleManager.runImmediateNavigation('location', navigate)
  );
  let enabled = false;
  let trackedId = null;
  const flights = {
    source: 'adsb.lol fallback',
    getStats: () => ({ count: 2, lastUpdate: Date.now() }),
    getAnalystRecords: (maxCount = 2000) => {
      assert.ok(maxCount > 2000, 'the nearest search must inspect the complete loaded fleet');
      return [
        { id: 'GROUND1', icao24: 'landed-near', callsign: 'GROUND1', lat: 30.2673, lon: -97.7432, onGround: true },
        { id: 'AIR1', icao24: 'airborne-far', callsign: 'AIR1', lat: 30.30, lon: -97.76, altitudeM: 2400, onGround: false },
      ];
    },
    findByQuery: (query) => (query === 'airborne-far'
      ? { icao24: 'airborne-far', callsign: 'AIR1', latitude: 30.30, longitude: -97.76, altitudeM: 2400 }
      : null),
    trackById: (id) => {
      order.push(`track:${id}`);
      trackedId = id;
      return true;
    },
  };
  const dataManager = {
    layers: new Map([['flights', { module: flights }]]),
    isEnabled: () => enabled,
    async setEnabled() {
      order.push('enable');
      enabled = true;
      return true;
    },
    async refreshLayer() {
      order.push('refresh-austin');
      return true;
    },
    getAll: () => [{ id: 'flights', name: 'Live Flights', enabled }],
  };
  const runner = createGevActionRunner({ viewer, styleManager, dataManager });
  const resultPromise = runner('select_nearest_aircraft', {
    layerId: 'flights',
    locationId: 'austin',
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['enable', 'fly'], 'Flights must turn on before navigation begins');
  completeFlight();
  const result = await resultPromise;
  assert.equal(result.ok, true);
  assert.equal(result.label, 'AIR1');
  assert.equal(result.aircraft.onGround, false);
  assert.equal(result.feed.state, 'fallback');
  assert.equal(result.feed.source, 'adsb.lol fallback');
  assert.equal(trackedId, 'airborne-far', 'the closer landed record must be excluded');
  assert.deepEqual(order, ['enable', 'fly', 'refresh-austin', 'track:airborne-far']);
});

test('nearest-aircraft voice action refreshes an already-enabled viewport layer after arrival', async () => {
  globalThis.window = globalThis.window || { clearTimeout, setTimeout, requestIdleCallback: null };
  const { viewer, styleManager } = createVoiceNavigationHarness();
  const order = [];
  let completeFlight = null;
  viewer.camera.flyTo = (options) => {
    order.push('fly');
    completeFlight = options.complete;
  };
  styleManager.runImmediateLocationNavigation = (navigate) => (
    styleManager.runImmediateNavigation('location', navigate)
  );
  const flights = {
    source: 'OpenSky Network',
    getStats: () => ({ source: 'OpenSky Network', count: 1, lastUpdate: Date.now() }),
    getAnalystRecords: () => [
      { id: 'DUPLICATE', icao24: 'fresh-austin', callsign: 'DUPLICATE', lat: 30.28, lon: -97.74, altitudeM: 1800, onGround: false },
    ],
    findByQuery: (query) => (query === 'fresh-austin'
      ? { icao24: 'fresh-austin', callsign: 'DUPLICATE', latitude: 30.28, longitude: -97.74, altitudeM: 1800 }
      : null),
    trackById: (id) => {
      order.push(`track:${id}`);
      return id === 'fresh-austin';
    },
  };
  const dataManager = {
    layers: new Map([['flights', { module: flights }]]),
    isEnabled: () => true,
    async setEnabled() {
      order.push('enable-same-state');
      return true;
    },
    async refreshLayer() {
      order.push('refresh-austin');
      return true;
    },
    getAll: () => [{ id: 'flights', name: 'Live Flights', enabled: true }],
  };
  const runner = createGevActionRunner({ viewer, styleManager, dataManager });
  const resultPromise = runner('select_nearest_aircraft', {
    layerId: 'flights',
    locationId: 'austin',
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['enable-same-state', 'fly']);
  completeFlight();
  const result = await resultPromise;
  assert.equal(result.ok, true);
  assert.equal(result.aircraft.id, 'fresh-austin');
  assert.deepEqual(order, [
    'enable-same-state',
    'fly',
    'refresh-austin',
    'track:fresh-austin',
  ]);
});

test('fallback with zero airborne records reports enabled fallback without selecting a landed aircraft', async () => {
  globalThis.window = globalThis.window || { clearTimeout, setTimeout, requestIdleCallback: null };
  const { viewer, styleManager } = createVoiceNavigationHarness();
  let completeFlight = null;
  viewer.camera.flyTo = (options) => { completeFlight = options.complete; };
  styleManager.runImmediateLocationNavigation = (navigate) => (
    styleManager.runImmediateNavigation('location', navigate)
  );
  let enabled = false;
  const flights = {
    source: 'adsb.lol fallback',
    getStats: () => ({ count: 1, lastUpdate: Date.now() }),
    getAnalystRecords: () => [
      { id: 'GROUND2', icao24: 'ground-only', callsign: 'GROUND2', lat: 30.2673, lon: -97.7432, onGround: true },
    ],
    trackById: () => {
      assert.fail('a landed-only fallback result must not be tracked');
    },
  };
  const dataManager = {
    layers: new Map([['flights', { module: flights }]]),
    isEnabled: () => enabled,
    async setEnabled() {
      enabled = true;
      return true;
    },
    async refreshLayer() {
      return true;
    },
    getAll: () => [{ id: 'flights', name: 'Live Flights', enabled }],
  };
  const runner = createGevActionRunner({ viewer, styleManager, dataManager });
  const resultPromise = runner('select_nearest_aircraft', {
    layerId: 'flights',
    locationId: 'austin',
  });
  await new Promise((resolve) => setImmediate(resolve));
  completeFlight();
  const result = await resultPromise;
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'nearest');
  assert.equal(result.feed.state, 'fallback');
  assert.equal(result.feed.source, 'adsb.lol fallback');
  assert.match(result.error, /enabled on the adsb\.lol fallback feed.*no airborne aircraft/i);
});

test('nearest-aircraft voice action rejects a missing destination without changing the map or layer', async () => {
  const { viewer, styleManager } = createVoiceNavigationHarness();
  let enabled = false;
  const dataManager = {
    layers: new Map([['flights', { module: {} }]]),
    isEnabled: () => enabled,
    async setEnabled() {
      enabled = true;
      return true;
    },
    getAll: () => [{ id: 'flights', name: 'Live Flights', enabled }],
  };
  const runner = createGevActionRunner({ viewer, styleManager, dataManager });
  const result = await runner('select_nearest_aircraft', { layerId: 'flights' });
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'location');
  assert.equal(enabled, false);
});

test('successful voice tracking stamps and releases the old owner before layer takeover', async () => {
  globalThis.window = globalThis.window || { clearTimeout, setTimeout, requestIdleCallback: null };
  const { order, viewer, styleManager } = createVoiceNavigationHarness();
  const satellites = {
    findByQuery: () => ({ noradId: '25544', name: 'ISS' }),
    trackById(id) {
      order.push(`track:${id}`);
      return true;
    },
  };
  const dataManager = {
    layers: new Map([['satellites', { module: satellites }]]),
    isEnabled: (id) => id === 'satellites',
    getAll: () => [],
  };
  const runner = createGevActionRunner({ viewer, styleManager, dataManager });
  const result = await runner('track_entity', { query: 'ISS', layerId: 'satellites' });
  assert.equal(result.ok, true);
  assert.deepEqual(order, ['stamp:satellite', 'release', 'cancel', 'track:25544']);
});

test('voice Stop Tracking clears all durable tracker IDs even without active trackers', async () => {
  const cleared = [];
  const dormant = { getTrackedInfo: () => null, stopTracking() { throw new Error('must not need active tracking'); } };
  const dataManager = {
    layers: new Map([
      ['flights', { module: dormant }],
      ['military', { module: dormant }],
      ['satellites', { module: dormant }],
    ]),
    setLayerParams(layerId, params, options) { cleared.push({ layerId, params, options }); return true; },
    getAll: () => [],
  };
  const runner = createGevActionRunner({
    viewer: {
      scene: {
        canvas: { addEventListener() {}, removeEventListener() {} },
        preRender: { addEventListener() {} },
      },
      camera: { moveEnd: { addEventListener() {} } },
      clock: { onTick: { addEventListener() {} } },
    },
    styleManager: {},
    dataManager,
  });
  assert.deepEqual(await runner('stop_tracking'), { ok: true, action: 'stop_tracking', released: [] });
  assert.deepEqual(cleared, [
    { layerId: 'flights', params: { selectedFlightsTrackingId: null }, options: { origin: 'voice' } },
    { layerId: 'military', params: { selectedMilitaryTrackingId: null }, options: { origin: 'voice' } },
    { layerId: 'satellites', params: { selectedSatTrackingId: null }, options: { origin: 'voice' } },
  ]);
});

test('voice Stop Tracking reports exact layers whose active or durable clear failed', async () => {
  const active = {
    getTrackedInfo: () => ({ icao24: 'active' }),
    stopTracking: () => false,
  };
  const dormant = { getTrackedInfo: () => null };
  const dataManager = {
    layers: new Map([
      ['flights', { module: active }],
      ['military', { module: dormant }],
      ['satellites', { module: dormant }],
    ]),
    setLayerParams(layerId) { return layerId !== 'military'; },
    getAll: () => [],
  };
  const viewer = {
    trackedEntity: { gevTrackedId: 'flights:active' },
    scene: {
      canvas: { addEventListener() {}, removeEventListener() {} },
      preRender: { addEventListener() {} },
    },
    camera: { moveEnd: { addEventListener() {} } },
    clock: { onTick: { addEventListener() {} } },
  };
  const runner = createGevActionRunner({ viewer, styleManager: {}, dataManager });

  assert.deepEqual(await runner('stop_tracking'), {
    ok: false,
    action: 'stop_tracking',
    released: [],
    failedLayerIds: ['flights', 'military'],
    error: 'Tracking could not be cleared for: flights, military',
  });
  assert.equal(viewer.trackedEntity, undefined, 'camera ownership still releases after partial failure');
});

test('successful voice overhead framing stamps and releases the old owner before flight', async () => {
  globalThis.window = globalThis.window || { clearTimeout, setTimeout, requestIdleCallback: null };
  const { order, viewer, styleManager } = createVoiceNavigationHarness();
  const position = viewer.camera.positionWC;
  viewer.camera.pickEllipsoid = () => position;
  const flights = { getNearby: () => [{ id: 'abc123', position }] };
  const dataManager = {
    layers: new Map([['flights', { module: flights }]]),
    isEnabled: (id) => id === 'flights',
    getAll: () => [],
  };
  const runner = createGevActionRunner({ viewer, styleManager, dataManager });
  const result = await runner('frame_overhead', { target: 'flights' });
  assert.equal(result.ok, true);
  assert.deepEqual(order, ['stamp:frame', 'release', 'cancel', 'fly:released']);
});

test('tracked aircraft yields to strongest-fire and vessel voice flights before either flight begins', async () => {
  globalThis.window = globalThis.window || { clearTimeout, setTimeout, requestIdleCallback: null };
  for (const kind of ['fire', 'vessel']) {
    const { order, viewer, styleManager } = createVoiceNavigationHarness();
    const module = kind === 'fire'
      ? {
          getStrongestFire: () => ({
            id: 'fire-1', label: 'Strongest fire', latitude: 37.77, longitude: -122.42, frp: 900,
          }),
        }
      : {
          findByQuery: () => ({ mmsi: '123456789', name: 'Test vessel', latitude: 29.75, longitude: -95.35 }),
          selectById(id) { order.push(`select:${id}`); return true; },
        };
    const layerId = kind === 'fire' ? 'local-firms' : 'ais-live-vessels';
    const dataManager = {
      layers: new Map([[layerId, { module }]]),
      isEnabled: (id) => id === layerId,
      getAll: () => [],
    };
    const runner = createGevActionRunner({ viewer, styleManager, dataManager });
    const result = await runner('track_entity', {
      query: kind === 'fire' ? 'strongest fire' : 'Test vessel',
      layerId,
    });
    assert.equal(result.ok, true, kind);
    assert.equal(order[0], `stamp:${kind}`);
    assert.equal(order[1], 'release');
    assert.equal(order[2], 'cancel');
    if (kind === 'vessel') assert.equal(order[3], 'select:123456789');
    assert.equal(order.at(-1), 'fly:released');
  }
});

test('move_camera and fly_route validate first, then use the shared camera authority seam', async () => {
  globalThis.window = globalThis.window || { clearTimeout, setTimeout, requestIdleCallback: null };
  const { order, viewer, styleManager } = createVoiceNavigationHarness();
  const annotations = {
    list: () => [{
      type: 'route',
      label: 'harbor route',
      path: [{ lat: 29.75, lon: -95.36 }, { lat: 29.76, lon: -95.34 }],
    }],
  };
  const runner = createGevActionRunner({
    viewer,
    styleManager,
    dataManager: { layers: new Map(), getAll: () => [] },
    annotations,
  });

  assert.equal((await runner('move_camera', { motion: 'pan', direction: 'right' })).ok, true);
  assert.deepEqual(order.splice(0), ['stamp:camera', 'release', 'cancel']);
  assert.equal(getActiveCameraMotion()?.kind, 'pan');

  viewer.trackedEntity = { id: 'replacement-owner' };
  assert.equal((await runner('fly_route', { label: 'harbor' })).ok, true);
  assert.deepEqual(order, ['stamp:route', 'release', 'cancel']);
  assert.equal(getActiveCameraMotion()?.kind, 'route');
  interruptCameraMotion('test-cleanup');
});

test('a chained orbit preserves its current destination flight while still stamping authority', async () => {
  globalThis.window = globalThis.window || { clearTimeout, setTimeout, requestIdleCallback: null };
  const { order, viewer, styleManager } = createVoiceNavigationHarness();
  viewer.trackedEntity = undefined;
  viewer.scene.tweens.push({ id: 'destination-flight' });
  const runner = createGevActionRunner({
    viewer,
    styleManager,
    dataManager: { layers: new Map(), getAll: () => [] },
  });
  const result = await runner('move_camera', { motion: 'orbit', mode: 'continuous' });
  assert.equal(result.ok, true);
  assert.equal(result.armed, 'waiting-for-arrival');
  assert.deepEqual(order, ['stamp:camera', 'release']);
  assert.equal(viewer.scene.tweens.length, 1);
  interruptCameraMotion('test-cleanup');
});

test('invalid named voice navigation never releases the current camera owner', async () => {
  globalThis.window = globalThis.window || { clearTimeout, setTimeout, requestIdleCallback: null };
  const { order, viewer, styleManager } = createVoiceNavigationHarness();
  const runner = createGevActionRunner({
    viewer,
    styleManager,
    dataManager: { layers: new Map(), isEnabled: () => false, getAll: () => [] },
    annotations: { list: () => [] },
  });
  assert.equal((await runner('move_camera', { motion: 'warp' })).ok, false);
  assert.equal((await runner('fly_route')).ok, false);
  assert.equal((await runner('frame_overhead', { target: 'flights' })).ok, false);
  assert.deepEqual(order, []);
  assert.equal(viewer.trackedEntity?.id, 'prior-aircraft');

  const invalidRouteRunner = createGevActionRunner({
    viewer,
    styleManager,
    dataManager: { layers: new Map(), isEnabled: () => false, getAll: () => [] },
    annotations: { list: () => [{
      type: 'route',
      path: [{ lat: 30, lon: -97 }, { lat: Number.NaN, lon: -96 }],
    }] },
  });
  assert.equal((await invalidRouteRunner('fly_route')).ok, false);
  assert.deepEqual(order, []);

  const outOfRangeRouteRunner = createGevActionRunner({
    viewer,
    styleManager,
    dataManager: { layers: new Map(), isEnabled: () => false, getAll: () => [] },
    annotations: { list: () => [{
      type: 'route',
      path: [{ lat: 95, lon: -97 }, { lat: 30, lon: -96 }],
    }] },
  });
  assert.equal((await outOfRangeRouteRunner('fly_route')).ok, false);
  assert.deepEqual(order, []);
  assert.equal(viewer.trackedEntity?.id, 'prior-aircraft');
});

test('Drone View refuses every named voice camera route before camera or selection mutation', async () => {
  globalThis.window = globalThis.window || { clearTimeout, setTimeout, requestIdleCallback: null };
  const cases = [
    ['move_camera', { motion: 'pan', direction: 'right' }],
    ['move_camera', { motion: 'stop' }],
    ['fly_route', { label: 'harbor' }],
    ['frame_overhead', { target: 'flights' }],
    ['track_entity', { query: 'strongest fire', layerId: 'local-firms' }],
    ['track_entity', { query: 'Test vessel', layerId: 'ais-live-vessels' }],
  ];
  for (const [name, args] of cases) {
    const { order, viewer, styleManager } = createVoiceNavigationHarness({ immersiveViewActive: true });
    let selected = 0;
    const position = viewer.camera.positionWC;
    const modules = new Map([
      ['flights', { module: { getNearby: () => [{ id: 'flight-1', position }] } }],
      ['local-firms', { module: { getStrongestFire: () => ({ latitude: 37.77, longitude: -122.42, frp: 900 }) } }],
      ['ais-live-vessels', { module: {
        findByQuery: () => ({ mmsi: '123456789', latitude: 29.75, longitude: -95.35 }),
        selectById: () => { selected += 1; return true; },
      } }],
    ]);
    const runner = createGevActionRunner({
      viewer,
      styleManager,
      dataManager: { layers: modules, isEnabled: () => true, getAll: () => [] },
      annotations: { list: () => [{
        type: 'route', label: 'harbor route',
        path: [{ lat: 29.75, lon: -95.36 }, { lat: 29.76, lon: -95.34 }],
      }] },
    });
    if (args.motion === 'stop') {
      assert.equal(moveCamera({ motion: 'pan', direction: 'right', mode: 'continuous' }).ok, true);
      assert.equal(getActiveCameraMotion()?.kind, 'pan');
    }
    const result = await runner(name, args);
    assert.equal(result.ok, false, `${name}:${args.query || args.target || args.motion}`);
    assert.deepEqual(order, []);
    assert.equal(selected, 0);
    assert.equal(viewer.trackedEntity?.id, 'prior-aircraft');
    if (args.motion === 'stop') {
      assert.equal(getActiveCameraMotion()?.kind, 'pan');
      interruptCameraMotion('test-cleanup');
    }
  }
});

test('a newer voice action makes an older deferred navigation authority inert', async () => {
  globalThis.window = globalThis.window || { clearTimeout, setTimeout, requestIdleCallback: null };
  const { viewer, styleManager, currentGeneration } = createVoiceNavigationHarness();
  const oldGeneration = currentGeneration();
  const runner = createGevActionRunner({
    viewer,
    styleManager,
    dataManager: {
      layers: new Map([['local-firms', { module: {
        getStrongestFire: () => ({ latitude: 37.77, longitude: -122.42, frp: 900 }),
      } }]]),
      isEnabled: () => true,
      getAll: () => [],
    },
  });
  assert.equal((await runner('track_entity', { query: 'strongest fire' })).ok, true);
  let staleReleased = false;
  assert.equal(reassertNavigationHandoff({
    generation: oldGeneration,
    currentGeneration: currentGeneration(),
    release: () => { staleReleased = true; },
  }), false);
  assert.equal(staleReleased, false);
});

test('Data Layers voice inventory hides the Context coordinator while current-view truth retains it', async () => {
  globalThis.window = globalThis.window || { clearTimeout, setTimeout, requestIdleCallback: null };
  const layers = [
    { id: 'flights', name: 'Live Flights', enabled: false, showInTogglePanel: true, stats: { count: 0 } },
    { id: 'military-awareness', name: 'Global Context', enabled: true, showInTogglePanel: false, stats: { count: 1 } },
  ];
  const dataManager = {
    layers: new Map(),
    getAll: () => layers,
  };
  const styleManager = {
    activeStyle: 'normal',
    setPanelCollapsed() {},
    getControlState: () => null,
    getContextModeState: () => ({ mode: 'flights', active: true }),
  };
  const viewer = {
    clock: { onTick: { addEventListener: () => () => {} } },
    scene: { canvas: { addEventListener() {}, removeEventListener() {} } },
    camera: {
      moveEnd: { addEventListener() {} },
      positionWC: Cesium.Cartesian3.fromDegrees(-97.7, 30.2, 1000),
    },
  };
  const runner = createGevActionRunner({ viewer, styleManager, dataManager });
  const menu = await runner('show_data_layers_menu');
  assert.deepEqual(menu.layers.map(({ id }) => id), ['flights']);
  const current = await runner('get_current_view_state');
  assert.deepEqual(current.layers.map(({ id }) => id), ['flights', 'military-awareness']);
  // The Contacts mode's internal id is 'flights'; the tools accept 'contacts'.
  // State output reports the accepted word so the model cannot read its own
  // active context as "off", with the internal id kept for layer reasoning.
  assert.deepEqual(current.context, { mode: 'contacts', modeInternal: 'flights', active: true });
});


test('voice CCTV focus reports tracking ownership separately from no active camera', () => {
  assert.deepEqual(
    cctvVoiceFocusOutcome(CCTV_FOCUS_RESULT.TRACKING_HOLDS_VIEW),
    {
      ok: false,
      error: 'Camera active; tracking holds the view — say untrack first',
    },
  );
  assert.deepEqual(
    cctvVoiceFocusOutcome(CCTV_FOCUS_RESULT.NO_ACTIVE_CAMERA),
    { ok: false, error: 'No active camera to focus' },
  );
  assert.deepEqual(
    cctvVoiceFocusOutcome(CCTV_FOCUS_RESULT.FOCUSED),
    { ok: true, error: null },
  );
});

test('voice CCTV focus reports Drone View ownership', () => {
  assert.deepEqual(
    cctvVoiceFocusOutcome(CCTV_FOCUS_RESULT.DRONE_VIEW_ACTIVE),
    {
      ok: false,
      error: 'Exit Drone View to fly to a camera',
    },
  );
  assert.deepEqual(
    cctvVoiceFocusOutcome(CCTV_FOCUS_RESULT.DRONE_VIEW_ACTIVE, { cameraSelected: true }),
    {
      ok: false,
      error: 'Camera selected; exit Drone View to fly to it',
    },
  );
});

test('set_context_mode forwards cancellation authority and reports a stale turn', async () => {
  globalThis.window = globalThis.window || { clearTimeout, setTimeout, requestIdleCallback: null };
  const controller = new AbortController();
  let receivedOptions = null;
  const styleManager = {
    getContextModeState: () => ({ mode: null, active: false, changing: false }),
    setPanelCollapsed() {},
    async setContextMode(_mode, options) {
      receivedOptions = options;
      controller.abort();
      return { ok: false, mode: null };
    },
  };
  const viewer = {
    clock: { onTick: { addEventListener: () => () => {} } },
    scene: { canvas: { addEventListener() {}, removeEventListener() {} } },
    camera: { moveEnd: { addEventListener() {} } },
  };
  const runner = createGevActionRunner({
    viewer,
    styleManager,
    dataManager: { layers: new Map(), getAll: () => [] },
  });
  const result = await runner('set_context_mode', { mode: 'contacts' }, {
    signal: controller.signal,
    isCurrent: () => !controller.signal.aborted,
  });
  assert.equal(receivedOptions.signal, controller.signal);
  assert.equal(result.ok, false);
  assert.equal(result.cancelled, true);
  // State output speaks the tools' own vocabulary: no context reads as 'off',
  // the word set_context_mode accepts, with the internal id kept alongside.
  assert.equal(result.mode, 'off');
  assert.equal(result.modeInternal, null);
  assert.equal(result.active, false);
  assert.equal(result.changing, false);
});

test('opening Contacts expands Context before activation and returns its settled aircraft window', async () => {
  globalThis.window = globalThis.window || { clearTimeout, setTimeout, requestIdleCallback: null };
  const order = [];
  const contactsWindow = {
    centeredOn: 'SWA2120',
    radiusKm: 250,
    aircraft: 17,
    flights: 14,
    military: 3,
    vessels: 2,
  };
  const styleManager = {
    getContextModeState: () => ({ mode: 'flights', active: true, changing: false }),
    setPanelCollapsed(panelId, collapsed) {
      order.push(`panel:${panelId}:${collapsed ? 'closed' : 'open'}`);
    },
    async setContextMode(mode) {
      order.push(`mode:${mode}`);
      return {
        ok: true,
        action: 'set_context_mode',
        mode: 'flights',
        active: true,
        contactsWindow,
      };
    },
  };
  const viewer = {
    clock: { onTick: { addEventListener: () => () => {} } },
    scene: { canvas: { addEventListener() {}, removeEventListener() {} } },
    camera: { moveEnd: { addEventListener() {} } },
  };
  const runner = createGevActionRunner({
    viewer,
    styleManager,
    dataManager: { layers: new Map(), getAll: () => [] },
  });
  const result = await runner('set_context_mode', { mode: 'contacts' });
  assert.deepEqual(order, [
    'panel:global-context-panel:open',
    'mode:flights',
  ]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.contactsWindow, contactsWindow);
  assert.equal(result.contactsWindow.aircraft, 17);
});

test('set_context_mode pre-dispatch cancellation includes authoritative Context state', async () => {
  globalThis.window = globalThis.window || { clearTimeout, setTimeout, requestIdleCallback: null };
  const controller = new AbortController();
  controller.abort();
  const styleManager = {
    getContextModeState: () => ({ mode: 'flights', active: true, changing: false }),
    setContextMode: () => assert.fail('cancelled request must not dispatch'),
  };
  const viewer = {
    clock: { onTick: { addEventListener: () => () => {} } },
    scene: { canvas: { addEventListener() {}, removeEventListener() {} } },
    camera: { moveEnd: { addEventListener() {} } },
  };
  const runner = createGevActionRunner({
    viewer,
    styleManager,
    dataManager: { layers: new Map(), getAll: () => [] },
  });
  const result = await runner('set_context_mode', { mode: 'contacts' }, {
    signal: controller.signal,
  });
  assert.deepEqual(result, {
    ok: false,
    action: 'set_context_mode',
    cancelled: true,
    error: 'Context request was cancelled before it could run',
    // Authoritative state, reported in the vocabulary the tool accepts.
    mode: 'contacts',
    modeInternal: 'flights',
    active: true,
    changing: false,
  });
});

test('voice CCTV select, next, prev, and nearest report tracking-refused flights after selection', async () => {
  const calls = [];
  let activeCameraId = 'cam-a';
  const cameras = [
    { id: 'cam-a', name: 'Camera A' },
    { id: 'cam-b', name: 'Camera B' },
  ];
  const cctv = {
    getUIState() {
      return {
        activeCameraId,
        activeCamera: cameras.find((camera) => camera.id === activeCameraId),
        cameras,
      };
    },
    selectCamera(id, options) {
      calls.push(['select', id, options]);
      activeCameraId = id;
      return true;
    },
    cycleCamera(step, options) {
      calls.push(['cycle', step, options]);
      activeCameraId = step > 0 ? 'cam-b' : 'cam-a';
      return activeCameraId;
    },
    focusNearest(options) {
      calls.push(['nearest', options]);
      activeCameraId = 'cam-a';
      return activeCameraId;
    },
    focusCamera(id, durationSec) {
      calls.push(['focus', id, durationSec]);
      return CCTV_FOCUS_RESULT.TRACKING_HOLDS_VIEW;
    },
  };
  const dataManager = {
    layers: new Map([['cctv', { module: cctv }]]),
    isEnabled: () => true,
  };

  for (const args of [
    { action: 'select', cameraQuery: 'Camera B' },
    { action: 'next' },
    { action: 'prev' },
    { action: 'nearest' },
  ]) {
    const result = await controlCctv(dataManager, args);
    assert.equal(result.ok, false);
    assert.equal(
      result.error,
      'Camera selected; tracking holds the view — say untrack to fly',
    );
  }

  assert.deepEqual(calls, [
    ['select', 'cam-b', undefined],
    ['focus', 'cam-b', 1.8],
    ['cycle', 1, undefined],
    ['focus', 'cam-b', 1.8],
    ['cycle', -1, undefined],
    ['focus', 'cam-a', 1.8],
    ['nearest', { focus: false }],
    ['focus', 'cam-a', 1.8],
  ]);
});

test('voice CCTV coverage writes the canonical durable coverage mode', async () => {
  let coverageMode = 'viewshed';
  const calls = [];
  const cctv = {
    getUIState: () => ({
      coverageMode,
      showCoverage: coverageMode !== 'off',
    }),
  };
  const dataManager = {
    layers: new Map([['cctv', { module: cctv }]]),
    isEnabled: () => true,
    setLayerParams(layerId, params, options) {
      calls.push([layerId, params, options]);
      coverageMode = params.coverageMode;
    },
  };

  let result = await controlCctv(dataManager, { action: 'coverage' });
  assert.equal(result.coverageMode, 'off');

  result = await controlCctv(dataManager, { action: 'coverage', enabled: true });
  assert.equal(result.coverageMode, 'on');
  assert.deepEqual(calls, [
    ['cctv', { coverageMode: 'off' }, { origin: 'voice' }],
    ['cctv', { coverageMode: 'on' }, { origin: 'voice' }],
  ]);
});


function contextClaimProbe() {
  const calls = [];
  let contextMode = null;
  const styleManager = {
    getContextModeState: () => ({ mode: contextMode, active: contextMode !== null, changing: false }),
    setPanelCollapsed() {},
    setContextMode: async (mode, options = {}) => {
      calls.push({ mode, claimVisualAuthority: options.claimVisualAuthority });
      contextMode = mode;
      return { ok: true, mode, active: mode !== null };
    },
  };
  const viewer = {
    clock: { onTick: { addEventListener: () => () => {} } },
    scene: { canvas: { addEventListener() {}, removeEventListener() {} } },
    camera: { moveEnd: { addEventListener() {} } },
  };
  const runner = createGevActionRunner({
    viewer,
    styleManager,
    dataManager: { layers: new Map(), isEnabled: () => false, getAll: () => [] },
  });
  return { runner, calls };
}

test('a genuine set_context_mode request DOES claim the visual lane', async () => {
  globalThis.window = globalThis.window || { clearTimeout, setTimeout, requestIdleCallback: null };
  const probe = contextClaimProbe();
  await probe.runner('set_context_mode', { mode: 'contacts' });

  assert.equal(probe.calls.length, 1);
  // The operator's own request must take authority: undefined (the facade
  // default) or an explicit true both mean "claim".
  assert.notEqual(
    probe.calls[0].claimVisualAuthority,
    false,
    'an operator Context request must not opt out of claiming',
  );
});

/**
 * Viewer stub for the moveEnd prewarm: enough scene graph for
 * `createGevActionRunner` to install its listeners, with every pick under the
 * test's control.
 */
function createPrewarmHarness({ pickPosition, positionCartographic } = {}) {
  const calls = { pickPosition: 0, pickEllipsoid: 0, getPickRay: 0 };
  const position = Cesium.Cartesian3.fromDegrees(-97.74, 30.26, 900_000);
  const surface = Cesium.Cartesian3.fromDegrees(-97.74, 30.26, 0);
  let moveEndListener = null;
  const camera = {
    moveEnd: { addEventListener(listener) { moveEndListener = listener; } },
    positionWC: position,
    heading: Cesium.Math.toRadians(28),
    pitch: Cesium.Math.toRadians(-45),
    pickEllipsoid() { calls.pickEllipsoid += 1; return surface; },
    getPickRay() { calls.getPickRay += 1; return null; },
    cancelFlight() {},
    flyToBoundingSphere() {},
    lookAtTransform() {},
  };
  Object.defineProperty(camera, 'positionCartographic', {
    get: positionCartographic || (() => Cesium.Cartographic.fromCartesian(position)),
  });
  const viewer = {
    clock: { onTick: { addEventListener: () => () => {} } },
    camera,
    scene: {
      canvas: {
        clientWidth: 1200,
        clientHeight: 800,
        addEventListener() {},
        removeEventListener() {},
      },
      globe: undefined,
      tweens: [],
      pickPositionSupported: true,
      pickPosition(...args) {
        calls.pickPosition += 1;
        return pickPosition ? pickPosition(...args) : surface;
      },
    },
  };
  return { viewer, calls, fireMoveEnd: () => moveEndListener?.(), hasListener: () => !!moveEndListener };
}

/** Drive the prewarm's debounce + idle callback by hand, deterministically. */
function withCapturedTimers(run) {
  globalThis.window = globalThis.window || {};
  const saved = {
    setTimeout: globalThis.window.setTimeout,
    clearTimeout: globalThis.window.clearTimeout,
    requestIdleCallback: globalThis.window.requestIdleCallback,
  };
  const debounced = [];
  const idle = [];
  const debugLines = [];
  const savedDebug = console.debug;
  globalThis.window.setTimeout = (fn) => { debounced.push(fn); return debounced.length; };
  globalThis.window.clearTimeout = () => {};
  globalThis.window.requestIdleCallback = (fn) => { idle.push(fn); return idle.length; };
  console.debug = (...args) => { debugLines.push(args.map(String).join(' ')); };
  try {
    return run({
      debounced,
      idle,
      debugLines,
      /** moveEnd → 120 ms debounce → requestIdleCallback → the prewarm itself. */
      flush: () => {
        while (debounced.length) debounced.shift()();
        while (idle.length) idle.shift()();
      },
    });
  } finally {
    console.debug = savedDebug;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete globalThis.window[key];
      else globalThis.window[key] = value;
    }
  }
}

test('a degenerate depth pick does not escape the view-target prewarm', () => {
  // The demo path: a plain camera flight, no scene and no tracking. Over empty
  // sky the depth pick comes back as NaN; converting that used to throw
  // `DeveloperError: normalized result is not a number` from inside
  // requestIdleCallback, where nothing could catch it — a red console error on
  // first impression.
  const degenerate = new Cesium.Cartesian3(Number.NaN, Number.NaN, Number.NaN);
  withCapturedTimers(({ flush, debugLines }) => {
    const harness = createPrewarmHarness({ pickPosition: () => degenerate });
    createGevActionRunner({
      viewer: harness.viewer,
      styleManager: {},
      dataManager: { layers: new Map(), isEnabled: () => false, getAll: () => [] },
    });
    assert.ok(harness.hasListener(), 'the prewarm must register a moveEnd listener');

    harness.fireMoveEnd();
    assert.doesNotThrow(flush, 'a degenerate pick must not throw out of the idle callback');

    assert.equal(harness.calls.pickPosition, 1, 'the prewarm must actually have picked');
    // A degenerate pick is a MISSED pick, so the cascade continues instead of
    // carrying nonsense forward. Before the fix the NaN Cartesian was truthy
    // and short-circuited every fallback.
    assert.equal(harness.calls.pickEllipsoid, 1, 'a degenerate pick must fall through to the ellipsoid');
    assert.deepEqual(debugLines, [], 'the guard handles this — the backstop must stay quiet');
  });
});

test('an unexpected prewarm failure is logged once at debug level, never thrown', () => {
  // Belt and braces: the guard is the fix, but an idle callback is an uncaught
  // context, so a surprise from anywhere in the scene graph must still be
  // swallowed — and must not spam the console when its cause repeats.
  withCapturedTimers(({ flush, debugLines }) => {
    const harness = createPrewarmHarness({
      positionCartographic: () => { throw new Error('scene graph is mid-teardown'); },
    });
    createGevActionRunner({
      viewer: harness.viewer,
      styleManager: {},
      dataManager: { layers: new Map(), isEnabled: () => false, getAll: () => [] },
    });

    for (let i = 0; i < 3; i += 1) {
      harness.fireMoveEnd();
      assert.doesNotThrow(flush, `prewarm pass ${i + 1} must not throw`);
    }

    assert.equal(debugLines.length, 1, 'reported once per viewer, not once per move');
    assert.match(debugLines[0], /view-target prewarm skipped/);
    assert.match(debugLines[0], /scene graph is mid-teardown/);
  });
});


test('an absent secondary mode stays absent instead of claiming to be off', async () => {
  globalThis.window = globalThis.window || { clearTimeout, setTimeout, requestIdleCallback: null };
  const styleManager = {
    getContextModeState: () => ({ mode: 'flights', active: true, changing: false, entering: null }),
    setPanelCollapsed() {},
    async setContextMode() {
      return { ok: true, action: 'set_context_mode', mode: 'flights', active: true, entering: null };
    },
  };
  const viewer = {
    clock: { onTick: { addEventListener: () => () => {} } },
    scene: { canvas: { addEventListener() {}, removeEventListener() {} } },
    camera: { moveEnd: { addEventListener() {} } },
  };
  const runner = createGevActionRunner({
    viewer,
    styleManager,
    dataManager: { layers: new Map(), getAll: () => [] },
  });
  const result = await runner('set_context_mode', { mode: 'contacts' });
  assert.equal(result.mode, 'contacts');
  assert.equal(
    result.entering,
    null,
    'nothing is entering — calling that "off" would assert a transition that is not happening',
  );
});

/**
 * Front 5 (owner's live trial, 2026-08-22 01:42-01:44). Contacts was active
 * with contact N546PC as its subject, a DATACENTER sat in the recency slot,
 * and "how many nearby" produced 15 from a radius centred on the datacenter
 * while the panel showed 111. Two causes: the wrong centre, and two different
 * computations for one question (the panel's live-position window vs the
 * analyst's 2 000-record last-fix slice). These pin the unified engine.
 */
function awarenessSubjectHarness({ subject, flights = [], military = [] }) {
  const position = subject ? { __subject: true } : null;
  return {
    snapshot: subject ? { subject: { ...subject, position }, radiusM: 250_000, cohorts: [] } : null,
    flights,
    military,
  };
}

async function withAwareness(harness, run) {
  const awareness = (await import('../data/militaryAwareness.js')).default;
  const flightsLayer = (await import('../data/flights.js')).default;
  const militaryLayer = (await import('../data/militaryFlights.js')).default;
  const originals = {
    snapshot: awareness.getContextSnapshot,
    flightsNearby: flightsLayer.getNearby,
    militaryNearby: militaryLayer.getNearby,
    cartoFrom: Cesium.Cartographic.fromCartesian,
  };
  awareness.getContextSnapshot = () => harness.snapshot;
  flightsLayer.getNearby = () => harness.flights.slice();
  militaryLayer.getNearby = () => harness.military.slice();
  Cesium.Cartographic.fromCartesian = (value) => (
    value?.__subject
      ? { latitude: Cesium.Math.toRadians(29.9), longitude: Cesium.Math.toRadians(-97.9), height: 9000 }
      : originals.cartoFrom(value)
  );
  try {
    return await run();
  } finally {
    awareness.getContextSnapshot = originals.snapshot;
    flightsLayer.getNearby = originals.flightsNearby;
    militaryLayer.getNearby = originals.militaryNearby;
    Cesium.Cartographic.fromCartesian = originals.cartoFrom;
  }
}

function analystRunner() {
  const flights = {
    id: 'flights',
    // Deliberately a DIFFERENT population from the proximity window: this is
    // the record slice the old engine counted, and the unified answer must not
    // come from it.
    getAnalystRecords: () => ([
      { id: 'STALE1', icao24: 'aaa001', lat: 29.9, lon: -97.9 },
    ]),
  };
  const viewer = {
    clock: { onTick: { addEventListener: () => () => {} } },
    scene: { canvas: { addEventListener() {}, removeEventListener() {} } },
    camera: {
      moveEnd: { addEventListener() {} },
      positionCartographic: { height: 300_000, latitude: 0.52, longitude: -1.71 },
    },
  };
  return createGevActionRunner({
    viewer,
    styleManager: {},
    dataManager: {
      layers: new Map([['flights', { module: flights }]]),
      isEnabled: (id) => id === 'flights',
      getAll: () => [{ id: 'flights', name: 'Live Flights', enabled: true, stats: { count: 1 } }],
    },
  });
}

test('front5: a nearby ask centres on the Contacts SUBJECT, not the selected datacenter', async () => {
  globalThis.window = globalThis.window || { clearTimeout, setTimeout, requestIdleCallback: null };
  const harness = awarenessSubjectHarness({
    subject: { id: 'a1b2c3', label: 'N546PC' },
    flights: Array.from({ length: 111 }, (_, i) => ({ id: `F${i}`, icao24: `f${i}`, distance: 1000 * i })),
    military: Array.from({ length: 5 }, (_, i) => ({ id: `M${i}`, icao24: `m${i}`, distance: 500 * i })),
  });
  await withAwareness(harness, async () => {
    const runner = analystRunner();
    const result = await runner('analyst_query', {
      layers: ['flights', 'military'],
      // The centre the model reached for in the field: the selected datacenter.
      scope: { kind: 'radius', km: 250, center: { lat: 29.429371, lon: -98.486908 } },
    });
    assert.equal(result.ok, true);
    // A centre that is NOT the subject is answered where it was asked, and is
    // NOT silently re-pointed at the subject.
    assert.match(result.coverage.scope, /^radius:250km/);
    const subjectCentred = await runner('analyst_query', {
      layers: ['flights', 'military'],
      scope: { kind: 'radius', km: 250 },
    });
    assert.equal(subjectCentred.count, 116, 'the subject-centred count is the window cohort');
    assert.equal(subjectCentred.scopeLabel, 'within 250 km of N546PC');
    assert.equal(subjectCentred.window.engine, 'contacts-window');
    assert.equal(subjectCentred.window.centeredOn, 'N546PC');
  });
});

test('front5: the spoken count and the panel window are ONE number by construction', async () => {
  globalThis.window = globalThis.window || { clearTimeout, setTimeout, requestIdleCallback: null };
  const { collectAircraftProximityWindow } = await import('../data/militaryAwareness.js');
  const harness = awarenessSubjectHarness({
    subject: { id: 'a1b2c3', label: 'N546PC' },
    flights: Array.from({ length: 111 }, (_, i) => ({ id: `F${i}`, icao24: `f${i}` })),
    military: Array.from({ length: 5 }, (_, i) => ({ id: `M${i}`, icao24: `m${i}` })),
  });
  await withAwareness(harness, async () => {
    // What the PANEL computes for this subject...
    const panel = collectAircraftProximityWindow(harness.snapshot.subject.position, {
      subject: harness.snapshot.subject,
    });
    // ...and what VOICE answers for the same subject.
    const spoken = await analystRunner()('analyst_query', {
      layers: ['flights', 'military'],
      scope: { kind: 'radius', km: 250 },
    });
    assert.equal(
      spoken.count,
      panel.aircraft,
      'one engine, two consumers — these can never disagree again',
    );
    assert.equal(spoken.window.flights, panel.flights.length);
    assert.equal(spoken.window.military, panel.military.length);
  });
});

test('front5: Contacts active with NO subject falls back to the view, not an empty panel', async () => {
  globalThis.window = globalThis.window || { clearTimeout, setTimeout, requestIdleCallback: null };
  const harness = awarenessSubjectHarness({ subject: null });
  await withAwareness(harness, async () => {
    const result = await analystRunner()('analyst_query', {
      layers: ['flights'],
      scope: { kind: 'radius', km: 250 },
    });
    assert.equal(result.ok, true);
    assert.notEqual(result.window?.engine, 'contacts-window', 'there is no window to read');
    assert.match(result.coverage.scope, /^radius:250km$/, 'and it is not named after a subject that does not exist');
    assert.equal(result.contactsWindowCount, undefined);
  });
});

test('front5: an explicit region still uses the region engine while Contacts is active', async () => {
  globalThis.window = globalThis.window || { clearTimeout, setTimeout, requestIdleCallback: null };
  const harness = awarenessSubjectHarness({
    subject: { id: 'a1b2c3', label: 'N546PC' },
    flights: Array.from({ length: 111 }, (_, i) => ({ id: `F${i}`, icao24: `f${i}` })),
  });
  await withAwareness(harness, async () => {
    const result = await analystRunner()('analyst_query', {
      layers: ['flights'],
      scope: { kind: 'region', name: 'Texas' },
    });
    assert.notEqual(result.window?.engine, 'contacts-window', 'an explicit place wins over Contacts state');
    assert.ok(
      String(result.coverage?.scope || result.error || '').includes('region'),
      'and is answered by the region engine',
    );
  });
});


/**
 * The centre test decides whether a nearby ask is answered from the Contacts
 * window or as a general query about somewhere else. A lat/lon delta BOX gets
 * that wrong in both directions, so these pins sit exactly where a box and a
 * true distance disagree — anywhere else, both agree and prove nothing.
 * Subject is at (29.9, -97.9); 1 deg lat ~= 111.19 km, 1 deg lon ~= 96.5 km there.
 */
function subjectWindowHarness() {
  return awarenessSubjectHarness({
    subject: { id: 'a1b2c3', label: 'N546PC' },
    flights: Array.from({ length: 111 }, (_, i) => ({ id: `F${i}`, icao24: `f${i}` })),
    military: Array.from({ length: 5 }, (_, i) => ({ id: `M${i}`, icao24: `m${i}` })),
  });
}

test('front5: the box DIAGONAL is not the subject — 1.32 km away is somewhere else', async () => {
  // Both deltas are under 0.01, so a box calls this the subject. The real
  // separation is 1.32 km. This is the case the coordinator flagged: a centre
  // far enough to be a different place, slipping through on the diagonal.
  globalThis.window = globalThis.window || { clearTimeout, setTimeout, requestIdleCallback: null };
  await withAwareness(subjectWindowHarness(), async () => {
    const result = await analystRunner()('analyst_query', {
      layers: ['flights', 'military'],
      scope: { kind: 'radius', km: 250, center: { lat: 29.9 + 0.009, lon: -97.9 + 0.009 } },
    });
    assert.notEqual(
      result.window?.engine,
      'contacts-window',
      '1.32 km away must not be answered as the subject’s window',
    );
    // And it must not masquerade: the payload names the engine that ran.
    assert.match(result.coverage.scope, /^radius:250km/);
    assert.notEqual(result.count, 116, 'a different place gets a different answer');
  });
});

test('front5: 0.99 km due EAST is the subject, though a degree box rejects it', async () => {
  // A degree of longitude is short at this latitude, so 0.0103 deg is only
  // 0.99 km — inside 1 km — yet over the 0.01 box threshold. A box would send
  // the operator a different, smaller number for a centre that IS the contact.
  globalThis.window = globalThis.window || { clearTimeout, setTimeout, requestIdleCallback: null };
  await withAwareness(subjectWindowHarness(), async () => {
    const result = await analystRunner()('analyst_query', {
      layers: ['flights', 'military'],
      scope: { kind: 'radius', km: 250, center: { lat: 29.9, lon: -97.9 + 0.0103 } },
    });
    assert.equal(result.window?.engine, 'contacts-window', '0.99 km away IS the subject');
    assert.equal(result.count, 116, 'and gets the window number the panel shows');
    assert.equal(result.window.centeredOn, 'N546PC');
  });
});
