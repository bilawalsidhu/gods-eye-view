import assert from 'node:assert/strict';
import test from 'node:test';
import { CITY_BY_ID } from './registry.js';
import { createIngestion } from './ingestion.js';
import { createModel } from './model.js';
import { createViewport } from './viewport.js';
import { isAllowedGbfsHost, isAllowedGbfsPath } from '../../data/gbfsSource.js';

// Each system's PBSC host, the station farthest from its registered centre,
// and the depots its live feed lists on other continents (checked 2026-10-16).
const CITIES = {
  'bogota-tembici': {
    host: 'bogota.publicbikesystem.net',
    provider: 'Tembici Bogotá',
    stations: [
      { name: '067 - KR 7B Bis con CL 152A', lat: 4.727729, lon: -74.026271 },
    ],
    depots: [
      {
        station_id: '316',
        name: 'Calle 13 - 316',
        lat: -23.4008649,
        lon: -46.3972181,
      },
    ],
  },
  'santiago-bike-itau': {
    host: 'santiago.publicbikesystem.net',
    provider: 'Bike Itaú Santiago',
    stations: [
      { name: 'LC077 - Mall Sport', lat: -33.3707813, lon: -70.5073122 },
    ],
    depots: [
      {
        station_id: '459',
        name: 'Galpon - 459',
        lat: 40.4167747,
        lon: -3.7037899,
      },
      {
        station_id: '440',
        name: 'Galpon - 440',
        lat: -23.5690975,
        lon: -46.697366,
      },
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

test('Bogotá and Santiago are registered and readable through the proxy', () => {
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

test('each load radius reaches its outermost stations', () => {
  // The range check floors every radius at 100 km; the station filter and
  // get_bike_share use the radius as registered.
  for (const [id, expected] of Object.entries(CITIES)) {
    const city = CITY_BY_ID.get(id);
    for (const station of expected.stations) {
      const distance = parts.model.haversineKm(
        city.centerLat,
        city.centerLon,
        station.lat,
        station.lon,
      );
      assert.ok(
        distance <= city.loadRadiusKm,
        `${station.name} is ${distance.toFixed(1)} km from the ${id} centre`,
      );
    }
  }
});

test('stations a feed lists on another continent are not loaded', async () => {
  for (const [id, expected] of Object.entries(CITIES)) {
    const city = CITY_BY_ID.get(id);
    const outermost = expected.stations[0];
    const payload = {
      data: {
        stations: [
          {
            station_id: 'local',
            name: outermost.name,
            lat: outermost.lat,
            lon: outermost.lon,
          },
          ...expected.depots,
        ],
      },
    };
    const state = {
      _stationInfoCache: new Map(),
      _inFlightInfo: new Map(),
      _inFlightStatus: new Map(),
      _loadingOps: 0,
      _loading: false,
    };
    const ingestion = createIngestion({
      state,
      services: {},
      parts,
      source: {
        async getStations(url) {
          assert.equal(url, city.stationInformationUrl);
          return payload;
        },
      },
    });

    const stations = await ingestion.loadCityStationInfo(id, 1);
    assert.deepEqual(
      [...stations.keys()],
      ['local'],
      `${id} keeps only local stations`,
    );
    assert.equal(state._stationInfoCache.get(id), stations);
  }
});

test('a feed with only far-away stations reports no station information', async () => {
  const city = CITY_BY_ID.get('santiago-bike-itau');
  const ingestion = createIngestion({
    state: {
      _stationInfoCache: new Map(),
      _inFlightInfo: new Map(),
      _inFlightStatus: new Map(),
      _loadingOps: 0,
      _loading: false,
    },
    services: {},
    parts,
    source: {
      async getStations() {
        return { data: { stations: CITIES['santiago-bike-itau'].depots } };
      },
    },
  });
  await assert.rejects(
    ingestion.loadCityStationInfo('santiago-bike-itau', 1),
    new RegExp(`No station information for ${city.city}`),
  );
});
