import assert from 'node:assert/strict';
import test from 'node:test';
import { requiresKeyIdFor, validateProviders } from './registry.js';

const def = (overrides = {}) => ({
  id: 'mapillary',
  name: 'Mapillary',
  label: 'MAPILLARY',
  requiresKeyId: 'mapillary',
  pickPrefix: 'mly:',
  colors: { coverage: '#05cb63' },
  credit: { key: 'mapillary', html: 'Mapillary' },
  capabilities: { coverage: 'tiles', sequences: true },
  legend: [],
  externalUrl: (id) => `https://example.test/${id}`,
  create: () => ({}),
  ...overrides,
});

test('a valid list is frozen in registration order', () => {
  const list = validateProviders([
    def(),
    def({ id: 'panoramax', pickPrefix: 'pnx:', requiresKeyId: null }),
  ]);
  assert.ok(Object.isFrozen(list));
  assert.deepEqual(
    list.map((p) => p.id),
    ['mapillary', 'panoramax'],
  );
});

test('an empty list, duplicate ids and malformed ids are rejected', () => {
  assert.throws(() => validateProviders([]), /at least one/);
  assert.throws(() => validateProviders(null), /at least one/);
  assert.throws(() => validateProviders([def(), def()]), /Duplicate/);
  assert.throws(() => validateProviders([def({ id: 'Bad Id' })]), /slug/);
});

test('every required field is checked by name', () => {
  for (const key of [
    'name',
    'label',
    'pickPrefix',
    'colors',
    'credit',
    'capabilities',
    'legend',
    'externalUrl',
    'create',
  ])
    assert.throws(
      () => validateProviders([def({ [key]: undefined })]),
      new RegExp(`lacks ${key}`),
      key,
    );
  assert.throws(() => validateProviders([def({ create: 1 })]), /create/);
  assert.throws(
    () => validateProviders([def({ credit: { key: 'x' } })]),
    /credit/,
  );
  assert.throws(() => validateProviders([def({ legend: 'no' })]), /legend/);
  assert.throws(
    () => validateProviders([def({ pickPrefix: '' })]),
    /pick prefix/,
  );
});

test('overlapping pick prefixes are rejected either way round', () => {
  assert.throws(
    () => validateProviders([def(), def({ id: 'other', pickPrefix: 'mly:x' })]),
    /overlaps/,
  );
  assert.throws(
    () =>
      validateProviders([def({ pickPrefix: 'mly:x' }), def({ id: 'other' })]),
    /overlaps/,
  );
  assert.doesNotThrow(() =>
    validateProviders([def(), def({ id: 'other', pickPrefix: 'ml:' })]),
  );
});

test('requiresKeyIdFor is the shared key, or null once providers differ', () => {
  assert.equal(requiresKeyIdFor([def()]), 'mapillary');
  assert.equal(
    requiresKeyIdFor([def(), def({ id: 'b', pickPrefix: 'b:' })]),
    'mapillary',
  );
  assert.equal(
    requiresKeyIdFor([
      def(),
      def({ id: 'b', pickPrefix: 'b:', requiresKeyId: null }),
    ]),
    null,
  );
  assert.equal(
    requiresKeyIdFor([
      def(),
      def({ id: 'b', pickPrefix: 'b:', requiresKeyId: 'google-maps' }),
    ]),
    null,
  );
  assert.equal(requiresKeyIdFor([def({ requiresKeyId: null })]), null);
});
