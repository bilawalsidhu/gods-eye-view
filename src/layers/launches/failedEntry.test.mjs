// The real manager, Context coordinator and launches ingestion run against a
// stubbed /api/launches, so a failed first load takes the browser's path.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as geo from '../../geo/index.js';
import { createFakeEngine } from '../../globe/testing/fakeEngine.js';
import { DataLayerManager } from '../../data/manager.js';
import { ContextControls } from '../../ui/contextControls.js';
import { spaceMissionsIndexFailure } from '../../ui/contextActions.js';
import { createLaunchSource } from './source.js';
import { createState } from './state.js';
import { createModel } from './model.js';
import { createPolicyHelpers } from './policyHelpers.js';
import { createIngestion } from './ingestion.js';
import { createPanel } from './panel.js';
import { createControls } from './controls.js';
import { createLifecycle } from './lifecycle.js';
import { createReplay } from './replay.js';
import { createLaunchesDisplay } from './render/display.js';

const noop = () => {};

const launchRecord = {
  id: 'fixture-launch',
  name: 'Fixture mission',
  net: new Date(Date.now() - 3600000).toISOString(),
  status: { name: 'Launch Successful' },
  pad: { name: 'Fixture pad', latitude: 28.6, longitude: -80.6 },
  rocket: { payloads: [] },
};

function plainLayer(id, name, params = {}) {
  let current = { ...params };
  return {
    id,
    name,
    icon: '',
    source: 'test',
    updateInterval: -1,
    init: noop,
    enable: noop,
    disable: noop,
    update: noop,
    getParams: () => ({ ...current }),
    setParams(next) {
      current = { ...current, ...next };
      return true;
    },
  };
}

// The fake engine's camera, counted and steered as the tests need: flights
// run on its frames (land() runs them to the end), a new flight cancels the
// one in progress.
function cameraOf(engine) {
  const calls = (method) => engine.fake.callsOf(method).length;
  return {
    get flights() {
      return calls('camera.flyTo');
    },
    get cancelled() {
      return calls('camera.cancelFlight');
    },
    get flying() {
      return engine.camera.flightActive();
    },
    land: () => engine.fake.frames(400),
    flyTo: (options) => engine.camera.flyTo(options),
    setView: (view) => engine.camera.setView(view),
  };
}

async function fixture(t) {
  const upstream = { status: 429, results: [launchRecord] };
  const source = createLaunchSource({
    async fetchImpl(url) {
      if (url === '/api/celestrak/active') return new Response('');
      if (upstream.hold) await upstream.hold;
      return Response.json(
        upstream.status === 200 ? { results: upstream.results } : {},
        { status: upstream.status },
      );
    },
  });

  const services = {
    overlays: {
      setEntries: noop,
      setVisible: noop,
      clearSource: noop,
    },
    render: { holdContinuousRender: noop, releaseContinuousRender: noop },
    renderer: { create: ({ engine }) => createLaunchesDisplay(engine) },
  };
  const state = createState({ services });
  const engine = createFakeEngine({ width: 1200, height: 800 });
  // An oblique view the full-globe flight changes.
  engine.fake.setPose({
    position: geo.cartesian3.fromDegrees(10, 20, 3_000_000),
    heading: 0.1,
    pitch: -0.5,
    roll: 0,
  });
  const camera = cameraOf(engine);
  // Scene presentation is stubbed; ingestion, lifecycle and panel are real.
  const parts = {
    overlays: {
      shortMissionLabel: (name) => name,
      createReplayVehicleOverlay: noop,
      clearMissionOverlaySources: noop,
      hideReplayVehicleOverlay: noop,
      destroyReplayVehicleOverlay: noop,
      syncMissionOverlayEntries: noop,
    },
    selection: {
      focusFullGlobe(target, flight) {
        target.camera.flyTo({
          destination: geo.cartesian3.fromDegrees(30, 40, 20_000_000),
          duration: 2.4,
          ...flight,
        });
        return true;
      },
      setSelectedMission: noop,
      focusMission: noop,
      stopMissionZoomAnchor: noop,
      entityLaunchId: () => null,
    },
    orbitRendering: {
      removeMissionOrbitPrimitives: noop,
      syncMissionOrbitPrimitiveVisibility: noop,
    },
    launchPad: {
      initLaunchPadZonePrimitive: noop,
      hideLaunchPadZone: noop,
      destroyLaunchPadZonePrimitive: noop,
    },
    rendering: {
      updateMissionFrame: noop,
      addLaunchElements(record) {
        state._missionElements.set(record.id, { id: record.id });
      },
      removeMissionElements: () => state._missionElements.clear(),
    },
  };
  const getRenderer = () => state._renderer;
  const context = { state, services, parts, source, getRenderer };
  parts.policyHelpers = createPolicyHelpers(context);
  parts.model = createModel(context);
  parts.panel = createPanel(context);
  parts.replay = createReplay(context);
  parts.ingestion = createIngestion(context);
  parts.controls = createControls(context);
  parts.lifecycle = createLifecycle(context);
  const missions = Object.assign(
    {},
    parts.controls.methods,
    parts.lifecycle.methods,
    parts.ingestion.methods,
  );
  const rosters = [];
  parts.panel.subscribePanel((view) => rosters.push(view.roster));

  const manager = new DataLayerManager(null, { engine });
  manager.register(plainLayer('earthquakes', 'Earthquakes (24h)'));
  manager.register(plainLayer('satellites', 'Satellites'));
  manager.register(plainLayer('wind', 'Wind'));
  manager.register(missions);
  missions.attachDataManager(manager);

  const toasts = [];
  const controls = new ContextControls({
    elements: {},
    installations: {},
    actions: {
      getCockpit: () => null,
      claimVisualAuthority: noop,
      showToast: (message) => toasts.push(message),
      setClearBusy: noop,
      syncDetection: noop,
      scheduleLayout: noop,
      refreshRadio: noop,
      setPanelCollapsed: noop,
    },
  });
  controls.connect(manager);

  t.after(async () => {
    controls.stop();
    controls.disconnect();
    for (const id of ['rocket-launches', 'satellites', 'earthquakes', 'wind'])
      await manager.setEnabled(id, false);
    await missions.destroy();
    engine.destroy();
  });

  const enabledIds = () => [...manager.getEnabledLayerIds()].sort();
  const view = () => {
    const pose = engine.camera.pose();
    return {
      position: pose.position,
      heading: pose.heading,
      pitch: pose.pitch,
    };
  };
  const settle = async () => {
    await controls._waitForContextLayerSettlement();
    for (const id of ['rocket-launches', 'satellites', 'earthquakes'])
      await manager.waitForLayerSettled(id);
    await controls._waitForContextLayerSettlement();
  };
  return {
    upstream,
    manager,
    controls,
    missions,
    toasts,
    state,
    camera,
    rosters,
    enabledIds,
    view,
    settle,
  };
}

// The same view, to a millimetre and a microradian.
function assertSameView(actual, expected, message) {
  assert.ok(
    geo.cartesian3.distance(actual.position, expected.position) < 1e-3 &&
      Math.abs(actual.heading - expected.heading) < 1e-6 &&
      Math.abs(actual.pitch - expected.pitch) < 1e-6,
    `${message ?? 'the same view'}: ${JSON.stringify(actual)} vs ${JSON.stringify(expected)}`,
  );
}

const entries = {
  direct: (f) =>
    f.manager.setEnabled('rocket-launches', true, { origin: 'user' }),
  'Context-panel': async (f) =>
    (
      await f.controls.setContextMode('space-missions', {
        claimVisualAuthority: false,
      })
    ).ok,
};

for (const [path, enter] of Object.entries(entries))
  test(`a ${path} Space Missions entry that gets HTTP 429 rolls back instead of isolating`, async (t) => {
    const f = await fixture(t);
    await f.manager.setEnabled('earthquakes', true, { origin: 'user' });
    const before = f.view();

    const entered = await enter(f);
    await f.settle();

    assert.equal(entered, false, 'a failed mission index fails the enable');
    assert.deepEqual(f.enabledIds(), ['earthquakes']);
    assert.equal(f.controls.getContextModeState().mode, null);
    assert.equal(f.controls.getContextModeState().active, false);
    assert.equal(f.missions.getStats().error, 'HTTP 429');
    assertSameView(f.view(), before, 'the pre-entry view comes back');
    assert.ok(f.camera.cancelled > 0, 'the full-globe flight is cancelled');

    assert.equal(
      await f.manager.setEnabled('wind', true, { origin: 'user' }),
      true,
      'an unrelated layer is not blocked after the failed entry',
    );
  });

// Holds the /api/launches reply until the returned release is called.
function holdReply(f) {
  let release;
  f.upstream.hold = new Promise((resolve) => {
    release = resolve;
  });
  return () => {
    f.upstream.hold = null;
    release();
  };
}

async function untilFlown(f) {
  for (let i = 0; i < 200 && f.camera.flights === 0; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(f.camera.flights > 0, 'the entry started its full-globe flight');
}

test('a landed entry flight still gives the view back after a failed first load', async (t) => {
  const f = await fixture(t);
  await f.manager.setEnabled('earthquakes', true, { origin: 'user' });
  const before = f.view();
  const release = holdReply(f);

  const entering = f.manager.setEnabled('rocket-launches', true, {
    origin: 'user',
  });
  await untilFlown(f);
  f.camera.land();

  release();
  assert.equal(await entering, false);
  await f.settle();
  assertSameView(f.view(), before);
});

test('a camera move after the entry flight survives a failed first load', async (t) => {
  const f = await fixture(t);
  await f.manager.setEnabled('earthquakes', true, { origin: 'user' });
  const release = holdReply(f);

  const entering = f.manager.setEnabled('rocket-launches', true, {
    origin: 'user',
  });
  await untilFlown(f);
  f.camera.land();
  // The user drags the globe while the mission index is still loading.
  f.camera.setView({
    destination: geo.cartesian3.fromDegrees(-50, 10, 5_000_000),
    orientation: { heading: 0.3, pitch: -0.2, roll: 0 },
  });
  const moved = f.view();

  release();
  assert.equal(await entering, false);
  await f.settle();
  assertSameView(f.view(), moved);
});

test('a navigation during a failed first load is not cancelled by the rollback', async (t) => {
  const f = await fixture(t);
  await f.manager.setEnabled('earthquakes', true, { origin: 'user' });
  const release = holdReply(f);

  const entering = f.manager.setEnabled('rocket-launches', true, {
    origin: 'user',
  });
  await untilFlown(f);
  // Search or Home: navigation releases mission camera ownership, then flies.
  f.missions.releaseCameraOwnership();
  let navigationCancelled = false;
  f.camera.flyTo({
    destination: geo.cartesian3.fromDegrees(5, 5, 5_000_000),
    cancel: () => {
      navigationCancelled = true;
    },
  });
  const cancelled = f.camera.cancelled;
  const navigated = f.view();

  release();
  assert.equal(await entering, false);
  await f.settle();
  assert.equal(
    navigationCancelled,
    false,
    'the rollback does not cancel the Search/Home flight',
  );
  assert.equal(f.camera.cancelled, cancelled);
  assertSameView(f.view(), navigated);
});

test('the roster reports a failed mission index instead of loading forever', async (t) => {
  const f = await fixture(t);
  await f.manager.setEnabled('rocket-launches', true, { origin: 'user' });
  await f.settle();

  const roster = f.rosters.at(-1);
  assert.ok(roster, 'a failed load publishes a roster view');
  assert.deepEqual(roster.entries, []);
  assert.equal(roster.empty, '30-DAY MISSION INDEX UNAVAILABLE');

  // A new attempt starts from the loading state, then shows the index.
  f.upstream.status = 200;
  const loadingFrom = f.rosters.length;
  assert.equal(
    await f.manager.setEnabled('rocket-launches', true, { origin: 'user' }),
    true,
  );
  await f.settle();
  assert.equal(f.rosters.slice(loadingFrom).includes(null), true);
  assert.equal(f.rosters.at(-1).entries.length, 1);
  assert.equal(f.controls.getContextModeState().mode, 'space-missions');
});

test('a valid empty mission index is a successful entry', async (t) => {
  const f = await fixture(t);
  f.upstream.status = 200;
  f.upstream.results = [];
  assert.equal(
    await f.manager.setEnabled('rocket-launches', true, { origin: 'user' }),
    true,
  );
  await f.settle();
  assert.equal(f.controls.getContextModeState().mode, 'space-missions');
  assert.equal(
    f.rosters.at(-1).empty,
    'NO MISSIONS AVAILABLE IN THE CURRENT 30-DAY WINDOW',
  );
  assert.ok(f.camera.flights > 0, 'a successful entry frames the globe');
});

test('a refresh failure after a loaded index keeps the mode and its records', async (t) => {
  const f = await fixture(t);
  f.upstream.status = 200;
  await f.manager.setEnabled('rocket-launches', true, { origin: 'user' });
  await f.settle();
  const framed = f.view();

  f.upstream.status = 429;
  await f.missions.update();
  await f.settle();

  assert.equal(f.manager.isEnabled('rocket-launches'), true);
  assert.equal(f.controls.getContextModeState().mode, 'space-missions');
  assert.equal(f.missions.getStats().count, 1);
  assert.equal(f.missions.getStats().error, 'HTTP 429');
  assert.equal(f.rosters.at(-1).entries.length, 1);

  // Leaving a loaded mode does not restore the pre-entry view.
  await f.manager.setEnabled('rocket-launches', false, { origin: 'user' });
  await f.settle();
  assertSameView(f.view(), framed);
});
test('exiting during a successful entry flight cancels the mission-owned flight', async (t) => {
  const f = await fixture(t);
  f.upstream.status = 200;
  assert.equal(
    await f.manager.setEnabled('rocket-launches', true, { origin: 'user' }),
    true,
  );
  await f.settle();
  assert.ok(f.camera.flying, 'the 2.4 s entry flight is still in progress');

  await f.manager.setEnabled('rocket-launches', false, { origin: 'user' });
  await f.settle();
  assert.equal(
    f.camera.flying,
    false,
    'leaving Space Missions stops the flight it started (main cancels it)',
  );
});
// The rollback hides the roster, so the toast has to name the cause.
test('a failed first load tells the user the mission index is unavailable', async (t) => {
  const f = await fixture(t);
  await f.manager.setEnabled('earthquakes', true, { origin: 'user' });

  await f.controls.setContextMode('space-missions', {
    claimVisualAuthority: false,
  });
  await f.settle();
  assert.equal(f.controls.getContextModeState().mode, null, 'rolled back');
  assert.ok(
    f.toasts.some((message) => /mission index/i.test(message)),
    `visible feedback names the failure, got ${JSON.stringify(f.toasts)}`,
  );
});

test('navigation taking the camera keeps a mission flight it asked to preserve', async (t) => {
  const f = await fixture(t);
  f.upstream.status = 200;
  await f.manager.setEnabled('rocket-launches', true, { origin: 'user' });
  await f.settle();
  assert.ok(f.camera.flying, 'the entry flight is in progress');
  const cancelled = f.camera.cancelled;
  f.missions.releaseCameraOwnership();
  assert.ok(f.camera.flying, 'navigation decides about the flight');
  assert.equal(f.camera.cancelled, cancelled);
  // After exit an inactive layer never cancels another owner's flight.
  await f.manager.setEnabled('rocket-launches', false, { origin: 'user' });
  await f.settle();
  let otherCancelled = false;
  f.camera.flyTo({
    destination: geo.cartesian3.fromDegrees(1, 1, 1_000_000),
    cancel: () => {
      otherCancelled = true;
    },
  });
  f.missions.releaseCameraOwnership();
  assert.ok(f.camera.flying);
  assert.equal(otherCancelled, false);
});

test("an earlier attempt's index error is not blamed for a later failure", async (t) => {
  const f = await fixture(t);
  await f.manager.setEnabled('rocket-launches', true, { origin: 'user' });
  await f.settle();
  assert.match(spaceMissionsIndexFailure(f.manager), /mission index/);
  assert.equal(spaceMissionsIndexFailure(f.manager, Date.now() + 1), null);
});
