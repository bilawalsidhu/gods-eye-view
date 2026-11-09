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

const WEEK = [
  { lat: 24.1, lon: 121.1, frp: 864, confidence: 'l', acqDate: '2026-10-01', acqTime: '0100' },
  { lat: 24.2, lon: 121.2, frp: 120, confidence: 'h', acqDate: '2026-10-01', acqTime: '0100' },
  { lat: 24.3, lon: 121.3, frp: 20, confidence: 'n', acqDate: '2026-10-01', acqTime: '0100' },
  { lat: 24.4, lon: 121.4, frp: 2, confidence: 'h', acqDate: '2026-10-01', acqTime: '0100' },
  { lat: 30, lon: 100, frp: 500, confidence: 'h', acqDate: '2026-10-01', acqTime: '0100' },
];
const TAIWAN = { area: { bbox: [120, 23, 122, 25] } };

test('get_active_fires shows every detection by default and reports the filter it used', async () => {
  const result = await catalogWith(WEEK).call('get_active_fires', TAIWAN);
  assert.deepEqual(result.data.rows.map((row) => row.frp_mw), [864, 120, 20, 2]);
  assert.deepEqual(result.data.filter, { min_frp_mw: 0, confidence: 'all' });
  assert.match(result.summary, /^4 fire detections in /);
});

test('get_active_fires applies the same minimum-FRP and confidence filter as the layer', async () => {
  const catalog = catalogWith(WEEK);
  const strong = await catalog.call('get_active_fires', { ...TAIWAN, min_frp_mw: 20 });
  assert.deepEqual(strong.data.rows.map((row) => row.frp_mw), [864, 120, 20]);
  assert.match(strong.summary, /^3 fire detections \(≥ 20 MW\) in /);

  const nominal = await catalog.call('get_active_fires', { ...TAIWAN, confidence: 'nominal' });
  assert.deepEqual(nominal.data.rows.map((row) => row.frp_mw), [120, 20, 2], 'the 864 MW low-confidence fire drops');
  assert.match(nominal.summary, /\(nominal or high confidence\)/);

  const both = await catalog.call('get_active_fires', {
    ...TAIWAN,
    min_frp_mw: 19.6,
    confidence: 'high',
  });
  assert.deepEqual(both.data.rows.map((row) => row.frp_mw), [120]);
  assert.deepEqual(both.data.filter, { min_frp_mw: 20, confidence: 'high' });
  assert.match(both.summary, /\(≥ 20 MW, high confidence\)/);
});
