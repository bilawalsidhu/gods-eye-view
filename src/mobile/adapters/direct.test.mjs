import test from 'node:test';
import assert from 'node:assert/strict';
import { createWeatherDirectSource } from './weatherDirect.js';
import { createAdsbdbDirectSource } from './adsbdbDirect.js';
import {
  NOMINATIM_REVERSE_ENDPOINT,
  NOMINATIM_SEARCH_ENDPOINT,
  createGeocodeDirectSource,
  createRouteDirectSource,
} from './geocodeDirect.js';
import {
  createCycloneDirectSource,
  createFirmsDirectSource,
  createFirePerimeterDirectSource,
  createGbfsDirectSource,
  createRadioDirectSource,
} from './staticFeedsDirect.js';
import {
  createMapillaryDirectSource,
  createTerrainDirectSource,
} from './tileFeedsDirect.js';
import {
  buildLocalReceiverRegistry,
  createLocalReceiverDirectSource,
} from './localReceiversDirect.js';

/** Wrap a payload in a real Response so adapter body readers stay honest. */
function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function textResponse(text, status = 200) {
  return new Response(text, {
    status,
    headers: { 'content-type': 'text/csv' },
  });
}

function bytesResponse(bytes, status = 200) {
  return new Response(bytes, {
    status,
    headers: { 'content-type': 'application/x-protobuf' },
  });
}

/** Registry refusal, mirroring nativeFetch's `{ code }` contract. */
function refusalError() {
  return Object.assign(new Error('Upstream not allowed for host "x": test'), {
    code: 'UPSTREAM_NOT_ALLOWED',
  });
}

/** Record calls and delegate each request to a handler. */
function stubFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init, calls);
  };
  return { calls, fetchImpl };
}

/**
 * Abort-then-resolve: the adapter must discard the late body and surface the
 * abort, because CapacitorHttp cannot cancel in flight.
 */
async function assertDiscardsLateResponse(invoke) {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const fetchImpl = async () => {
    await gate;
    return jsonResponse({ unexpected: true });
  };
  const controller = new AbortController();
  const pending = invoke(fetchImpl, controller.signal);
  controller.abort();
  release();
  await assert.rejects(pending, (error) => {
    assert.equal(error.name, 'AbortError');
    return true;
  });
}

/** No-op pacer recording how often the courtesy gate was consulted. */
function recordingPacer() {
  const waits = [];
  return {
    waits,
    wait: async () => {
      waits.push(true);
    },
  };
}

// ---------------------------------------------------------------------------
// weatherDirect
// ---------------------------------------------------------------------------

const OPEN_METEO_FIXTURE = {
  current: {
    time: '2026-10-11T12:00',
    temperature_2m: 21.5,
    apparent_temperature: 23.0,
    precipitation: 0.0,
    weather_code: 1,
    cloud_cover: 25,
    wind_speed_10m: 10.0,
    wind_direction_10m: 180,
    visibility: 24000,
  },
};

test('weather direct returns the normalized Open-Meteo current record', async () => {
  const { calls, fetchImpl } = stubFetch(() =>
    jsonResponse(OPEN_METEO_FIXTURE),
  );
  const source = createWeatherDirectSource({ fetchImpl });
  const record = await source.getCurrent({
    latitude: 48.85,
    longitude: 2.35,
  });
  assert.equal(record.temperatureC, 21.5);
  assert.equal(record.apparentTemperatureC, 23.0);
  assert.equal(record.windKph, 10.0);
  assert.equal(record.visibilityM, 24000);
  assert.equal(record.observedAt, '2026-10-11T12:00:00.000Z');
  assert.match(calls[0].url, /^https:\/\/api\.open-meteo\.com\/v1\/forecast\?/);
  assert.match(calls[0].url, /latitude=48\.85/);
});

test('weather direct rejects out-of-range coordinates without fetching', async () => {
  const { calls, fetchImpl } = stubFetch(() => jsonResponse({}));
  const source = createWeatherDirectSource({ fetchImpl });
  await assert.rejects(source.getCurrent({ latitude: 91, longitude: 0 }));
  assert.equal(calls.length, 0);
});

test('weather direct throws on a payload with no usable current block', async () => {
  const { fetchImpl } = stubFetch(() => jsonResponse({ current: {} }));
  const source = createWeatherDirectSource({ fetchImpl });
  await assert.rejects(source.getCurrent({ latitude: 0, longitude: 0 }));
});

test('weather direct maps registry refusal to honest unavailable', async () => {
  const { fetchImpl } = stubFetch(() => {
    throw refusalError();
  });
  const source = createWeatherDirectSource({ fetchImpl });
  assert.deepEqual(await source.getCurrent({ latitude: 0, longitude: 0 }), {
    unavailable: 'UPSTREAM_NOT_ALLOWED',
  });
});

test('weather direct discards a late response after abort', async () => {
  await assertDiscardsLateResponse((fetchImpl, signal) =>
    createWeatherDirectSource({ fetchImpl }).getCurrent({
      latitude: 0,
      longitude: 0,
      signal,
    }),
  );
});

test('weather direct reports tile imagery honestly unavailable (no fetch)', async () => {
  const { calls, fetchImpl } = stubFetch(() => jsonResponse({}));
  const source = createWeatherDirectSource({ fetchImpl });
  const snapshot = await source.getSnapshot({ product: 'radar' });
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.product, 'radar');
  assert.equal(snapshot.unavailable, true);
  assert.equal(calls.length, 0);
  await assert.rejects(source.getSnapshot({ product: 'hail' }), /Unknown/);
});

// ---------------------------------------------------------------------------
// adsbdbDirect
// ---------------------------------------------------------------------------

const ADSBDB_ROUTE_FIXTURE = {
  response: {
    flightroute: {
      airline: { name: 'United Airlines' },
      origin: {
        iata_code: 'SFO',
        municipality: 'San Francisco',
        latitude: 37.61,
        longitude: -122.36,
      },
      destination: {
        iata_code: 'JFK',
        municipality: 'New York',
        latitude: 40.64,
        longitude: -73.78,
      },
    },
  },
};

const ADSBDB_AIRCRAFT_FIXTURE = {
  response: {
    aircraft: {
      icao_type: 'B738',
      manufacturer: 'Boeing',
      type: '737-800',
      registration: 'N12345',
    },
  },
};

test('adsbdb direct normalizes callsign routes and aircraft records', async () => {
  const { calls, fetchImpl } = stubFetch((url) =>
    jsonResponse(
      url.includes('/callsign/') ? ADSBDB_ROUTE_FIXTURE : ADSBDB_AIRCRAFT_FIXTURE,
    ),
  );
  const source = createAdsbdbDirectSource({ fetchImpl });
  const route = await source.lookupRoute('UAL123');
  assert.equal(route.airline, 'United Airlines');
  assert.equal(route.origin.code, 'SFO');
  assert.equal(route.destination.code, 'JFK');
  assert.equal(route.destination.lat, 40.64);
  const aircraft = await source.lookupAircraft('ab12cd');
  assert.equal(aircraft.typeCode, 'B738');
  assert.equal(aircraft.typeName, 'Boeing 737-800');
  assert.equal(aircraft.registration, 'N12345');
  assert.match(calls[0].url, /^https:\/\/api\.adsbdb\.com\/v0\/callsign\//);
  assert.match(calls[1].url, /^https:\/\/api\.adsbdb\.com\/v0\/aircraft\//);
});

test('adsbdb direct returns null on 404 (known-missing key)', async () => {
  const { fetchImpl } = stubFetch(() => jsonResponse({}, 404));
  const source = createAdsbdbDirectSource({ fetchImpl });
  assert.equal(await source.lookupRoute('NOCALL'), null);
  assert.equal(await source.lookupAircraft('000000'), null);
});

test('adsbdb direct rejects blank keys without fetching', async () => {
  const { calls, fetchImpl } = stubFetch(() => jsonResponse({}));
  const source = createAdsbdbDirectSource({ fetchImpl });
  await assert.rejects(source.lookupRoute('  '));
  await assert.rejects(source.lookupAircraft(''));
  assert.equal(calls.length, 0);
});

test('adsbdb direct maps registry refusal to honest unavailable', async () => {
  const { fetchImpl } = stubFetch(() => {
    throw refusalError();
  });
  const source = createAdsbdbDirectSource({ fetchImpl });
  assert.deepEqual(await source.lookupRoute('UAL123'), {
    unavailable: 'UPSTREAM_NOT_ALLOWED',
  });
});

test('adsbdb direct discards a late response after abort', async () => {
  await assertDiscardsLateResponse((fetchImpl, signal) =>
    createAdsbdbDirectSource({ fetchImpl }).lookupRoute('UAL123', { signal }),
  );
});

// ---------------------------------------------------------------------------
// geocodeDirect
// ---------------------------------------------------------------------------

const NOMINATIM_SEARCH_FIXTURE = [
  {
    lat: '48.8566',
    lon: '2.3522',
    display_name: 'Paris, Île-de-France, France',
    name: 'Paris',
    class: 'place',
    type: 'city',
    boundingbox: ['48.81', '48.90', '2.22', '2.47'],
  },
];

const NOMINATIM_REVERSE_FIXTURE = {
  lat: '48.8566',
  lon: '2.3522',
  display_name: 'Paris, Île-de-France, France',
  name: 'Paris',
  class: 'place',
  type: 'city',
  address: { city: 'Paris', country: 'France', country_code: 'fr' },
};

const OSRM_FIXTURE = {
  code: 'Ok',
  routes: [
    {
      distance: 1500.2,
      duration: 900.6,
      geometry: {
        coordinates: [
          [2.35, 48.85],
          [2.36, 48.86],
        ],
      },
      legs: [
        {
          steps: [
            {
              maneuver: { type: 'depart', location: [2.35, 48.85] },
              name: 'Rue A',
              distance: 500,
              duration: 300,
            },
            {
              maneuver: { type: 'arrive', location: [2.36, 48.86] },
              name: '',
              distance: 1000.2,
              duration: 600.6,
            },
          ],
        },
      ],
    },
  ],
};

test('geocode direct searches Nominatim and consults the shared courtesy pacer', async () => {
  const { calls, fetchImpl } = stubFetch(() =>
    jsonResponse(NOMINATIM_SEARCH_FIXTURE),
  );
  const waits = [];
  const { resetSharedPacer, setSharedPacerClock } = await import('../../mobile/sourcePolicy.js');
  resetSharedPacer();
  setSharedPacerClock({
    now: () => Date.now(),
    sleep: async (ms) => { waits.push(ms); },
  });
  const source = createGeocodeDirectSource({ fetchImpl });
  const rows1 = await source.search('Paris');
  assert.equal(rows1.length, 1);
  assert.match(rows1[0].display_name, /Paris/);
  const rows2 = await source.search('London');
  assert.equal(rows2.length, 1);
  assert.equal(waits.length, 1);
  // Allow small timing variance (pacer interval is 1100ms, actual may be ~1099)
  assert.ok(waits[0] >= 1090 && waits[0] <= 1110, `wait was ${waits[0]}ms, expected ~1100`);
  assert.match(calls[0].url, new RegExp(`^${NOMINATIM_SEARCH_ENDPOINT}\\?`));
  assert.match(calls[0].url, /q=Paris/);
});

test('geocode direct reverse-geocodes through the Nominatim endpoint', async () => {
  const { calls, fetchImpl } = stubFetch(() =>
    jsonResponse(NOMINATIM_REVERSE_FIXTURE),
  );
  const { resetSharedPacer, setSharedPacerClock } = await import('../../mobile/sourcePolicy.js');
  resetSharedPacer();
  setSharedPacerClock({ now: () => Date.now(), sleep: async () => {} });
  const source = createGeocodeDirectSource({ fetchImpl });
  const row = await source.reverse(48.85, 2.35);
  assert.match(row.display_name, /Paris/);
  assert.match(calls[0].url, new RegExp(`^${NOMINATIM_REVERSE_ENDPOINT}\\?`));
});

test('geocode direct discards a late response after abort', async () => {
  const { resetSharedPacer, setSharedPacerClock } = await import('../../mobile/sourcePolicy.js');
  resetSharedPacer();
  setSharedPacerClock({ now: () => Date.now(), sleep: async () => {} });
  await assertDiscardsLateResponse((fetchImpl, signal) =>
    createGeocodeDirectSource({ fetchImpl }).search('Paris', { signal }),
  );
});

test('route direct projects the OSRM response like the proxy payload', async () => {
  const { calls, fetchImpl } = stubFetch(() => jsonResponse(OSRM_FIXTURE));
  const waits = [];
  const { resetSharedPacer, setSharedPacerClock } = await import('../../mobile/sourcePolicy.js');
  resetSharedPacer();
  setSharedPacerClock({
    now: () => Date.now(),
    sleep: async (ms) => { waits.push(ms); },
  });
  const source = createRouteDirectSource({ fetchImpl });
  // First request (no wait, first call)
  const payload1 = await source.getRoute({
    mode: 'foot',
    a: { lat: 48.85, lon: 2.35 },
    b: { lat: 48.86, lon: 2.36 },
  });
  assert.equal(payload1.ok, true);
  // Second request (should wait due to shared pacer)
  const payload2 = await source.getRoute({
    mode: 'foot',
    a: { lat: 48.86, lon: 2.36 },
    b: { lat: 48.87, lon: 2.37 },
  });
  assert.equal(payload2.ok, true);
  assert.equal(waits.length, 1);
  // Allow small timing variance (pacer interval is 1100ms, actual may be ~1099)
  assert.ok(waits[0] >= 1090 && waits[0] <= 1110, `wait was ${waits[0]}ms, expected ~1100`);
  assert.equal(payload1.ok, true);
  assert.equal(payload1.profile, 'foot');
  assert.equal(payload1.distanceM, 1500);
  assert.equal(payload1.durationS, 901);
  assert.deepEqual(payload1.geometry, [
    [2.35, 48.85],
    [2.36, 48.86],
  ]);
  assert.equal(payload1.steps.length, 2);
  assert.match(
    calls[0].url,
    /^https:\/\/routing\.openstreetmap\.de\/routed-foot\/route\/v1\/foot\//,
  );
});

test('route direct answers invalid input without fetching', async () => {
  const { calls, fetchImpl } = stubFetch(() => jsonResponse(OSRM_FIXTURE));
  const source = createRouteDirectSource({ fetchImpl });
  const badProfile = await source.getRoute({
    mode: 'teleport',
    a: { lat: 0, lon: 0 },
    b: { lat: 0.01, lon: 0.01 },
  });
  assert.equal(badProfile.ok, false);
  const tooFar = await source.getRoute({
    mode: 'car',
    a: { lat: 0, lon: 0 },
    b: { lat: 0, lon: 10 },
  });
  assert.equal(tooFar.ok, false);
  assert.equal(calls.length, 0);
});

test('route direct reports no-route and rate limits like the legacy source', async () => {
  const noRoute = createRouteDirectSource({
    fetchImpl: stubFetch(() => jsonResponse({ code: 'NoRoute' })).fetchImpl,
  });
  assert.deepEqual(await noRoute.getRoute({
    mode: 'foot',
    a: { lat: 0, lon: 0 },
    b: { lat: 0.01, lon: 0.01 },
  }), { ok: false, error: 'no route found' });
  const limited = createRouteDirectSource({
    fetchImpl: stubFetch(() => jsonResponse({}, 429)).fetchImpl,
  });
  await assert.rejects(
    limited.getRoute({
      mode: 'foot',
      a: { lat: 0, lon: 0 },
      b: { lat: 0.01, lon: 0.01 },
    }),
    /rate limited/,
  );
});

test('route direct maps registry refusal to honest unavailable', async () => {
  const { fetchImpl } = stubFetch(() => {
    throw refusalError();
  });
  const source = createRouteDirectSource({ fetchImpl });
  const result = await source.getRoute({
    mode: 'foot',
    a: { lat: 0, lon: 0 },
    b: { lat: 0.01, lon: 0.01 },
  });
  assert.equal(result.ok, false);
  assert.equal(result.unavailable, 'UPSTREAM_NOT_ALLOWED');
});

test('route direct discards a late response after abort', async () => {
  await assertDiscardsLateResponse((fetchImpl, signal) =>
    createRouteDirectSource({ fetchImpl }).getRoute(
      { mode: 'foot', a: { lat: 0, lon: 0 }, b: { lat: 0.01, lon: 0.01 } },
      { signal },
    ),
  );
});

// ---------------------------------------------------------------------------
// staticFeedsDirect: fire perimeters
// ---------------------------------------------------------------------------

function wfigsFeature(id, name) {
  return {
    type: 'Feature',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [-122, 37],
          [-121, 37],
          [-121, 38],
          [-122, 38],
          [-122, 37],
        ],
      ],
    },
    properties: {
      poly_IncidentName: name,
      attr_UniqueFireIdentifier: id,
      attr_IncidentSize: 123.5,
      attr_PercentContained: 10,
      attr_POOState: 'CA-US',
    },
  };
}

test('fire perimeter direct normalizes WFIGS pages into layer rows', async () => {
  const { calls, fetchImpl } = stubFetch((url) => {
    if (url.includes('resultOffset=1')) {
      return jsonResponse({ features: [wfigsFeature('id-2', 'Second')] });
    }
    return jsonResponse({
      exceededTransferLimit: true,
      features: [wfigsFeature('id-1', 'First')],
    });
  });
  const source = createFirePerimeterDirectSource({ fetchImpl });
  const rows = await source.getSnapshot();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].stableId, 'id-1');
  assert.equal(rows[0].name, 'First');
  assert.equal(rows[0].acres, 123.5);
  assert.equal(rows[1].stableId, 'id-2');
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /^https:\/\/services3\.arcgis\.com\//);
});

test('fire perimeter direct rejects a non-collection without faking rows', async () => {
  const { fetchImpl } = stubFetch(() => jsonResponse({ features: null }));
  const source = createFirePerimeterDirectSource({ fetchImpl });
  await assert.rejects(source.getSnapshot(), /invalid_snapshot|Malformed/);
});

test('fire perimeter direct surfaces refusal as unavailable, never empty', async () => {
  const { fetchImpl } = stubFetch(() => {
    throw refusalError();
  });
  const source = createFirePerimeterDirectSource({ fetchImpl });
  await assert.rejects(source.getSnapshot(), (error) => {
    assert.equal(error.unavailable, 'UPSTREAM_NOT_ALLOWED');
    return true;
  });
});

test('fire perimeter direct discards a late response after abort', async () => {
  await assertDiscardsLateResponse((fetchImpl, signal) =>
    createFirePerimeterDirectSource({ fetchImpl }).getSnapshot({ signal }),
  );
});

// ---------------------------------------------------------------------------
// staticFeedsDirect: cyclones
// ---------------------------------------------------------------------------

const CYCLONE_NOW = Date.parse('2026-10-11T13:00:00.000Z');

function cycloneStatusFixture() {
  const issued = new Date(CYCLONE_NOW - 3_600_000).toISOString();
  return {
    activeStorms: [
      {
        id: 'al092026',
        name: 'Test Storm',
        classification: 'Hurricane',
        longitudeNumeric: -60.5,
        latitudeNumeric: 20.25,
        lastUpdate: issued,
        intensity: '100',
        pressure: '950',
        movementDir: '300',
        movementSpeed: '15',
        forecastAdvisory: {
          issuance: issued,
          advNum: '10',
          url: 'https://www.nhc.noaa.gov/text/MIATCMAT1.shtml',
        },
      },
    ],
  };
}

function cycloneGisFixture(kind) {
  const idp =
    kind === 'pts'
      ? 'AL092026-10_5day_pts'
      : kind === 'lin'
        ? 'AL092026-10_5day_lin'
        : 'AL092026-10_5day_pgn';
  const geometry =
    kind === 'pts'
      ? { type: 'Point', coordinates: [-60.5, 20.25] }
      : kind === 'lin'
        ? {
            type: 'LineString',
            coordinates: [
              [-60.5, 20.25],
              [-61, 21],
            ],
          }
        : {
            type: 'Polygon',
            coordinates: [
              [
                [-62, 19],
                [-59, 19],
                [-59, 22],
                [-62, 22],
                [-62, 19],
              ],
            ],
          };
  const properties =
    kind === 'pts'
      ? { idp_source: idp, advisnum: '10', tau: 12, maxwind: 100, gust: 120 }
      : { idp_source: idp, advisnum: '10' };
  return {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', properties, geometry }],
  };
}

function cycloneFetchImpl() {
  return stubFetch((url) => {
    if (url.includes('CurrentStorms.json')) {
      return jsonResponse(cycloneStatusFixture());
    }
    if (url.includes('/5/query')) return jsonResponse(cycloneGisFixture('pts'));
    if (url.includes('/6/query')) return jsonResponse(cycloneGisFixture('lin'));
    if (url.includes('/7/query')) return jsonResponse(cycloneGisFixture('pgn'));
    throw new Error(`unexpected cyclone url: ${url}`);
  });
}

test('cyclone direct builds a layer-valid snapshot with geometry', async () => {
  const { calls, fetchImpl } = cycloneFetchImpl();
  const source = createCycloneDirectSource({
    fetchImpl,
    now: () => CYCLONE_NOW,
  });
  const snapshot = await source.getSnapshot();
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.unavailable, false);
  assert.equal(snapshot.storms.length, 1);
  const storm = snapshot.storms[0];
  assert.equal(storm.id, 'al092026');
  assert.equal(storm.name, 'Test Storm');
  assert.equal(storm.geometryStatus, 'current');
  assert.equal(storm.forecastPoints.length, 1);
  assert.equal(storm.track.type, 'LineString');
  assert.equal(storm.cone.type, 'Polygon');
  assert.ok(calls.some((call) => call.url.includes('CurrentStorms.json')));
});

test('cyclone direct keeps status-only storms pending when GIS fails', async () => {
  const { fetchImpl } = stubFetch((url) => {
    if (url.includes('CurrentStorms.json')) {
      return jsonResponse(cycloneStatusFixture());
    }
    return jsonResponse({}, 500);
  });
  const source = createCycloneDirectSource({
    fetchImpl,
    now: () => CYCLONE_NOW,
  });
  const snapshot = await source.getSnapshot();
  assert.equal(snapshot.storms[0].geometryStatus, 'unavailable');
  assert.deepEqual(snapshot.storms[0].forecastPoints, []);
});

test('cyclone direct maps registry refusal to honest unavailable', async () => {
  const { fetchImpl } = stubFetch(() => {
    throw refusalError();
  });
  const source = createCycloneDirectSource({
    fetchImpl,
    now: () => CYCLONE_NOW,
  });
  const snapshot = await source.getSnapshot();
  assert.equal(snapshot.unavailable, 'UPSTREAM_NOT_ALLOWED');
  assert.deepEqual(snapshot.storms, []);
});

test('cyclone direct discards a late response after abort', async () => {
  await assertDiscardsLateResponse((fetchImpl, signal) =>
    createCycloneDirectSource({ fetchImpl, now: () => CYCLONE_NOW }).getSnapshot({
      signal,
    }),
  );
});

// ---------------------------------------------------------------------------
// staticFeedsDirect: gbfs
// ---------------------------------------------------------------------------

const GBFS_FIXTURE = {
  data: {
    stations: [{ station_id: '1', name: 'A', lat: 40.7, lon: -74 }],
  },
};

test('gbfs direct fetches the allowlisted upstream document itself', async () => {
  const { calls, fetchImpl } = stubFetch(() => jsonResponse(GBFS_FIXTURE));
  const source = createGbfsDirectSource({ fetchImpl });
  const url = 'https://gbfs.bluebikes.com/gbfs/en/station_information.json';
  const payload = await source.getStations(url);
  assert.deepEqual(payload, GBFS_FIXTURE);
  assert.equal(calls[0].url, url);
});

test('gbfs direct refuses non-allowlisted targets without fetching', async () => {
  const { calls, fetchImpl } = stubFetch(() => jsonResponse(GBFS_FIXTURE));
  const source = createGbfsDirectSource({ fetchImpl });
  await assert.rejects(
    source.getStations('https://evil.example.com/station_information.json'),
  );
  await assert.rejects(
    source.getStations(
      'http://gbfs.bluebikes.com/gbfs/en/station_information.json',
    ),
  );
  await assert.rejects(
    source.getStations(
      'https://gbfs.bluebikes.com/gbfs/en/stations.json',
    ),
    /station_information\/station_status/,
  );
  assert.equal(calls.length, 0);
});

test('gbfs direct maps registry refusal to honest unavailable', async () => {
  const { fetchImpl } = stubFetch(() => {
    throw refusalError();
  });
  const source = createGbfsDirectSource({ fetchImpl });
  assert.deepEqual(
    await source.getStations(
      'https://gbfs.bluebikes.com/gbfs/en/station_status.json',
    ),
    { unavailable: 'UPSTREAM_NOT_ALLOWED' },
  );
});

test('gbfs direct discards a late response after abort', async () => {
  await assertDiscardsLateResponse((fetchImpl, signal) =>
    createGbfsDirectSource({ fetchImpl }).getStations(
      'https://gbfs.bluebikes.com/gbfs/en/station_status.json',
      { signal },
    ),
  );
});

// ---------------------------------------------------------------------------
// staticFeedsDirect: radio
// ---------------------------------------------------------------------------

const RADIO_ROW_FIXTURE = {
  stationuuid: '12345678-1234-1234-1234-123456789012',
  name: 'Test FM',
  url_resolved: 'https://stream.example.com/live',
  url: 'http://stream.example.com/live',
  homepage: '',
  country: 'Testland',
  countrycode: 'TT',
  state: '',
  codec: 'MP3',
  bitrate: 128,
  lastcheckok: 1,
  hls: 0,
  geo_lat: 48.8,
  geo_long: 2.3,
  tags: 'news,talk',
  language: 'english',
  clickcount: 100,
};

test('radio direct returns the proxy-shaped directory with normalized stations', async () => {
  const { calls, fetchImpl } = stubFetch(() =>
    jsonResponse([RADIO_ROW_FIXTURE]),
  );
  const source = createRadioDirectSource({ fetchImpl });
  const directory = await source.getDirectory();
  assert.equal(directory.stations.length, 1);
  const station = directory.stations[0];
  assert.equal(station.id, '12345678-1234-1234-1234-123456789012');
  assert.equal(station.name, 'Test FM');
  assert.equal(station.lat, 48.8);
  assert.equal(station.lon, 2.3);
  assert.equal(station.streamUrl, 'https://stream.example.com/live');
  assert.equal(station.codec, 'MP3');
  assert.ok(directory.updatedAt);
  assert.match(
    calls[0].url,
    /^https:\/\/[a-z0-9-]+\.api\.radio-browser\.info\/json\/stations\/search\?/,
  );
});

test('radio direct fails over to the next mirror on outage', async () => {
  const { calls, fetchImpl } = stubFetch((url) => {
    if (url.startsWith('https://de1.')) return jsonResponse({}, 500);
    return jsonResponse([RADIO_ROW_FIXTURE]);
  });
  const source = createRadioDirectSource({ fetchImpl });
  const directory = await source.getDirectory();
  assert.equal(directory.stations.length, 1);
  assert.equal(calls.length, 2);
});

test('radio direct enforces single-level mirrors (tighter than the registry)', async () => {
  const { calls, fetchImpl } = stubFetch(() =>
    jsonResponse([RADIO_ROW_FIXTURE]),
  );
  assert.throws(
    () =>
      createRadioDirectSource({
        fetchImpl,
        mirrors: ['https://a.b.api.radio-browser.info'],
      }),
    /no usable.*mirror/i,
  );
  assert.equal(calls.length, 0);
  const filtered = createRadioDirectSource({
    fetchImpl,
    mirrors: [
      'https://a.b.api.radio-browser.info',
      'https://de1.api.radio-browser.info',
    ],
  });
  await filtered.getDirectory();
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /^https:\/\/de1\.api\.radio-browser\.info\//);
});

test('radio direct validates click ids and reports clicks best-effort', async () => {
  const { calls, fetchImpl } = stubFetch(() => new Response(null, { status: 200 }));
  const source = createRadioDirectSource({ fetchImpl });
  await source.recordClick('12345678-1234-1234-1234-123456789012');
  assert.match(
    calls[0].url,
    /\/json\/url\/12345678-1234-1234-1234-123456789012$/,
  );
  await assert.rejects(source.recordClick('not-a-uuid'));
  assert.equal(calls.length, 1);
});

test('radio direct maps registry refusal to honest unavailable', async () => {
  const { fetchImpl } = stubFetch(() => {
    throw refusalError();
  });
  const source = createRadioDirectSource({ fetchImpl });
  const directory = await source.getDirectory();
  assert.deepEqual(directory.stations, []);
  assert.equal(directory.unavailable, 'UPSTREAM_NOT_ALLOWED');
});

test('radio direct discards a late response after abort', async () => {
  await assertDiscardsLateResponse((fetchImpl, signal) =>
    createRadioDirectSource({ fetchImpl }).getDirectory({ signal }),
  );
});

// ---------------------------------------------------------------------------
// staticFeedsDirect: firms
// ---------------------------------------------------------------------------

const FIRMS_NOW = Date.parse('2026-10-12T00:30:00.000Z');
const FIRMS_CSV_FIXTURE =
  'latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,' +
  'instrument,confidence,version,bright_ti5,frp,daynight\n' +
  '34.05,-118.25,320.5,1.0,1.0,2026-10-11,1200,NOAA-20,VIIRS,h,1N,290.1,5.5,D\n' +
  '34.06,-118.26,321.5,1.0,1.0,2026-10-11,1200,NOAA-20,VIIRS,n,1N,291.1,6.5,D\n';

test('firms direct without a vault key is honestly unavailable (no fetch)', async () => {
  const { calls, fetchImpl } = stubFetch(() => textResponse(FIRMS_CSV_FIXTURE));
  const source = createFirmsDirectSource({
    fetchImpl,
    getKey: async () => null,
    now: () => FIRMS_NOW,
  });
  assert.deepEqual(await source.getSnapshot(), {
    unavailable: 'KEY_REQUIRED',
  });
  assert.equal(calls.length, 0);
});

test('firms direct merges the area feeds into the proxy snapshot shape', async () => {
  const { calls, fetchImpl } = stubFetch(() => textResponse(FIRMS_CSV_FIXTURE));
  const source = createFirmsDirectSource({
    fetchImpl,
    getKey: async () => 'test-map-key',
    now: () => FIRMS_NOW,
  });
  const snapshot = await source.getSnapshot();
  assert.ok(Array.isArray(snapshot.fires));
  assert.ok(snapshot.fires.length > 0);
  assert.equal(snapshot.count, snapshot.fires.length);
  assert.equal(snapshot.sources.length, 4);
  assert.ok(snapshot.fetchedAt);
  assert.match(
    calls[0].url,
    /^https:\/\/firms\.modaps\.eosdis\.nasa\.gov\/api\/area\/csv\//,
  );
  assert.ok(
    calls.every((call) => call.url.includes('test-map-key')),
    'MAP_KEY travels in the FIRMS path segment over HTTPS',
  );
  assert.ok(
    calls.every((call) => call.init.capBytes === 16 * 1024 * 1024),
    'world CSVs carry the 16 MiB server-parity cap so phones stop failing',
  );
});

test('firms direct skips error payloads and fails only when all fail', async () => {
  const { fetchImpl } = stubFetch(() => textResponse('Invalid MAP_KEY'));
  const source = createFirmsDirectSource({
    fetchImpl,
    getKey: async () => 'bad-key',
    now: () => FIRMS_NOW,
  });
  await assert.rejects(source.getSnapshot(), /all FIRMS sources failed/);
});

test('firms direct maps registry refusal to honest unavailable', async () => {
  const { fetchImpl } = stubFetch(() => {
    throw refusalError();
  });
  const source = createFirmsDirectSource({
    fetchImpl,
    getKey: async () => 'test-map-key',
    now: () => FIRMS_NOW,
  });
  assert.deepEqual(await source.getSnapshot(), {
    unavailable: 'UPSTREAM_NOT_ALLOWED',
  });
});

// ---------------------------------------------------------------------------
// tileFeedsDirect: mapillary
// ---------------------------------------------------------------------------

test('mapillary direct fetches tiles with the token (no proxy path)', async () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const { calls, fetchImpl } = stubFetch(() => bytesResponse(bytes));
  const source = createMapillaryDirectSource({
    fetchImpl,
    token: 'test-token',
  });
  const tile = await source.getTile('coverage', 14, 1, 2);
  assert.ok(tile instanceof Uint8Array);
  assert.deepEqual([...tile], [1, 2, 3, 4]);
  assert.match(
    calls[0].url,
    /^https:\/\/tiles\.mapillary\.com\/maps\/vtp\/mly1_public\/2\/14\/1\/2\?/,
  );
  assert.match(calls[0].url, /access_token=test-token/);
});

test('mapillary direct requires a token like the legacy source', async () => {
  const { calls, fetchImpl } = stubFetch(() => bytesResponse(new Uint8Array()));
  const source = createMapillaryDirectSource({ fetchImpl });
  assert.equal(source.hasToken(), false);
  await assert.rejects(source.getTile('coverage', 14, 1, 2), (error) => {
    assert.equal(error.keyRequired, true);
    return true;
  });
  assert.equal(calls.length, 0);
});

test('mapillary direct queries the graph API for nearby images', async () => {
  const { calls, fetchImpl } = stubFetch(() =>
    jsonResponse({ data: [{ id: 'img-1' }] }),
  );
  const source = createMapillaryDirectSource({
    fetchImpl,
    token: 'test-token',
  });
  const images = await source.nearestImages({ lat: 48.85, lon: 2.35 });
  assert.deepEqual(images, [{ id: 'img-1' }]);
  assert.match(
    calls[0].url,
    /^https:\/\/graph\.mapillary\.com\/images\?/,
  );
});

test('mapillary direct flags rejected tokens from graph errors', async () => {
  const { fetchImpl } = stubFetch(() => jsonResponse({ error: 'x' }, 403));
  const source = createMapillaryDirectSource({
    fetchImpl,
    token: 'stale-token',
  });
  await assert.rejects(source.nearestImages({ lat: 0, lon: 0 }), (error) => {
    assert.equal(error.keyRejected, true);
    return true;
  });
});

test('mapillary direct discards a late response after abort', async () => {
  await assertDiscardsLateResponse((fetchImpl, signal) =>
    createMapillaryDirectSource({ fetchImpl, token: 't' }).nearestImages(
      { lat: 0, lon: 0 },
      { signal },
    ),
  );
});

// ---------------------------------------------------------------------------
// tileFeedsDirect: terrain
// ---------------------------------------------------------------------------

test('terrain direct returns upstream heights for layer points', async () => {
  const results = [{ ellipsoid: 12.5, geoid: 30.1, elevation: 42.6 }];
  const { calls, fetchImpl } = stubFetch(() => jsonResponse({ results }));
  const source = createTerrainDirectSource({ fetchImpl });
  const heights = await source.getHeights([{ lat: 48.85, lon: 2.35 }]);
  assert.deepEqual(heights, results);
  assert.match(calls[0].url, /^https:\/\/terrain\.reearth\.land\/heights\.json\?/);
  assert.match(calls[0].url, /points=/);
});

test('terrain direct never retries a registry refusal', async () => {
  const { calls, fetchImpl } = stubFetch(() => {
    throw refusalError();
  });
  const source = createTerrainDirectSource({ fetchImpl });
  await assert.rejects(source.getHeights([{ lat: 0, lon: 0 }]), (error) => {
    assert.equal(error.code, 'UPSTREAM_NOT_ALLOWED');
    return true;
  });
  assert.equal(calls.length, 1);
});

test('terrain direct discards a late response after abort', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const fetchImpl = async () => {
    await gate;
    return jsonResponse({ results: [{ ellipsoid: 1 }] });
  };
  const controller = new AbortController();
  const source = createTerrainDirectSource({ fetchImpl });
  const pending = source.getHeights([{ lat: 0, lon: 0 }], {
    signal: controller.signal,
  });
  controller.abort();
  release();
  await assert.rejects(pending, (error) => {
    assert.equal(error.name, 'AbortError');
    return true;
  });
});

// ---------------------------------------------------------------------------
// localReceiversDirect
// ---------------------------------------------------------------------------

const DUMP1090_FIXTURE = {
  now: 1_790_000_000,
  aircraft: [
    {
      hex: 'abc123',
      flight: 'UAL123 ',
      lat: 37.7,
      lon: -122.4,
      alt_baro: 35000,
      gs: 450,
      track: 270,
      baro_rate: 0,
      category: 'A3',
      squawk: '1234',
      rssi: -20,
      seen: 1,
      messages: 100,
    },
  ],
};

test('local receivers read a LAN decoder feed into layer records', async () => {
  const { calls, fetchImpl } = stubFetch(() => jsonResponse(DUMP1090_FIXTURE));
  const source = createLocalReceiverDirectSource({
    fetchImpl,
    feeds: [{ band: '1090', url: 'http://192.168.1.10:8080/aircraft.json' }],
    now: () => 1_790_000_000_000,
  });
  const snapshot = await source.getSnapshot();
  assert.equal(snapshot.configured, true);
  assert.equal(snapshot.feeds.length, 1);
  assert.equal(snapshot.feeds[0].status, 'live');
  assert.equal(snapshot.records.length, 1);
  assert.equal(snapshot.records[0].icao, 'abc123');
  assert.equal(
    calls[0].url,
    'http://192.168.1.10:8080/aircraft.json',
  );
});

test('local receivers never fetch non-local or malformed feed targets', async () => {
  const { calls, fetchImpl } = stubFetch(() => jsonResponse(DUMP1090_FIXTURE));
  const source = createLocalReceiverDirectSource({
    fetchImpl,
    feeds: [
      { band: '1090', url: 'http://8.8.8.8/aircraft.json' },
      { band: '1090', url: 'http://192.168.1.10/other.json' },
      { band: '1090', url: 'http://192.168.1.10/aircraft.json?x=1' },
    ],
  });
  const snapshot = await source.getSnapshot();
  assert.equal(snapshot.configured, true);
  assert.ok(
    snapshot.feeds.every((feed) => feed.status === 'invalid'),
    'every bad feed is reported invalid',
  );
  assert.deepEqual(snapshot.records, []);
  assert.equal(calls.length, 0);
});

test('local receivers accept localhost and mDNS names via the tap rule', async () => {
  const { calls, fetchImpl } = stubFetch(() => jsonResponse(DUMP1090_FIXTURE));
  const source = createLocalReceiverDirectSource({
    fetchImpl,
    feeds: [
      { band: '978', url: 'http://piaware.local/aircraft.json' },
      { band: '1090', url: 'http://localhost:8080/aircraft.json' },
    ],
    now: () => 1_790_000_000_000,
  });
  const snapshot = await source.getSnapshot();
  assert.equal(snapshot.feeds.filter((f) => f.status !== 'invalid').length, 2);
  assert.equal(calls.length, 2);
});

test('local receiver registry overrides pin the validated LAN hosts', () => {
  const override = buildLocalReceiverRegistry([
    { band: '1090', url: 'http://192.168.1.10:8080/aircraft.json' },
    { band: '978', url: 'http://piaware.local/aircraft.json' },
  ]);
  assert.deepEqual(override.localReceivers.hosts, [
    '192.168.1.10',
    'piaware.local',
  ]);
  assert.ok(
    override.localReceivers.paths.some((rule) => rule.test('/aircraft.json')),
  );
});

test('local receivers discard a late response after abort', async () => {
  await assertDiscardsLateResponse((fetchImpl, signal) =>
    createLocalReceiverDirectSource({
      fetchImpl,
      feeds: [{ band: '1090', url: 'http://192.168.1.10/aircraft.json' }],
    }).getSnapshot({ signal }),
  );
});

// ---------------------------------------------------------------------------
// catalog composition: direct selection threading
// ---------------------------------------------------------------------------

test('standalone layer sources swap to direct adapters when asked', async () => {
  const { createStandaloneLayerSources } = await import(
    '../../standalone/layerSources.js'
  );
  const { fetchImpl } = stubFetch((url) => {
    if (url.includes('radio-browser')) return jsonResponse([RADIO_ROW_FIXTURE]);
    if (url.includes('open-meteo')) return jsonResponse(OPEN_METEO_FIXTURE);
    throw new Error(`unexpected direct url: ${url}`);
  });
  const sources = createStandaloneLayerSources(
    {},
    { direct: true, fetchImpl },
  );
  const directory = await sources.radio.getDirectory();
  assert.equal(directory.stations.length, 1);
  assert.equal(directory.stations[0].name, 'Test FM');
  const weather = await sources.weather.getSnapshot({ product: 'radar' });
  assert.equal(weather.unavailable, true);
});

test('standalone layer sources keep the legacy path unless direct', async () => {
  const { createStandaloneLayerSources } = await import(
    '../../standalone/layerSources.js'
  );
  const { calls, fetchImpl } = stubFetch(() =>
    jsonResponse({ stations: [], updatedAt: null }),
  );
  const sources = createStandaloneLayerSources(
    {},
    { direct: false, fetchImpl },
  );
  await sources.radio.getDirectory();
  assert.equal(calls[0].url, '/api/radio/stations');
});

test('standalone place search uses Nominatim direct when asked', async () => {
  const { createStandalonePlaceSearch } = await import(
    '../../standalone/placeSearch.js'
  );
  const { calls, fetchImpl } = stubFetch((url) => {
    if (url.includes('nominatim')) {
      return jsonResponse(NOMINATIM_SEARCH_FIXTURE);
    }
    throw new Error(`unexpected geocode url: ${url}`);
  });
  const search = createStandalonePlaceSearch({ direct: true, fetchImpl });
  const outcome = await search.geocode('Paris');
  assert.equal(outcome.answered, true);
  assert.ok(
    calls.some((call) => call.url.startsWith(NOMINATIM_SEARCH_ENDPOINT)),
    'Nominatim endpoint was consulted',
  );
});
