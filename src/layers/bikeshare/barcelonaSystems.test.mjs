import assert from 'node:assert/strict';
import test from 'node:test';
import { CITY_BY_ID } from './registry.js';
import { createModel } from './model.js';
import { createViewport } from './viewport.js';
import { isAllowedGbfsHost, isAllowedGbfsPath } from '../../data/gbfsSource.js';

// Each Barcelona system's host, and the stations farthest from its registered
// centre in the live feed (checked 2026-10-16). AMBici spans the metropolitan
// area, so it lists its south-western and north-eastern ends.
const SYSTEMS = {
  'barcelona-bicing': {
    host: 'barcelona.publicbikesystem.net',
    provider: 'Bicing',
    stations: [
      { name: 'AV. RASOS DE PEGUERA, 10', lat: 41.462095, lon: 2.178959 },
      { name: 'C/ 60, NÚMERO 25', lat: 41.3467746, lon: 2.1436235 },
    ],
  },
  'barcelona-ambici': {
    host: 'gbfs.nextbike.net',
    provider: 'AMBici',
    stations: [
      { name: 'Poal', lat: 41.268865, lon: 1.943849 },
      { name: 'Platja del Manresà', lat: 41.460101, lon: 2.267271 },
      { name: 'Can Ruti', lat: 41.482205, lon: 2.237607 },
    ],
  },
};

// The production range check, with no viewer or fetches behind it.
const parts = {
  model: createModel({ state: {}, services: {}, parts: {}, source: null }),
};
const { computeInRangeCities } = createViewport({
  state: {},
  services: { render: { governorRequestRender() {} } },
  parts,
  source: null,
});

test('Bicing and AMBici are registered and readable through the proxy', () => {
  for (const [id, expected] of Object.entries(SYSTEMS)) {
    const system = CITY_BY_ID.get(id);
    assert.ok(system, `${id} is registered`);
    assert.equal(system.provider, expected.provider);
    assert.deepEqual(system.hosts, [expected.host]);
    for (const feed of [
      system.stationInformationUrl,
      system.stationStatusUrl,
    ]) {
      const url = new URL(feed);
      assert.ok(isAllowedGbfsHost(url.hostname), `${id} host ${url.hostname}`);
      assert.ok(
        isAllowedGbfsPath(url.pathname, url.hostname),
        `${id} path ${url.pathname}`,
      );
    }
  }
});

test('a camera over each outermost station activates its system', () => {
  for (const [id, expected] of Object.entries(SYSTEMS)) {
    for (const station of expected.stations) {
      assert.ok(
        computeInRangeCities({ lat: station.lat, lon: station.lon }).has(id),
        `${station.name} activates ${id}`,
      );
    }
  }
});

test('each load radius reaches its outermost stations', () => {
  // The range check floors every radius at 100 km, so the test above passes
  // with any loadRadiusKm; get_bike_share uses the radius as registered.
  for (const [id, expected] of Object.entries(SYSTEMS)) {
    const system = CITY_BY_ID.get(id);
    for (const station of expected.stations) {
      const distance = parts.model.haversineKm(
        system.centerLat,
        system.centerLon,
        station.lat,
        station.lon,
      );
      assert.ok(
        distance <= system.loadRadiusKm,
        `${station.name} is ${distance.toFixed(1)} km from the ${id} centre`,
      );
    }
  }
});

test('a camera over central Barcelona activates both systems', () => {
  // Plaça de Catalunya.
  const active = computeInRangeCities({ lat: 41.387, lon: 2.17 });
  assert.ok(active.has('barcelona-bicing'));
  assert.ok(active.has('barcelona-ambici'));
});

test('the nextbike allowance is that one host, not its domain', () => {
  assert.equal(isAllowedGbfsHost('gbfs.nextbike.net'), true);
  assert.equal(isAllowedGbfsHost('api.nextbike.net'), false);
  assert.equal(isAllowedGbfsHost('gbfs.nextbike.net.example'), false);
});
