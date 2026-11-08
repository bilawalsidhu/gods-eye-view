import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import * as Cesium from 'cesium';
import { createLaunchSource } from './source.js';
import { createState } from './state.js';
import { createModel } from './model.js';
import { createIngestion } from './ingestion.js';
import { createControls } from './controls.js';
import { createLifecycle } from './lifecycle.js';
import { layerFeedState } from '../../data/feedState.js';
import { inputFor } from '../../input/dispatcher.js';
import { bindRenderer } from '../../render/rendererOf.js';
import { fakeSceneFrame } from '../../testSupport/fakeCesiumScene.mjs';

const noop = () => {};

async function fixture({ legacySource = false } = {}) {
  const launch = {
    id: 'owned-launch',
    name: 'Owned mission fixture',
    net: new Date(Date.now() - 3600000).toISOString(),
    status: { name: 'Launch Successful' },
    pad: { name: 'Owned pad', latitude: 28.6, longitude: -80.6 },
    rocket: { payloads: [] },
  };
  const mode = { cache: 'HIT', results: [launch], hold: false };
  let arrival;
  let release;
  const server = http.createServer((req, res) => {
    if (req.url === '/api/celestrak/active') {
      res.end('');
      return;
    }
    assert.equal(req.url, '/api/launches');
    const send = () => {
      if (res.destroyed) return;
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'X-GEV-Cache': mode.cache,
      });
      res.end(JSON.stringify({ results: mode.results }));
    };
    if (mode.hold) {
      release = send;
      arrival?.();
    } else send();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const launchSource = createLaunchSource({
    fetchImpl: (url, options) => {
      assert.ok(['/api/launches', '/api/celestrak/active'].includes(url));
      return fetch(new URL(url, origin), options);
    },
  });
  const source = legacySource
    ? {
        getLaunches: launchSource.getLaunches,
        getActiveTle: launchSource.getActiveTle,
      }
    : launchSource;
  const services = {
    overlays: {
      setOverlayEntries: noop,
      setOverlaySourceVisible: noop,
      clearOverlaySource: noop,
    },
    render: { holdContinuousRender: noop, releaseContinuousRender: noop },
  };
  const state = createState({ services });
  state._enabled = true;
  state._lifecycleToken = 1;
  state._missionSets = { show: false, items: [] };
  const canvas = Object.assign(new EventTarget(), {
    disableRootEvents: true,
    onwheel: null,
    style: {},
  });
  const viewer = {
    dataSources: new Cesium.DataSourceCollection(),
    scene: { canvas, preRender: new Cesium.Event(), drillPick: () => [] },
  };
  bindRenderer(viewer, { frame: fakeSceneFrame(viewer) });
  // Only presentation boundaries are inert. Source, normalization, state,
  // ingestion, lifecycle, stats and feed-state policy execute unchanged.
  // Mission draw sets attached and not let go: the fixture starts with one.
  let attached = 1;
  const parts = {
    panel: {
      createMissionPanel: noop,
      renderMissionRoster: noop,
      renderMissionPanel: noop,
      clearMissionRosterHover: noop,
      clearMissionPanel: noop,
    },
    replay: { stopMissionReplay: noop },
    selection: {
      setSelectedMission: noop,
      focusMission: noop,
      stopMissionZoomAnchor: noop,
    },
    orbitRendering: {
      removeMissionOrbitPrimitives: noop,
      syncMissionOrbitPrimitiveVisibility: noop,
    },
    overlays: {
      createReplayVehicleOverlay: noop,
      clearMissionOverlaySources: noop,
      hideReplayVehicleOverlay: noop,
      destroyReplayVehicleOverlay: noop,
    },
    launchPad: {
      initLaunchPadZonePrimitive: noop,
      hideLaunchPadZone: noop,
      destroyLaunchPadZonePrimitive: noop,
    },
    rendering: {
      // As the rendering part owns the mission draw sets.
      attach() {
        state._missionSets = { show: false, items: [] };
        attached += 1;
      },
      detach() {
        if (state._missionSets) attached -= 1;
        state._missionSets = null;
      },
      updateMissionFrame: noop,
      missionsShown: () => Boolean(state._missionSets?.show),
      showMissions(shown) {
        if (state._missionSets) state._missionSets.show = shown;
      },
      clearLaunchEntities: () => {
        if (state._missionSets) state._missionSets.items = [];
      },
      launchIdFromPicks: () => null,
      missionHitsAt: () => [],
      followTargetFor: () => null,
      launchMarkerAt: () => false,
      addLaunchEntity(record) {
        state._missionSets.items.push(record.id);
      },
      flushLaunchEntities() {},
    },
  };
  const context = { state, services, parts, source };
  parts.model = createModel(context);
  parts.ingestion = createIngestion(context);
  parts.controls = createControls(context);
  parts.lifecycle = createLifecycle(context);
  const current = () => {
    const stats = parts.controls.methods.getStats();
    return {
      stats,
      feed: layerFeedState(stats),
      rendered: state._missionSets?.items.slice() || [],
      enabled: state._enabled,
    };
  };
  return {
    mode,
    state,
    source,
    current,
    viewer,
    attachedSets: () => attached,
    init: () => parts.lifecycle.methods.init(viewer),
    update: () => parts.ingestion.methods.update(),
    disable: () => parts.lifecycle.methods.disable(),
    destroy: () => parts.lifecycle.methods.destroy(viewer),
    holdArrival: () =>
      new Promise((resolve) => {
        arrival = resolve;
      }),
    release: () => release?.(),
    async close() {
      await parts.lifecycle.methods.destroy(viewer);
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test('fresh launches remain nominal through ingestion and the layer stats', async () => {
  const f = await fixture();
  try {
    await f.update();
    const value = f.current();
    assert.equal(value.feed, 'nominal');
    assert.equal(value.stats.count, 1);
    assert.deepEqual(value.rendered, ['owned-launch']);
    assert.equal(value.stats.error, null);
    assert.ok(value.stats.lastUpdate);
  } finally {
    await f.close();
  }
});

test('STALE-ERROR provenance reaches the layer feed state without dropping records', async () => {
  const f = await fixture();
  try {
    f.mode.cache = 'STALE-ERROR';
    assert.equal((await f.source.getLaunchSnapshot()).stale, true);
    await f.update();
    const value = f.current();
    assert.equal(value.stats.count, 1);
    assert.deepEqual(value.rendered, ['owned-launch']);
    assert.equal(value.feed, 'stale');
  } finally {
    await f.close();
  }
});

test('a fresh recovery clears stale launch provenance', async () => {
  const f = await fixture();
  try {
    f.mode.cache = 'STALE-ERROR';
    await f.update();
    const stale = f.current();
    f.mode.cache = 'MISS';
    await f.update();
    const recovered = f.current();
    assert.equal(recovered.feed, 'nominal');
    assert.equal(recovered.stats.count, 1);
    assert.equal(recovered.stats.error, null);
    assert.equal(stale.feed, 'stale');
  } finally {
    await f.close();
  }
});

test('an empty stale snapshot still identifies its fallback provenance', async () => {
  const f = await fixture();
  try {
    f.mode.cache = 'STALE-ERROR';
    f.mode.results = [];
    await f.update();
    assert.equal(f.current().stats.count, 0);
    assert.equal(f.current().feed, 'stale');
  } finally {
    await f.close();
  }
});

test('getLaunches-only injected sources remain supported', async () => {
  const f = await fixture({ legacySource: true });
  try {
    await f.update();
    assert.equal(f.current().feed, 'nominal');
    assert.deepEqual(f.current().rendered, ['owned-launch']);
  } finally {
    await f.close();
  }
});

test('disable cancels a pending stale response without committing it', async () => {
  const f = await fixture();
  try {
    await f.update();
    const healthy = f.current();
    f.mode.cache = 'STALE-ERROR';
    f.mode.hold = true;
    const arrived = f.holdArrival();
    const pending = f.update();
    await arrived;
    await f.disable();
    f.release();
    await pending;
    const value = f.current();
    assert.equal(value.enabled, false);
    assert.equal(value.stats.lastUpdate, healthy.stats.lastUpdate);
    assert.equal(value.feed, 'nominal');
    assert.equal(f.state._sourceController.signal.aborted, true);
  } finally {
    await f.close();
  }
});

test('hiding retained stale records does not relabel them as fresh', async () => {
  const f = await fixture();
  try {
    f.mode.cache = 'STALE-ERROR';
    await f.update();
    await f.disable();
    assert.equal(f.current().feed, 'stale');
    assert.equal(f.current().stats.count, 1);
  } finally {
    await f.close();
  }
});

test('destroy clears the previous feed state and records', async () => {
  const f = await fixture();
  try {
    f.mode.cache = 'STALE-ERROR';
    await f.update();
    await f.destroy();
    const value = f.current();
    assert.equal(value.stats.count, 0);
    assert.equal(value.stats.lastUpdate, null);
    assert.equal(value.feed, 'nominal');
    assert.equal(value.enabled, false);
  } finally {
    await f.close();
  }
});

test('destroy followed by actual init starts a clean instance with owned handlers', async () => {
  const f = await fixture();
  try {
    f.mode.cache = 'STALE-ERROR';
    await f.update();
    await f.destroy();
    await f.init();
    const value = f.current();
    assert.equal(value.feed, 'nominal');
    assert.equal(value.stats.count, 0);
    assert.equal(value.stats.lastUpdate, null);
    assert.equal(value.stats.error, null);
    assert.equal(value.enabled, false);
    assert.equal(f.attachedSets(), 1);
    assert.equal(f.viewer.scene.preRender.numberOfListeners, 1);
    const input = inputFor(f.viewer);
    const before = input.subscriberCount();
    assert.equal(typeof f.state._inputSubscription, 'function');
    await f.destroy();
    assert.equal(f.state._inputSubscription, null);
    assert.equal(
      input.subscriberCount(),
      before - 3,
      'click, hover and double-click follow',
    );
    assert.equal(f.attachedSets(), 0);
    assert.equal(f.viewer.scene.preRender.numberOfListeners, 0);
  } finally {
    await f.close();
  }
});
