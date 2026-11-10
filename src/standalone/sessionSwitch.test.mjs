import assert from 'node:assert/strict';
import test from 'node:test';
import { createLayerSession } from '../app/layerSession.js';
import { createApplicationCatalog } from '../app/constructCatalog.js';
import { createSurfaceServices } from '../app/surfaceServices.js';
import { createQaSources } from '../app/layers/qaSources.js';
import { loadLayerRenderers, rendererFor } from '../app/layers/renderers.js';
import { aircraftAtlasLayout } from '../layers/aircraft/render/display.js';
import { SATELLITE_FIXTURE_EPOCH } from '../bench/satelliteFixture.js';
import { LayerLifecycle } from '../data/lifecycle.js';
import { LayerStateCoordinator } from '../data/layerStateCoordinator.js';
import { sceneServicesFor } from '../data/sceneServices.js';
import { createFakeEngine } from '../globe/testing/fakeEngine.js';
import { ContextControls } from '../ui/contextControls.js';
import { CockpitCoordinator } from '../ui/cockpitCoordinator.js';
import {
  installLifecycleEnvironment,
  flushLifecycleTasks,
} from '../testSupport/lifecycleEnvironment.mjs';
import { createEngineAddress } from './engineSwitch.js';
import { createSceneSwitcher } from './sceneSwitcher.js';

async function fixture(t, { aircraft = null, failOpen = false } = {}) {
  let cleanup = async () => {};
  t.after(() => cleanup());
  const { window } = installLifecycleEnvironment(t);
  t.mock.timers.setTime(SATELLITE_FIXTURE_EPOCH);
  const previous = {
    HTMLElement: globalThis.HTMLElement,
    EventTarget: globalThis.EventTarget,
  };
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.EventTarget = window.EventTarget;
  t.after(() => {
    Object.assign(globalThis, previous);
  });
  await loadLayerRenderers('navara');
  await loadLayerRenderers('cesium');
  const session = createLayerSession();
  const fullCatalog = createApplicationCatalog({
    layerSession: session,
    signal: session.lifetime.signal,
    sources: createQaSources([
      { layer: 'launches' },
      ...(aircraft ? [{ layer: aircraft, count: 1 }] : []),
    ]),
    surface: createSurfaceServices({
      terrainSource: { getHeights: async () => [] },
      signal: session.lifetime.signal,
      eventTarget: null,
    }),
    createDisplay(id, engine, options) {
      const layout = aircraftAtlasLayout();
      return rendererFor(id, engine, {
        ...options,
        drawAtlas: async () => ({
          canvas: { width: layout.width, height: layout.height },
          cells: layout.cells,
        }),
      });
    },
  });
  const ids = [
    'flights',
    'military',
    'satellites',
    'rocket-launches',
    'military-awareness',
  ];
  const catalog = {
    ...fullCatalog,
    layers: fullCatalog.layers.filter(({ id }) => ids.includes(id)),
    metadata: fullCatalog.metadata.filter(({ id }) => ids.includes(id)),
  };
  const engines = [];
  const newEngine = (kind) => {
    const engine = createFakeEngine({
      kind,
      container: document.createElement('div'),
      canvas: document.createElement('canvas'),
    });
    engines.push(engine);
    return engine;
  };
  let engine = newEngine('navara');
  const manager = new LayerLifecycle(null);
  session.manager = manager;
  await manager.bindCatalog(engine, catalog);
  for (const layer of catalog.layers) layer.attachDataManager?.(manager);
  const context = new ContextControls({
    elements: {},
    installations: {},
    actions: {
      getCockpit: () => cockpit?.cockpitView,
      claimVisualAuthority() {},
      showToast() {},
      setClearBusy() {},
      syncDetection() {},
      scheduleLayout() {},
      refreshRadio() {},
      setPanelCollapsed() {},
    },
  });
  let cockpit = null;
  context.connect(manager);
  const buildCockpit = () =>
    new CockpitCoordinator({
      engine,
      services: {
        ...sceneServicesFor(engine).render,
        flightsLayer: catalog.get('flights'),
        militaryFlightsLayer: catalog.get('military'),
        isTr3b: () => false,
        regionalDistanceM: () => 0,
        fetchRegionalBrief: async () => ({}),
      },
      elements: {},
      operations: {
        getAircraftTrackingTarget: () => {
          const info = aircraft && catalog.get(aircraft).getTrackedInfo();
          return info ? { id: info.icao24, layerId: aircraft } : null;
        },
        _stampNavigation() {},
        _setCockpitVision() {},
      },
      readDataManager: () => manager,
      readContext: () => context.getContextModeState(),
      readActiveStyle: () => 'normal',
      enterPanels() {},
      exitPanels() {},
    });
  cockpit = buildCockpit();
  let addressState = { enabledLayerIds: [], options: {} };
  const style = {
    initialRestorePromise: Promise.resolve(),
    getCockpitState: () => cockpit.getCockpitState(),
    getAircraftTrackingTarget: () => cockpit.getAircraftTrackingTarget(),
    controlCockpit: (...args) => cockpit.controlCockpit(...args),
    get cockpitView() {
      return cockpit.cockpitView;
    },
    shareLinkManager: { currentLayerState: () => addressState },
  };
  let coordinator;
  const app = {
    getState: () => ({ status: 'ready' }),
    getComponents: () => ({
      scene: { engine },
      controls: { styleManager: style },
    }),
    async detachScene() {
      cockpit.stop();
      cockpit.destroy();
      coordinator?.destroy();
      await manager.detachScene();
      engine = null;
    },
    async attachScene(kind, { resume }) {
      if (failOpen && kind === 'cesium')
        throw new Error('WebGL context refused');
      engine = newEngine(kind);
      await manager.bindCatalog(engine, catalog, {
        viewRestored: session.viewRestored,
      });
      cockpit = buildCockpit();
      coordinator = new LayerStateCoordinator(manager, null, { storage: null });
      style.initialRestorePromise = coordinator
        .start({
          shareLayerState: addressState,
          handoff: session.handoff,
        })
        .then(() => {
          // Share restoration requests Follow before releasing the view gate.
          const target = coordinator.retainedTrackingTarget();
          if (target) coordinator.resumeRetainedTracking(target);
        });
      await resume();
    },
  };
  window.history.replaceState(null, '', '?engine=navara');
  const switcher = createSceneSwitcher({
    kind: 'navara',
    requested: () => new URL(window.location.href).searchParams.get('engine'),
    layerSession: session,
    getApplication: () => app,
    renderers: { retain() {} },
    address: createEngineAddress({
      location: window.location,
      history: window.history,
    }),
  });
  cleanup = async () => {
    context.stop();
    context.disconnect();
    cockpit.destroy();
    coordinator?.destroy();
    session.lifetime.abort();
    await manager.destroyAll();
    for (const engine of engines) {
      sceneServicesFor(engine).destroy();
      engine.destroy();
    }
  };
  return {
    session,
    manager,
    catalog,
    context,
    style,
    switcher,
    window,
    engine: () => engine,
    address: (state) => {
      addressState = state;
    },
  };
}

test('Space Missions keeps its context, selection and paused replay across engines', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.context.setContextMode('space-missions')).ok, true);
  const launches = f.catalog.get('rocket-launches');
  launches.selectMissionAt(0);
  launches.setReplaySpeed(4);
  launches.startSelectedReplay();
  f.engine().camera.completeFlight();
  await flushLifecycleTasks(t, 20_000);
  f.engine().fake.frame();
  launches.toggleReplayPause();
  const before = launches.qaDrawn();
  const stamp = launches.getStats().lastUpdate;
  assert.ok(before.paused && before.replay.active);
  assert.ok(before.replay.phaseProgress > 0);
  f.address({
    enabledLayerIds: ['rocket-launches', 'satellites'],
    options: {},
  });
  const snapshot = f.context.captureScene().snapshot;
  for (const kind of ['cesium', 'navara']) {
    await f.switcher.select(kind);
    await f.context._waitForContextLayerSettlement();
    assert.equal(f.context.getContextModeState().mode, 'space-missions');
    assert.equal(f.context.captureScene().snapshot, snapshot);
    const after = launches.qaDrawn();
    assert.equal(after.selected, before.selected);
    assert.ok(after.paused && after.replay.active);
    assert.equal(after.speed, 4);
    assert.equal(after.replay.phaseProgress, before.replay.phaseProgress);
    assert.equal(launches.getStats().lastUpdate, stamp);
  }
});

for (const aircraft of ['flights', 'military']) {
  test(`failed engine startup restores the ${aircraft} cockpit and session without history`, async (t) => {
    const f = await fixture(t, { aircraft, failOpen: true });
    const layer = f.catalog.get(aircraft);
    await f.manager.setEnabled(aircraft, true);
    await flushLifecycleTasks(t);
    const id = layer.getAnalystRecords()[0].icao24;
    assert.equal(layer.trackById(id), true);
    const entered = f.style.controlCockpit('enter');
    assert.equal(entered.ok, true, entered.error);
    f.style.cockpitView.setVisionMode('thermal');
    f.address({
      enabledLayerIds: [aircraft],
      options: {
        flights: {
          [aircraft === 'flights'
            ? 'selectedFlightsTrackingId'
            : 'selectedMilitaryTrackingId']: id,
        },
      },
    });
    const manager = f.manager;
    const entry = manager.layers.get(aircraft);
    const length = f.window.history.length;
    await f.switcher.select('cesium');
    assert.equal(f.engine().kind, 'navara');
    assert.equal(
      new URL(f.window.location.href).searchParams.get('engine'),
      'navara',
    );
    assert.equal(f.window.history.length, length);
    assert.equal(f.session.manager, manager);
    assert.equal(manager.layers.get(aircraft), entry);
    assert.equal(f.style.getAircraftTrackingTarget()?.id, id);
    assert.equal(f.style.getCockpitState().active, true);
    assert.equal(f.style.getCockpitState().visionMode, 'thermal');
    assert.equal(f.style.getCockpitState().subject.id, id);
    assert.equal(
      f.style.cockpitView.trackedEntity.gevSelectionOrigin,
      'share-restore',
    );
    assert.equal(f.session.handoff, null);
  });
}
