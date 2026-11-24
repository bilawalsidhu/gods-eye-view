// Away from live, a launch shows from its lift-off on, so scrubbing the world
// time brings the launches up in the order they flew.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';
import { worldClock } from '../../time/worldClock.js';
import { createState } from './state.js';
import { createRendering } from './rendering.js';
import { createSelection } from './selection.js';

const noop = () => {};
const LAUNCH_MS = Date.UTC(2026, 9, 20, 12);

function scene(t) {
  t.after(() => worldClock.goLive());
  const state = createState({
    services: {
      overlays: {
        setOverlayEntries: noop,
        setOverlaySourceVisible: noop,
        clearOverlaySource: noop,
      },
    },
  });
  const launch = {
    id: 'ceres-1',
    name: 'Ceres-1',
    lon: 0,
    lat: 0,
    launchTime: new Date(LAUNCH_MS).toISOString(),
    status: 'Launch Successful',
    recoveryStages: [],
    trajectory: [
      { latitude: 0, longitude: 0 },
      { latitude: 1, longitude: 1 },
    ],
  };
  const viewer = { scene: {} };
  const flights = [];
  const { draw, unbind } = bindFakeDraw(viewer, {
    camera: {
      pose: () => ({ position: { x: 2e7, y: 0, z: 0 } }),
      on: () => () => {},
      flyTo: (...args) => flights.push(args),
      lookAt: noop,
      release: noop,
    },
  });
  t.after(unbind);
  state._enabled = true;
  state._viewer = viewer;
  const syncs = { labels: 0, orbits: 0 };
  const parts = {
    model: { missionMarkerColor: () => [1, 1, 1, 1] },
    policyHelpers: { launchStatusAllowsOrbit: () => false },
    paths: { surfaceSafePath: (positions) => positions },
    panel: { updateMissionTelemetry: noop },
    overlays: {
      missionHoverReticleImage: () => ({}),
      hideReplayVehicleOverlay: noop,
      updateReplayVehicleOverlay: noop,
      refreshSelectedMissionOverlayText: noop,
      missionAnchorVisible: () => true,
      syncMissionOverlayEntries: () => syncs.labels++,
    },
    orbitRendering: {
      syncMissionOrbitPrimitiveVisibility: () => syncs.orbits++,
    },
  };
  const services = {
    geometry: { getKeyholeGeometry: noop },
    satellites: {},
  };
  parts.selection = createSelection({ state, services, parts });
  const rendering = createRendering({ state, services, parts });
  parts.rendering = rendering;
  rendering.attach(viewer);
  rendering.showMissions(true);
  rendering.addLaunchEntity(launch, null);
  rendering.flushLaunchEntities();
  // The drawn item by id, across the mission sets.
  const item = (id) => {
    for (const record of draw.sets.values())
      if (!record.disposed && record.items.has(id)) return record.items.get(id);
    return null;
  };
  assert.ok(item(`rocket-launch:${launch.id}`), 'the marker is drawn');
  assert.ok(item(`rocket-trajectory:${launch.id}:0`), 'the path is drawn');
  const shown = () => {
    rendering.updateMissionFrame();
    return {
      marker: item(`rocket-launch:${launch.id}`).show,
      path: item(`rocket-trajectory:${launch.id}:0`).show,
    };
  };
  return { state, rendering, launch, syncs, shown, draw, parts, flights };
}

test('live shows every launch in the window, lifted off or not', (t) => {
  const { state, launch, shown } = scene(t);
  assert.equal(state.launchPending(launch), false);
  assert.deepEqual(shown(), { marker: true, path: true });
});

test('away from live a launch shows from its lift-off on', (t) => {
  const { state, launch, syncs, shown } = scene(t);
  worldClock.seek(LAUNCH_MS - 60_000);
  assert.equal(state.launchPending(launch), true);
  assert.deepEqual(shown(), { marker: false, path: false });
  assert.deepEqual(syncs, { labels: 1, orbits: 1 }, 'its label and orbit go');
  shown();
  assert.deepEqual(syncs, { labels: 1, orbits: 1 }, 'once, not each frame');

  worldClock.seek(LAUNCH_MS);
  assert.equal(state.launchPending(launch), false);
  assert.deepEqual(shown(), { marker: true, path: true });
  assert.deepEqual(syncs, { labels: 2, orbits: 2 });
});

test('the selected mission stays whenever it flies', (t) => {
  const { state, rendering, launch, shown } = scene(t);
  state._selectedLaunchId = launch.id;
  rendering.isolateMission(launch.id);
  worldClock.seek(LAUNCH_MS - 60_000);
  assert.deepEqual(shown(), { marker: true, path: true });
});

test('the live orbit rings turn at the frame time, not the wall clock', (t) => {
  const { draw } = scene(t);
  const orbits = [...draw.sets.values()].find((record) =>
    record.spec.id.endsWith(':orbits'),
  );
  assert.deepEqual(orbits.spec.motionClock, { kind: 'scene' });
});

test('in the cockpit a chosen mission is not flown to', (t) => {
  const { launch, parts, flights } = scene(t);
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      body: { classList: { contains: (name) => name === 'cockpit-mode' } },
    },
  });
  try {
    parts.selection.focusMission(launch);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'document', previous);
    else delete globalThis.document;
  }
  assert.deepEqual(flights, [], 'the cockpit keeps the camera');
});
