import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeStarshipLiveSnapshot } from './starshipLive.js';

test('normalizes a samples-array Starship feed', () => {
  const snapshot = normalizeStarshipLiveSnapshot(
    {
      names: { ship42: 'Starship Flight 15' },
      samples: [
        {
          veh: 'ship42',
          lat: 25.9968,
          lon: -97.158,
          alt: 95.3,
          spd: 0,
          hdg: 90,
          wall: 1794608923746,
        },
      ],
      status: { connected: true, t0: 1794610056 },
    },
    1234,
  );
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.active, true);
  assert.equal(snapshot.vehicles.length, 1);
  assert.equal(snapshot.vehicles[0].id, 'ship42');
  assert.equal(snapshot.vehicles[0].name, 'Starship Flight 15');
  assert.equal(snapshot.vehicles[0].lat, 25.9968);
  assert.equal(snapshot.vehicles[0].lon, -97.158);
  assert.equal(snapshot.vehicles[0].alt, 95.3);
  assert.equal(snapshot.status.connected, true);
});

test('derives heading from the feed trajectory when heading is absent', () => {
  const snapshot = normalizeStarshipLiveSnapshot(
    {
      samples: [
        {
          veh: 'ship42',
          lat: 25.9968,
          lon: -97.158,
          alt: 95,
          spd: 0,
          traj: [
            [25.9968, -97.158, 95, 1],
            [25.9978, -97.157, 120, 2],
          ],
        },
      ],
    },
    1234,
  );
  const vehicle = snapshot.vehicles[0];
  assert.ok(vehicle.speed > 100);
  assert.ok(vehicle.speed < 200);
  assert.ok(vehicle.heading > 0);
  assert.ok(vehicle.heading < 360);
});

test('derives Stardash-compatible speed from the feed trajectory when speed is zero', () => {
  const snapshot = normalizeStarshipLiveSnapshot({
    samples: [
      {
        veh: 'ship42',
        lat: 25.9968,
        lon: -97.158,
        alt: 95,
        spd: 0,
        traj: [
          [25.9968, -97.158, 95, 1],
          [26.0058, -97.148, 120, 2],
        ],
      },
    ],
  });
  const speed = snapshot.vehicles[0].speed;
  assert.ok(speed > 1_300);
  assert.ok(speed < 1_500);
  assert.ok(snapshot.vehicles[0].heading > 0);
  assert.ok(snapshot.vehicles[0].heading < 360);
});

test('derives speed from consecutive live samples like Stardash', () => {
  const history = new Map();
  const first = normalizeStarshipLiveSnapshot(
    {
      samples: [
        {
          veh: 'ship42',
          lat: 22.202886,
          lon: 163.736437,
          alt: 263953.137818,
          spd: 0,
          gps: 1478649883.537085,
        },
      ],
    },
    1234,
    history,
  );
  const second = normalizeStarshipLiveSnapshot(
    {
      samples: [
        {
          veh: 'ship42',
          lat: 22.932763,
          lon: 165.63638,
          alt: 264167.969746,
          spd: 0,
          gps: 1478649913.537581,
        },
      ],
    },
    1235,
    history,
  );
  assert.equal(first.vehicles[0].speed, 0);
  assert.equal((second.vehicles[0].speed * 3.6).toFixed(2), '25354.65');
});

test('normalizes a direct vehicle-key Starship feed', () => {
  const snapshot = normalizeStarshipLiveSnapshot(
    {
      status: { connected: false },
      ship42: {
        current: {
          lat: 1,
          lon: 2,
          alt: 3,
          spd: 4,
          hdg: 5,
          wall: 6,
        },
      },
    },
    1234,
  );
  assert.equal(snapshot.vehicles.length, 1);
  assert.equal(snapshot.vehicles[0].id, 'ship42');
  assert.equal(snapshot.vehicles[0].alt, 3);
  assert.equal(snapshot.status.connected, false);
});

test('rejects malformed and oversized Starship feeds', () => {
  assert.throws(() => normalizeStarshipLiveSnapshot(null), /malformed/);
  assert.throws(
    () =>
      normalizeStarshipLiveSnapshot({
        samples: [
          { veh: 'a', lat: 1, lon: 1 },
          { veh: 'b', lat: 1, lon: 1 },
          { veh: 'c', lat: 1, lon: 1 },
        ],
      }),
    /too_many_vehicles/,
  );
});
