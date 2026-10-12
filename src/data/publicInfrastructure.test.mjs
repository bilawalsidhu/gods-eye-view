import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clusterInfrastructure,
  visibleInfrastructure,
  PUBLIC_INFRASTRUCTURE,
} from './publicInfrastructure.js';
import { createDefaultLayerState, LAYER_STATE_REGISTRY } from './layerState.js';

test('public layers remain independent default-off with reserved unique share tokens', () => {
  assert.equal(new Set(PUBLIC_INFRASTRUCTURE.map((c) => c.token)).size, 5);
  for (const c of PUBLIC_INFRASTRUCTURE) {
    assert.equal(
      createDefaultLayerState().enabledLayerIds.includes(c.id),
      false,
    );
    assert.equal(
      LAYER_STATE_REGISTRY.find((r) => r.id === c.id).token,
      c.token,
    );
  }
});
test('dateline viewport includes both sides and tech filters require explicit source data', () => {
  const records = [
    { id: 'a', lat: 10, lon: 179, technologies: ['5G'] },
    { id: 'b', lat: 10, lon: -179, operator: 'Verizon' },
    { id: 'c', lat: 10, lon: 0, technologies: ['5G'] },
  ];
  const b = { south: 0, north: 20, west: 170, east: -170 };
  assert.deepEqual(
    visibleInfrastructure(records, b).map((r) => r.id),
    ['a', 'b'],
  );
  assert.deepEqual(
    visibleInfrastructure(records, b, '5G').map((r) => r.id),
    ['a'],
  );
});
test('dense source is bounded while clusters retain source counts', () => {
  const b = { south: -90, north: 90, west: -180, east: 180 };
  const records = Array.from({ length: 15000 }, (_, i) => ({
    id: String(i),
    lat: -80 + (i % 150) * 1.06,
    lon: -175 + Math.floor(i / 150) * 3.5,
  }));
  for (const limit of [80, 160]) {
    const result = clusterInfrastructure(records, b, limit);
    assert.ok(result.length <= limit);
    assert.equal(
      result.reduce((n, r) => n + (r.count || 1), 0),
      records.length,
    );
    assert.ok(
      result.filter((r) => r.cluster).every((r) => /zoom in/.test(r.name)),
    );
  }
});
