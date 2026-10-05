import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aisStreamRows,
  ingestAisStreamEnvelope,
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
