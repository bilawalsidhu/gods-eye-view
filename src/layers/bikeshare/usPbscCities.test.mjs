import assert from 'node:assert/strict';
import test from 'node:test';
import { CITY_BY_ID } from './registry.js';
import { createModel } from './model.js';
import { createViewport } from './viewport.js';
import { isAllowedGbfsHost, isAllowedGbfsPath } from '../../data/gbfsSource.js';

// Each city's PBSC host, and the stations farthest from its registered centre
// in the live feed (checked 2026-10-13). HIBike's centre sits between its two
// towns, so it lists the outermost station in each.
const CITIES = {
  'detroit-mogo': {
    host: 'detroit.publicbikesystem.net',
    provider: 'MoGo',
    stations: [{ name: 'Robina Ave & W Twelve Mile Rd', lat: 42.50288, lon: -83.18921 }],
  },
  'pittsburgh-pogoh': {
    host: 'pittsburgh.publicbikesystem.net',
    provider: 'POGOH',
    stations: [{ name: 'Wilkinsburg Park & Ride', lat: 40.446951, lon: -79.888593 }],
  },
  'aspen-we-cycle': {
    host: 'aspen.publicbikesystem.net',
    provider: 'WE-cycle',
    stations: [{ name: 'Cowen Dr | Hwy 133', lat: 39.413115, lon: -107.220634 }],
  },
  'hawaii-island-hibike': {
    host: 'kona.publicbikesystem.net',
    provider: 'HIBike',
    stations: [
      { name: 'Kona Community Center', lat: 19.642932, lon: -156.004962 },
      { name: 'Kealoha Beach Park, Hilo', lat: 19.733317, lon: -155.029202 },
    ],
  },
};

// The production range check, with no viewer or fetches behind it.
const parts = { model: createModel({ state: {}, services: {}, parts: {}, source: null }) };
const { computeInRangeCities } = createViewport({
  state: {},
  services: { render: { governorRequestRender() {} } },
  parts,
  source: null,
});

test('the added US PBSC systems are registered and readable through the proxy', () => {
  for (const [id, expected] of Object.entries(CITIES)) {
    const city = CITY_BY_ID.get(id);
    assert.ok(city, `${id} is registered`);
    assert.equal(city.provider, expected.provider);
    assert.deepEqual(city.hosts, [expected.host]);
    for (const feed of [city.stationInformationUrl, city.stationStatusUrl]) {
      const url = new URL(feed);
      assert.ok(isAllowedGbfsHost(url.hostname), `${id} host ${url.hostname}`);
      assert.ok(isAllowedGbfsPath(url.pathname), `${id} path ${url.pathname}`);
    }
  }
});

test('a camera over each outermost station activates its system', () => {
  for (const [id, expected] of Object.entries(CITIES)) {
    for (const station of expected.stations) {
      assert.ok(
        computeInRangeCities({ lat: station.lat, lon: station.lon }).has(id),
        `${station.name} activates ${id}`,
      );
    }
  }
});

test('HIBike stays inactive away from Hawaii Island', () => {
  // Honolulu is about 270 km from the HIBike centre.
  assert.equal(
    computeInRangeCities({ lat: 21.3069, lon: -157.8583 }).has('hawaii-island-hibike'),
    false,
  );
});
