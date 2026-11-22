// Suggested layers for Context: at most three, by simple rules, only where a
// layer declares coverage, never one that is on or lacks its key.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LAYER_COVERAGE,
  MAX_SUGGESTIONS,
  coversView,
  suggestLayers,
} from './layerSuggestions.js';

const row = (id, extra = {}) => ({ id, enabled: false, ...extra });
const ALL = [
  'satellites',
  'flights',
  'ais-live-vessels',
  'street-level',
  'cctv',
  'transit',
  'local-firms',
  'wind',
  'earthquakes',
].map((id) => row(id));

test('at globe view: satellites, flights and vessels', () => {
  assert.deepEqual(suggestLayers(ALL, { globe: true }), [
    'satellites',
    'flights',
    'ais-live-vessels',
  ]);
});

test('zoomed in: only what declares coverage there (cameras and transit say nothing yet)', () => {
  assert.deepEqual(suggestLayers(ALL, { globe: false }), ['street-level']);
  assert.equal(coversView('cctv'), false);
  assert.equal(coversView('transit'), false);
});

test('with layers on, what goes with them comes first; a layer that is on is never suggested', () => {
  const rows = ALL.map((layer) =>
    layer.id === 'local-firms' ? { ...layer, enabled: true } : layer,
  );
  assert.deepEqual(suggestLayers(rows, { globe: false }), [
    'wind',
    'street-level',
  ]);
  const flightsOn = ALL.map((layer) =>
    layer.id === 'flights' ? { ...layer, enabled: true } : layer,
  );
  assert.deepEqual(suggestLayers(flightsOn, { globe: true }), [
    'ais-live-vessels',
    'satellites',
  ]);
});

test('never more than three, never a layer whose key is missing or that has no row', () => {
  const rows = ALL.map((layer) =>
    layer.id === 'satellites'
      ? { ...layer, stats: { keyRequired: true } }
      : layer.id === 'flights'
        ? { ...layer, showInTogglePanel: false }
        : layer,
  );
  assert.deepEqual(suggestLayers(rows, { globe: true }), ['ais-live-vessels']);
  assert.deepEqual(suggestLayers([], { globe: true }), []);
  const many = suggestLayers(
    ALL.map((layer) =>
      ['flights', 'local-firms'].includes(layer.id)
        ? { ...layer, enabled: true }
        : layer,
    ),
    { globe: true },
  );
  assert.ok(many.length <= MAX_SUGGESTIONS);
});

test('every declared coverage is global or names regions; unknown means never', () => {
  for (const [id, coverage] of Object.entries(LAYER_COVERAGE))
    assert.equal(coverage, 'global', id);
  assert.equal(coversView('no-such-layer'), false);
});
