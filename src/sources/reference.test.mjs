import test from 'node:test';
import assert from 'node:assert/strict';
import { createReferenceSources } from './reference.js';
import { createStandaloneReferenceSources } from '../standalone/layerSources.js';

test('reference factories retain compatibility without starting acquisition or sharing instances', (t) => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', () => {
    requests++;
    throw new Error('unexpected acquisition');
  });
  assert.equal(createReferenceSources, createStandaloneReferenceSources);
  const first = createReferenceSources();
  const second = createReferenceSources();
  assert.deepEqual(Object.keys(first), [
    'earthquakes',
    'air-quality',
    'fire-perimeters',
    'cables',
  ]);
  assert.notEqual(first.earthquakes, second.earthquakes);
  assert.notEqual(first['air-quality'], second['air-quality']);
  assert.notEqual(first['fire-perimeters'], second['fire-perimeters']);
  assert.notEqual(first.cables, second.cables);
  assert.equal(typeof first.earthquakes.getSnapshot, 'function');
  assert.equal(typeof first['air-quality'].getSnapshot, 'function');
  assert.equal(typeof first['fire-perimeters'].getSnapshot, 'function');
  assert.equal(typeof first.cables.fetch, 'function');
  assert.equal(requests, 0);
});
