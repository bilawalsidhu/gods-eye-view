import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AISSTREAM_STALE_MS,
  aisStreamRows,
  hasAisStreamStatic,
  ingestAisStreamEnvelope,
  pruneAisStreamCache,
} from '../../server/providers/vessels/ais-store.js';

// ITU-R M.1371 encodes speed over ground in 0.1-knot units and course over
// ground in 0.1-degree units, reserving the top code of each field for "not
// available": SOG 1023 arrives as 102.3 knots and COG 3600 as 360 degrees.
// Both are finite numbers, so they reach consumers as ordinary readings unless
// the store rejects them here.
const positionReport = (mmsi, body) => ({
  MessageType: 'PositionReport',
  Message: { PositionReport: { UserID: Number(mmsi), ...body } },
  MetaData: {
    MMSI: mmsi,
    latitude: 53.40879,
    longitude: 6.19741,
    time_utc: '2026-09-17 20:00:00.000000000 +0000 UTC',
  },
});

const rowFor = (mmsi) => aisStreamRows(50000).find((row) => row.mmsi === mmsi);

test('speed over ground reported as unavailable is unknown, not 102.3 knots', () => {
  assert.equal(
    ingestAisStreamEnvelope(positionReport('244060365', { Sog: 102.3 })),
    true,
  );
  assert.equal(rowFor('244060365').speed, null);
});

test('course over ground reported as unavailable is unknown, not 360 degrees', () => {
  assert.equal(
    ingestAisStreamEnvelope(positionReport('245382000', { Cog: 360 })),
    true,
  );
  assert.equal(rowFor('245382000').course, null);
});

test('genuine speed and course readings survive the unavailable check', () => {
  ingestAisStreamEnvelope(
    positionReport('341260000', { Sog: 12.9, Cog: 74.6 }),
  );
  const row = rowFor('341260000');
  assert.equal(row.speed, 12.9);
  assert.equal(row.course, 74.6);
});

test('a stopped vessel keeps its zero speed and zero course', () => {
  ingestAisStreamEnvelope(positionReport('244374235', { Sog: 0, Cog: 0 }));
  const row = rowFor('244374235');
  assert.equal(row.speed, 0);
  assert.equal(row.course, 0);
});

test('the fastest encodable reading below the unavailable code is kept', () => {
  ingestAisStreamEnvelope(
    positionReport('244060366', { Sog: 102.2, Cog: 359.9 }),
  );
  const row = rowFor('244060366');
  assert.equal(row.speed, 102.2);
  assert.equal(row.course, 359.9);
});

test('pruneAisStreamCache evicts expired static data when vessel is stale', () => {
  const mmsi = '999888777';
  ingestAisStreamEnvelope({
    MessageType: 'ShipStaticData',
    Message: {
      ShipStaticData: {
        UserID: Number(mmsi),
        Name: 'TEST VESSEL',
        Destination: 'NOWHERE',
      },
    },
    MetaData: { MMSI: mmsi },
  });
  assert.equal(hasAisStreamStatic(mmsi), true);
  // Stale prune removes static entries for MMSIs with no active vessel
  pruneAisStreamCache(Date.now() + AISSTREAM_STALE_MS + 1000);
  assert.equal(
    hasAisStreamStatic(mmsi),
    false,
    'stale static data was evicted',
  );
});

test('pruneAisStreamCache preserves static data for active anchored vessels with stale pending track', () => {
  const mmsi = '999888778';
  // Static data arrives
  ingestAisStreamEnvelope({
    MessageType: 'ShipStaticData',
    Message: {
      ShipStaticData: {
        UserID: Number(mmsi),
        Name: 'ANCHORED VESSEL',
        Destination: 'PORT',
      },
    },
    MetaData: { MMSI: mmsi },
  });
  // First position fix creates pending track with old epoch (35 minutes in the past)
  const pastEpoch = Math.floor(Date.now() / 1000) - 35 * 60;
  ingestAisStreamEnvelope({
    ...positionReport(mmsi, { Sog: 0, Cog: 0 }),
    MetaData: {
      MMSI: mmsi,
      latitude: 53.40879,
      longitude: 6.19741,
      time_utc: new Date(pastEpoch * 1000).toISOString(),
    },
  });
  assert.equal(hasAisStreamStatic(mmsi), true);

  // Vessel reports fresh position right now, remaining anchored (< 25m move)
  ingestAisStreamEnvelope(positionReport(mmsi, { Sog: 0, Cog: 0 }));

  // Prune at Date.now(): pending fix (35 min old) is pruned, but vessel is fresh
  pruneAisStreamCache(Date.now());
  // Static data MUST survive because the vessel itself is still active in _aisStreamVessels!
  assert.equal(
    hasAisStreamStatic(mmsi),
    true,
    'active anchored vessel retained static data',
  );
  const row = rowFor(mmsi);
  assert.equal(row.name, 'ANCHORED VESSEL');
});
