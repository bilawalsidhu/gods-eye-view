import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aisStreamRows,
  ingestAisStreamEnvelope,
  readAisTrack,
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

// Position uses the same scheme: latitude 91 and longitude 181 mean "not
// available". A transponder without a fix must neither appear at the pole nor
// seed its trail with that point, yet it still proves the feed is live.
test('a position reported as unavailable is not stored, but still counts as feed liveness', () => {
  const report = positionReport('244690000', { Sog: 0 });
  report.MetaData.latitude = 91;
  report.MetaData.longitude = 181;
  assert.equal(ingestAisStreamEnvelope(report), true);
  assert.equal(rowFor('244690000'), undefined);
  assert.deepEqual(readAisTrack('244690000'), []);
});

test('a fix following an unavailable position starts the trail at the real fix', () => {
  const unavailable = positionReport('244690001', { Sog: 9 });
  unavailable.MetaData.latitude = 91;
  unavailable.MetaData.longitude = 181;
  ingestAisStreamEnvelope(unavailable);

  const first = positionReport('244690001', { Sog: 9 });
  const second = positionReport('244690001', { Sog: 9 });
  second.MetaData.latitude = 53.41879;
  second.MetaData.time_utc = '2026-09-17 20:05:00.000000000 +0000 UTC';
  ingestAisStreamEnvelope(first);
  ingestAisStreamEnvelope(second);

  const row = rowFor('244690001');
  assert.equal(row.lat, 53.41879);
  const track = readAisTrack('244690001');
  assert.equal(track.length, 2);
  for (const sample of track) assert.ok(Math.abs(sample.lat) <= 90);
});
