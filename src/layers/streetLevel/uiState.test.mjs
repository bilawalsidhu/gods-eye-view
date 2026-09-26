import assert from 'node:assert/strict';
import test from 'node:test';
import { composeUIState, summarizeCoverage } from './uiState.js';

const provider = (overrides = {}) => ({
  id: 'mapillary',
  name: 'Mapillary',
  label: 'MAPILLARY',
  on: true,
  configured: true,
  keyRequired: false,
  requiresKeyId: 'mapillary',
  loading: false,
  count: 10,
  hint: '',
  error: null,
  legend: [{ key: 'recent', label: 'Recent', color: '#0f0' }],
  ...overrides,
});
const base = {
  enabled: true,
  filter: { pano: 'all', sinceDays: 0 },
  street: { open: false },
  sequence: { selectedId: null, images: 0, loading: false },
};

test('counts add up across active providers only', () => {
  const ui = composeUIState({
    ...base,
    providers: [
      provider(),
      provider({ id: 'panoramax', name: 'Panoramax', count: 5, on: false }),
      provider({ id: 'kartaview', name: 'KartaView', count: 7, loading: true }),
    ],
  });
  assert.equal(ui.coverage.count, 17);
  assert.equal(ui.coverage.loading, true);
});

test('the layer is key-gated only when every switched-on provider lacks its key', () => {
  const gated = composeUIState({
    ...base,
    providers: [provider({ keyRequired: true })],
  });
  assert.equal(gated.keyRequired, true);
  const mixed = composeUIState({
    ...base,
    providers: [
      provider({ keyRequired: true }),
      provider({ id: 'panoramax', name: 'Panoramax', requiresKeyId: null }),
    ],
  });
  assert.equal(mixed.keyRequired, false, 'a keyless provider still draws');
  const offOnly = composeUIState({
    ...base,
    providers: [provider({ keyRequired: true, on: false })],
  });
  assert.equal(offOnly.keyRequired, false, 'nothing switched on to gate');
});

test('the legend lists active providers, prefixed once more than one is registered', () => {
  const single = composeUIState({ ...base, providers: [provider()] });
  assert.deepEqual(
    single.legend.map((entry) => [entry.key, entry.label]),
    [
      ['mapillary:recent', 'Recent'],
      ['selected', 'Selected'],
    ],
  );
  const two = composeUIState({
    ...base,
    providers: [
      provider(),
      provider({
        id: 'panoramax',
        name: 'Panoramax',
        on: false,
        legend: [{ key: 'coverage', label: 'Coverage', color: '#00f' }],
      }),
    ],
  });
  assert.deepEqual(
    two.legend.map((entry) => entry.label),
    ['Mapillary Recent', 'Selected'],
  );
  assert.deepEqual(
    composeUIState({ ...base, providers: [provider({ on: false })] }).legend,
    [],
  );
});

test('hint and error come from the first active provider that has one', () => {
  const ui = composeUIState({
    ...base,
    providers: [
      provider({ hint: '', error: null }),
      provider({ id: 'b', name: 'B', hint: 'Look down', error: 'boom' }),
    ],
  });
  assert.equal(ui.coverage.hint, 'Look down');
  assert.equal(ui.coverage.error, 'boom');
  assert.deepEqual(ui.filter, base.filter);
  assert.notEqual(ui.filter, base.filter, 'snapshot copies the filter');
});

test('summarizeCoverage is what getStats reports, without building a snapshot', () => {
  assert.deepEqual(
    summarizeCoverage([
      provider({ count: 4, hint: 'Look down' }),
      provider({ id: 'b', name: 'B', count: 6, loading: true, error: 'boom' }),
      provider({ id: 'c', name: 'C', count: 99, on: false, keyRequired: true }),
    ]),
    {
      count: 10,
      loading: true,
      hint: 'Look down',
      error: 'boom',
      keyRequired: false,
    },
  );
  assert.equal(summarizeCoverage([]).keyRequired, false);
});
