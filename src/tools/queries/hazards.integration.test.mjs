import assert from 'node:assert/strict';
import test from 'node:test';
import { composeCatalog } from '../catalog.js';
import { getActiveFires } from './hazards.js';

const point = { lat: -30, lon: -60 };
const callFires = (fires, extra = {}) =>
  composeCatalog({
    tools: [getActiveFires],
    services: { fires: { getSnapshot: async () => ({ fires, ...extra }) } },
  }).call('get_active_fires', { area: { bbox: [-65, -35, -55, -25] } });

test('FIRMS HHMM is ISO UTC, even when unpadded', async () => {
  for (const [acqTime, expected] of [
    ['0045', '2026-01-01T00:45:00.000Z'],
    ['45', '2026-01-01T00:45:00.000Z'],
    [45, '2026-01-01T00:45:00.000Z'],
    ['0130', '2026-01-01T01:30:00.000Z'],
    ['2359', '2026-01-01T23:59:00.000Z'],
  ]) {
    const { data } = await callFires([
      { ...point, provider: 'nasa-firms', acqDate: '2026-01-01', acqTime },
    ]);
    assert.equal(data.rows[0].acquired, expected, String(acqTime));
    assert.equal(data.rows[0].source, 'NASA FIRMS');
  }
});

test('FIRMS invalid and missing UTC acquisition fields return null', async () => {
  for (const [acqDate, acqTime] of [
    ['2026-02-29', '0045'],
    ['2026-02-30', '0045'],
    ['2026-04-31', '0045'],
    ['1900-02-29', '0045'],
    ['2026-13-01', '0045'],
    ['2026-01-00', '0045'],
    ['2026-01-01', '2400'],
    ['2026-01-01', '1260'],
    ['2026-01-01', 'abcd'],
    ['2026-01-01', null],
    ['2026-01-01', undefined],
    [null, '0045'],
    [undefined, '0045'],
  ]) {
    const { data } = await callFires([{ ...point, acqDate, acqTime }]);
    assert.equal(data.rows[0].acquired, null, String(acqDate) + ' ' + String(acqTime));
  }
});

test('FIRMS valid Gregorian leap days preserve UTC', async () => {
  for (const [acqDate, expected] of [
    ['2024-02-29', '2024-02-29T00:45:00.000Z'],
    ['2000-02-29', '2000-02-29T00:45:00.000Z'],
  ]) {
    const { data } = await callFires([{ ...point, acqDate, acqTime: '45' }]);
    assert.equal(data.rows[0].acquired, expected);
  }
});

test('CONAE uses already converted acqMs, without any FIRMS fields', async () => {
  const acqMs = Date.parse('2026-10-15T00:20:00.000Z');
  const result = await callFires([
    { ...point, provider: 'conae-goes', acqMs, satellite: 'GOES-19',
      daynight: '', confidence: null, frp: null },
    { ...point, provider: 'conae-goes', acqMs,
      acqDate: 'not a FIRMS date', acqTime: 'invalid' },
    { ...point, provider: 'conae-goes' },
  ]);
  assert.deepEqual(result.data.rows.map((r) => r.acquired), [
    '2026-10-15T00:20:00.000Z',
    '2026-10-15T00:20:00.000Z',
    null,
  ]);
  assert.deepEqual(result.data.rows.map((r) => r.source),
    ['CONAE GOES', 'CONAE GOES', 'CONAE GOES']);
  assert.equal(result.data.rows[0].frp_mw, null);
  assert.equal(result.data.rows[0].confidence, null);
  assert.equal(result.data.rows[0].day_night, null);
  assert.equal(result.data.rows[0].satellite, 'GOES-19');
});

test('mixed providers preserve attribution, unknowns and thermal-only claims', async () => {
  const result = await callFires([
    { ...point, provider: 'nasa-firms', frp: 6, confidence: 'n',
      acqDate: '2026-10-15', acqTime: '45' },
    { ...point, provider: 'conae-goes', frp: 16,
      acqMs: Date.parse('2026-10-15T03:20:00Z') },
    { ...point, provider: 'nasa-firms',
      acqDate: '2026-02-30', acqTime: '1200' },
  ], {
    stale: true,
    fetchedAt: Date.parse('2026-10-15T04:00:00Z'),
    sources: [
      { source: 'NASA FIRMS', ok: true },
      { source: 'CONAE GOES', ok: false },
    ],
  });
  assert.deepEqual(result.data.rows.map((r) => r.source),
    ['CONAE GOES', 'NASA FIRMS', 'NASA FIRMS']);
  assert.deepEqual(result.data.rows.map((r) => r.acquired), [
    '2026-10-15T03:20:00.000Z',
    '2026-10-15T00:45:00.000Z',
    null,
  ]);
  assert.deepEqual(result.data.rows.map((r) => r.frp_mw), [16, 6, null]);
  assert.deepEqual(result.data.rows.map((r) => r.confidence), [null, 'n', null]);
  assert.equal(result.data.stale, true);
  assert.deepEqual(result.data.missing_sources, ['CONAE GOES']);
  assert.equal(result.data.fetched_at, '2026-10-15T04:00:00.000Z');
  assert.match(result.summary, /^3 fire detections /);
  assert.match(result.summary, /data may be stale/);
  assert.match(result.summary, /no data from CONAE GOES/);
  assert.match(getActiveFires.description, /thermal detections/);
  assert.match(getActiveFires.description, /not confirmed wildfire incidents/);
});
