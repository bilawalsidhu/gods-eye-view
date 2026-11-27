import test from 'node:test';
import assert from 'node:assert/strict';
import { createSelection } from './selection.js';
import { bindRenderer } from '../../render/rendererOf.js';
import { followedOf } from '../../data/followed.js';
import { fakeCameraPort } from '../../testSupport/fakeCameraPort.mjs';

function setup(t, satelliteId = null) {
  const viewer = {};
  const { port, emit } = fakeCameraPort();
  let followTarget = {
    key: satelliteId === null ? 'flights:near01' : `satellites:${satelliteId}`,
  };
  let trackedSatellite = satelliteId;
  const satelliteStops = [];
  const moves = [];
  const move = (kind) => moves.push([kind, followTarget, trackedSatellite]);
  const camera = {
    ...port,
    get followed() {
      return followTarget;
    },
    follow(target) {
      followTarget = target;
      emit('followChanged');
    },
    flyTo: () => move('fly'),
    flyToBounds: () => move('fly-bounds'),
    release: () => move('release'),
    lookAt: () => {},
  };
  const unbind = bindRenderer(viewer, {
    camera,
    canvas: { clientWidth: 1200, clientHeight: 800 },
    input: { on: () => () => {}, isPointerFree: () => true },
  });
  t.after(unbind);
  const dataManager = { layers: new Map() };
  if (satelliteId !== null) {
    dataManager.layers.set('satellites', {
      module: {
        stopTracking(options) {
          satelliteStops.push(options);
          trackedSatellite = null;
        },
      },
    });
  }
  const released = [];
  const noop = () => {};
  const selection = createSelection({
    state: { _viewer: viewer, _enabled: true, _dataManager: dataManager },
    services: { geometry: { getKeyholeGeometry: () => ({ radius: 350 }) } },
    parts: {
      replay: { stopMissionReplay: noop },
      rendering: { selectLaunchEntity: noop, projectedOrbitPath: () => null },
      policyHelpers: {
        releaseAircraftTracking: (manager) => released.push(manager),
      },
    },
  });
  return { viewer, moves, released, selection, dataManager, satelliteStops };
}

const LAUNCH = { id: 'a', lat: 28.5, lon: -80.6 };

test('Fly to while following ends the follow before the flight', (t) => {
  const { viewer, moves, released, selection, dataManager } = setup(t);
  selection.focusLaunchSite(LAUNCH);
  assert.equal(followedOf(viewer), null);
  assert.deepEqual(released, [dataManager]);
  assert.deepEqual(moves.at(-1), ['fly-bounds', null, null]);
});

test('a mission flight while following ends the follow before the flight', (t) => {
  const { viewer, moves, released, selection, dataManager } = setup(t);
  selection.focusMission(LAUNCH);
  assert.equal(followedOf(viewer), null);
  assert.deepEqual(released, [dataManager]);
  assert.deepEqual(moves.at(-1), ['fly', null, null]);
});

test('an explicit mission flight releases the satellite tracker before moving the camera', async (t) => {
  for (const [method, move] of [
    ['focusLaunchSite', 'fly-bounds'],
    ['focusMission', 'fly'],
  ]) {
    await t.test(method, (t) => {
      const { viewer, selection, satelliteStops, moves } = setup(t, 25544);
      selection[method](LAUNCH);
      assert.equal(followedOf(viewer), null);
      assert.deepEqual(satelliteStops, [{ origin: 'tool' }]);
      assert.deepEqual(moves.at(-1), [move, null, null]);
    });
  }
});
