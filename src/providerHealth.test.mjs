import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProviderHealthRows } from './providerHealth.js';

test('builds honest provider health rows from layer stats', () => {
  const rows = buildProviderHealthRows([
    {
      id: 'flights',
      name: 'Flights',
      source: 'OpenSky',
      showInTogglePanel: true,
      enabled: true,
      stats: { status: 'live', count: 42, lastUpdate: 99_000 },
    },
    {
      id: 'firms',
      name: 'Active Fires',
      source: 'NASA FIRMS',
      showInTogglePanel: true,
      enabled: true,
      stats: { status: 'unavailable', keyRequired: true, error: 'KEY REQUIRED' },
    },
    {
      id: 'radio',
      name: 'Radio',
      source: 'Radio Browser',
      showInTogglePanel: false,
      enabled: true,
      stats: { status: 'live', count: 10 },
    },
  ], 100_000);

  assert.deepEqual(rows.map(({ id, label, detail, count, keyRequired }) => ({
    id, label, detail, count, keyRequired,
  })), [
    { id: 'flights', label: 'LIVE', detail: 'just now', count: 42, keyRequired: false },
    { id: 'firms', label: 'UNAVAILABLE', detail: 'KEY REQUIRED', count: null, keyRequired: true },
  ]);
});

test('disabled layers remain visible as OFF and malformed input is safe', () => {
  const rows = buildProviderHealthRows([
    { id: 'traffic', name: 'Traffic', enabled: false, stats: {} },
    null,
  ], 100_000);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].label, 'OFF');
  assert.equal(rows[0].detail, 'never');
});
