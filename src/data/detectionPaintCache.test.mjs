import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDetectionPaintCache,
  PAINTED_OBJECT_FIELDS,
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
  cache.keep(view(), objects, built);
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

test('a position that appears or goes away is a miss', () => {
  let { cache, objects } = kept();
  objects[2].position = { x: 0, y: 0, z: 0 };
  assert.equal(cache.reuse(view(), objects), null, 'appears');

  ({ cache, objects } = kept());
  objects[0].position = null;
  assert.equal(cache.reuse(view(), objects), null, 'goes away');
});

test('every field the sweep reads is compared', () => {
  for (const field of PAINTED_OBJECT_FIELDS) {
    const { cache, objects, built } = kept();
    const before = objects[0][field];
    objects[0][field] = before === 'changed' ? 'again' : 'changed';
    assert.equal(cache.reuse(view(), objects), null, field);
    objects[0][field] = before;
    assert.equal(cache.reuse(view(), objects), built, `${field} put back`);
    objects[0][field] = 'changed';
    const rebuilt = {};
    cache.keep(view(), objects, rebuilt);
    assert.equal(cache.reuse(view(), objects), rebuilt, `${field} is recorded`);
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
