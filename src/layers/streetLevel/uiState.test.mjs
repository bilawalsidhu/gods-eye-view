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

test('Street View draws no lines: no legend swatch, and no Selected on its own', () => {
  const streetView = provider({
    id: 'google',
    name: 'Google Street View',
    color: '#4285f4',
    count: 0,
    groundClick: true,
    filters: [],
  });
  assert.deepEqual(
    composeUIState({ ...base, providers: [streetView] }).legend,
    [],
  );
  assert.deepEqual(
    composeUIState({
      ...base,
      providers: [provider(), streetView],
    }).legend.map((entry) => entry.key),
    ['mapillary', 'selected'],
  );
});

test('the filter controls show only for a lit provider that honours them', () => {
  const streetView = provider({ id: 'google', groundClick: true, filters: [] });
  const controls = (providers) =>
    composeUIState({ ...base, providers }).filterControls;
  assert.deepEqual(controls([streetView]), { pano: false, since: false });
  assert.deepEqual(controls([provider(), streetView]), {
    pano: true,
    since: true,
  });
  assert.deepEqual(
    controls([provider({ on: false }), streetView]),
    { pano: false, since: false },
    'Mapillary switched off',
  );
  assert.deepEqual(
    controls([provider({ on: false }), { ...streetView, on: false }]),
    { pano: true, since: true },
    'nothing lit: both, ready for the first chip',
  );
});

test('a lit provider that dates by upload puts a note under SINCE', () => {
  const kartaView = provider({
    id: 'kartaview',
    name: 'KartaView',
    sinceBasis: 'upload',
  });
  const note = (providers) => composeUIState({ ...base, providers }).sinceNote;
  assert.equal(note([provider()]), null, 'Mapillary: capture date');
  assert.equal(note([kartaView]), 'KartaView: by upload date');
  assert.equal(note([{ ...kartaView, on: false }]), null, 'only while lit');
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
      label: null,
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

test('every switched-on provider’s hint is kept, once each', async () => {
  const { summarizeCoverage } = await import('./uiState.js');
  const { providerSnapshot } =
    await import('../../testSupport/streetLevelFakes.mjs');
  const summary = summarizeCoverage([
    providerSnapshot({ hint: 'zoom in for sequences' }),
    providerSnapshot({
      id: 'google',
      hint: 'click a street to open Street View',
    }),
    providerSnapshot({ id: 'off', on: false, hint: 'not shown' }),
    providerSnapshot({ id: 'dup', hint: 'zoom in for sequences' }),
  ]);
  assert.equal(
    summary.hint,
    'zoom in for sequences · click a street to open Street View',
  );
});

test('a key-gated layer offers the switched-off sources that would draw with a key already set', async () => {
  const { keyAlternatives } = await import('./uiState.js');
  const mapillary = providerSnapshot({ keyRequired: true, configured: false });
  const streetView = providerSnapshot({
    id: 'google',
    label: 'STREET VIEW',
    on: false,
    configured: true,
    requiresKeyId: 'google-maps',
  });
  assert.deepEqual(keyAlternatives([mapillary, streetView]), [
    { id: 'google', label: 'STREET VIEW', requiresKeyId: 'google-maps' },
  ]);
  // Nothing to offer: Mapillary has its key, or Street View has none either.
  assert.deepEqual(keyAlternatives([providerSnapshot(), streetView]), []);
  assert.deepEqual(
    keyAlternatives([
      mapillary,
      { ...streetView, configured: false, keyRequired: true },
    ]),
    [],
  );
});

test('a source whose lines never show a selection lists no Selected swatch, and names its own lines', () => {
  const kartaView = provider({
    id: 'kartaview',
    name: 'KartaView',
    color: '#635bff',
    highlightsSequence: false,
    coverageLabel: {
      noun: 'streets',
      action: 'click a line for its nearest photo',
    },
  });
  const ui = composeUIState({ ...base, providers: [kartaView] });
  assert.deepEqual(
    ui.legend.map((entry) => entry.key),
    ['kartaview'],
  );
  assert.deepEqual(ui.coverage.label, {
    noun: 'streets',
    action: 'click a line for its nearest photo',
  });
});
