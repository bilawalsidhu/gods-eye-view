import test from 'node:test';
import assert from 'node:assert/strict';
import { infrastructureDetailRows } from './infrastructureDetails.js';
test('owner, operator, mapped carrier tag and unverified tenants remain separate', () => {
  const rows = new Map(
    infrastructureDetailRows({
      layerId: 'mapped-mobile-sites',
      properties: {
        owner: 'Tower Owner',
        operator: 'Site Operator',
        network: 'Carrier tag',
        hostedCarriers: 'Unknown; not inferred',
        technologies: ['4G', '5G'],
        source: 'OSM',
        date: '2026-10-10',
      },
    }),
  );
  assert.equal(rows.get('Owner (source reported)'), 'Tower Owner');
  assert.equal(rows.get('Site operator (source reported)'), 'Site Operator');
  assert.equal(rows.get('Mapped network/carrier tag'), 'Carrier tag');
  assert.equal(
    rows.get('Hosted cellular carriers/tenants'),
    'Unknown; not inferred',
  );
  assert.equal(rows.get('Documented mapped technology'), '4G, 5G');
});
test('absent public tags are unknown, and cluster location never impersonates a tower', () => {
  const rows = new Map(infrastructureDetailRows({ properties: {} }));
  assert.equal(rows.get('Owner (source reported)'), 'Unknown');
  assert.equal(rows.get('Mapped network/carrier tag'), 'Unknown');
  assert.equal(rows.get('Documented mapped technology'), 'Unknown');
  const cluster = new Map(
    infrastructureDetailRows({
      properties: { type: 'Approximate geographic cluster', records: 30 },
    }),
  );
  assert.match(cluster.get('Position'), /Representative/);
  assert.equal(cluster.has('Owner (source reported)'), false);
});
