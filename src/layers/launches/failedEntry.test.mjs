// The real manager, Context coordinator and launches ingestion run against a
// stubbed /api/launches, so a failed first load takes the browser's path.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataLayerManager } from '../../data/manager.js';
import { ContextControls } from '../../ui/contextControls.js';
import { createLaunchSource } from './source.js';
import { createState } from './state.js';
import { createModel } from './model.js';
import { createPolicyHelpers } from './policyHelpers.js';
import { createIngestion } from './ingestion.js';
import { createSatelliteIntents } from './satelliteIntents.js';
import { createPanel } from './panel.js';
import { createControls } from './controls.js';
import { createLifecycle } from './lifecycle.js';
import { createReplay } from './replay.js';
import { bindFakeCesiumCamera } from '../../testSupport/fakeCameraPort.mjs';

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
    position: { x: 1, y: 2, z: 3 },
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
      camera.position = {
        x: destination.x,
        y: destination.y,
        z: destination.z,
      };
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
      camera.position = {
        x: destination.x,
        y: destination.y,
        z: destination.z,
      };
      camera.heading = orientation.heading;
      camera.pitch = orientation.pitch;
      camera.roll = orientation.roll;
    },
  };
  return camera;
}

async function fixture(t, { beforeConnect } = {}) {
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
    scene: { canvas, drillPick: () => [] },
  };
  // The Cesium camera port over the fake camera, as the renderer binds it.
  bindFakeCesiumCamera(viewer);
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
          destination: { x: 9, y: 9, z: 9 },
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
      // The launches' draw sets, which a loaded index needs to land in.
      attach() {
        state._missionSets = {};
      },
      detach() {
        state._missionSets = null;
      },
      showMissions: noop,
      missionsShown: () => true,
      updateMissionFrame: noop,
      addLaunchEntity: noop,
      flushLaunchEntities: noop,
      clearLaunchEntities: noop,
      launchIdFromPicks: () => null,
      launchMarkerAt: () => null,
      missionHitsAt: () => [],
    },
  };
  const context = { state, services, parts, source };
  parts.policyHelpers = createPolicyHelpers(context);
  parts.model = createModel(context);
  parts.panel = createPanel(context);
  parts.replay = createReplay(context);
  parts.ingestion = createIngestion(context);
  parts.satelliteIntents = createSatelliteIntents(context);
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
  manager.register(plainLayer('military-awareness', 'Global Context'));
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
  beforeConnect?.(manager);
  controls.connect(manager);

  t.after(async () => {
    controls.stop();
    controls.disconnect();
    for (const id of [
      'rocket-launches',
      'satellites',
      'earthquakes',
      'wind',
      'military-awareness',
    ])
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
    panel: parts.panel,
    enabledIds,
    view,
    settle,
  };
}

test('a Space Missions start that gets HTTP 429 rolls back and leaves other layers alone', async (t) => {
  const f = await fixture(t);
  await f.manager.setEnabled('earthquakes', true, { origin: 'user' });
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
    destination: { x: 7, y: 7, z: 7 },
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
    destination: { x: 5, y: 5, z: 5 },
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
  assert.equal(f.manager.isEnabled('rocket-launches'), true);
  assert.equal(
    f.controls.getContextModeState().mode,
    null,
    'not a Context mode',
  );
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
  assert.equal(f.manager.isEnabled('rocket-launches'), true);
  assert.equal(
    f.rosters.at(-1).empty,
    'NO MISSIONS AVAILABLE IN THE CURRENT 30-DAY WINDOW',
  );
  assert.ok(f.camera.flights > 0, 'a successful entry frames the globe');
});

for (const phase of ['while starting', 'after start']) {
  test(`Space Missions runs beside Contacts and a later Satellites OFF ends it (${phase})`, async (t) => {
    const gate = Promise.withResolvers();
    const guardReached = Promise.withResolvers();
    const f = await fixture(t, {
      beforeConnect(manager) {
        if (phase !== 'while starting') return;
        manager.addVisibilityGuard(async ({ layerId, enabled }) => {
          if (layerId !== 'rocket-launches' || !enabled) return;
          guardReached.resolve();
          await gate.promise;
        });
      },
    });
    f.upstream.status = 200;
    await f.manager.setEnabled('satellites', true, { origin: 'user' });
    assert.equal(await f.controls._selectContextMode('flights'), true);
    await f.settle();
    assert.deepEqual(
      f.enabledIds(),
      ['military-awareness', 'satellites'],
      'Contacts leaves Satellites alone',
    );

    const launch = f.manager.setEnabled('rocket-launches', true, {
      origin: 'user',
    });
    try {
      if (phase === 'while starting') {
        await guardReached.promise;
      } else {
        assert.equal(await launch, true);
        assert.deepEqual(f.enabledIds(), [
          'military-awareness',
          'rocket-launches',
          'satellites',
        ]);
      }
      assert.equal(
        f.controls.getContextModeState().mode,
        'flights',
        'starting Space Missions leaves Contacts on',
      );
      assert.equal(
        await f.manager.setEnabled('satellites', false, { origin: 'voice' }),
        true,
      );
    } finally {
      gate.resolve();
    }
    assert.equal(await launch, phase === 'after start');
    await f.missions.waitForSatelliteIntents?.();
    await f.settle();
    assert.deepEqual(f.enabledIds(), ['military-awareness']);
    assert.equal(f.controls.getContextModeState().mode, 'flights');
  });
}

test('Contacts started and ended while Space Missions runs leaves it and Satellites alone', async (t) => {
  const f = await fixture(t);
  f.upstream.status = 200;
  assert.equal(
    await f.manager.setEnabled('rocket-launches', true, { origin: 'user' }),
    true,
  );
  await f.settle();
  const missionParams = f.manager.getLayerParams('satellites');
  assert.equal(missionParams.showPoints, false, 'the mission display applied');

  assert.equal(await f.controls._selectContextMode('flights'), true);
  await f.settle();
  assert.deepEqual(f.enabledIds(), [
    'military-awareness',
    'rocket-launches',
    'satellites',
  ]);
  assert.equal(await f.controls._selectContextMode(null), true);
  await f.settle();
  assert.deepEqual(f.enabledIds(), ['rocket-launches', 'satellites']);
  assert.deepEqual(f.manager.getLayerParams('satellites'), missionParams);

  await f.manager.setEnabled('rocket-launches', false, { origin: 'user' });
  await f.settle();
  assert.deepEqual(f.enabledIds(), []);
  const after = f.manager.getLayerParams('satellites');
  assert.notEqual(after.showPoints, false, 'Satellites shows its points again');
  assert.notEqual(after.showOrbits, false, 'and its orbits');
});

test('a Satellites OFF requested before Space Missions entry does not cancel it', async (t) => {
  const f = await fixture(t);
  f.upstream.status = 200;
  await f.manager.setEnabled('satellites', true, { origin: 'user' });
  const satellites = f.manager.layers.get('satellites').module;
  const disable = satellites.disable;
  const gate = Promise.withResolvers();
  const disabling = Promise.withResolvers();
  satellites.disable = async () => {
    disabling.resolve();
    await gate.promise;
  };
  let entry;
  try {
    const off = f.manager.setEnabled('satellites', false, { origin: 'user' });
    await disabling.promise;
    // The entry is requested while the earlier OFF is still settling.
    entry = f.manager.setEnabled('rocket-launches', true, { origin: 'user' });
    gate.resolve();
    assert.equal(await off, true);
  } finally {
    gate.resolve();
    satellites.disable = disable;
  }
  assert.equal(await entry, true, 'the later entry is not cancelled');
  await f.settle();
  assert.equal(f.manager.isEnabled('rocket-launches'), true);

  // Leaving keeps the earlier Satellites OFF.
  await f.manager.setEnabled('rocket-launches', false, { origin: 'user' });
  await f.settle();
  assert.equal(f.manager.isEnabled('satellites'), false);
  assert.equal(f.manager.isEnabled('rocket-launches'), false);
});

test('Space Missions is an ordinary layer: it neither isolates nor opens a Context session', async (t) => {
  const f = await fixture(t);
  f.upstream.status = 200;
  await f.manager.setEnabled('earthquakes', true, { origin: 'user' });
  assert.equal(
    await f.manager.setEnabled('rocket-launches', true, { origin: 'user' }),
    true,
  );
  await f.settle();
  assert.deepEqual(f.enabledIds(), [
    'earthquakes',
    'rocket-launches',
    'satellites',
  ]);
  assert.equal(f.controls._contextSessionSnapshot, null);
  assert.equal(
    await f.manager.setEnabled('wind', true, { origin: 'user' }),
    true,
    'other layers are not refused while Space Missions is on',
  );
  await f.manager.setEnabled('rocket-launches', false, { origin: 'user' });
  await f.settle();
  assert.deepEqual(
    f.enabledIds(),
    ['earthquakes', 'wind'],
    'Space Missions gives back only the Satellites it turned on',
  );
});

test('a Satellites enable that never settles still lets mission disable complete', async (t) => {
  const f = await fixture(t);
  f.upstream.status = 200;
  assert.equal(
    await f.manager.setEnabled('rocket-launches', true, { origin: 'user' }),
    true,
  );
  await f.settle();
  f.state.satelliteSettleTimeoutMs = 50;
  const satellites = f.manager.layers.get('satellites').module;
  const enable = satellites.enable;
  const stuck = Promise.withResolvers();
  satellites.enable = () => stuck.promise;
  try {
    // A programmatic Satellites restart whose enable hangs.
    await f.manager.setEnabled('satellites', false);
    void f.manager.setEnabled('satellites', true);
    const exit = f.manager.setEnabled('rocket-launches', false, {
      origin: 'user',
    });
    const outcome = await Promise.race([
      exit.then(() => 'settled'),
      new Promise((resolve) => setTimeout(() => resolve('hung'), 2000)),
    ]);
    assert.equal(
      outcome,
      'settled',
      'the mission disable does not wait forever',
    );
    assert.equal(f.missions.getAnalystRecords().length, 0);
  } finally {
    satellites.enable = enable;
    stuck.resolve();
  }
  await f.settle();
  // The saved Satellites state was kept: turning Space Missions off again
  // once Satellites settles gives back the Satellites it turned on.
  assert.equal(f.manager.isEnabled('satellites'), true);
  await f.manager.setEnabled('rocket-launches', false, { origin: 'user' });
  await f.settle();
  assert.equal(f.manager.isEnabled('rocket-launches'), false);
  assert.equal(f.manager.isEnabled('satellites'), false);
});

test('Space Missions turned on again after a busy restore switches Satellites on', async (t) => {
  const f = await fixture(t);
  f.upstream.status = 200;
  assert.equal(
    await f.manager.setEnabled('rocket-launches', true, { origin: 'user' }),
    true,
  );
  await f.settle();
  f.state.satelliteSettleTimeoutMs = 50;
  const satellites = f.manager.layers.get('satellites').module;
  const enable = satellites.enable;
  const stuck = Promise.withResolvers();
  satellites.enable = () => stuck.promise;
  try {
    await f.manager.setEnabled('satellites', false);
    void f.manager.setEnabled('satellites', true);
    await f.manager.setEnabled('rocket-launches', false, { origin: 'user' });
  } finally {
    satellites.enable = enable;
    stuck.resolve();
  }
  await f.settle();
  // Something else switches Satellites off, then Space Missions comes back.
  await f.manager.setEnabled('satellites', false);
  await f.settle();
  assert.equal(f.manager.isEnabled('satellites'), false);
  assert.equal(
    await f.manager.setEnabled('rocket-launches', true, { origin: 'user' }),
    true,
  );
  await f.settle();
  assert.equal(f.manager.isEnabled('satellites'), true);
  // Its own off still gives back the Satellites from before the first start.
  await f.manager.setEnabled('rocket-launches', false, { origin: 'user' });
  await f.settle();
  assert.equal(f.manager.isEnabled('satellites'), false);
});

test('a Satellites switch made between missions is what the next mission gives back', async (t) => {
  const f = await fixture(t);
  f.upstream.status = 200;
  assert.equal(
    await f.manager.setEnabled('rocket-launches', true, { origin: 'user' }),
    true,
  );
  await f.settle();
  f.state.satelliteSettleTimeoutMs = 50;
  const satellites = f.manager.layers.get('satellites').module;
  const enable = satellites.enable;
  const stuck = Promise.withResolvers();
  satellites.enable = () => stuck.promise;
  try {
    await f.manager.setEnabled('satellites', false);
    void f.manager.setEnabled('satellites', true);
    await f.manager.setEnabled('rocket-launches', false, { origin: 'user' });
  } finally {
    satellites.enable = enable;
    stuck.resolve();
  }
  await f.settle();
  // The person switches Satellites on, then something else switches it off.
  await f.manager.setEnabled('satellites', true, { origin: 'user' });
  await f.settle();
  await f.manager.setEnabled('satellites', false);
  await f.settle();
  assert.equal(
    await f.manager.setEnabled('rocket-launches', true, { origin: 'user' }),
    true,
  );
  await f.settle();
  assert.equal(f.manager.isEnabled('satellites'), true);
  await f.manager.setEnabled('rocket-launches', false, { origin: 'user' });
  await f.settle();
  assert.equal(f.manager.isEnabled('satellites'), false);
});

test('a Satellites setting changed between missions survives the next one', async (t) => {
  const f = await fixture(t);
  f.upstream.status = 200;
  assert.equal(
    await f.manager.setEnabled('rocket-launches', true, { origin: 'user' }),
    true,
  );
  await f.settle();
  f.state.satelliteSettleTimeoutMs = 50;
  const satellites = f.manager.layers.get('satellites').module;
  const enable = satellites.enable;
  const stuck = Promise.withResolvers();
  satellites.enable = () => stuck.promise;
  try {
    await f.manager.setEnabled('satellites', false);
    void f.manager.setEnabled('satellites', true);
    await f.manager.setEnabled('rocket-launches', false, { origin: 'user' });
  } finally {
    satellites.enable = enable;
    stuck.resolve();
  }
  await f.settle();
  f.manager.setLayerParams(
    'satellites',
    { showOrbits: false },
    { origin: 'user' },
  );
  await f.settle();
  await f.manager.setEnabled('rocket-launches', true, { origin: 'user' });
  await f.settle();
  await f.manager.setEnabled('rocket-launches', false, { origin: 'user' });
  await f.settle();
  assert.equal(f.manager.getLayerParams('satellites').showOrbits, false);
});

test('tracking stopped by a place search during a mission stays stopped after it', async (t) => {
  const f = await fixture(t);
  f.upstream.status = 200;
  assert.equal(
    await f.manager.setEnabled('rocket-launches', true, { origin: 'user' }),
    true,
  );
  await f.settle();
  f.manager.setLayerParams(
    'satellites',
    { selectedSatTrackingId: 25544 },
    { origin: 'voice' },
  );
  await f.settle();
  // A place search stops tracking with the tool origin.
  f.manager.setLayerParams(
    'satellites',
    { selectedSatTrackingId: null },
    { origin: 'tool' },
  );
  await f.settle();
  await f.manager.setEnabled('rocket-launches', false, { origin: 'user' });
  await f.settle();
  assert.equal(
    f.manager.getLayerParams('satellites').selectedSatTrackingId ?? null,
    null,
  );
});

test('a failed Satellites restore still clears the selected mission panel', async (t) => {
  const f = await fixture(t);
  f.upstream.status = 200;
  assert.equal(
    await f.manager.setEnabled('rocket-launches', true, { origin: 'user' }),
    true,
  );
  await f.settle();
  assert.equal(f.manager.isEnabled('satellites'), true);

  let panelView;
  const unsubscribe = f.panel.subscribePanel((view) => {
    panelView = view;
  });
  const satellites = f.manager.layers.get('satellites').module;
  const disable = satellites.disable;
  try {
    f.state._selectedLaunchId = f.state._launches[0].id;
    f.panel.renderMissionPanel();
    assert.ok(panelView.mission);

    satellites.disable = () => {
      throw new Error('injected Satellites restore failure');
    };
    assert.equal(
      await f.manager.setEnabled('rocket-launches', false, { origin: 'user' }),
      false,
    );
    const { enabled, uncertain } =
      f.manager.getLayerLifecycleState('rocket-launches');
    assert.equal(enabled, true);
    assert.equal(uncertain, true);
    assert.equal(panelView.mission, null);
  } finally {
    satellites.disable = disable;
    unsubscribe();
  }
});

test('a refresh failure after a loaded index keeps the layer and its records', async (t) => {
  const f = await fixture(t);
  f.upstream.status = 200;
  await f.manager.setEnabled('rocket-launches', true, { origin: 'user' });
  await f.settle();
  const framed = f.view();

  f.upstream.status = 429;
  await f.missions.update();
  await f.settle();

  assert.equal(f.manager.isEnabled('rocket-launches'), true);
  assert.equal(f.missions.getStats().count, 1);
  assert.equal(f.missions.getStats().error, 'HTTP 429');
  assert.equal(f.rosters.at(-1).entries.length, 1);

  // Leaving after a loaded index does not restore the pre-entry view.
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

  await f.manager.setEnabled('rocket-launches', true, { origin: 'user' });
  await f.settle();
  assert.equal(f.manager.isEnabled('rocket-launches'), false, 'rolled back');
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
  f.camera.flyTo({ destination: { x: 1, y: 1, z: 1 } });
  const other = f.camera.flight;
  f.missions.releaseCameraOwnership();
  assert.equal(f.camera.flight, other);
});

test('a refresh error after a loaded index is not blamed on the index', async (t) => {
  const f = await fixture(t);
  await f.manager.setEnabled('rocket-launches', true, { origin: 'user' });
  await f.settle();
  assert.match(f.missions.enableFailureMessage(), /mission index/);

  f.upstream.status = 200;
  await f.manager.setEnabled('rocket-launches', true, { origin: 'user' });
  await f.settle();
  f.upstream.status = 429;
  await f.missions.update();
  assert.equal(f.missions.getStats().error, 'HTTP 429');
  assert.equal(f.missions.enableFailureMessage(), null);
});
