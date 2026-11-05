// A Space Missions entry whose mission index never loads must not commit the
// mode. The real manager, Context coordinator and launches ingestion run
// against a local /api/launches that answers 429, so the test follows the
// same failure the browser sees: isolation clears the other layers, the first
// update fails, and the entry rolls back to the layers and view it replaced.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import * as Cesium from 'cesium';
import { DataLayerManager } from '../../data/manager.js';
import { ContextControls } from '../../ui/contextControls.js';
import { createLaunchSource } from './source.js';
import { createState } from './state.js';
import { createModel } from './model.js';
import { createPolicyHelpers } from './policyHelpers.js';
import { createIngestion } from './ingestion.js';
import { createPanel } from './panel.js';
import { createControls } from './controls.js';
import { createLifecycle } from './lifecycle.js';

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
    get positionWC() {
      return camera.position;
    },
    flyTo({ destination }) {
      camera.flights += 1;
      camera.position = Cesium.Cartesian3.clone(destination);
      camera.heading = 0;
      camera.pitch = -Math.PI / 2;
    },
    cancelFlight() {
      camera.cancelled += 1;
    },
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
  const server = http.createServer((req, res) => {
    if (req.url === '/api/celestrak/active') {
      res.end('');
      return;
    }
    if (upstream.status !== 200) {
      res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Launch Library 2 unavailable' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ results: upstream.results }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const source = createLaunchSource({
    fetchImpl: (url, options) => fetch(new URL(url, origin), options),
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
  // Scene presentation is inert; source, ingestion, lifecycle, panel views
  // and the satellites dependency run unchanged.
  const parts = {
    overlays: {
      shortMissionLabel: (name) => name,
      createReplayVehicleOverlay: noop,
      clearMissionOverlaySources: noop,
      hideReplayVehicleOverlay: noop,
      destroyReplayVehicleOverlay: noop,
    },
    replay: { stopMissionReplay: noop, presentReplay: () => null },
    selection: {
      focusFullGlobe: (target) =>
        target.camera.flyTo({ destination: new Cesium.Cartesian3(9, 9, 9) }),
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
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
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
    state,
    camera,
    rosters,
    toasts,
    enabledIds,
    view,
    settle,
  };
}

test('a direct Space Missions entry that gets HTTP 429 rolls back instead of isolating', async (t) => {
  const f = await fixture(t);
  assert.equal(
    await f.manager.setEnabled('earthquakes', true, { origin: 'user' }),
    true,
  );
  const before = f.view();

  const entered = await f.manager.setEnabled('rocket-launches', true, {
    origin: 'user',
  });
  await f.settle();

  assert.equal(entered, false, 'a failed mission index fails the enable');
  assert.deepEqual(f.enabledIds(), ['earthquakes']);
  assert.equal(f.controls.getContextModeState().mode, null);
  assert.equal(f.controls.getContextModeState().active, false);
  assert.equal(f.missions.getStats().error, 'HTTP 429');
  assert.deepEqual(f.view(), before, 'the pre-entry view comes back');
  assert.ok(f.camera.cancelled > 0, 'the full-globe flight is cancelled');

  // Nothing is left isolating the workspace.
  assert.equal(
    await f.manager.setEnabled('wind', true, { origin: 'user' }),
    true,
    'an unrelated layer is not blocked after the failed entry',
  );
});

test('a Context-panel Space Missions entry that gets HTTP 429 restores the previous layers', async (t) => {
  const f = await fixture(t);
  await f.manager.setEnabled('earthquakes', true, { origin: 'user' });
  const before = f.view();

  const result = await f.controls.setContextMode('space-missions', {
    claimVisualAuthority: false,
  });
  await f.settle();

  assert.equal(result.ok, false);
  assert.deepEqual(f.enabledIds(), ['earthquakes']);
  assert.equal(f.controls.getContextModeState().mode, null);
  assert.deepEqual(f.view(), before);
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

  // Leaving a mode that loaded keeps today's camera behaviour.
  await f.manager.setEnabled('rocket-launches', false, { origin: 'user' });
  await f.settle();
  assert.deepEqual(f.view(), framed);
});
