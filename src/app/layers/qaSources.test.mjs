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
