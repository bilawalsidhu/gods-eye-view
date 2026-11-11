// Focused tests for the local-infrastructure analyst-record mapper. The
// layer's snapshot is tested in src/layers/infrastructure/session.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapAnalystRecord } from './localGeojsonCore.js';

const DC_RAW = {
  id: '1176042553',
  lat: -52.942,
  lon: -70.85,
  properties: {
    tags: {
      name: 'AWS',
      operator: 'Amazon Web Services',
      'operator:short': 'AWS',
      'capacity:it_load': '27 MW',
    },
  },
};

const DAM_RAW = {
  id: '-19685440',
  lat: -25.41,
  lon: -54.59,
  properties: {
    name: 'Usina Hidrelétrica de Itaipu',
    output: '14000 MW',
    tags: {
      name: 'Usina Hidrelétrica de Itaipu',
      'name:en': 'Itaipu Dam',
      operator: 'Itaipú Binacional',
      associated_river: 'Paraná',
      'plant:output:electricity': '14000 MW',
    },
  },
};

test('infra analyst record: datacenter maps name, operator, capacity', () => {
  const r = mapAnalystRecord(DC_RAW, 'local-datacenters');
  assert.deepEqual(r, {
    id: 'AWS',
    name: 'AWS',
    lat: -52.942,
    lon: -70.85,
    operator: 'Amazon Web Services',
    capacity: '27 MW',
    river: null,
    output: null,
  });
});

test('infra analyst record: dam maps name, operator, river, output; names stay unclamped', () => {
  const r = mapAnalystRecord(DAM_RAW, 'local-dams');
  assert.equal(r.id, 'Usina Hidrelétrica de Itaipu');
  assert.equal(r.name, 'Usina Hidrelétrica de Itaipu');
  assert.equal(r.operator, 'Itaipú Binacional');
  assert.equal(r.river, 'Paraná');
  assert.equal(r.output, '14000 MW');
  assert.equal(r.capacity, null);
});

test('infra analyst record: unnamed feature falls back to source id', () => {
  const r = mapAnalystRecord(
    {
      id: 'dc-42',
      lat: 30.2,
      lon: -97.7,
      properties: { tags: { operator: 'Example Cloud' } },
    },
    'local-datacenters',
  );
  assert.equal(r.id, 'dc-42');
  assert.equal(r.name, null);
  assert.equal(r.operator, 'Example Cloud');
});

test('infra analyst record: empty record yields nulls, never NaN/undefined', () => {
  const r = mapAnalystRecord(undefined, 'local-dams');
  assert.equal(r.id, 'Dam');
  for (const [key, value] of Object.entries(r)) {
    assert.notEqual(value, undefined, `${key} must not be undefined`);
    if (typeof value === 'number')
      assert.ok(Number.isFinite(value), `${key} must not be NaN`);
  }
});

test('infra analyst record: output is JSON-safe (no engine types leak)', () => {
  const r = mapAnalystRecord(
    {
      ...DAM_RAW,
      entity: {},
      position: { x: 1 },
    },
    'local-dams',
  );
  assert.deepEqual(JSON.parse(JSON.stringify(r)), r);
  assert.equal('entity' in r, false);
  assert.equal('position' in r, false);
});
