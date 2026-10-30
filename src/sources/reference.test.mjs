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
    'gnss-integrity',
    'vigicrues-floods',
    'ign-geoplateforme',
    'entsoe-grid',
    'copernicus-ems',
  ]);
  assert.notEqual(first.earthquakes, second.earthquakes);
  assert.notEqual(first['air-quality'], second['air-quality']);
  assert.notEqual(first['fire-perimeters'], second['fire-perimeters']);
  assert.notEqual(first.cables, second.cables);
  assert.notEqual(first['gnss-integrity'], second['gnss-integrity']);
  assert.notEqual(first['vigicrues-floods'], second['vigicrues-floods']);
  assert.notEqual(first['ign-geoplateforme'], second['ign-geoplateforme']);
  assert.notEqual(first['entsoe-grid'], second['entsoe-grid']);
  assert.notEqual(first['copernicus-ems'], second['copernicus-ems']);
  assert.equal(typeof first.earthquakes.getSnapshot, 'function');
  assert.equal(typeof first['air-quality'].getSnapshot, 'function');
  assert.equal(typeof first['fire-perimeters'].getSnapshot, 'function');
  assert.equal(typeof first.cables.fetch, 'function');
  assert.equal(typeof first['gnss-integrity'].getSnapshot, 'function');
  assert.equal(typeof first['vigicrues-floods'].getSnapshot, 'function');
  assert.equal(typeof first['ign-geoplateforme'].getDescriptor, 'function');
  assert.equal(typeof first['entsoe-grid'].getSnapshot, 'function');
  assert.equal(typeof first['copernicus-ems'].getSnapshot, 'function');
  assert.equal(requests, 0);
});
