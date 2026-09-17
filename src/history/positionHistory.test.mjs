import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FIX_BYTES,
  MATCH_TOLERANCE_MS,
  createPositionHistory,
  fixFromRecord,
} from './positionHistory.js';

function createFakeManager(modules) {
  const listeners = new Set();
  const enabled = new Set(Object.keys(modules));
  return {
    layers: new Map(
      Object.entries(modules).map(([id, module]) => [id, { module }]),
    ),
    enabled,
    isEnabled: (id) => enabled.has(id),
    subscribeActivity(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    emit(change) {
      for (const callback of listeners) callback(change);
    },
    get listenerCount() {
      return listeners.size;
    },
  };
}
const flight = (icao24, lat, lon, extra = {}) => ({
  id: extra.callsign || icao24,
  icao24,
  callsign: extra.callsign ?? null,
  lat,
  lon,
  altitudeM: extra.altitudeM ?? 10_000,
  speedMps: extra.speedMps ?? 200,
  heading: extra.heading ?? 90,
  onGround: extra.onGround ?? false,
});
const vessel = (mmsi, lat, lon, extra = {}) => ({
  id: mmsi,
  mmsi,
  name: extra.name ?? null,
  lat,
  lon,
  speedKts: extra.speedKts ?? 10,
  courseDeg: extra.courseDeg ?? 180,
});

test('records analyst snapshots per poll and interpolates between fixes', () => {
  let clock = 1_000_000;
  const flights = { records: [] };
  const vessels = { records: [] };
  const manager = createFakeManager({
    flights: { getAnalystRecords: () => flights.records },
    'ais-live-vessels': { getAnalystRecords: () => vessels.records },
    earthquakes: { getAnalystRecords: () => [{ id: 'eq', lat: 1, lon: 1 }] },
  });
  const history = createPositionHistory({
    dataManager: manager,
    now: () => clock,
  });
  flights.records = [
    flight('abc123', 10, 20, { callsign: 'UAL1', heading: 350 }),
  ];
  vessels.records = [vessel('123456789', -5, 179, { name: 'EVER GIVEN' })];
  manager.emit({ type: 'data-updated', layerId: 'flights' });
  manager.emit({ type: 'data-updated', layerId: 'ais-live-vessels' });
  manager.emit({ type: 'data-updated', layerId: 'earthquakes' });
  clock += 30_000;
  flights.records = [
    flight('abc123', 12, 22, { callsign: 'UAL1', heading: 10 }),
  ];
  vessels.records = [vessel('123456789', -5, -179, { name: 'EVER GIVEN' })];
  manager.emit({ type: 'data-updated', layerId: 'flights' });
  manager.emit({ type: 'data-updated', layerId: 'ais-live-vessels' });

  const range = history.range();
  assert.equal(range.count, 2);
  assert.equal(range.oldestT, 1_000_000);
  assert.equal(range.newestT, 1_030_000);

  const mid = history.entitiesAt(1_015_000);
  assert.equal(mid.length, 2);
  const plane = mid.find((entity) => entity.layerId === 'flights');
  assert.equal(plane.id, 'abc123');
  assert.equal(plane.label, 'UAL1');
  assert.ok(Math.abs(plane.lat - 11) < 1e-9);
  assert.ok(Math.abs(plane.lon - 21) < 1e-9);
  assert.equal(plane.heightM, 10_000);
  assert.ok(Math.abs(plane.headingDeg - 0) < 1e-6, 'heading wraps via 360');
  assert.equal(plane.ageMs, 15_000);
  const ship = mid.find((entity) => entity.layerId === 'ais-live-vessels');
  assert.equal(ship.label, 'EVER GIVEN');
  assert.ok(Math.abs(Math.abs(ship.lon) - 180) < 1e-9, 'antimeridian lerp');
  assert.ok(Math.abs(ship.speed - 10 * 0.514444) < 1e-5, 'knots to m/s (f32)');

  // Before the first fix the entity holds its first position; far outside
  // the tolerance it is absent.
  assert.equal(history.entitiesAt(1_000_000 - 60_000).length, 2);
  assert.equal(
    history.entitiesAt(1_000_000 - MATCH_TOLERANCE_MS - 1).length,
    0,
  );
  assert.equal(
    history.entitiesAt(1_030_000 + MATCH_TOLERANCE_MS + 1).length,
    0,
  );
  assert.equal(history.trackOf('flights', 'abc123').length, 2);
  assert.deepEqual(
    history.trailPositions('flights', 'abc123', 0, Infinity),
    [20, 10, 10_000, 22, 12, 10_000],
  );

  history.destroy();
  assert.equal(manager.listenerCount, 0);
  assert.equal(history.range().count, 0);
});

test('disabled layers, unwatched layers and malformed records are ignored', () => {
  const manager = createFakeManager({
    flights: {
      getAnalystRecords: () => [
        flight('bad', NaN, 20),
        { icao24: '', lat: 1, lon: 1 },
        flight('ok', 1, 1),
      ],
    },
    military: { getAnalystRecords: () => [flight('mil', 2, 2)] },
  });
  manager.enabled.delete('military');
  const history = createPositionHistory({
    dataManager: manager,
    layers: ['flights', 'military'],
    now: () => 5_000,
  });
  manager.emit({ type: 'data-updated', layerId: 'flights' });
  manager.emit({ type: 'data-updated', layerId: 'military' });
  manager.emit({ type: 'status' });
  assert.equal(history.range().count, 1);
  assert.equal(history.entitiesAt(5_000)[0].id, 'ok');
  assert.equal(fixFromRecord('flights', null), null);
  assert.equal(fixFromRecord('flights', flight('x', 91, 0)), null);
  assert.equal(
    fixFromRecord('flights', flight('g', 0, 0, { onGround: true })).heightM,
    0,
  );
  history.destroy();
});

test('retention drops old fixes and forgets entities that stop reporting', () => {
  let clock = 0;
  const history = createPositionHistory({
    retentionMs: 100_000,
    now: () => clock,
  });
  history.recordSnapshot('flights', [flight('a', 0, 0), flight('b', 1, 1)], 0);
  for (clock = 30_000; clock <= 150_000; clock += 30_000)
    history.recordSnapshot('flights', [flight('a', 0, clock / 30_000)], clock);
  const range = history.range();
  assert.equal(range.count, 1, 'entity b had no fix inside the window');
  assert.equal(range.oldestT, 60_000);
  assert.equal(range.newestT, 150_000);
  assert.equal(history.trackOf('flights', 'a').length, 4);
  history.destroy();
});

test('feeds faster than the spacing floor are thinned; unmoved contacts refresh slowly', () => {
  const history = createPositionHistory({ retentionMs: 3_600_000 });
  history.recordSnapshot('flights', [flight('a', 0, 0)], 0);
  history.recordSnapshot('flights', [flight('a', 0, 1)], 1_000);
  assert.equal(history.trackOf('flights', 'a').length, 1, 'too soon');
  history.recordSnapshot('flights', [flight('a', 0, 0)], 10_000);
  assert.equal(history.trackOf('flights', 'a').length, 1, 'unmoved');
  history.recordSnapshot('flights', [flight('a', 0, 0)], 70_000);
  assert.equal(history.trackOf('flights', 'a').length, 2, 'refreshed');
  history.recordSnapshot('flights', [flight('a', 0, 2)], 75_000);
  assert.equal(history.trackOf('flights', 'a').length, 3, 'moved');
  history.destroy();
});

test('a per-entity ring buffer caps at 256 fixes and keeps the newest', () => {
  const history = createPositionHistory({ retentionMs: 24 * 3_600_000 });
  for (let i = 0; i < 300; i++)
    history.recordSnapshot('flights', [flight('a', 0, i / 10)], i * 5_000);
  const fixes = history.trackOf('flights', 'a');
  assert.equal(fixes.length, 256);
  assert.equal(fixes[0].t, 44 * 5_000);
  assert.equal(fixes.at(-1).t, 299 * 5_000);
  assert.equal(history.stats().bytes, 256 * FIX_BYTES);
  const sample = history.entitiesAt(299 * 5_000 - 2_500)[0];
  assert.ok(Math.abs(sample.lon - 29.85) < 1e-9);
  history.destroy();
});

test('the byte budget evicts the entities that reported least recently', () => {
  const capacity = 8 * FIX_BYTES; // first allocation per entity
  const history = createPositionHistory({
    maxBytes: capacity * 3,
    retentionMs: 3_600_000,
  });
  history.recordSnapshot('flights', [flight('old', 0, 0)], 0);
  history.recordSnapshot('flights', [flight('mid', 0, 0)], 10_000);
  history.recordSnapshot(
    'ais-live-vessels',
    [vessel('1', 0, 0), vessel('2', 0, 0)],
    20_000,
  );
  assert.ok(history.stats().bytes <= capacity * 3);
  assert.equal(history.range().count, 3);
  assert.equal(history.trackOf('flights', 'old').length, 0, 'oldest dropped');
  assert.equal(history.trackOf('flights', 'mid').length, 1);
  assert.equal(history.trackOf('ais-live-vessels', '2').length, 1);
  history.destroy();
});

test('attach swaps managers without losing recorded history', () => {
  const first = createFakeManager({
    flights: { getAnalystRecords: () => [flight('a', 0, 0)] },
  });
  const second = createFakeManager({
    flights: { getAnalystRecords: () => [flight('b', 1, 1)] },
  });
  let clock = 0;
  const history = createPositionHistory({
    dataManager: first,
    now: () => clock,
  });
  first.emit({ type: 'data-updated', layerId: 'flights' });
  history.attach(second);
  assert.equal(first.listenerCount, 0);
  clock = 30_000;
  first.emit({ type: 'data-updated', layerId: 'flights' });
  second.emit({ type: 'data-updated', layerId: 'flights' });
  assert.equal(history.range().count, 2);
  assert.equal(history.trackOf('flights', 'a').length, 1);
  assert.equal(history.trackOf('flights', 'b').length, 1);
  history.destroy();
});

test('fixTime prefers a plausible source timestamp over arrival time', async () => {
  const { fixTime, fixFromRecord } = await import('./positionHistory.js');
  const arrival = 1_000_000_000;
  assert.equal(fixTime({ t: arrival - 20_000 }, arrival), arrival - 20_000);
  assert.equal(fixTime({ t: null }, arrival), arrival, 'no source time');
  assert.equal(fixTime({ t: arrival + 120_000 }, arrival), arrival, 'future');
  assert.equal(
    fixTime({ t: arrival - 20 * 60_000 }, arrival),
    arrival,
    'too old',
  );
  const fix = fixFromRecord('flights', {
    icao24: 'abc123',
    lat: 30,
    lon: -90,
    altitudeM: 9000,
    positionTimeMs: arrival - 5_000,
  });
  assert.equal(fix.t, arrival - 5_000);
  assert.equal(
    fixFromRecord('ais-live-vessels', { mmsi: '1', lat: 1, lon: 1 }).t,
    undefined,
  );
});
