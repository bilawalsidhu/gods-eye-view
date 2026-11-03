import assert from 'node:assert/strict';
import test from 'node:test';
import { composeCatalog } from '../catalog.js';
import { getActiveFires } from './hazards.js';

const catalogWith = (fires) =>
  composeCatalog({
    tools: [getActiveFires],
    services: { fires: { getSnapshot: async () => ({ fires }) } },
  });

test('a fire acquired at 00:45 UTC reads as 00:45, not "45"', async () => {
  const result = await catalogWith([
    { lat: 24, lon: 121, frp: 5, acqDate: '2026-01-01', acqTime: '45' },
  ]).call('get_active_fires', { area: { bbox: [120, 23, 122, 25] } });
  assert.equal(result.data.rows[0].acquired, '2026-01-01T00:45:00.000Z');
});

test('fire acquisition timestamps reject impossible calendar dates', async () => {
  for (const acqDate of [
    '2026-02-29',
    '2026-02-30',
    '2026-04-31',
    '1900-02-29',
    '2026-13-01',
    '2026-01-00',
  ]) {
    const result = await catalogWith([
      { lat: 24, lon: 121, acqDate, acqTime: '45' },
    ]).call('get_active_fires', { area: { bbox: [120, 23, 122, 25] } });
    assert.equal(result.data.rows[0].acquired, null, acqDate);
  }
});

test('fire acquisition timestamps preserve valid leap days and UTC times', async () => {
  for (const [acqDate, acqTime, expected] of [
    ['2024-02-29', '45', '2024-02-29T00:45:00.000Z'],
    ['2000-02-29', 0, '2000-02-29T00:00:00.000Z'],
    ['2026-04-30', '2359', '2026-04-30T23:59:00.000Z'],
  ]) {
    const result = await catalogWith([
      { lat: 24, lon: 121, acqDate, acqTime },
    ]).call('get_active_fires', { area: { bbox: [120, 23, 122, 25] } });
    assert.equal(result.data.rows[0].acquired, expected);
  }
});
