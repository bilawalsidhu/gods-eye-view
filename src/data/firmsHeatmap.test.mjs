// src/data/firmsHeatmap.test.mjs
// Focused tests for the pure analyst-record mapper (analyst query engine seam).
// Pure function — no viewer/DOM needed; imported directly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFirmsHeatmapLayer, mapAnalystRecord } from './firmsHeatmap.js';
import { layerKeyRequirementTooltip } from './manager.js';

const FULL_FIRE = {
  index: 7,
  lat: 30.51,
  lon: -98.21,
  frp: 1520.4,
  confidence: 0.9,
  satellite: 'N21',
  sensor: 'VIIRS',
  acqMs: 1_753_600_000_000,
};

test('firms analyst record: full record maps every contract field', () => {
  const r = mapAnalystRecord(FULL_FIRE);
  assert.deepEqual(r, {
    id: 'FIRE-00007',
    lat: 30.51,
    lon: -98.21,
    frp: 1520.4,
    confidence: 0.9,
    satellite: 'N21',
    acqTime: 1_753_600_000_000,
  });
});

test('firms analyst record: id matches the layer pick-id convention (5-digit pad)', () => {
  assert.equal(mapAnalystRecord({ ...FULL_FIRE, index: 0 }).id, 'FIRE-00000');
  assert.equal(mapAnalystRecord({ ...FULL_FIRE, index: 12345 }).id, 'FIRE-12345');
});

test('firms analyst record: blank satellite falls back to sensor, then null', () => {
  assert.equal(mapAnalystRecord({ ...FULL_FIRE, satellite: '' }).satellite, 'VIIRS');
  assert.equal(mapAnalystRecord({ ...FULL_FIRE, satellite: '', sensor: '' }).satellite, null);
});

test('firms analyst record: unparseable acq time (0 sentinel) becomes null', () => {
  assert.equal(mapAnalystRecord({ ...FULL_FIRE, acqMs: 0 }).acqTime, null);
});

test('firms analyst record: empty record yields nulls, never NaN/undefined', () => {
  const r = mapAnalystRecord(undefined);
  assert.equal(r.id, 'FIRE-00000');
  for (const [key, value] of Object.entries(r)) {
    assert.notEqual(value, undefined, `${key} must not be undefined`);
    if (typeof value === 'number') assert.ok(Number.isFinite(value), `${key} must not be NaN`);
  }
});

test('firms analyst record: output is JSON-safe (no Cesium types leak)', () => {
  const r = mapAnalystRecord({ ...FULL_FIRE, contextEntity: {}, position: { x: 1 } });
  assert.deepEqual(JSON.parse(JSON.stringify(r)), r);
  assert.equal('position' in r, false);
});

// #143 part 2 — the Fires row is the one data-layer control a provider key
// gates, so the layer must DECLARE which key that is (a registry id, not a
// hardcoded env var) and report the keyless state machine-readably. Without
// `keyRequired` the shared loading-feedback contract can only see the
// 'KEY REQUIRED' string in `error`, which is indistinguishable from a broken
// feed — the dead control then never says which free key would fix it.
test('firms layer declares the provider key it needs and reports the keyless state', () => {
  const layer = createFirmsHeatmapLayer({ id: 'fires', name: 'Wildfires' });
  assert.equal(layer.requiresKeyId, 'firms', 'the layer declares its KEY_SETUP_KEYS id');
  const stats = layer.getStats();
  assert.equal(stats.keyRequired, false, 'a key is not declared missing before the proxy answers');
  assert.equal(
    typeof stats.keyRequired,
    'boolean',
    'keyRequired is a machine-readable flag, not only the human "KEY REQUIRED" error string',
  );
});

test('firms layer: the declared key id resolves to the tooltip that names FIRMS_MAP_KEY', () => {
  // Ties the layer's declaration to the rendered guidance, so either half
  // drifting (a renamed registry id, a dropped requiresKeyId) fails here.
  const layer = createFirmsHeatmapLayer({ id: 'fires', name: 'Wildfires' });
  assert.equal(
    layerKeyRequirementTooltip({ requiresKeyId: layer.requiresKeyId, stats: { keyRequired: true } }),
    'Needs FIRMS_MAP_KEY — add it in Provider Settings',
  );
});
