import test from 'node:test';
import assert from 'node:assert/strict';
import { createQaSources, parseQaFeed } from './qaSources.js';

test('qaFeed names fixture sources per layer', () => {
  assert.deepEqual(
    parseQaFeed('?qaFeed=flights:synthetic:10000,vessels:fixture'),
    [
      { layer: 'flights', kind: 'synthetic', count: 10000 },
      { layer: 'vessels', kind: 'fixture', count: null },
    ],
  );
  assert.deepEqual(parseQaFeed('?engine=navara'), []);
  assert.throws(() => parseQaFeed('?qaFeed=flights:live'), /qaFeed/);
  assert.throws(() => parseQaFeed('?qaFeed=weather:fixture'), /qaFeed/);
  assert.throws(() => parseQaFeed('?qaFeed=flights:synthetic:-3'), /qaFeed/);
});

test('fixture sources answer with the live sources’ snapshot shape', async () => {
  const now = Date.UTC(2026, 9, 16, 12);
  const sources = createQaSources(
    parseQaFeed('?qaFeed=flights:synthetic:500,vessels:fixture'),
    { now: () => now },
  );
  const flights = await sources.flights.getSnapshot({});
  assert.equal(flights.records.length, 500);
  assert.ok(
    flights.records.every((record) => Number.isFinite(record.latitude)),
  );
  // Seeded: the same aircraft every time.
  const again = await sources.flights.getSnapshot({});
  assert.deepEqual(
    again.records.map(({ id }) => id),
    flights.records.map(({ id }) => id),
  );
  const vessels = await sources.vessels.getSnapshot({ maxRows: 12000 });
  assert.equal(vessels.records.length, 12000);
  const near = await sources.vessels.getSnapshot({
    maxRows: 12000,
    area: { lat: 40.65724, lon: -73.78, radiusKm: 10 },
  });
  assert.ok(near.records.length > 10 && near.records.length < 12000);
  assert.deepEqual(createQaSources([]), {});
});

test('military:synthetic answers with the military source’s shape, some shared with flights', async () => {
  const now = Date.UTC(2026, 9, 16, 12);
  const sources = createQaSources(
    parseQaFeed('?qaFeed=military:synthetic:300,flights:synthetic:500'),
    { now: () => now },
  );
  const military = await sources.military.getSnapshot({});
  assert.equal(military.records.length, 300);
  assert.ok(military.records.some((record) => record.onGround));
  assert.ok(military.records.every((record) => record.typeCode));
  const identities = await sources.military.getIdentities({});
  assert.ok(identities.records?.length ?? identities.length);
  const civil = new Set(
    (await sources.flights.getSnapshot({})).records.map(({ id }) => id),
  );
  const shared = military.records.filter(({ id }) => civil.has(id));
  assert.equal(shared.length, 25);
  const track = await sources.military.getTrack('ae1100');
  assert.deepEqual(track.records, []);
});

test('local-adsb:fixture answers as the local receivers do (1090 MHz and UAT)', async () => {
  const now = Date.UTC(2026, 9, 16, 12);
  assert.deepEqual(parseQaFeed('?qaFeed=local-adsb:fixture'), [
    { layer: 'local-adsb', kind: 'fixture', count: null },
  ]);
  const { localAdsbFeeds } = createQaSources(
    parseQaFeed('?qaFeed=local-adsb:fixture'),
    { now: () => now },
  );
  const loaded = new Promise((resolve) =>
    localAdsbFeeds.subscribe((state) => {
      if (state.records?.length) resolve();
    }),
  );
  localAdsbFeeds.start();
  await loaded;
  const state = localAdsbFeeds.getState();
  localAdsbFeeds.stop();
  assert.equal(state.records.length, 40);
  assert.ok(state.records.some((record) => record.band === '978'));
  assert.ok(state.records.some((record) => record.band === '1090'));
});
