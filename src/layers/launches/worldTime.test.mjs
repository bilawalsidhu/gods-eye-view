// Away from live, a launch shows from its lift-off on, so scrubbing the world
// time brings the launches up in the order they flew.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
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
    launchTime: new Date(LAUNCH_MS).toISOString(),
  };
  state._enabled = true;
  state._dataSource = new Cesium.CustomDataSource('launches');
  state._viewer = {
    scene: { camera: { positionWC: new Cesium.Cartesian3(2e7, 0, 0) } },
  };
  state._missionOverlayRecords.set(launch.id, { launch });
  const position = Cesium.Cartesian3.fromDegrees(0, 0);
  const anchor = state._dataSource.entities.add({
    id: `rocket-launch:${launch.id}`,
    position,
    point: { pixelSize: 5 },
  });
  const path = state._dataSource.entities.add({
    id: `rocket-transfer:${launch.id}`,
    polyline: { positions: [position, Cesium.Cartesian3.fromDegrees(1, 1)] },
  });
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
  parts.selection = createSelection({ state, services, parts });
  const rendering = createRendering({ state, services, parts });
  const shown = () => {
    rendering.updateMissionFrame();
    const time = Cesium.JulianDate.now();
    return {
      marker: anchor.point.show.getValue(time),
      path: path.polyline.show?.getValue(time) ?? true,
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
