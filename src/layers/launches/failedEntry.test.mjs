// The real manager, Context coordinator and launches ingestion run against a
// stubbed /api/launches, so a failed first load takes the browser's path.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
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

function fakeCamera() {
  const camera = {
    position: new Cesium.Cartesian3(1, 2, 3),
    heading: 0.1,
    pitch: -0.5,
    roll: 0,
    flights: 0,
    cancelled: 0,
    flight: null,
    get positionWC() {
      return camera.position;
    },
    // Like Cesium, a new flight cancels the one in progress.
    flyTo({ destination, complete, cancel }) {
      camera.flight?.cancel?.();
      camera.flight = { complete, cancel };
      camera.flights += 1;
      camera.position = Cesium.Cartesian3.clone(destination);
      camera.heading = 0;
      camera.pitch = -Math.PI / 2;
    },
    land() {
      const flight = camera.flight;
      camera.flight = null;
      flight?.complete?.();
    },
    cancelFlight() {
      camera.cancelled += 1;
      const flight = camera.flight;
      camera.flight = null;
      flight?.cancel?.();
    },
    lookAtTransform: noop,
    setView({ destination, orientation }) {
      camera.position = Cesium.Cartesian3.clone(destination);
      camera.heading = orientation.heading;
      camera.pitch = orientation.pitch;
      camera.roll = orientation.roll;
    },
  };
  return camera;
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
      setOverlayEntries: noop,
      setOverlaySourceVisible: noop,
      clearOverlaySource: noop,
    },
    render: { holdContinuousRender: noop, releaseContinuousRender: noop },
  };
  const state = createState({ services });
  const camera = fakeCamera();
  const canvas = Object.assign(new EventTarget(), {
    disableRootEvents: true,
    onwheel: null,
    style: {},
    clientWidth: 1200,
    clientHeight: 800,
  });
  const viewer = {
    camera,
    dataSources: new Cesium.DataSourceCollection(),
    scene: { canvas, preRender: new Cesium.Event(), drillPick: () => [] },
  };
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
          destination: new Cesium.Cartesian3(9, 9, 9),
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
      addLaunchEntity(record) {
        state._dataSource.entities.add({
          id: record.id,
          position: Cesium.Cartesian3.fromDegrees(record.lon, record.lat),
        });
      },
    },
  };
  const context = { state, services, parts, source };
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

  const manager = new DataLayerManager(viewer);
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
    await missions.destroy(viewer);
  });

  const enabledIds = () => [...manager.getEnabledLayerIds()].sort();
  const view = () => ({
    x: camera.position.x,
    y: camera.position.y,
    z: camera.position.z,
    heading: camera.heading,
    pitch: camera.pitch,
  });
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
    assert.deepEqual(f.view(), before, 'the pre-entry view comes back');
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
  assert.deepEqual(f.view(), before);
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
    destination: new Cesium.Cartesian3(7, 7, 7),
    orientation: { heading: 0.3, pitch: -0.2, roll: 0 },
  });
  const moved = f.view();

  release();
  assert.equal(await entering, false);
  await f.settle();
  assert.deepEqual(f.view(), moved);
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
    destination: new Cesium.Cartesian3(5, 5, 5),
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
  assert.deepEqual(f.view(), navigated);
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
  assert.deepEqual(f.view(), framed);
});
test('exiting during a successful entry flight cancels the mission-owned flight', async (t) => {
  const f = await fixture(t);
  f.upstream.status = 200;
  assert.equal(
    await f.manager.setEnabled('rocket-launches', true, { origin: 'user' }),
    true,
  );
  await f.settle();
  assert.ok(f.camera.flight, 'the 2.4 s entry flight is still in progress');

  await f.manager.setEnabled('rocket-launches', false, { origin: 'user' });
  await f.settle();
  assert.equal(
    f.camera.flight,
    null,
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
  const flight = f.camera.flight;
  assert.ok(flight, 'the entry flight is in progress');
  f.missions.releaseCameraOwnership();
  assert.equal(f.camera.flight, flight, 'navigation decides about the flight');
  // After exit an inactive layer never cancels another owner's flight.
  await f.manager.setEnabled('rocket-launches', false, { origin: 'user' });
  await f.settle();
  f.camera.flyTo({ destination: new Cesium.Cartesian3(1, 1, 1) });
  const other = f.camera.flight;
  f.missions.releaseCameraOwnership();
  assert.equal(f.camera.flight, other);
});

test("an earlier attempt's index error is not blamed for a later failure", async (t) => {
  const f = await fixture(t);
  await f.manager.setEnabled('rocket-launches', true, { origin: 'user' });
  await f.settle();
  assert.match(spaceMissionsIndexFailure(f.manager), /mission index/);
  assert.equal(spaceMissionsIndexFailure(f.manager, Date.now() + 1), null);
});
