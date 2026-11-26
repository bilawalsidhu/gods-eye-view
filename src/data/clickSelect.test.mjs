// The one click rule for moving things on the map: a click selects and
// centres once, keeping the camera's view; it never follows; one thing is
// selected at a time across layers.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CLICK_CENTER_S,
  _resetSelectionForTest,
  centerOnClick,
  claimSelection,
  clockRateFor,
  currentSelection,
  followOnSecondClick,
  isCentredOnSelection,
  onSelectionChanged,
  releaseSelection,
  yieldSelectionToOthers,
} from './clickSelect.js';
import { flyToWorldTarget } from '../worldFocus.js';
import {
  distance,
  fromDegrees,
  normalize,
  sub,
  toLonLatH,
} from '../geo/index.js';
import { bindClickCamera } from '../testSupport/clickCamera.mjs';
import { worldClock } from '../time/worldClock.js';

const near = (a, b, eps = 1e-6) => distance(a, b) < eps;

function setup(t) {
  _resetSelectionForTest();
  const viewer = { isDestroyed: () => false };
  const camera = bindClickCamera(viewer);
  t.after(() => {
    camera.unbind();
    _resetSelectionForTest();
  });
  return { viewer, camera };
}

test('a click centres once, keeping the camera’s distance and angle, and follows nothing', (t) => {
  const { viewer, camera } = setup(t);
  const before = camera.port.pose();
  // A plane 5 km east of the view's middle, 10 km up.
  const at = fromDegrees(-97.69, 30.27, 10_000);
  assert.equal(
    centerOnClick(viewer, () => at),
    true,
  );
  assert.equal(camera.flights.length, 1, 'one flight');
  assert.equal(camera.follows.length, 0, 'never followed');
  assert.equal(camera.followed, null);
  const { destination, options } = camera.flights[0];
  assert.equal(options.durationS, CLICK_CENTER_S);
  assert.equal(options.maxHeight, 0, 'no arc');
  // Same view direction: the eye only moves.
  assert.deepEqual(options.orientation.direction, before.direction);
  // From where it lands the eye looks at the target, from the same range.
  const range = distance(before.position, at);
  assert.ok(Math.abs(distance(destination, at) - range) < 1e-3);
  const look = normalize(sub(at, destination));
  assert.ok(near(look, normalize(before.direction), 1e-9), 'centred');
});

test('a moving thing is met where it will be when the flight lands', (t) => {
  const { viewer, camera } = setup(t);
  const asked = [];
  const now = fromDegrees(-97.7, 30.3, 10_000);
  const later = fromDegrees(-97.69, 30.3, 10_000);
  centerOnClick(viewer, (aheadMs) => {
    asked.push(aheadMs);
    return aheadMs > 0 ? later : now;
  });
  assert.deepEqual(asked, [CLICK_CENTER_S * 1000]);
  const { destination } = camera.flights[0];
  const look = normalize(sub(later, destination));
  assert.ok(near(look, normalize(camera.port.pose().direction), 1e-9));
});

test('a click ends a follow in progress and leaves nothing followed', (t) => {
  const { viewer, camera } = setup(t);
  camera.port.follow({ key: 'satellites:25544', position: () => null });
  centerOnClick(viewer, () => fromDegrees(-97.7, 30.3, 0));
  assert.equal(camera.followed, null);
  assert.equal(camera.flights.length, 1);
});

test('the Cockpit keeps the camera through a click; nowhere to go is no flight', (t) => {
  const { viewer, camera } = setup(t);
  const previous = globalThis.document;
  globalThis.document = {
    body: { classList: { contains: (name) => name === 'cockpit-mode' } },
  };
  t.after(() => {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  });
  assert.equal(
    centerOnClick(viewer, () => fromDegrees(-97.7, 30.3, 0)),
    false,
  );
  globalThis.document = previous;
  assert.equal(
    centerOnClick(viewer, () => null),
    false,
  );
  assert.equal(
    centerOnClick(viewer, () => ({ x: NaN, y: 0, z: 0 })),
    false,
  );
  assert.equal(camera.flights.length, 0);
});

test('a vessel’s or a train’s click focus is the same flight', (t) => {
  const { viewer, camera } = setup(t);
  const at = fromDegrees(-97.7, 30.3, 0);
  flyToWorldTarget(viewer, {
    kind: 'vessel',
    id: 'v1',
    position: at,
    keepView: true,
  });
  centerOnClick(viewer, () => at);
  assert.equal(camera.flights.length, 2);
  const [vessel, click] = camera.flights;
  assert.ok(near(vessel.destination, click.destination));
  assert.deepEqual(vessel.options, click.options);
});

test('one selection across layers: a claim makes every other layer let go', (t) => {
  setup(t);
  const cleared = [];
  let flights = null;
  let vessels = null;
  yieldSelectionToOthers(
    'flights',
    () => flights !== null,
    (selection) => {
      cleared.push(['flights', selection.layerId, selection.origin]);
      flights = null;
    },
  );
  yieldSelectionToOthers(
    'ais-live-vessels',
    () => vessels !== null,
    () => {
      cleared.push(['vessels']);
      vessels = null;
    },
  );
  flights = 'abc123';
  claimSelection('flights', 'abc123');
  assert.deepEqual(cleared, [], 'its own claim keeps it');
  vessels = 'v1';
  claimSelection('ais-live-vessels', 'v1');
  assert.deepEqual(cleared, [['flights', 'ais-live-vessels', 'user']]);
  flights = 'def456';
  claimSelection('flights', 'def456', { origin: 'voice' });
  assert.deepEqual(cleared.at(-1), ['vessels']);
  assert.equal(currentSelection().id, 'def456');
});

test('a release names its own selection only', (t) => {
  setup(t);
  const seen = [];
  onSelectionChanged((selection, previous) =>
    seen.push([selection?.id ?? null, previous?.id ?? null]),
  );
  const subject = { key: 'flights:abc123' };
  claimSelection('flights', 'abc123', { subject });
  assert.equal(currentSelection().subject, subject);
  releaseSelection('flights', 'zzz999');
  releaseSelection('satellites');
  assert.equal(currentSelection().id, 'abc123', 'not theirs to release');
  releaseSelection('flights', 'abc123');
  assert.equal(currentSelection(), null);
  assert.deepEqual(seen, [
    ['abc123', null],
    [null, 'abc123'],
  ]);
});

/** A world clock double in the state `getState` reports. */
const clockState = (state) => ({
  getState: () => ({
    live: false,
    playing: true,
    buffering: false,
    rate: 1,
    following: ['flights', 'satellites'],
    ...state,
  }),
});

test('the lead is the time the flight takes on the layer’s own clock', () => {
  assert.equal(clockRateFor('flights', clockState({ live: true })), 1);
  assert.equal(clockRateFor('flights', clockState({ rate: 60 })), 60);
  assert.equal(clockRateFor('flights', clockState({ playing: false })), 0);
  assert.equal(clockRateFor('flights', clockState({ buffering: true })), 0);
  // A layer that stays live while the world plays back runs at 1.
  assert.equal(clockRateFor('transit', clockState({ rate: 60 })), 1);
  assert.equal(clockRateFor(null, clockState({ rate: 60 })), 1);
});

test('a paused world aims at where the thing is; a 60x one sixty times further', (t) => {
  const { viewer } = setup(t);
  const asked = [];
  const positionAt = (aheadMs) => {
    asked.push(aheadMs);
    return fromDegrees(-97.7, 30.3, 10_000);
  };
  worldClock.seek(Date.UTC(2026, 0, 1));
  t.after(() => worldClock.goLive());
  worldClock.pause();
  centerOnClick(viewer, positionAt, { clockId: 'satellites' });
  worldClock.setRate(60);
  t.after(() => worldClock.setRate(1));
  worldClock.play({ continuous: true });
  centerOnClick(viewer, positionAt, { clockId: 'satellites' });
  assert.deepEqual(asked, [0, 60 * CLICK_CENTER_S * 1000]);
});

test('deselecting while the camera is on its way stops it there', (t) => {
  const { viewer, camera } = setup(t);
  const cancelled = [];
  const flyTo = camera.port.flyTo;
  camera.port.flyTo = (...args) => {
    flyTo(...args);
    return {
      done: new Promise(() => {}),
      cancel: () => cancelled.push(args[0]),
    };
  };
  claimSelection('flights', 'abc123');
  centerOnClick(viewer, () => fromDegrees(-97.7, 30.3, 10_000));
  releaseSelection('flights', 'abc123');
  assert.equal(cancelled.length, 1, 'cancelled in flight');
  // Another layer's selection replacing it stops it too.
  claimSelection('flights', 'abc123');
  centerOnClick(viewer, () => fromDegrees(-97.7, 30.3, 10_000));
  claimSelection('ais-live-vessels', 'v1');
  assert.equal(cancelled.length, 2);
});

test('a landed centring is not cancelled by a later deselect', async (t) => {
  const { viewer, camera } = setup(t);
  let cancels = 0;
  const flyTo = camera.port.flyTo;
  camera.port.flyTo = (...args) => {
    flyTo(...args);
    return { done: Promise.resolve('complete'), cancel: () => cancels++ };
  };
  claimSelection('flights', 'abc123');
  centerOnClick(viewer, () => fromDegrees(-97.7, 30.3, 10_000));
  await new Promise((resolve) => setImmediate(resolve));
  releaseSelection('flights', 'abc123');
  assert.equal(cancels, 0, 'a later flight of anyone else is left alone');
});

test('a thing beyond the horizon is framed by a flight, never looked at through the planet', (t) => {
  _resetSelectionForTest();
  const viewer = { isDestroyed: () => false };
  const camera = bindClickCamera(viewer, { lon: 0, lat: 0, height: 20_000 });
  t.after(() => {
    camera.unbind();
    _resetSelectionForTest();
  });
  // An aircraft on the far side of the planet.
  const at = fromDegrees(180, 0, 10_000);
  assert.equal(
    centerOnClick(viewer, () => at),
    true,
  );
  const { destination, options } = camera.flights[0];
  const eye = toLonLatH(destination);
  assert.ok(eye.height > 1_000, 'the eye is above the ground');
  const towards = normalize(sub(at, destination));
  assert.ok(distance(normalize(options.orientation.direction), towards) < 1e-9);
  // Nothing of the planet between the eye and the aircraft.
  for (let i = 1; i < 32; i++) {
    const k = i / 32;
    const p = {
      x: destination.x + (at.x - destination.x) * k,
      y: destination.y + (at.y - destination.y) * k,
      z: destination.z + (at.z - destination.z) * k,
    };
    assert.ok(toLonLatH(p).height > 0, 'a clear line of sight');
  }
  assert.ok(distance(destination, at) < 100_000, 'framed close');
  assert.equal(options.maxHeight, undefined, 'a long flight arcs');
});

test('the view a centring left counts as centred through a renderer’s small clamp', async (t) => {
  const { viewer, camera } = setup(t);
  claimSelection('satellites', '25544');
  const at = fromDegrees(-80, 30.3, 400_000);
  centerOnClick(viewer, () => at);
  const { destination, options } = camera.flights[0];
  const range = distance(destination, at);
  const nudged = { ...destination, z: destination.z + range * 1e-4 };
  assert.ok(
    isCentredOnSelection({
      position: nudged,
      direction: options.orientation.direction,
    }),
  );
  const moved = { ...destination, z: destination.z + range * 0.05 };
  assert.ok(
    !isCentredOnSelection({
      position: moved,
      direction: options.orientation.direction,
    }),
  );
});

test('a second click on the selected thing follows it; on a followed one it keeps the follow', (t) => {
  const { viewer, camera } = setup(t);
  let following = false;
  const follows = [];
  const layer = {
    isFollowed: () => following,
    follow: () => {
      follows.push('follow');
      following = true;
      return true;
    },
  };
  // Not the selected thing: nothing is followed.
  assert.equal(followOnSecondClick('flights', 'abc123', layer), false);
  claimSelection('flights', 'abc123');
  assert.equal(followOnSecondClick('flights', 'def456', layer), false);
  assert.equal(followOnSecondClick('military', 'abc123', layer), false);
  assert.equal(follows.length, 0);
  // The selected thing: followed, and its centring flight gives way.
  const cancelled = [];
  const flyTo = camera.port.flyTo;
  camera.port.flyTo = (...args) => {
    flyTo(...args);
    return { done: new Promise(() => {}), cancel: () => cancelled.push(1) };
  };
  centerOnClick(viewer, () => fromDegrees(-97.7, 30.3, 10_000));
  assert.equal(followOnSecondClick('flights', 'abc123', layer), true);
  assert.deepEqual(follows, ['follow']);
  assert.equal(cancelled.length, 1);
  assert.equal(currentSelection()?.id, 'abc123', 'still selected');
  // Already followed: kept as it is, never toggled off nor started again.
  assert.equal(followOnSecondClick('flights', 'abc123', layer), false);
  assert.deepEqual(follows, ['follow']);
});

test('the Cockpit keeps the camera through a second click', (t) => {
  setup(t);
  const previous = globalThis.document;
  globalThis.document = {
    body: { classList: { contains: (name) => name === 'cockpit-mode' } },
  };
  t.after(() => {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  });
  claimSelection('satellites', 25544);
  let followed = false;
  const started = followOnSecondClick('satellites', 25544, {
    isFollowed: () => false,
    follow: () => (followed = true),
  });
  assert.equal(started, false);
  assert.equal(followed, false);
});
