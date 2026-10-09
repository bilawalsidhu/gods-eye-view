// src/data/firmsAdapt.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  adaptFirmsRecords,
  normalizeConfidence,
  normalizeSensor,
  parseAcquisitionMs,
} from './firmsAdapt.js';

/** A proxy record as served by /api/firms (firmsCsv.js parser shape). */
const proxyRecord = (overrides = {}) => ({
  lat: 38.99488,
  lon: -121.67046,
  frp: 0.53,
  confidence: 'n',
  brightness: 303.6,
  brightnessTi5: 290.73,
  daynight: 'N',
  acqDate: '2026-07-16',
  acqTime: '1006',
  satellite: 'N20',
  instrument: 'VIIRS',
  ...overrides,
});

test('adapter maps a proxy record into the internal fire-record shape', () => {
  const [fire] = adaptFirmsRecords([proxyRecord()]);
  assert.equal(fire.index, 0);
  assert.equal(fire.lat, 38.99488);
  assert.equal(fire.lon, -121.67046);
  assert.equal(fire.frp, 0.53);
  assert.equal(fire.confidence, 0.6); // 'n' (nominal) → 0.6
  assert.equal(fire.brightness, 303.6);
  assert.equal(fire.night, true); // daynight 'N'
  assert.equal(fire.acqMs, Date.UTC(2026, 6, 16, 10, 6));
  assert.equal(fire.sensor, 'VIIRS');
  assert.equal(fire.satellite, 'N20');
  assert.equal(fire.contextEntity, null);
  assert.equal(fire.position, null);
});

test('categorical confidence → 0..1 (l/n/h and word forms)', () => {
  assert.equal(normalizeConfidence('l'), 0.3);
  assert.equal(normalizeConfidence('n'), 0.6);
  assert.equal(normalizeConfidence('h'), 0.9);
  assert.equal(normalizeConfidence('low'), 0.3);
  assert.equal(normalizeConfidence('nominal'), 0.6);
  assert.equal(normalizeConfidence('high'), 0.9);
});

test('numeric confidence (MODIS-style) → value/100, clamped', () => {
  assert.equal(normalizeConfidence(85), 0.85);
  assert.equal(normalizeConfidence('85'), 0.85);
  assert.equal(normalizeConfidence(120), 1);
  assert.equal(normalizeConfidence('garbage'), 0);
});

test('unpadded acq_time parses in the adapter path ("45" = 00:45Z)', () => {
  const [fire] = adaptFirmsRecords([proxyRecord({ acqTime: '45' })]);
  assert.equal(fire.acqMs, Date.UTC(2026, 6, 16, 0, 45));
});

test('parseAcquisitionMs: memo cache is honored, invalid input → 0', () => {
  const cache = new Map();
  assert.equal(parseAcquisitionMs('2026-07-16', '1006', cache), Date.UTC(2026, 6, 16, 10, 6));
  assert.equal(cache.size, 1);
  assert.equal(parseAcquisitionMs('2026-07-16', '1006', cache), Date.UTC(2026, 6, 16, 10, 6));
  assert.equal(parseAcquisitionMs(undefined, '1006', cache), 0);
});

test('daynight "D" → night false', () => {
  const [fire] = adaptFirmsRecords([proxyRecord({ daynight: 'D' })]);
  assert.equal(fire.night, false);
});

test('sensor normalization: VIIRS/MODIS detected, junk truncated', () => {
  assert.equal(normalizeSensor('VIIRS'), 'VIIRS');
  assert.equal(normalizeSensor('some_modis_file'), 'MODIS');
  assert.equal(normalizeSensor(''), '');
  assert.equal(normalizeSensor('ABCDEFGHIJKLMNOP'), 'ABCDEFGHIJKL'); // 12-char cap
});

test('records with non-finite lat/lon are skipped; index stays sequential', () => {
  const fires = adaptFirmsRecords([
    proxyRecord(),
    proxyRecord({ lat: 'nope' }),
    proxyRecord({ lon: Infinity }),
    proxyRecord({ lat: 40.1 }),
  ]);
  assert.equal(fires.length, 2);
  assert.deepEqual(fires.map((f) => f.index), [0, 1]);
});

test('non-finite frp/brightness → 0; empty input → []', () => {
  const [fire] = adaptFirmsRecords([proxyRecord({ frp: 'n/a', brightness: undefined })]);
  assert.equal(fire.frp, 0);
  assert.equal(fire.brightness, 0);
  assert.deepEqual(adaptFirmsRecords([]), []);
  assert.deepEqual(adaptFirmsRecords(null), []);
});

// ── Unchanged-snapshot polls ─────────────────────────────────────────────────
// When the proxy answers 304 the layer keeps its adapted records and applies
// the trailing window itself. That must equal what a full refetch would have
// produced at the same instant, or the two poll paths render different fires.

const sortByFrp = (fires) => [...fires].sort((a, b) => b.frp - a.frp);

/** Rows straddling the 24 h boundary, with tied FRPs to pin tie order. */
function boundaryRows() {
  const rows = [];
  // 2026-09-10 11:50Z to 12:47Z, every 3 min: each later poll ages more out.
  for (let step = 0; step < 20; step++) {
    const acquired = new Date(Date.UTC(2026, 8, 10, 11, 50 + step * 3));
    rows.push({
      lat: 10 + step / 100,
      lon: 20 - step / 100,
      frp: [5, 9, 9, 1.5][step % 4],
      confidence: 'n',
      brightness: 330,
      daynight: step % 2 ? 'N' : 'D',
      acqDate: acquired.toISOString().slice(0, 10),
      acqTime: String(acquired.getUTCHours() * 100 + acquired.getUTCMinutes()),
      satellite: ['N20', 'N21', 'N'][step % 3],
      instrument: 'VIIRS',
    });
  }
  // A fresh detection that outlives every poll.
  rows.push({ ...rows[0], acqDate: '2026-09-11', acqTime: '1100', frp: 9 });
  return rows;
}

test('expiring held records equals a full refetch at the same instant', async () => {
  const { filterTrailing24h } = await import('./firmsCsv.js');
  const { expireFirmsRecords } = await import('./firmsAdapt.js');
  const rows = boundaryRows();
  const fetchedAt = Date.UTC(2026, 8, 11, 11, 50);
  const held = adaptFirmsRecords(filterTrailing24h(rows, fetchedAt));
  for (const minutes of [10, 20, 30]) {
    const now = fetchedAt + minutes * 60_000;
    const refetched = adaptFirmsRecords(filterTrailing24h(rows, now));
    const expired = expireFirmsRecords(held, sortByFrp(held), now);
    assert.ok(refetched.length < held.length, `${minutes} min: rows really aged out`);
    assert.deepEqual(expired.fires, refetched, `${minutes} min: same records, same indices`);
    assert.deepEqual(expired.firesByFrp, sortByFrp(refetched), `${minutes} min: same FRP order`);
  }
});

test('expired records are fresh objects, so lazily built scene state is not carried over', async () => {
  const { expireFirmsRecords } = await import('./firmsAdapt.js');
  const now = Date.UTC(2026, 8, 11, 12);
  const held = adaptFirmsRecords([
    proxyRecord({ acqDate: '2026-09-10', acqTime: '1159' }),
    proxyRecord({ acqDate: '2026-09-11', acqTime: '1100', frp: 1 }),
  ]);
  held[1].contextEntity = { stale: true };
  held[1].position = { stale: true };
  const { fires, firesByFrp } = expireFirmsRecords(held, sortByFrp(held), now);
  assert.equal(fires.length, 1);
  assert.notEqual(fires[0], held[1]);
  assert.equal(fires[0].index, 0, 'indices key pick ids and stay sequential');
  assert.equal(fires[0].contextEntity, null);
  assert.equal(fires[0].position, null);
  assert.equal(firesByFrp[0], fires[0], 'both views share the new records');
});

test('nothing aged out means nothing to rebuild', async () => {
  const { expireFirmsRecords } = await import('./firmsAdapt.js');
  const held = adaptFirmsRecords([proxyRecord({ acqDate: '2026-09-11', acqTime: '1100' })]);
  assert.equal(expireFirmsRecords(held, sortByFrp(held), Date.UTC(2026, 8, 11, 12)), null);
  assert.equal(expireFirmsRecords([], [], Date.UTC(2026, 8, 11, 12)), null);
});
