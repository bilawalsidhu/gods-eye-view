import assert from 'node:assert/strict';
import test from 'node:test';
import { CITY_BY_ID } from './registry.js';
import { createIngestion } from './ingestion.js';
import { createViewport } from './viewport.js';
import { greatCircleKm } from '../../geoDistance.js';
import { isAllowedGbfsHost } from '../../data/gbfsSource.js';

// Each system's stations farthest from its registered centre in the live
// feed; a centre between two towns or ends lists the outermost of each.
// JCDecaux names keep their feed spelling here.
const OUTERMOST = [
  // Spain (checked 2026-10-17).
  {
    cityId: 'madrid-bicimad',
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
  {
    cityId: 'valencia-valenbisi',
    stations: [
      { name: '_CAMPAMENTO_81', lat: 39.499875, lon: -0.426354 },
      { name: '_EDIFICIO_VELES_E_VENTS', lat: 39.461943, lon: -0.323856 },
    ],
  },
  {
    cityId: 'zaragoza-bizi',
    stations: [
      { name: '231- Heroínas Sitios: Gómara', lat: 41.627549, lon: -0.962297 },
      { name: '263- Avda. Real Zaragoza', lat: 41.666994, lon: -0.823078 },
    ],
  },
  {
    cityId: 'sevilla-sevici',
    stations: [
      { name: '_ESTADIO OLIMPICO', lat: 37.415898, lon: -6.005849 },
      { name: '_HOSPITAL VALME', lat: 37.320325, lon: -5.969204 },
    ],
  },
  {
    cityId: 'valladolid-biki',
    stations: [
      { name: '1002 Puente Duero', lat: 41.55413, lon: -4.79122 },
      { name: '1005 Santovenia Centro Civico', lat: 41.692504, lon: -4.688387 },
    ],
  },
  {
    cityId: 'a-coruna-bicicoruna',
    stations: [
      { name: 'Novo Mesoiro III', lat: 43.323367, lon: -8.443926 },
      { name: 'Adormideras', lat: 43.3833748, lon: -8.3956482 },
    ],
  },
  {
    cityId: 'donostia-dbizi',
    stations: [
      { name: '59 - BUENAVISTA', lat: 43.321211, lon: -1.922239 },
      { name: '54 - BERIO 42', lat: 43.305158, lon: -2.016997 },
    ],
  },
  {
    cityId: 'bilbao-bilbaobizi',
    stations: [
      { name: 'ZORROTZAKO KIROLDEGIA', lat: 43.2778696, lon: -2.9735575 },
      { name: 'OTXARKOAGA', lat: 43.258515, lon: -2.899282 },
    ],
  },
  {
    cityId: 'rivas-bicinrivas',
    stations: [
      {
        name: 'Polideportivo Parque Sureste',
        lat: 40.3236695,
        lon: -3.5127191,
      },
      { name: 'OCÉANO ÁRTICO', lat: 40.383292, lon: -3.5343627 },
    ],
  },
  // Latin America (checked 2026-10-16).
  {
    cityId: 'bogota-tembici',
    stations: [
      { name: '067 - KR 7B Bis con CL 152A', lat: 4.727729, lon: -74.026271 },
    ],
  },
  {
    cityId: 'santiago-bike-itau',
    stations: [
      { name: 'LC077 - Mall Sport', lat: -33.3707813, lon: -70.5073122 },
    ],
  },
  // Barcelona (checked 2026-10-16): AMBici spans the metropolitan area.
  {
    cityId: 'barcelona-bicing',
    stations: [
      { name: 'AV. RASOS DE PEGUERA, 10', lat: 41.462095, lon: 2.178959 },
      { name: 'C/ 60, NÚMERO 25', lat: 41.3467746, lon: 2.1436235 },
    ],
  },
  {
    cityId: 'barcelona-ambici',
    stations: [
      { name: 'Poal', lat: 41.268865, lon: 1.943849 },
      { name: 'Platja del Manresà', lat: 41.460101, lon: 2.267271 },
      { name: 'Can Ruti', lat: 41.482205, lon: 2.237607 },
    ],
  },
  // United States (checked 2026-10-13): HIBike's centre sits between its
  // two towns.
  {
    cityId: 'detroit-mogo',
    stations: [
      { name: 'Robina Ave & W Twelve Mile Rd', lat: 42.50288, lon: -83.18921 },
    ],
  },
  {
    cityId: 'pittsburgh-pogoh',
    stations: [
      { name: 'Wilkinsburg Park & Ride', lat: 40.446951, lon: -79.888593 },
    ],
  },
  {
    cityId: 'aspen-we-cycle',
    stations: [
      { name: 'Cowen Dr | Hwy 133', lat: 39.413115, lon: -107.220634 },
    ],
  },
  {
    cityId: 'hawaii-island-hibike',
    stations: [
      { name: 'Kona Community Center', lat: 19.642932, lon: -156.004962 },
      { name: 'Kealoha Beach Park, Hilo', lat: 19.733317, lon: -155.029202 },
    ],
  },
  // Brazil, Bike Itaú (checked 2026-10-15).
  {
    cityId: 'sao-paulo-bike-itau',
    stations: [{ name: '260 - P3', lat: -23.568235, lon: -46.740715 }],
  },
  {
    cityId: 'rio-de-janeiro-bike-itau',
    stations: [
      { name: '293 - Praia da Macumba', lat: -23.03135, lon: -43.479584 },
    ],
  },
  {
    cityId: 'salvador-bike-itau',
    stations: [{ name: '49 - Stella Maris', lat: -12.93645, lon: -38.32701 }],
  },
  {
    cityId: 'recife-bike-itau',
    stations: [
      { name: '69 - Praia de Piedade', lat: -8.186205, lon: -34.918371 },
    ],
  },
  {
    cityId: 'porto-alegre-bike-itau',
    stations: [
      { name: '72 - Avenida Tramandaí', lat: -30.135915, lon: -51.22684 },
    ],
  },
  {
    cityId: 'brasilia-bike-itau',
    stations: [
      { name: "60 - Parque Olhos d'Água", lat: -15.7431, lon: -47.88667 },
    ],
  },
  {
    cityId: 'curitiba-bike-itau',
    stations: [
      { name: '42 - Terminal Portão', lat: -25.476885, lon: -49.292608 },
    ],
  },
];

/** The outermost stations listed for `cityId`. */
const stationsOf = (cityId) =>
  OUTERMOST.find((city) => city.cityId === cityId).stations;

// Stations Spanish feeds list away from the city: a workshop at (0,0), a lab
// in Madrid, planned sites with no position yet (checked 2026-10-17).
const STRAYS = {
  'sevilla-sevici': [
    {
      station_id: '298',
      name: '_LAB MADRID',
      lat: 40.448779,
      lon: -3.584983,
    },
    { station_id: '300', name: '_TALLER SEVILLA', lat: 0, lon: 0 },
  ],
  'a-coruna-bicicoruna': [
    { station_id: '24', name: 'Playa de Oza', lat: 0, lon: 0 },
    { station_id: '37', name: 'Campus Elviña 2', lat: 0, lon: 0 },
    { station_id: '38', name: 'Campus Zapateira', lat: 0, lon: 0 },
  ],
};

// Depots PBSC feeds list on other continents (checked 2026-10-16).
const DEPOTS = {
  'bogota-tembici': [
    {
      station_id: '316',
      name: 'Calle 13 - 316',
      lat: -23.4008649,
      lon: -46.3972181,
    },
  ],
  'santiago-bike-itau': [
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
};

// The production range check, with no viewer or fetches behind it.
const { computeInRangeCities } = createViewport({
  state: {},
  services: { render: { governorRequestRender() {} } },
  parts: {},
  source: null,
});

/** Station information for `id` through the real ingestion path. */
async function loadThroughIngestion(id, stations, state = ingestionState()) {
  const city = CITY_BY_ID.get(id);
  const ingestion = createIngestion({
    state,
    services: {},
    parts: {},
    source: {
      async getStations(url) {
        assert.equal(url, city.stationInformationUrl);
        return { data: { stations } };
      },
    },
  });
  return ingestion.loadCityStationInfo(id);
}

function ingestionState() {
  return {
    _stationInfoCache: new Map(),
    _inFlightInfo: new Map(),
    _inFlightStatus: new Map(),
    _loadingOps: 0,
    _loading: false,
  };
}

test('a camera over each outermost station activates its system', () => {
  for (const { cityId, stations } of OUTERMOST) {
    for (const station of stations) {
      assert.ok(
        computeInRangeCities({ lat: station.lat, lon: station.lon }).has(
          cityId,
        ),
        `${station.name} activates ${cityId}`,
      );
    }
  }
});

test('each load radius reaches its outermost stations', () => {
  // The range check floors every radius at 100 km, but station information
  // is trimmed to the radius as registered, and get_bike_share uses it too.
  for (const { cityId, stations } of OUTERMOST) {
    const city = CITY_BY_ID.get(cityId);
    for (const station of stations) {
      const distance = greatCircleKm(
        { lat: city.centerLat, lon: city.centerLon },
        station,
      );
      assert.ok(
        distance <= city.loadRadiusKm,
        `${station.name} is ${distance.toFixed(1)} km from the ${cityId} centre`,
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
  for (const [id, strays] of Object.entries(STRAYS)) {
    const local = stationsOf(id).map((station, index) => ({
      station_id: `local-${index}`,
      ...station,
    }));
    const stations = await loadThroughIngestion(id, [...local, ...strays]);
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
      stationsOf(id).map((station, index) => ({
        station_id: String(index),
        ...station,
      })),
    );
    for (const station of stations.values())
      assert.doesNotMatch(station.name, /_/, `${id}: ${station.name}`);
  }
  const valenbisi = await loadThroughIngestion('valencia-valenbisi', [
    { station_id: '81', ...stationsOf('valencia-valenbisi')[0] },
  ]);
  assert.equal(valenbisi.get('81').name, 'CAMPAMENTO 81');
});

test('PBSC station capacity reaches the layer as docks, without the geofenced area', async () => {
  // Bilbao Bizi's ARAGOI and a BiciMAD station as published on 2026-10-17.
  const [bilbao] = stationsOf('bilbao-bilbaobizi');
  const bilbaoStations = await loadThroughIngestion('bilbao-bilbaobizi', [
    { station_id: '1', ...bilbao, capacity: 839, geofenced_capacity: 800 },
  ]);
  assert.equal(bilbaoStations.get('1').capacity, 39);
  const [madrid] = stationsOf('madrid-bicimad');
  const madridStations = await loadThroughIngestion('madrid-bicimad', [
    { station_id: '627', ...madrid, capacity: 47, geofenced_capacity: 20 },
  ]);
  assert.equal(madridStations.get('627').capacity, 27);
});

test('stations a feed lists on another continent are not loaded', async () => {
  for (const [id, depots] of Object.entries(DEPOTS)) {
    const [outermost] = stationsOf(id);
    const state = ingestionState();
    const stations = await loadThroughIngestion(
      id,
      [
        {
          station_id: 'local',
          name: outermost.name,
          lat: outermost.lat,
          lon: outermost.lon,
        },
        ...depots,
      ],
      state,
    );
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
  await assert.rejects(
    loadThroughIngestion('santiago-bike-itau', DEPOTS['santiago-bike-itau']),
    new RegExp(`No station information for ${city.city}`),
  );
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

test('HIBike stays inactive away from Hawaii Island', () => {
  // Honolulu is about 270 km from the HIBike centre.
  assert.equal(
    computeInRangeCities({ lat: 21.3069, lon: -157.8583 }).has(
      'hawaii-island-hibike',
    ),
    false,
  );
});
