import assert from 'node:assert/strict';
import test from 'node:test';
import { composeUIState, summarizeCoverage } from './uiState.js';
import { COLORS } from './policy.js';
import { providerSnapshot } from '../../testSupport/streetLevelFakes.mjs';

const provider = (overrides = {}) =>
  providerSnapshot({ count: 10, ...overrides });
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

test('the legend is one swatch per active source, in its colour, then Selected', () => {
  const single = composeUIState({ ...base, providers: [provider()] });
  assert.deepEqual(single.legend, [
    { key: 'mapillary', label: 'Mapillary', color: '#05cb63' },
    { key: 'selected', label: 'Selected', color: COLORS.selected },
  ]);
  const two = composeUIState({
    ...base,
    providers: [
      provider(),
      provider({ id: 'panoramax', name: 'Panoramax', color: '#a66bff' }),
    ],
  });
  assert.deepEqual(
    two.legend.map((entry) => [entry.label, entry.color]),
    [
      ['Mapillary', '#05cb63'],
      ['Panoramax', '#a66bff'],
      ['Selected', COLORS.selected],
    ],
  );
  const oneOff = composeUIState({
    ...base,
    providers: [
      provider(),
      provider({ id: 'panoramax', name: 'Panoramax', on: false }),
    ],
  });
  assert.deepEqual(
    oneOff.legend.map((entry) => entry.key),
    ['mapillary', 'selected'],
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
      keyRejected: false,
    },
  );
  assert.equal(summarizeCoverage([]).keyRequired, false);
});

test('a rejected key gates like a missing one and is named as rejected', () => {
  const rejected = provider({
    keyRequired: true,
    keyRejected: true,
    error: 'Mapillary rejected MAPILLARY_CLIENT_TOKEN',
  });
  const summary = summarizeCoverage([rejected]);
  assert.equal(summary.keyRequired, true);
  assert.equal(summary.keyRejected, true);
  assert.equal(summary.error, 'Mapillary rejected MAPILLARY_CLIENT_TOKEN');
  const state = composeUIState({ ...base, providers: [rejected] });
  assert.equal(state.keyRequired, true);
  assert.equal(state.keyRejected, true);
  // A provider that is merely missing its key is not "rejected".
  assert.equal(
    summarizeCoverage([provider({ keyRequired: true })]).keyRejected,
    false,
  );
});

test('the surface mode defaults to draped and passes through', () => {
  assert.equal(
    composeUIState({ ...base, providers: [provider()] }).surface,
    'draped',
  );
  assert.equal(
    composeUIState({ ...base, providers: [provider()], surface: 'terrain' })
      .surface,
    'terrain',
  );
});
