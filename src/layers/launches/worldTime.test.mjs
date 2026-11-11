// Away from live, a launch shows from its lift-off on, so scrubbing the world
// time brings the launches up in the order they flew.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as geo from '../../geo/index.js';
import { createFakeEngine } from '../../globe/testing/fakeEngine.js';
import { WHITE } from '../shared/color.js';
import { createLaunchesDisplay } from './render/display.js';
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
        setEntries: noop,
        setVisible: noop,
        clearSource: noop,
      },
    },
  });
  const launch = {
    id: 'ceres-1',
    launchTime: new Date(LAUNCH_MS).toISOString(),
  };
  state._enabled = true;
  const engine = createFakeEngine();
  const renderer = createLaunchesDisplay(engine);
  engine.camera.setView({ destination: geo.cartesian3.create(2e7, 0, 0) });
  state._engine = engine;
  state._renderer = renderer;
  renderer.setVisible(true);
  t.after(() => {
    renderer.destroy();
    engine.destroy();
  });
  state._missionOverlayRecords.set(launch.id, { launch });
  const position = geo.cartesian3.fromDegrees(0, 0);
  const syncs = { labels: 0, orbits: 0 };
  const parts = {
    panel: { updateMissionTelemetry: noop },
    overlays: {
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
  const context = { state, services, parts, getRenderer: () => renderer };
  parts.selection = createSelection(context);
  const rendering = createRendering(context);
  const anchor = rendering.addMissionElement({
    id: `rocket-launch:${launch.id}`,
    position,
    point: { pixelSize: 5, color: WHITE },
  });
  const path = rendering.addMissionElement({
    id: `rocket-transfer:${launch.id}`,
    polyline: {
      positions: [position, geo.cartesian3.fromDegrees(1, 1)],
      width: 2,
      color: WHITE,
    },
  });
  const shown = () => {
    rendering.updateMissionFrame();
    return {
      marker: anchor.point.show,
      path: path.line.show,
    };
  };
  return { state, launch, syncs, shown };
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
  const { state, launch, shown } = scene(t);
  state._selectedLaunchId = launch.id;
  worldClock.seek(LAUNCH_MS - 60_000);
  assert.deepEqual(shown(), { marker: true, path: true });
});
