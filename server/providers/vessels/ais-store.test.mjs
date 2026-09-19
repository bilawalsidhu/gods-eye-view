import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ingestAisStreamEnvelope,
  aisStreamRows,
  draughtRangeFor,
  setAisHistoryForTesting,
} from './ais-store.js';

setAisHistoryForTesting(null); // never touch disk from unit tests

let nextMmsi = 300000000;
/** Unique MMSI per test — the store is process-scoped and shared. */
function mmsi() {
  nextMmsi += 1;
  return String(nextMmsi);
}

function position(id, overrides = {}) {
  return {
    MessageType: 'PositionReport',
    MetaData: { MMSI: id, latitude: 10, longitude: 20, time_utc: '2026-09-18 05:00:00 +0000 UTC' },
    Message: { PositionReport: { Sog: 12.3, Cog: 87, TrueHeading: 88, ...overrides } },
  };
}

function staticData(id, overrides = {}) {
  return {
    MessageType: 'ShipStaticData',
    MetaData: { MMSI: id, ShipName: 'TEST VESSEL' },
    Message: {
      ShipStaticData: {
        Destination: 'ROTTERDAM',
        ImoNumber: 9123456,
        CallSign: 'H3RC',
        Type: 70,
        MaximumStaticDraught: 12.4,
        Eta: { Month: 9, Day: 24, Hour: 14, Minute: 30 },
        Dimension: { A: 200, B: 200, C: 30, D: 29 },
        ...overrides,
      },
    },
  };
}

function rowFor(id) {
  return aisStreamRows(50000).find((row) => row.mmsi === id);
}

test('static data yields call sign, draught, ETA and hull dimensions', () => {
  const id = mmsi();
  assert.equal(ingestAisStreamEnvelope(staticData(id)), true);
  assert.equal(ingestAisStreamEnvelope(position(id)), true);
  const row = rowFor(id);
  assert.equal(row.call_sign, 'H3RC');
  assert.equal(row.draught, 12.4);
  assert.equal(row.eta, '09-24 14:30');
  assert.equal(row.length, 400); // A + B
  assert.equal(row.beam, 59); // C + D
  assert.equal(row.imo, '9123456');
});

test('a zero draught is "not available", not a surfaced hull', () => {
  const id = mmsi();
  ingestAisStreamEnvelope(staticData(id, { MaximumStaticDraught: 0 }));
  ingestAisStreamEnvelope(position(id));
  assert.equal(rowFor(id).draught, null);
});

test('a zeroed ETA month or day reads as unavailable', () => {
  const id = mmsi();
  ingestAisStreamEnvelope(staticData(id, { Eta: { Month: 0, Day: 0, Hour: 24, Minute: 60 } }));
  ingestAisStreamEnvelope(position(id));
  assert.equal(rowFor(id).eta, '');
});

test('navigational status resolves to its ITU label', () => {
  const id = mmsi();
  ingestAisStreamEnvelope(position(id, { NavigationalStatus: 1 }));
  const row = rowFor(id);
  assert.equal(row.nav_status, 1);
  assert.equal(row.nav_status_text, 'AT ANCHOR');
});

test('reserved navigational codes carry no label', () => {
  const id = mmsi();
  ingestAisStreamEnvelope(position(id, { NavigationalStatus: 13 }));
  assert.equal(rowFor(id).nav_status_text, '');
});

test('out-of-range navigational codes are dropped', () => {
  const id = mmsi();
  ingestAisStreamEnvelope(position(id, { NavigationalStatus: 99 }));
  assert.equal(rowFor(id).nav_status, null);
});

test('load state stays UNKNOWN until the hull is seen deep and shallow', () => {
  const id = mmsi();
  ingestAisStreamEnvelope(staticData(id, { MaximumStaticDraught: 12.4 }));
  ingestAisStreamEnvelope(position(id));
  assert.equal(rowFor(id).load_state, 'UNKNOWN', 'one observation cannot classify');

  ingestAisStreamEnvelope(staticData(id, { MaximumStaticDraught: 6.0 }));
  ingestAisStreamEnvelope(position(id));
  assert.deepEqual(draughtRangeFor(id), { min: 6.0, max: 12.4 });
  assert.equal(rowFor(id).load_state, 'BALLAST', 'riding at its shallowest');

  ingestAisStreamEnvelope(staticData(id, { MaximumStaticDraught: 12.4 }));
  ingestAisStreamEnvelope(position(id));
  assert.equal(rowFor(id).load_state, 'LADEN', 'back to its deepest');

  ingestAisStreamEnvelope(staticData(id, { MaximumStaticDraught: 9.2 }));
  ingestAisStreamEnvelope(position(id));
  assert.equal(rowFor(id).load_state, 'PART LADEN', 'mid-range sits between');
});

test('a draught range narrower than half a metre cannot classify', () => {
  const id = mmsi();
  ingestAisStreamEnvelope(staticData(id, { MaximumStaticDraught: 12.4 }));
  ingestAisStreamEnvelope(position(id));
  ingestAisStreamEnvelope(staticData(id, { MaximumStaticDraught: 12.6 }));
  ingestAisStreamEnvelope(position(id));
  assert.equal(rowFor(id).load_state, 'UNKNOWN');
});

test('missing Dimension leaves length and beam null', () => {
  const id = mmsi();
  ingestAisStreamEnvelope(staticData(id, { Dimension: undefined }));
  ingestAisStreamEnvelope(position(id));
  const row = rowFor(id);
  assert.equal(row.length, null);
  assert.equal(row.beam, null);
});

test('static data arriving after a position backfills the live row', () => {
  const id = mmsi();
  ingestAisStreamEnvelope(position(id));
  assert.equal(rowFor(id).call_sign, '');
  ingestAisStreamEnvelope(staticData(id));
  const row = rowFor(id);
  assert.equal(row.call_sign, 'H3RC');
  assert.equal(row.eta, '09-24 14:30');
  assert.equal(row.length, 400);
});

test('existing position fields are unchanged by the additions', () => {
  const id = mmsi();
  ingestAisStreamEnvelope(position(id));
  const row = rowFor(id);
  assert.equal(row.speed, 12.3);
  assert.equal(row.course, 87);
  assert.equal(row.heading, 88);
  assert.equal(row.lat, 10);
  assert.equal(row.lon, 20);
});

test('cache and retention budgets read the environment, with defaults', async () => {
  const { aisCacheMax, aisStaleMs, AISSTREAM_CACHE_MAX, AISSTREAM_STALE_MS } =
    await import('./ais-store.js');
  const priorMax = process.env.AISSTREAM_CACHE_MAX;
  const priorMin = process.env.AISSTREAM_RETENTION_MIN;
  try {
    delete process.env.AISSTREAM_CACHE_MAX;
    delete process.env.AISSTREAM_RETENTION_MIN;
    assert.equal(aisCacheMax(), AISSTREAM_CACHE_MAX);
    assert.equal(aisStaleMs(), AISSTREAM_STALE_MS);

    process.env.AISSTREAM_CACHE_MAX = '250000';
    process.env.AISSTREAM_RETENTION_MIN = '90';
    assert.equal(aisCacheMax(), 250000);
    assert.equal(aisStaleMs(), 90 * 60 * 1000);

    // Garbage and non-positive values fall back rather than disabling the cache.
    process.env.AISSTREAM_CACHE_MAX = '0';
    process.env.AISSTREAM_RETENTION_MIN = 'abc';
    assert.equal(aisCacheMax(), AISSTREAM_CACHE_MAX);
    assert.equal(aisStaleMs(), AISSTREAM_STALE_MS);
  } finally {
    if (priorMax === undefined) delete process.env.AISSTREAM_CACHE_MAX;
    else process.env.AISSTREAM_CACHE_MAX = priorMax;
    if (priorMin === undefined) delete process.env.AISSTREAM_RETENTION_MIN;
    else process.env.AISSTREAM_RETENTION_MIN = priorMin;
  }
});

test('partner rows join the same cache as AIS observations', async () => {
  const { ingestPartnerRows } = await import('./ais-store.js');
  // A real Norwegian MID (257) — the synthetic 3xx range is unassigned, so it
  // would legitimately resolve to no flag and prove nothing.
  const id = '257000001';
  const accepted = ingestPartnerRows(
    [
      {
        mmsi: id,
        lat: 60.4,
        lon: 5.3,
        name: 'NORDLYS',
        speed: 12.5,
        course: 180,
        heading: 179,
        nav_status: 0,
        last_position_UTC: '2026-09-19T08:00:00Z',
      },
    ],
    'BarentsWatch',
  );
  assert.equal(accepted, 1);
  const row = rowFor(id);
  assert.equal(row.name, 'NORDLYS');
  assert.equal(row.source, 'BarentsWatch');
  assert.equal(row.nav_status_text, 'UNDER WAY (ENGINE)');
  assert.equal(row.flag, 'Norway', 'identity enrichment still runs for partner rows');
});

test('a partner poll never rewinds a vessel to an older fix', async () => {
  const { ingestPartnerRows } = await import('./ais-store.js');
  const id = mmsi();
  ingestPartnerRows(
    [{ mmsi: id, lat: 10, lon: 10, last_position_UTC: '2026-09-19T10:00:00Z' }],
    'p',
  );
  ingestPartnerRows(
    [{ mmsi: id, lat: 20, lon: 20, last_position_UTC: '2026-09-19T09:00:00Z' }],
    'p',
  );
  assert.equal(rowFor(id).lat, 10, 'the newer fix is kept');
});

test('unusable partner rows are skipped, not stored', async () => {
  const { ingestPartnerRows } = await import('./ais-store.js');
  assert.equal(ingestPartnerRows([{ mmsi: '', lat: 1, lon: 2 }]), 0);
  assert.equal(ingestPartnerRows([{ mmsi: '123456789', lat: 'x', lon: 2 }]), 0);
  assert.equal(ingestPartnerRows(null), 0);
});

test('search ranks exact identifiers above name matches', async () => {
  const { searchAisVessels, ingestPartnerRows } = await import('./ais-store.js');
  const base = 257100000;
  ingestPartnerRows(
    [
      { mmsi: String(base + 1), lat: 60, lon: 5, name: 'NORDIC STAR' },
      { mmsi: String(base + 2), lat: 60, lon: 5, name: 'STAR OF NORWAY' },
      { mmsi: String(base + 3), lat: 60, lon: 5, name: 'NORDIC STARLIGHT' },
    ],
    'test',
  );
  const byName = searchAisVessels('NORDIC STAR');
  assert.equal(byName[0].name, 'NORDIC STAR', 'exact name first');
  assert.ok(byName.some((r) => r.name === 'NORDIC STARLIGHT'), 'prefix included');

  const byMmsi = searchAisVessels(String(base + 2));
  assert.equal(byMmsi[0].mmsi, String(base + 2));
});

test('a name prefix outranks a mid-string match', async () => {
  const { searchAisVessels, ingestPartnerRows } = await import('./ais-store.js');
  ingestPartnerRows(
    [
      { mmsi: '257200001', lat: 60, lon: 5, name: 'ATLANTIC BREEZE' },
      { mmsi: '257200002', lat: 60, lon: 5, name: 'BREEZE ATLANTIC' },
    ],
    'test',
  );
  const results = searchAisVessels('BREEZE');
  assert.equal(results[0].name, 'BREEZE ATLANTIC', 'prefix beats substring');
});

test('search refuses queries too short to be meaningful', async () => {
  const { searchAisVessels } = await import('./ais-store.js');
  assert.deepEqual(searchAisVessels('a'), []);
  assert.deepEqual(searchAisVessels(''), []);
  assert.deepEqual(searchAisVessels(null), []);
});

test('search honours its result cap', async () => {
  const { searchAisVessels, ingestPartnerRows } = await import('./ais-store.js');
  ingestPartnerRows(
    Array.from({ length: 12 }, (_, i) => ({
      mmsi: String(257300000 + i), lat: 60, lon: 5, name: `CAPPED VESSEL ${i}`,
    })),
    'test',
  );
  assert.equal(searchAisVessels('CAPPED VESSEL', 5).length, 5);
});
