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
  assert.equal(sources.military.getTrack, undefined);
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

test('flight fixture enrichment returns a not-found reply without regenerating the fleet', async () => {
  let clockReads = 0;
  const { flights } = createQaSources(
    parseQaFeed('?qaFeed=flights:synthetic:10000'),
    {
      now: () => {
        clockReads++;
        return Date.UTC(2026, 9, 16, 12);
      },
    },
  );
  for (const kind of ['type', 'route']) {
    const reply = await flights.getEnrichment({ kind, id: 'a00001' });
    assert.equal(reply.found, false);
    assert.deepEqual(Object.keys(reply), ['found']);
  }
  assert.equal(clockReads, 0);
});

test('flight fixture track reads do not regenerate a snapshot', async () => {
  let clockReads = 0;
  const { flights } = createQaSources(
    parseQaFeed('?qaFeed=flights:synthetic:10000'),
    {
      now: () => {
        clockReads++;
        return Date.UTC(2026, 9, 16, 12);
      },
    },
  );
  assert.deepEqual(await flights.getTrack('a00001'), {
    records: [],
    complete: false,
  });
  assert.equal(clockReads, 0);
});

test('vessel fixture answers a relative track URL and retains its full snapshot', async () => {
  const { vessels } = createQaSources(parseQaFeed('?qaFeed=vessels:fixture'), {
    now: () => Date.UTC(2026, 9, 16, 12),
  });
  assert.deepEqual(await vessels.getTrack('990000001'), {
    records: [],
    complete: false,
  });
  assert.equal((await vessels.getSnapshot({})).records.length, 12000);
});

test('fixture counts cannot exceed the QA fleet budget', () => {
  for (const count of [
    '10001',
    '1e9',
    '9007199254740992',
    'Infinity',
    '0',
    '1.5',
  ])
    assert.throws(
      () => parseQaFeed(`?qaFeed=flights:synthetic:${count}`),
      TypeError,
    );
  assert.equal(parseQaFeed('?qaFeed=flights:synthetic:10000')[0].count, 10000);
});
