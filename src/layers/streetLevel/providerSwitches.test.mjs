import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeParams, decodeParams } from './params.js';
import {
  normalizeIdSwitches,
  patchRequestedIdSwitches,
  decodeIdSwitches,
  encodeIdSwitches,
} from '../../data/idSwitches.js';
import {
  createDefaultLayerState,
  encodeLayerStateParams,
  decodeLayerStateParams,
  serializeStoredLayerState,
  parseStoredLayerState,
} from '../../data/layerState.js';
import { validateProviders } from './registry.js';
import { fakeStreetLevelProvider } from '../../testSupport/streetLevelFakes.mjs';

const filter = { pano: 'flat', sinceDays: 365 };

test('custom switches survive sharing and storage without depending on provider order', () => {
  const providers = [
    ['panoramax', false],
    ['example', true],
    ['mapillary', false],
  ];
  const options = encodeParams({ providers, filter });
  assert.equal(options.providerSwitches, 'example-1*panoramax-0');
  assert.equal(
    encodeParams({ providers: [...providers].reverse(), filter })
      .providerSwitches,
    options.providerSwitches,
  );
  const state = createDefaultLayerState();
  state.enabledLayerIds = ['street-level'];
  state.options['street-level'] = options;
  const params = new URLSearchParams({ v: '2' });
  encodeLayerStateParams(params, state);
  assert.match(params.get('lo'), /0\.m\.0/);
  assert.match(params.get('lo'), /0\.r\.example-1\*panoramax-0/);
  assert.ok(
    params.toString().includes('0.r.example-1*panoramax-0'),
    'custom switches need no percent escaping',
  );
  for (const restored of [
    decodeLayerStateParams(params),
    parseStoredLayerState(serializeStoredLayerState(state)),
  ]) {
    const decoded = decodeParams(restored.options['street-level'], {
      providerIds: ['example', 'mapillary', 'panoramax'],
      filter: { pano: 'all', sinceDays: 0 },
    });
    assert.deepEqual(
      [...decoded.providers],
      [
        ['example', true],
        ['mapillary', false],
        ['panoramax', false],
      ],
    );
    assert.deepEqual(decoded.filter, filter);
    assert.deepEqual(
      [
        ...decodeParams(restored.options['street-level'], {
          providerIds: ['panoramax'],
          filter,
        }).providers,
      ],
      [['panoramax', false]],
    );
    assert.equal(
      decodeParams(restored.options['street-level'], {
        providerIds: [],
        filter,
      }).providers.size,
      0,
    );
  }
});

test('legacy links retain Mapillary semantics and leave custom defaults alone', () => {
  for (const [lo, on] of [
    ['', true],
    ['0.m.0', false],
  ]) {
    const state = decodeLayerStateParams(
      new URLSearchParams({ v: '2', l: '0', lo }),
    );
    const restored = decodeParams(state.options['street-level'], {
      providerIds: ['mapillary', 'example'],
      filter,
    });
    assert.deepEqual([...restored.providers], [['mapillary', on]]);
  }
});

test('switches reject ambiguous or oversized fields and cannot override the legacy token', () => {
  for (const value of [
    'example-0*example-1',
    'mapillary-0',
    '__proto__-1',
    'a-2',
    'a-1*',
    'a.b-1',
    'a_b-0',
    `${'a'.repeat(255)}-1`,
    null,
    {},
  ]) {
    assert.equal(normalizeIdSwitches(value, ['mapillary']), null);
  }
  assert.equal(normalizeIdSwitches('constructor-0'), 'constructor-0');
  assert.throws(
    () => encodeIdSwitches([['a'.repeat(255), true]]),
    /share-link/,
  );
  assert.throws(
    () => validateProviders([fakeStreetLevelProvider({ id: 'a'.repeat(255) })]),
    /share-link/,
  );
  const decoded = decodeParams(
    { providerSwitches: 'mapillary-0', mapillary: true },
    { providerIds: ['mapillary'], filter },
  );
  assert.equal(decoded.providers.get('mapillary'), true);
});

test('neutral switch codec preserves hyphens and numeric suffixes in IDs', () => {
  const switches = [
    ['provider-0', false],
    ['provider-1', true],
    ['a-b-c', true],
  ];
  const encoded = encodeIdSwitches(switches);
  assert.equal(encoded, 'a-b-c-1*provider-0-0*provider-1-1');
  const decoded = decodeIdSwitches(encoded);
  for (const [id, on] of switches) assert.equal(decoded.get(id), on);
  assert.equal(decodeIdSwitches('valid-1*broken').size, 0);
});

test('editing a receiving composition drops unknown IDs before enforcing the share bound', () => {
  const previous = `${'x'.repeat(254)}-1`;
  assert.equal(normalizeIdSwitches(previous), previous);
  assert.equal(
    patchRequestedIdSwitches(previous, 'alpha-0*beta-0', { alpha: false }),
    'alpha-0',
  );
  assert.equal(
    patchRequestedIdSwitches(previous, 'alpha-0', { pano: 'flat' }),
    undefined,
  );
});
