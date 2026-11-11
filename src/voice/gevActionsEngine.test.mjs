// The W1 voice actions on the globe engine: the same
// results as on the Cesium viewer, through engine.camera / picker /
// projector only, and a structured refusal when a required capability
// is missing from the attached scene.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import * as geo from '../geo/index.js';
import { createFakeEngine } from '../globe/testing/fakeEngine.js';
import { GEV_ACTION_SCHEMAS } from './actionSchemas.js';
import {
  UNAVAILABLE_FEATURES,
  UNAVAILABLE_ON_ENGINE,
  createGevActionRunner,
} from './gevActions.js';
import { cameraPoseKey } from './pointerContext.js';
import { createPointerPicker } from './pointerPick.js';
import { renderFreshFrame } from './realtimeViewport.js';

globalThis.window ||= {
  setTimeout,
  clearTimeout,
  requestIdleCallback: null,
};

const toRad = geo.math.toRadians;

/** A fake engine over Austin at `altitude`, looking straight down. */
function engineOverAustin(options = {}) {
  return createFakeEngine({
    longitude: toRad(-97.74),
    latitude: toRad(30.27),
    altitude: 20_000,
    ...options,
  });
}

/** The UI navigation seam, without its policy: runs the move. */
const navigatingStyleManager = (extra = {}) => ({
  runImmediateNavigation: (noun, navigate) => navigate(),
  ...extra,
});

function dataManagerWith(modules, { enabled = Object.keys(modules) } = {}) {
  const on = new Set(enabled);
  const params = [];
  return {
    params,
    layers: new Map(
      Object.entries(modules).map(([id, module]) => [id, { id, module }]),
    ),
    isEnabled: (id) => on.has(id),
    getAll: () =>
      Object.keys(modules).map((id) => ({
        id,
        name: id,
        enabled: on.has(id),
        stats: modules[id]?.getStats?.() || {},
      })),
    setLayerParams(id, values) {
      params.push({ id, values });
      return true;
    },
    async setEnabled(id, value) {
      if (value) on.add(id);
      else on.delete(id);
      return true;
    },
  };
}

const runnerOn = (engine, options = {}) =>
  createGevActionRunner({
    viewer: null,
    engine,
    styleManager: navigatingStyleManager(),
    dataManager: dataManagerWith({}),
    ...options,
  });

const follow = (engine, position) =>
  engine.camera.follow({
    position: () => position,
    viewFrom: { x: 0, y: -2000, z: 800 },
  });

test('every capability-gated action is a real offered tool', () => {
  const tools = new Set(GEV_ACTION_SCHEMAS.map((schema) => schema.name));
  for (const name of Object.keys(UNAVAILABLE_FEATURES))
    assert.ok(tools.has(name), `${name} is a voice tool`);
});

for (const kind of ['cesium', 'navara'])
  test(`${kind} enters cockpit on a ready tracked aircraft without starting Contacts`, async () => {
    const engine = engineOverAustin({ kind });
    const runner = runnerOn(engine, {
      styleManager: {
        getCockpitState: () => ({ entryAllowed: true }),
        getAircraftTrackingTarget: () => ({ layerId: 'flights', id: '507c84' }),
        setContextMode: () =>
          assert.fail('the selected flight already owns the camera'),
        controlCockpit: (action, { rollbackTarget }) => {
          assert.equal(action, 'enter');
          assert.equal(rollbackTarget.id, '507c84');
          return { ok: true, state: { active: true } };
        },
      },
    });
    const result = await runner('control_cockpit', { action: 'enter' });
    assert.equal(result.ok, true);
    assert.equal(result.state.active, true);
  });

test('missing scene capabilities refuse with a structured result', async () => {
  const engine = engineOverAustin({ kind: 'navara' });
  const touched = [];
  const styleManager = new Proxy(navigatingStyleManager(), {
    get(target, key) {
      if (typeof key === 'string') touched.push(key);
      return target[key];
    },
  });
  engine.destroy();
  const runner = runnerOn(engine, { styleManager });
  // The runner subscribes to camera handoffs when it is made.
  touched.length = 0;
  engine.fake.resetCalls();
  for (const name of [
    'annotate_map',
    'clear_annotations',
    'fly_route',
    'move_camera',
  ]) {
    const result = await runner(name, { action: 'status' });
    assert.equal(result.ok, false, name);
    assert.equal(result.action, name);
    assert.equal(result.unavailable, true, name);
    assert.equal(result.code, UNAVAILABLE_ON_ENGINE, name);
    assert.equal(result.engine, 'navara', name);
    assert.equal(result.feature, UNAVAILABLE_FEATURES[name], name);
    assert.equal(result.suggestion, '?engine=cesium', name);
    assert.equal(
      result.error,
      `${UNAVAILABLE_FEATURES[name]} is not available on the Navara engine yet. Switch to the Cesium engine (?engine=cesium) to use it.`,
      name,
    );
  }
  assert.deepEqual(touched, [], 'a refusal reaches no controller');
  assert.deepEqual(engine.fake.calls, [], 'a refusal moves no camera');
});

test('with a viewer radio still reports a missing layer', async () => {
  const runner = createGevActionRunner({
    viewer: {
      clock: { onTick: { addEventListener: () => () => {} } },
      scene: { canvas: { addEventListener() {}, removeEventListener() {} } },
      camera: { moveEnd: { addEventListener() {} } },
    },
    engine: engineOverAustin({ visualStyles: { thermal: [] } }),
    styleManager: {},
    dataManager: dataManagerWith({}),
  });
  const radio = await runner('control_radio', { action: 'status' });
  assert.equal(radio.error, 'Radio layer unavailable');
  assert.equal(radio.unavailable, undefined);
});

test('the runner warms the view target on the engine camera, once per engine', () => {
  const engine = engineOverAustin({ kind: 'navara' });
  runnerOn(engine);
  runnerOn(engine);
  assert.equal(engine.camera.moveEnd.numberOfListeners, 1);
});

test('stop_tracking stops the engine follow', async () => {
  const engine = engineOverAustin({ kind: 'navara' });
  const target = geo.cartesian3.fromDegrees(-97.7, 30.3, 9000);
  follow(engine, target);
  assert.ok(engine.camera.following());
  const released = [];
  const runner = runnerOn(engine, {
    dataManager: dataManagerWith({
      flights: {
        getTrackedInfo: () => ({ id: 'abc' }),
        stopTracking: () => released.push('flights'),
      },
    }),
  });
  const result = await runner('stop_tracking');
  assert.equal(result.ok, true);
  assert.deepEqual(result.released, ['flights']);
  assert.equal(engine.camera.following(), null);
});

test('zoom_to_globe leaves the follow and flies the engine camera', async () => {
  const engine = engineOverAustin({ kind: 'navara' });
  follow(engine, geo.cartesian3.fromDegrees(-97.7, 30.3, 9000));
  const runner = runnerOn(engine);
  const result = await runner('zoom_to_globe');
  assert.equal(result.ok, true);
  assert.equal(result.heightKm > 1000, true);
  assert.equal(engine.camera.following(), null);
  assert.equal(engine.fake.callsOf('camera.flyTo').length, 1);
});

test('fly_to_location to coordinates leaves the follow and flies the engine', async () => {
  const engine = engineOverAustin({ kind: 'navara' });
  follow(engine, geo.cartesian3.fromDegrees(-97.7, 30.3, 9000));
  const runner = runnerOn(engine);
  const result = await runner('fly_to_location', {
    latitude: 51.5,
    longitude: -0.12,
  });
  assert.equal(result.ok, true);
  assert.equal(result.navigationMode, 'close-coordinate');
  assert.equal(engine.camera.following(), null);
  assert.equal(engine.fake.callsOf('camera.flyToSphere').length, 1);
  engine.fake.frames(400, 16);
  const place = engine.camera.pose().cartographic;
  assert.ok(Math.abs(geo.math.toDegrees(place.latitude) - 51.5) < 0.05);
});

test('track_entity flies to a vessel through the engine', async () => {
  const engine = engineOverAustin({ kind: 'navara' });
  let selected = null;
  const runner = runnerOn(engine, {
    dataManager: dataManagerWith({
      'ais-live-vessels': {
        findByQuery: () => ({
          mmsi: 366999999,
          name: 'EVER GIVEN',
          latitude: 29.7,
          longitude: -95.0,
        }),
        selectById: (mmsi) => (selected = mmsi),
      },
    }),
  });
  const result = await runner('track_entity', {
    query: 'ever given',
    layerId: 'ais-live-vessels',
  });
  assert.equal(result.ok, true);
  assert.equal(result.label, 'EVER GIVEN');
  assert.equal(selected, 366999999);
  assert.equal(engine.fake.callsOf('camera.flyToSphere').length, 1);
});

test('track_entity selects a vessel UUID before its MMSI on either engine', async (t) => {
  const id = '0770e3ca-b896-c307-f499-4f9df2b8f86b';
  for (const kind of ['cesium', 'navara']) {
    const engine = engineOverAustin({ kind });
    t.after(() => engine.destroy());
    let selected = null;
    const runner = runnerOn(engine, {
      dataManager: dataManagerWith({
        'ais-live-vessels': {
          findByQuery: () => ({
            id,
            mmsi: '366999999',
            name: 'EVER GIVEN',
            latitude: 29.7,
            longitude: -95.0,
          }),
          selectById: (value) => (selected = value),
        },
      }),
    });
    const result = await runner('track_entity', {
      query: id,
      layerId: 'ais-live-vessels',
    });
    assert.equal(result.ok, true);
    assert.equal(selected, id);
    assert.equal(engine.fake.callsOf('camera.flyToSphere').length, 1);
  }
});

test('frame_overhead frames the nearby contacts with flyToSphere as on Cesium', async () => {
  const engine = engineOverAustin({ kind: 'navara' });
  const center = engine.camera.pickEllipsoid({ x: 512, y: 384 });
  const positions = [
    geo.cartesian3.fromDegrees(-97.7, 30.3, 9000),
    geo.cartesian3.fromDegrees(-97.9, 30.1, 11000),
    geo.cartesian3.fromDegrees(-97.5, 30.5, 10000),
  ];
  let asked = null;
  const runner = runnerOn(engine, {
    dataManager: dataManagerWith({
      flights: {
        getNearby(at, radiusM, limit) {
          asked = { at, radiusM, limit };
          return positions.map((position, index) => ({
            id: `F${index}`,
            icao24: `a${index}`,
            label: `F${index}`,
            position,
          }));
        },
      },
    }),
  });
  const heading = engine.camera.pose().heading;
  const result = await runner('frame_overhead', { target: 'flights' });
  assert.equal(result.ok, true);
  assert.equal(result.count, 3);
  assert.equal(asked.radiusM, 150_000);
  assert.equal(asked.limit, 80);
  assert.ok(geo.cartesian3.distance(asked.at, center) < 1e-6);
  // The same sphere and offset the Cesium path flew.
  const sphere = Cesium.BoundingSphere.fromPoints(positions);
  const radius = Math.max(sphere.radius * 1.25, 8000);
  const [call] = engine.fake.callsOf('camera.flyToSphere');
  const [flown, options] = call.args;
  assert.ok(geo.cartesian3.distance(flown.center, sphere.center) < 1e-6);
  assert.equal(flown.radius, radius);
  assert.equal(options.duration, 2);
  assert.equal(options.heading, heading);
  assert.equal(options.pitch, toRad(-62));
  assert.equal(options.range, radius * 2.4);
});

test('next_iss_pass observes from the engine camera', async () => {
  const engine = engineOverAustin({ kind: 'navara' });
  let observer = null;
  const runner = runnerOn(engine, {
    dataManager: dataManagerWith({
      satellites: {
        getNextIssPass(options) {
          observer = options;
          return { status: 'none' };
        },
      },
    }),
  });
  const result = await runner('next_iss_pass');
  assert.equal(result.ok, false);
  assert.ok(Math.abs(observer.latDeg - 30.27) < 1e-6);
  assert.ok(Math.abs(observer.lonDeg + 97.74) < 1e-6);
});

test('get_current_view_state reads the engine camera', async () => {
  const engine = engineOverAustin({ kind: 'navara' });
  const runner = runnerOn(engine, {
    styleManager: navigatingStyleManager({ activeStyle: 'noir' }),
  });
  const result = await runner('get_current_view_state');
  assert.equal(result.ok, true);
  assert.ok(Math.abs(result.camera.latitude - 30.27) < 1e-6);
  assert.ok(Math.abs(result.camera.longitude + 97.74) < 1e-6);
  assert.ok(Math.abs(result.camera.heightM - 20_000) < 1e-3);
});

test('adjust_camera_zoom moves the engine camera toward the view target', async () => {
  const engine = engineOverAustin({ kind: 'navara' });
  const runner = runnerOn(engine);
  const result = await runner('adjust_camera_zoom', {
    direction: 'in',
    amount: 'medium',
  });
  assert.equal(result.ok, true);
  assert.equal(result.movementRequestedM, 11_000);
  assert.equal(result.movementActualM, 11_000);
  assert.equal(result.afterHeightM, 9000);
  assert.equal(engine.fake.callsOf('camera.cancelFlight').length, 1);
});

test('get_entity_context samples the view through the engine', async () => {
  // Continental: no reverse geocoding, every viewport sample on the globe.
  const engine = engineOverAustin({ kind: 'navara', altitude: 4_000_000 });
  const runner = runnerOn(engine);
  const result = await runner('get_entity_context', { scope: 'in_view' });
  assert.equal(result.ok, true);
  assert.equal(result.scene.camera.heightM, 4_000_000);
  assert.equal(result.scene.basemap.viewScale, 'continental');
  assert.equal(result.scene.basemap.viewportSamples.length, 7);
  // The view centre, on the ellipsoid under the camera.
  const [centre] = result.scene.basemap.viewportSamples;
  assert.ok(Math.abs(centre.latitude - 30.27) < 0.1);
  assert.equal(centre.longitude, -97.74);
});

test('select_nearest_aircraft runs on the engine end to end', async () => {
  const engine = engineOverAustin({ kind: 'navara' });
  let tracked = null;
  const flights = {
    getStats: () => ({ count: 2, source: 'fixture' }),
    getAnalystRecords: () => [
      {
        id: 'FAR1',
        icao24: 'f1',
        callsign: 'FAR1',
        lat: 30.4,
        lon: -97.7,
        onGround: false,
      },
      {
        id: 'NEAR1',
        icao24: 'n1',
        callsign: 'NEAR1',
        lat: 30.3,
        lon: -97.7,
        onGround: false,
      },
    ],
    findByQuery: (query) =>
      query === 'n1'
        ? { icao24: 'n1', callsign: 'NEAR1', latitude: 30.3, longitude: -97.7 }
        : null,
    trackById: (id) => (tracked = id),
  };
  const dataManager = dataManagerWith({ flights }, { enabled: [] });
  dataManager.refreshLayer = async () => true;
  const runner = runnerOn(engine, { dataManager });
  const pending = runner('select_nearest_aircraft', {
    latitude: 30.27,
    longitude: -97.74,
  });
  for (let index = 0; index < 50 && !tracked; index++) {
    engine.fake.frames(20, 16);
    await new Promise((resolve) => setImmediate(resolve));
  }
  const result = await pending;
  assert.equal(result.ok, true, result.error);
  assert.equal(result.aircraft.id, 'n1');
  assert.equal(tracked, 'n1');
});

test('the camera pose key reads the engine pose', () => {
  const engine = engineOverAustin({ kind: 'navara' });
  const { position, heading, pitch, roll } = engine.camera.pose();
  const angle = (value) => Math.round(value * 1000);
  assert.equal(
    cameraPoseKey(engine),
    [
      Math.round(position.x),
      Math.round(position.y),
      Math.round(position.z),
      angle(heading),
      angle(pitch),
      angle(roll),
    ].join(','),
  );
});

test('the pointer picker picks through the engine', () => {
  const engine = engineOverAustin({ kind: 'navara' });
  engine.fake.script('pick', { id: { __gevContextId: 'none' } });
  const pick = createPointerPicker({ engine, dataManager: null });
  const result = pick(512, 384);
  assert.equal(result.entity, null);
  assert.ok(Math.abs(result.ground.lat - 30.27) < 1e-4);
  assert.ok(Math.abs(result.ground.lon + 97.74) < 1e-4);
  assert.equal(result.radiusKm, 15);
  assert.equal(result.cameraKey, cameraPoseKey(engine));
  const [screen] = engine.fake.callsOf('picker.pick')[0].args;
  assert.deepEqual([screen.x, screen.y], [512, 384]);
});

test('a fresh frame for capture comes from the engine render loop', async () => {
  const previous = globalThis.document;
  try {
    globalThis.document = { hidden: false };
    const engine = engineOverAustin({ kind: 'navara' });
    engine.fake.resetCalls();
    const fresh = renderFreshFrame(engine);
    assert.equal(engine.fake.renderRequests, 1);
    engine.fake.frame();
    assert.equal(await fresh, true);
    globalThis.document = { hidden: true };
    assert.equal(await renderFreshFrame(engine), false);
    assert.equal(engine.fake.renderRequests, 1, 'no render while hidden');
  } finally {
    globalThis.document = previous;
  }
});

test('missing visual style and bloom capabilities refuse and record nothing', async () => {
  const engine = engineOverAustin({ kind: 'navara' });
  const calls = [];
  const styleManager = navigatingStyleManager({
    setStyle: (...args) => calls.push(['setStyle', ...args]),
    setBloom: (...args) => calls.push(['setBloom', ...args]) && {},
    setSharpen: (...args) => calls.push(['setSharpen', ...args]) && {},
  });
  const runner = runnerOn(engine, { styleManager });
  const style = await runner('set_visual_style', { style: 'thermal' });
  assert.equal(style.ok, false);
  assert.equal(style.code, UNAVAILABLE_ON_ENGINE);
  assert.match(
    style.error,
    /visual style is not available on the Navara engine/,
  );
  const post = await runner('set_post_processing', {
    bloom: { enabled: true },
  });
  assert.equal(post.ok, false);
  assert.equal(post.code, UNAVAILABLE_ON_ENGINE);
  assert.deepEqual(calls, [], 'no style is applied or recorded');
});

test('with a viewer the visual style still applies', async () => {
  const calls = [];
  const runner = createGevActionRunner({
    viewer: {
      clock: { onTick: { addEventListener: () => () => {} } },
      scene: { canvas: { addEventListener() {}, removeEventListener() {} } },
      camera: { moveEnd: { addEventListener() {} } },
    },
    engine: engineOverAustin({ visualStyles: { thermal: [] } }),
    styleManager: navigatingStyleManager({
      setStyle: (style) => calls.push(style),
    }),
    dataManager: dataManagerWith({}),
  });
  const result = await runner('set_visual_style', { style: 'thermal' });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ['thermal']);
});

test('stop_tracking with nothing tracked is a no-op success, also without the layers', async () => {
  const engine = engineOverAustin({ kind: 'navara' });
  const dataManager = dataManagerWith({
    flights: { getTrackedInfo: () => null },
  });
  // As the manager answers: a layer it does not hold takes no params.
  dataManager.setLayerParams = (id) => dataManager.layers.has(id);
  const runner = runnerOn(engine, { dataManager });
  const result = await runner('stop_tracking', {});
  assert.equal(result.ok, true);
  assert.deepEqual(result.released, []);
});
