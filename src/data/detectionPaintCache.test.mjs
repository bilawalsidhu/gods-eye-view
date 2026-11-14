import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDetectionPaintCache,
  PAINTED_OBJECT_FIELDS,
  RECORD_STRIDE,
  SWEEPS_BEFORE_BACKOFF,
} from './detectionPaintCache.js';

const contacts = () => [
  {
    position: { x: 1, y: 2, z: 3 },
    _layerId: 'flights',
    sourceId: 'a',
    id: 'A',
    metric: 'FL300',
    type: 'AIR',
  },
  {
    position: { x: 4, y: 5, z: 6 },
    _layerId: 'vessels',
    sourceId: 'b',
    id: 'B',
    type: 'SEA',
  },
  { _layerId: 'cctv', sourceId: 'c', id: 'C', type: 'CAM' },
];
const view = () => ['DENSE', 800, 600, 0.25, 1, 0, 0, 1];

function kept() {
  const cache = createDetectionPaintCache();
  const objects = contacts();
  const built = { paths: 'kept' };
  assert.equal(cache.keep(view(), objects, built), true);
  return { cache, objects, built };
}

test('the kept sweep is handed back for the same view and the same objects', () => {
  const { cache, objects, built } = kept();
  assert.equal(cache.reuse(view(), objects), built);
  assert.equal(cache.reuse(view(), objects), built, 'and again');
  // The same objects in a new list are still the same objects.
  assert.equal(cache.reuse(view(), [...objects]), built);
});

test('nothing is handed back before a sweep is kept, or after it is forgotten', () => {
  const cache = createDetectionPaintCache();
  const objects = contacts();
  assert.equal(cache.reuse(view(), objects), null);
  cache.keep(view(), objects, {});
  cache.forget();
  assert.equal(cache.reuse(view(), objects), null);
  cache.keep(view(), objects, {});
  cache.clear();
  assert.equal(cache.reuse(view(), objects), null);
});

test('any value of the view that differs is a miss', () => {
  for (let i = 0; i < view().length; i++) {
    const { cache, objects } = kept();
    const changed = view();
    changed[i] = typeof changed[i] === 'number' ? changed[i] + 1e-9 : 'SPARSE';
    assert.equal(cache.reuse(changed, objects), null, `view value ${i}`);
  }
  const { cache, objects } = kept();
  assert.equal(cache.reuse([...view(), 0], objects), null, 'one value more');
  assert.equal(
    cache.reuse(view().slice(0, -1), objects),
    null,
    'one value fewer',
  );
});

test('a view value that is not a number never matches itself', () => {
  const cache = createDetectionPaintCache();
  const objects = contacts();
  cache.keep([NaN], objects, {});
  assert.equal(cache.reuse([NaN], objects), null);
});

test('the view is copied when kept, so the caller may write the next one over it', () => {
  const cache = createDetectionPaintCache();
  const objects = contacts();
  const scratch = view();
  const built = {};
  cache.keep(scratch, objects, built);
  scratch[1] = 1024;
  assert.equal(cache.reuse(scratch, objects), null);
  scratch[1] = 800;
  assert.equal(cache.reuse(scratch, objects), built);
});

test('a coordinate changed in place is a miss, however small', () => {
  for (const axis of ['x', 'y', 'z']) {
    const { cache, objects } = kept();
    objects[1].position[axis] += 1e-9;
    assert.equal(cache.reuse(view(), objects), null, axis);
  }
});

test('a position object swapped for an equal one is still the same paint', () => {
  const { cache, objects, built } = kept();
  objects[0].position = { x: 1, y: 2, z: 3 };
  assert.equal(cache.reuse(view(), objects), built);
});

test('a position that appears, goes away or is not a number is a miss', () => {
  let { cache, objects } = kept();
  objects[2].position = { x: 0, y: 0, z: 0 };
  assert.equal(cache.reuse(view(), objects), null, 'appears');

  ({ cache, objects } = kept());
  objects[0].position = null;
  assert.equal(cache.reuse(view(), objects), null, 'goes away');

  cache = createDetectionPaintCache();
  objects = contacts();
  objects[0].position.x = NaN;
  cache.keep(view(), objects, {});
  assert.equal(cache.reuse(view(), objects), null, 'not a number');
});

test('every field the sweep reads is compared', () => {
  for (const field of PAINTED_OBJECT_FIELDS) {
    const { cache, objects, built } = kept();
    const before = objects[0][field];
    objects[0][field] = before === 'changed' ? 'again' : 'changed';
    assert.equal(cache.reuse(view(), objects), null, field);
    objects[0][field] = before;
    assert.equal(cache.reuse(view(), objects), built, `${field} put back`);
  }
});

test('a field the sweep does not read may change freely', () => {
  const { cache, objects, built } = kept();
  objects[0]._candidateScreenX = 412;
  objects[0]._cohortHash = 7;
  assert.equal(cache.reuse(view(), objects), built);
});

test('a different object, count or order is a miss', () => {
  let { cache, objects } = kept();
  assert.equal(cache.reuse(view(), contacts()), null, 'equal copies');

  ({ cache, objects } = kept());
  assert.equal(cache.reuse(view(), objects.slice(0, 2)), null, 'one fewer');
  assert.equal(cache.reuse(view(), [...objects, objects[0]]), null, 'one more');

  ({ cache, objects } = kept());
  assert.equal(
    cache.reuse(view(), [objects[1], objects[0], objects[2]]),
    null,
    'order',
  );
});

test('keeping again replaces what was kept, for more or fewer objects', () => {
  const { cache, objects, built } = kept();
  const more = [...objects, ...contacts(), ...contacts()];
  const builtMore = {};
  cache.keep(view(), more, builtMore);
  assert.equal(cache.reuse(view(), objects), null);
  assert.equal(cache.reuse(view(), more), builtMore);
  cache.keep(view(), objects, built);
  assert.equal(cache.reuse(view(), more), null);
  assert.equal(cache.reuse(view(), objects), built);
});

test('objects that change on every paint are recorded only now and then', () => {
  const cache = createDetectionPaintCache();
  const objects = contacts();
  const recorded = [];
  const sweep = () => {
    objects[0].position.x += 1;
    assert.equal(cache.reuse(view(), objects), null);
    recorded.push(cache.keep(view(), objects, {}));
  };
  for (let i = 0; i < SWEEPS_BEFORE_BACKOFF; i++) sweep();
  assert.ok(recorded.every(Boolean), 'the first sweeps are all recorded');

  recorded.length = 0;
  for (let i = 0; i < RECORD_STRIDE * 5; i++) sweep();
  assert.equal(recorded.filter(Boolean).length, 5, 'then one in every stride');

  // A skipped sweep leaves nothing behind to reuse by mistake.
  const built = {};
  let wasRecorded = cache.keep(view(), objects, built);
  assert.equal(wasRecorded, false);
  assert.equal(cache.reuse(view(), objects), null);

  // Once the objects hold still, the next recorded sweep is reused, and
  // every sweep after a reuse is recorded again.
  while (!wasRecorded) wasRecorded = cache.keep(view(), objects, built);
  assert.equal(cache.reuse(view(), objects), built);
  for (let i = 0; i < SWEEPS_BEFORE_BACKOFF; i++)
    assert.equal(cache.keep(view(), objects, built), true);
});
