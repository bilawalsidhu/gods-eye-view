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
  currentSelection,
  onSelectionChanged,
  releaseSelection,
  yieldSelectionToOthers,
} from './clickSelect.js';
import { flyToWorldTarget } from '../worldFocus.js';
import { distance, fromDegrees, normalize, sub } from '../geo/index.js';
import { bindClickCamera } from '../testSupport/clickCamera.mjs';

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
