import test from 'node:test';
import assert from 'node:assert/strict';
import * as geo from '../../geo/index.js';
import { createFakeEngine } from '../../globe/testing/fakeEngine.js';
import { WHITE } from '../shared/color.js';
import { createLaunchesNavaraRenderer } from './render/navara.js';
import { createState } from './state.js';
import { createPaths } from './paths.js';
import { createCamera } from './camera.js';
import { createSelection } from './selection.js';
import { createReplay } from './replay.js';
import { createIngestion } from './ingestion.js';

const noop = () => {};
const settle = async () => {
  for (let i = 0; i < 5; i++)
    await new Promise((resolve) => setImmediate(resolve));
};
const CAPE = { id: 'cape', name: 'Cape mission', lat: 28.56, lon: -80.58 };
const VANDENBERG = {
  id: 'vandy',
  name: 'Vandy mission',
  lat: 34.63,
  lon: -120.6,
};
const pad = (launch, height = 0) =>
  geo.cartesian3.fromDegrees(launch.lon, launch.lat, height);

function rig() {
  const engine = createFakeEngine({ kind: 'navara' });
  engine.fake.setPose({
    longitude: geo.math.toRadians(-100),
    latitude: geo.math.toRadians(30),
    height: 20_000_000,
  });
  const renderer = createLaunchesNavaraRenderer(engine);
  const state = createState({
    services: {
      overlays: {
        setOverlayEntries: noop,
        setOverlaySourceVisible: noop,
        clearOverlaySource: noop,
      },
    },
  });
  state._viewer = renderer.view;
  state._engine = engine;
  state._renderer = renderer;
  state._enabled = true;
  state._dataSource = renderer.createDataSource();
  state._dataSource.show = true;
  let feed = [CAPE, VANDENBERG];
  const source = {
    getLaunches: async () => feed,
    getActiveTle: async () => '1 25544U',
  };
  const parts = {
    panel: {
      clearMissionRosterHover: noop,
      renderMissionPanel: noop,
      renderMissionRoster: noop,
      publishPanel: noop,
    },
    overlays: { syncMissionOverlayEntries: noop },
    orbitRendering: {
      syncMissionOrbitPrimitiveVisibility: noop,
      removeMissionOrbitPrimitives: noop,
    },
    policyHelpers: { releaseAircraftTracking: noop },
    model: { normalizeRocketLaunches: (launches) => launches },
    rendering: {
      // The launch marker (the pad) and a replay track per mission.
      addLaunchEntity(launch) {
        renderer.addEntity(state._dataSource, {
          id: `rocket-launch:${launch.id}`,
          position: pad(launch),
          point: { pixelSize: 8, color: WHITE },
        });
        state._replayTracks.set(launch.id, {
          ascentDurationSec: 600,
          ascentPath: [pad(launch), pad(launch, 100_000)],
          animatedOrbitPath: [pad(launch, 100_000), pad(launch, 200_000)],
          beginReplayFrame: () => ({
            ascending: true,
            phaseProgress: 0.2,
            elapsedSinceStart: 10,
          }),
          getReplayState: () => null,
        });
      },
    },
  };
  const context = {
    state,
    services: { geometry: { getKeyholeGeometry: () => ({ radius: 300 }) } },
    parts,
    source,
    getRenderer: () => renderer,
  };
  parts.paths = createPaths(context);
  parts.camera = createCamera(context);
  parts.selection = createSelection(context);
  parts.replay = createReplay(context);
  parts.ingestion = createIngestion(context);
  return {
    engine,
    state,
    parts,
    setFeed: (next) => (feed = next),
    shown: (id) =>
      state._dataSource.entities.getById(`rocket-launch:${id}`)?.show,
    cameraCommands: () =>
      engine.fake.calls.filter(({ method }) =>
        [
          'camera.lookAt',
          'camera.setView',
          'camera.flyTo',
          'camera.flyToSphere',
        ].includes(method),
      ),
    cleanup() {
      state._sourceController.abort();
      parts.replay.stopMissionReplay();
      renderer.destroy();
      engine.destroy();
    },
  };
}

const near = (a, b, metres) => geo.cartesian3.distance(a, b) < metres;

test('edge:rocket-launches: choosing a second mission mid-flyover leaves the camera to that mission', async () => {
  const r = rig();
  try {
    await r.parts.ingestion.requestMissionUpdate();
    r.parts.selection.setSelectedMission(CAPE.id);
    assert.equal(r.parts.replay.startMissionReplay(CAPE.id), true);
    assert.equal(r.engine.camera.flightActive(), true);
    r.engine.fake.frames(20); // part-way to the Cape pad
    r.parts.selection.setSelectedMission(VANDENBERG.id);
    r.parts.selection.focusLaunchSite(VANDENBERG);
    r.engine.fake.resetCalls();
    r.engine.fake.frames(400);

    assert.equal(r.state._replayCameraLaunchId, null);
    assert.equal(r.state._selectedLaunchId, VANDENBERG.id);
    // Nothing the old flyover set up moves the camera again: the only command
    // after the switch is the zoom anchor on the second mission's pad.
    for (const { method, args } of r.cameraCommands()) {
      assert.equal(method, 'camera.lookAt');
      assert.ok(near(args[0], pad(VANDENBERG), 1), 'anchored on Vandenberg');
    }
    assert.ok(near(r.engine.fake.lookAtTarget(), pad(VANDENBERG), 1));
    assert.equal(r.shown(VANDENBERG.id), true);
    assert.equal(r.shown(CAPE.id), false);
  } finally {
    r.cleanup();
  }
});

test('edge:rocket-launches: a launch cancelled mid-flyover stops the flyover and keeps its card and pad', async () => {
  const r = rig();
  try {
    await r.parts.ingestion.requestMissionUpdate();
    r.parts.selection.setSelectedMission(CAPE.id);
    r.parts.replay.startMissionReplay(CAPE.id);
    r.engine.fake.frames(20);
    // The next snapshot reports the mission scrubbed.
    r.setFeed([{ ...CAPE, status: 'Scrubbed' }, VANDENBERG]);
    await r.parts.ingestion.requestMissionUpdate();
    await settle();
    const parked = r.engine.camera.pose().position;
    r.engine.fake.resetCalls();
    r.engine.fake.frames(400);

    assert.equal(r.state._replayCameraLaunchId, null);
    assert.equal(r.engine.camera.flightActive(), false);
    assert.deepEqual(r.cameraCommands(), [], 'the old flyover never resumes');
    assert.ok(near(r.engine.camera.pose().position, parked, 1));
    assert.equal(r.state._selectedLaunchId, CAPE.id, 'the card stays');
    assert.equal(r.shown(CAPE.id), true, 'the pad stays');
  } finally {
    r.cleanup();
  }
});
