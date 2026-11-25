import test from 'node:test';
import assert from 'node:assert/strict';
import { suggestLayers } from './layerSuggestions.js';

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
].map((id) => row(id, { stats: { lastUpdate: 1 } }));

test('at globe view: satellites, flights and vessels', () => {
  assert.deepEqual(suggestLayers(ALL, { globe: true }), [
    'satellites',
    'flights',
    'ais-live-vessels',
  ]);
});

test('Vessels is not suggested before the first successful update', () => {
  const rows = ALL.map((layer) =>
    layer.id === 'ais-live-vessels'
      ? { ...layer, stats: { count: 0, lastUpdate: null } }
      : layer,
  );
  assert.deepEqual(suggestLayers(rows, { globe: true }), [
    'satellites',
    'flights',
  ]);
});

test('Earthquakes suggests Active Fires only after a successful FIRMS update', () => {
  const earthquakes = row('earthquakes', { enabled: true });
  const firms = (stats) => row('local-firms', { stats });

  assert.deepEqual(
    suggestLayers([earthquakes, firms({ lastUpdate: null })]),
    [],
  );
  assert.deepEqual(suggestLayers([earthquakes, firms({ lastUpdate: 1 })]), [
    'local-firms',
  ]);
  assert.deepEqual(
    suggestLayers([earthquakes, firms({ lastUpdate: 1, keyRequired: true })]),
    [],
  );
});

test('a local view without a coverage signal has no default suggestions', () => {
  assert.deepEqual(suggestLayers(ALL, { globe: false }), []);
});

test('a layer with an unavailable source is not suggested', () => {
  const rows = ALL.map((layer) =>
    layer.id === 'satellites'
      ? { ...layer, stats: { sourceUnavailable: true } }
      : layer,
  );
  assert.deepEqual(suggestLayers(rows, { globe: true }), [
    'flights',
    'ais-live-vessels',
  ]);
});

test('with layers on, what goes with them comes first; a layer that is on is never suggested', () => {
  const rows = ALL.map((layer) =>
    layer.id === 'local-firms' ? { ...layer, enabled: true } : layer,
  );
  assert.deepEqual(suggestLayers(rows, { globe: false }), ['wind']);
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
      ['local-firms', 'earthquakes'].includes(layer.id)
        ? { ...layer, enabled: true }
        : layer,
    ),
    { globe: true },
  );
  assert.deepEqual(many, ['wind', 'satellites', 'flights']);
});
