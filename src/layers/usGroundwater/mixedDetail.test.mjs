import test from 'node:test';
import assert from 'node:assert/strict';
import { isDetailResolvable } from './mixedDetail.js';

test('same viewport admits sparse detail while dense cells stay weighted, and zoom reveals detail', () => {
  const square = (size) => [
    { x: 0, y: 0 },
    { x: size, y: 0 },
    { x: size, y: size },
    { x: 0, y: size },
  ];
  assert.equal(isDetailResolvable(square(80), 4), true);
  assert.equal(isDetailResolvable(square(80), 12), false);
  assert.equal(isDetailResolvable(square(160), 12), true);
  assert.equal(isDetailResolvable(square(10), 1), false);
  assert.equal(
    isDetailResolvable([undefined, ...square(80).slice(1)], 4),
    false,
  );
});

import sample from '../../../fixtures/us-groundwater/v1/expected-pack.json' with { type: 'json' };
import { refineCountView } from './mixedDetail.js';
test('a dense cell above 256 rows can hydrate within the unchanged 2000-row budget', async () => {
  const records = Array.from({ length: 300 }, (_, i) => {
    const r = structuredClone(sample.records[0]);
    r.id = 'USGS-' + String(330548081390000 + i);
    r.metadata.id = r.id;
    r.metadata.monitoring_location_number = r.id.slice(5);
    r.sourceUrl =
      'https://waterdata.usgs.gov/monitoring-location/' + r.id + '/';
    r.longitude = 1.01;
    r.latitude = 1.01;
    r.readings = [];
    return r;
  });
  const pack = { ...structuredClone(sample), records };
  const cell = {
    bounds: [1, 1, 1.03125, 1.03125],
    center: [1.01, 1.01],
    count: 300,
  };
  const view = {
    schemaVersion: 1,
    kind: 'gev-well-count-view',
    cells: [cell],
    degrees: 0.03125,
    total: 300,
    coverageComplete: false,
  };
  let reads = 0;
  const result = await refineCountView(
    view,
    {
      regions: [
        { url: 'fixture', count: 300, bytes: 100000, bounds: cell.bounds },
      ],
    },
    async () => {
      reads++;
      return pack;
    },
    () => 0,
  );
  assert.equal(reads, 1);
  assert.equal(result.detailPack.records.length, 300);
  assert.equal(result.cells.length, 0);
  assert.equal(new Set(result.detailPack.records.map((r) => r.id)).size, 300);
  const over = await refineCountView(
    { ...view, cells: [{ ...cell, count: 2001 }], total: 2001 },
    {
      regions: [
        { url: 'too-large', count: 2001, bytes: 100000, bounds: cell.bounds },
      ],
    },
    () => {
      throw Error('must not load over-budget data');
    },
    () => 0,
  );
  assert.equal(over.cells[0].count, 2001);
  assert.equal(over.detailPack, undefined);
});
