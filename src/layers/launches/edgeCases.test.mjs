import test from 'node:test';
import assert from 'node:assert/strict';
import * as geo from '../../geo/index.js';
import { createFakeEngine } from '../../globe/testing/fakeEngine.js';
import { WHITE } from '../shared/color.js';
import { createLaunchesDisplay } from './render/display.js';
import { createState } from './state.js';
import { createRendering } from './rendering.js';
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

function rig({ tle = async () => '1 25544U' } = {}) {
  const engine = createFakeEngine();
  engine.fake.setPose({
    longitude: geo.math.toRadians(-100),
    latitude: geo.math.toRadians(30),
    height: 20_000_000,
  });
  const renderer = createLaunchesDisplay(engine);
  const state = createState({
    services: {
      overlays: {
        setEntries: noop,
        setVisible: noop,
        clearSource: noop,
      },
    },
  });
  state._engine = engine;
  state._renderer = renderer;
  state._enabled = true;
  renderer.setVisible(true);
  let feed = [CAPE, VANDENBERG];
  const source = {
    getLaunches: async () => feed,
    getActiveTle: () => tle(),
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
  };
  const context = {
    state,
    services: {
      geometry: { getKeyholeGeometry: () => ({ radius: 300 }) },
      satellites: {
        getSatelliteOrbitTrack: () => null,
        findSatelliteOrbitTrackInTle: () => null,
      },
    },
    parts,
    source,
    getRenderer: () => renderer,
  };
  parts.rendering = {
    ...createRendering(context),
    // The launch marker (the pad) and a replay track per mission.
    addLaunchElements(launch) {
      parts.rendering.addMissionElement({
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
    shown: (id) => state._missionElements.get(`rocket-launch:${id}`)?.shown,
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
      parts.ingestion.clearPostTleRetry();
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

/** An active-satellite lookup that answers only when the test says so. */
function lateTle() {
  let answer;
  const pending = new Promise((resolve) => (answer = resolve));
  return { tle: () => pending, answer: () => answer('1 25544U') };
}
const flights = (r) =>
  r.cameraCommands().filter(({ method }) => method !== 'camera.lookAt');

test('edge:rocket-launches: a late TLE answer and a refresh never take the camera from a superseded flyover', async () => {
  const lookup = lateTle();
  const r = rig({ tle: lookup.tle });
  try {
    await r.parts.ingestion.requestMissionUpdate();
    r.parts.selection.setSelectedMission(CAPE.id);
    r.parts.selection.focusMission(CAPE);
    r.engine.fake.frames(200);
    r.parts.replay.startMissionReplay(CAPE.id);
    r.engine.fake.frames(20);
    // The user moves on to the second mission's launch site.
    r.parts.selection.setSelectedMission(VANDENBERG.id);
    r.parts.selection.focusLaunchSite(VANDENBERG);
    r.engine.fake.frames(400);
    const parked = r.engine.camera.pose().position;
    r.engine.fake.resetCalls();
    lookup.answer();
    await settle();
    await r.parts.ingestion.requestMissionUpdate();
    await settle();
    r.engine.fake.frames(400);

    assert.deepEqual(flights(r), [], 'no flight after the refresh');
    assert.ok(near(r.engine.camera.pose().position, parked, 1));
    assert.equal(r.state._selectedLaunchId, VANDENBERG.id);
  } finally {
    r.cleanup();
  }
});

test('edge:rocket-launches: a late TLE answer and a refresh never take the camera after a running or cancelled flyover', async () => {
  for (const cancel of [false, true]) {
    const lookup = lateTle();
    const r = rig({ tle: lookup.tle });
    try {
      await r.parts.ingestion.requestMissionUpdate();
      r.parts.selection.setSelectedMission(CAPE.id);
      r.parts.selection.focusMission(CAPE);
      r.engine.fake.frames(200);
      r.parts.replay.startMissionReplay(CAPE.id);
      r.engine.fake.frames(20);
      if (cancel) r.parts.replay.stopMissionReplay();
      lookup.answer();
      await settle();
      // The refresh ends a running flyover (its tracks are rebuilt) and must
      // leave the camera where the flyover put it.
      const parked = r.engine.camera.pose().position;
      r.engine.fake.resetCalls();
      await r.parts.ingestion.requestMissionUpdate();
      await settle();
      r.engine.fake.frames(400);

      assert.deepEqual(flights(r), [], `no flight (cancelled: ${cancel})`);
      assert.ok(near(r.engine.camera.pose().position, parked, 1));
      assert.equal(r.state._replayCameraLaunchId, null);
      assert.equal(r.state._selectedLaunchId, CAPE.id, 'the card stays');
    } finally {
      r.cleanup();
    }
  }
});

test('edge:rocket-launches: a mission still framed when its late TLE arrives is framed again with the orbit', async () => {
  const lookup = lateTle();
  const r = rig({ tle: lookup.tle });
  try {
    await r.parts.ingestion.requestMissionUpdate();
    r.parts.selection.setSelectedMission(CAPE.id);
    r.parts.selection.focusMission(CAPE);
    r.engine.fake.frames(200);
    r.engine.fake.resetCalls();
    lookup.answer();
    await settle();
    await r.parts.ingestion.requestMissionUpdate();
    await settle();
    assert.deepEqual(
      flights(r).map(({ method }) => method),
      ['camera.flyTo'],
      'the orbit view is framed once',
    );
  } finally {
    r.cleanup();
  }
});
