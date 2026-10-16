import assert from 'node:assert/strict';
import test from 'node:test';
import { openSkySnapshot } from '../sources/live/aircraft.js';
import { vesselSnapshot } from '../sources/live/vessels.js';
import {
  W1_FROZEN_MS,
  syntheticFlights,
  syntheticLocalReceivers,
  syntheticRecordings,
  syntheticVessels,
} from './w1Feeds.js';

test('synthetic flights are an OpenSky states payload the app reads', () => {
  const payload = syntheticFlights({ nowMs: W1_FROZEN_MS, count: 500 });
  assert.equal(payload.time, Math.floor(W1_FROZEN_MS / 1000));
  assert.equal(payload.states.length, 500);
  const snapshot = openSkySnapshot(payload, { now: W1_FROZEN_MS });
  assert.equal(snapshot.records.length, 500);
  const first = snapshot.records[0];
  assert.ok(first.positionTimeMs <= W1_FROZEN_MS);
  assert.ok(W1_FROZEN_MS - first.positionTimeMs <= 10_000);
  // Seeded: the same payload every time.
  assert.deepEqual(
    syntheticFlights({ nowMs: W1_FROZEN_MS, count: 500 }),
    payload,
  );
  // Some near JFK, so the city pose shows aircraft.
  const nearJfk = snapshot.records.filter(
    (r) =>
      Math.abs(r.latitude - 40.64) < 0.3 && Math.abs(r.longitude + 73.78) < 0.4,
  );
  assert.ok(nearJfk.length > 20, `${nearJfk.length} near JFK`);
});

test('synthetic vessels: 12 000 rows worldwide, and the rows within an area', () => {
  const all = syntheticVessels({ nowMs: W1_FROZEN_MS });
  assert.equal(all.rows.length, 12_000);
  const snapshot = vesselSnapshot(all);
  assert.equal(snapshot.records.length, 12_000);
  const area = syntheticVessels({
    nowMs: W1_FROZEN_MS,
    area: { lat: 40.65724, lon: -73.78, radiusKm: 10 },
  });
  assert.ok(area.rows.length > 10 && area.rows.length < 12_000);
  for (const row of area.rows)
    assert.ok(all.rows.some((r) => r.mmsi === row.mmsi));
});

test('synthetic local receivers carry 1090 and 978 MHz UAT aircraft near JFK', () => {
  const payload = syntheticLocalReceivers({ nowMs: W1_FROZEN_MS });
  assert.equal(payload.configured, true);
  assert.deepEqual(
    payload.feeds.map(({ band }) => band),
    ['1090', '978'],
  );
  const bands = new Set(payload.records.map(({ band }) => band));
  assert.deepEqual([...bands].sort(), ['1090', '978']);
  for (const record of payload.records) {
    assert.ok(W1_FROZEN_MS - record.lastMessageAt < 5_000);
    assert.ok(Math.abs(record.lat - 40.64) < 1);
  }
});

test('the recordings answer the keys the app asks', () => {
  const recordings = syntheticRecordings();
  const keys = (layer) => recordings[layer].entries.map(({ key }) => key);
  assert.ok(keys('flights').includes('GET /api/flights'));
  assert.ok(keys('vessels').includes('GET /api/vessels?maxRows=12000'));
  assert.ok(
    keys('vessels').includes(
      'GET /api/vessels?maxRows=12000&lat=40.65724&lon=-73.78000&radius_km=10.0',
    ),
  );
  // The global answer comes last: the replay's fallback for other areas.
  assert.equal(keys('vessels').at(-1), 'GET /api/vessels?maxRows=12000');
  assert.ok(keys('localAdsb').includes('GET /api/local-receivers/aircraft'));
  for (const recording of Object.values(recordings)) {
    assert.equal(recording.frozenMs, W1_FROZEN_MS);
    const entry = recording.entries[0];
    assert.equal(entry.status, 200);
    assert.ok(JSON.parse(Buffer.from(entry.body, 'base64').toString()));
  }
});
