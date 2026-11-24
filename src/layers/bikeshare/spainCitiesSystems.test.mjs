import assert from 'node:assert/strict';
import test from 'node:test';
import { CITY_BY_ID } from './registry.js';
import { createIngestion } from './ingestion.js';
import { createModel } from './model.js';
import { createViewport } from './viewport.js';
import { isAllowedGbfsHost, isAllowedGbfsPath } from '../../data/gbfsSource.js';

// Each system's host, its stations farthest from the registered centre in
// opposite directions, and the stations its live feed lists away from the
// city: a workshop at (0,0), a lab in Madrid, planned sites with no position
// yet (checked 2026-10-17). JCDecaux names keep their feed spelling here.
const SYSTEMS = {
  'madrid-bicimad': {
    host: 'madrid.publicbikesystem.net',
    provider: 'BiciMAD',
    stations: [
      {
        name: '627 - Alcalde Andrés Madrid Dávila, 92',
        lat: 40.398303,
        lon: -3.548534,
      },
      {
        name: '672 - Estación de tren de El Barrial-Pozuelo',
        lat: 40.464908,
        lon: -3.807764,
      },
    ],
  },
  'valencia-valenbisi': {
    host: 'api.cyclocity.fr',
    provider: 'Valenbisi',
    stations: [
      { name: '_CAMPAMENTO_81', lat: 39.499875, lon: -0.426354 },
      { name: '_EDIFICIO_VELES_E_VENTS', lat: 39.461943, lon: -0.323856 },
    ],
  },
  'zaragoza-bizi': {
    host: 'zaragoza.publicbikesystem.net',
    provider: 'Bizi Zaragoza',
    stations: [
      { name: '231- Heroínas Sitios: Gómara', lat: 41.627549, lon: -0.962297 },
      { name: '263- Avda. Real Zaragoza', lat: 41.666994, lon: -0.823078 },
    ],
  },
  'sevilla-sevici': {
    host: 'api.cyclocity.fr',
    provider: 'Sevici',
    stations: [
      { name: '_ESTADIO OLIMPICO', lat: 37.415898, lon: -6.005849 },
      { name: '_HOSPITAL VALME', lat: 37.320325, lon: -5.969204 },
    ],
    strays: [
      {
        station_id: '298',
        name: '_LAB MADRID',
        lat: 40.448779,
        lon: -3.584983,
      },
      { station_id: '300', name: '_TALLER SEVILLA', lat: 0, lon: 0 },
    ],
  },
  'valladolid-biki': {
    host: 'valladolid.publicbikesystem.net',
    provider: 'BIKI',
    stations: [
      { name: '1002 Puente Duero', lat: 41.55413, lon: -4.79122 },
      { name: '1005 Santovenia Centro Civico', lat: 41.692504, lon: -4.688387 },
    ],
  },
  'a-coruna-bicicoruna': {
    host: 'acoruna.publicbikesystem.net',
    provider: 'BiciCoruña',
    stations: [
      { name: 'Novo Mesoiro III', lat: 43.323367, lon: -8.443926 },
      { name: 'Adormideras', lat: 43.3833748, lon: -8.3956482 },
    ],
    strays: [
      { station_id: '24', name: 'Playa de Oza', lat: 0, lon: 0 },
      { station_id: '37', name: 'Campus Elviña 2', lat: 0, lon: 0 },
      { station_id: '38', name: 'Campus Zapateira', lat: 0, lon: 0 },
    ],
  },
  'donostia-dbizi': {
    host: 'sansebastian.publicbikesystem.net',
    provider: 'Dbizi',
    stations: [
      { name: '59 - BUENAVISTA', lat: 43.321211, lon: -1.922239 },
      { name: '54 - BERIO 42', lat: 43.305158, lon: -2.016997 },
    ],
  },
  'bilbao-bilbaobizi': {
    host: 'bilbao.publicbikesystem.net',
    provider: 'Bilbao Bizi',
    stations: [
      { name: 'ZORROTZAKO KIROLDEGIA', lat: 43.2778696, lon: -2.9735575 },
      { name: 'OTXARKOAGA', lat: 43.258515, lon: -2.899282 },
    ],
  },
  'rivas-bicinrivas': {
    host: 'rivas.publicbikesystem.net',
    provider: 'BicinRivas',
    stations: [
      {
        name: 'Polideportivo Parque Sureste',
        lat: 40.3236695,
        lon: -3.5127191,
      },
      { name: 'OCÉANO ÁRTICO', lat: 40.383292, lon: -3.5343627 },
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

/** Station information for `id` through the real ingestion path. */
async function loadThroughIngestion(id, stations) {
  const city = CITY_BY_ID.get(id);
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
        return { data: { stations } };
      },
    },
  });
  return ingestion.loadCityStationInfo(id, 1);
}

test('the Spanish city systems are registered and readable through the proxy', () => {
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
  // The range check floors every radius at 100 km, but station information is
  // trimmed to the radius as registered, so it has to reach every station.
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

test('a camera over central Madrid activates BiciMAD and BicinRivas', () => {
  // Puerta del Sol.
  const active = computeInRangeCities({ lat: 40.4169, lon: -3.7035 });
  assert.ok(active.has('madrid-bicimad'));
  assert.ok(active.has('rivas-bicinrivas'));
});

test('stations a feed lists away from its city are not loaded', async () => {
  for (const [id, expected] of Object.entries(SYSTEMS)) {
    if (!expected.strays) continue;
    const local = expected.stations.map((station, index) => ({
      station_id: `local-${index}`,
      ...station,
    }));
    const stations = await loadThroughIngestion(id, [
      ...local,
      ...expected.strays,
    ]);
    assert.deepEqual(
      [...stations.keys()],
      local.map((station) => station.station_id),
      `${id} keeps only its local stations`,
    );
  }
});

test('JCDecaux station names reach the layer without underscores', async () => {
  for (const id of ['valencia-valenbisi', 'sevilla-sevici']) {
    const stations = await loadThroughIngestion(
      id,
      SYSTEMS[id].stations.map((station, index) => ({
        station_id: String(index),
        ...station,
      })),
    );
    for (const station of stations.values())
      assert.doesNotMatch(station.name, /_/, `${id}: ${station.name}`);
  }
  const valenbisi = await loadThroughIngestion('valencia-valenbisi', [
    { station_id: '81', ...SYSTEMS['valencia-valenbisi'].stations[0] },
  ]);
  assert.equal(valenbisi.get('81').name, 'CAMPAMENTO 81');
});

test('PBSC station capacity reaches the layer as docks, without the geofenced area', async () => {
  // Bilbao Bizi's ARAGOI and a BiciMAD station as published on 2026-10-17.
  const [bilbao] = SYSTEMS['bilbao-bilbaobizi'].stations;
  const bilbaoStations = await loadThroughIngestion('bilbao-bilbaobizi', [
    { station_id: '1', ...bilbao, capacity: 839, geofenced_capacity: 800 },
  ]);
  assert.equal(bilbaoStations.get('1').capacity, 39);
  const [madrid] = SYSTEMS['madrid-bicimad'].stations;
  const madridStations = await loadThroughIngestion('madrid-bicimad', [
    { station_id: '627', ...madrid, capacity: 47, geofenced_capacity: 20 },
  ]);
  assert.equal(madridStations.get('627').capacity, 27);
});
