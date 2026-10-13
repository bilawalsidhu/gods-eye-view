import assert from 'node:assert/strict';
import test from 'node:test';
import { createPickRouter } from './pickRouter.js';

const providers = [
  { def: { id: 'mapillary', pickPrefix: 'mly:' }, instance: { name: 'm' } },
  { def: { id: 'panoramax', pickPrefix: 'pnx:' }, instance: { name: 'p' } },
];

test('ids are routed by prefix to their provider instance', () => {
  const router = createPickRouter(() => providers, { positionId: 'sl:pos' });
  assert.deepEqual(router.resolve('mly:seq:1'), {
    providerId: 'mapillary',
    instance: providers[0].instance,
    id: 'mly:seq:1',
  });
  assert.equal(router.resolve('pnx:img:9').providerId, 'panoramax');
  assert.equal(router.ownsPick('mly:img:2'), true);
});

test('the core-owned marker is owned but routes to no provider', () => {
  const router = createPickRouter(() => providers, { positionId: 'sl:pos' });
  assert.deepEqual(router.resolve('sl:pos'), {
    providerId: null,
    instance: null,
    id: 'sl:pos',
  });
  assert.equal(router.ownsPick('sl:pos'), true);
});

test('foreign and malformed ids are not ours', () => {
  const router = createPickRouter(() => providers);
  for (const id of ['cctv:1', '', null, undefined, 42, {}])
    assert.equal(router.ownsPick(id), false, String(id));
  assert.equal(router.resolve('sl:pos'), null, 'no marker id configured');
});
