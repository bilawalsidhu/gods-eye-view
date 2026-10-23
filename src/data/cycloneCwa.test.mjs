import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  CWA_CYCLONE_API_URL,
  CWA_CYCLONE_DATASET_URL,
  fetchCwaCyclones,
  parseCwaCyclones,
  pruneCwaForecasts,
} from '../../server/providers/cycloneCwa.js';
import {
  cycloneProxy,
  mergeCycloneProviders,
} from '../../server/providers/cyclones.js';

const NOW = Date.parse('2026-10-23T06:30:00.000Z');
const SENT = '2026-10-23T14:26:05+08:00';
const KEY = 'cwa-test-key-never-return-this';
const CYCLE = '2026-10-23T14:00:00+08:00';

function fix(at, lon, lat, extra = {}) {
  return {
    DateTime: at,
    CoordinateLongitude: String(lon),
    CoordinateLatitude: String(lat),
    MaxWindSpeed: '30',
    MaxGustSpeed: '40',
    Pressure: '990',
    ...extra,
  };
}

function forecast(tau, lon, lat, extra = {}) {
  return {
    CoordinateTau: tau,
    CoordinateLongitude: String(lon),
    CoordinateLatitude: String(lat),
    MaxWindSpeed: '32',
    MaxGustSpeed: '44',
    Pressure: '985',
    RadiusOf70PercentProbability: {
      Radius: { '#text': '150', '@unit': 'km' },
    },
    ...extra,
  };
}

function product(overrides = {}) {
  return {
    cwaopendata: {
      Identifier: 'CWA-TropicalCyclone_20261023142605',
      Sender: 'CWA',
      Sent: SENT,
      Status: 'Actual',
      Dataset: {
        TropicalCyclones: {
          TropicalCyclone: [
            {
              Year: '2026',
              TyphoonName: 'CHAMPI',
              CwaTyphoonName: '香蒂',
              CwaTdNo: '01',
              CwaTyNo: '01',
              AnalysisData: {
                Fix: [
                  fix('2026-10-23T05:00:00+00:00', 120, 19),
                  fix('2026-10-23T06:00:00+00:00', 121.5, 20, {
                    MovingSpeed: '20',
                    MovingDirection: 'NNE',
                  }),
                ],
              },
              ForecastData: {
                InitTime: CYCLE,
                Fix: [
                  forecast(12, 124, 22),
                  forecast(24, 128, 25, {
                    RadiusOf70PercentProbability: { Radius: '220' },
                  }),
                ],
              },
            },
            {
              Year: '2026',
              TyphoonName: 'NANGKA',
              CwaTyphoonName: '浪卡',
              CwaTdNo: null,
              CwaTyNo: '02',
              AnalysisData: {
                Fix: [fix('2026-10-23T06:00:00+00:00', 179.2, 17)],
              },
              ForecastData: {
                Forecast: {
                  InitTime: CYCLE,
                  Fix: [forecast(6, -178.4, 18), forecast(12, -175, 19)],
                },
              },
            },
          ],
        },
      },
      ...overrides,
    },
  };
}

function apiProduct() {
  const cyclones = product().cwaopendata.Dataset.TropicalCyclones;
  const entries = cyclones.TropicalCyclone.map((storm) => {
    const nestedForecast = storm.ForecastData.Forecast;
    const forecastData = nestedForecast ?? storm.ForecastData;
    const initTime = forecastData.InitTime;
    const fixes = forecastData.Fix.map((point) => {
      const normalized = {
        ...point,
        InitialTime: initTime,
        ForecastHour: String(point.CoordinateTau),
      };
      const radius = point.RadiusOf70PercentProbability;
      if (radius) {
        normalized.Radius70PercentProbability =
          radius.Radius['#text'] ?? radius.Radius;
      }
      delete normalized.CoordinateTau;
      delete normalized.RadiusOf70PercentProbability;
      return normalized;
    });
    return { ...storm, ForecastData: { Fix: fixes } };
  });
  return {
    success: 'true',
    result: { resource_id: 'W-C0034-005' },
    records: {
      dataid: 'C0034-005',
      TropicalCyclones: { TropicalCyclone: entries },
    },
  };
}

test('CWA Open Data API envelope normalizes its live field names and forecast cycle', () => {
  const storms = parseCwaCyclones(apiProduct(), NOW);
  assert.equal(storms.length, 2);
  const champi = storms[0];
  assert.equal(champi.name, 'CHAMPI');
  assert.equal(champi.positionAt, '2026-10-23T06:00:00.000Z');
  assert.equal(champi.issuedAt, '2026-10-23T06:00:00.000Z');
  assert.equal(champi.forecastPoints[0].validAt, '2026-10-23T18:00:00.000Z');
  assert.equal(champi.forecastPoints[0].tauHours, 12);
  assert.equal(champi.forecastPoints[0].probabilityRadiusKm, 150);
  assert.equal(champi.forecastPoints[1].probabilityRadiusKm, 220);
  assert.equal(champi.cycleId, `cwa-2026-td1:${champi.issuedAt}`);
});

test('CWA analysis and dated future forecasts preserve source cycles, units, and positions', () => {
  const storms = parseCwaCyclones(product(), NOW);
  assert.equal(storms.length, 2);
  const taiwan = storms[0];
  assert.equal(taiwan.id, 'cwa-2026-td1');
  assert.equal(taiwan.name, 'CHAMPI');
  assert.equal(taiwan.basin, 'WP');
  assert.equal(taiwan.source, 'Taiwan Central Weather Administration (CWA)');
  assert.equal(taiwan.sourceUrl, CWA_CYCLONE_DATASET_URL);
  assert.equal(
    taiwan.advisoryId,
    'CWA-TropicalCyclone_20261023142605:cwa-2026-td1',
  );
  assert.equal(taiwan.issuedAt, '2026-10-23T06:26:05.000Z');
  assert.equal(taiwan.positionAt, '2026-10-23T06:00:00.000Z');
  assert.deepEqual(taiwan.position, { longitude: 121.5, latitude: 20 });
  assert.equal(taiwan.windMs, 30);
  assert.equal(taiwan.windKt, null, 'CWA m/s must not be relabeled as knots');
  assert.equal(taiwan.windAveragingMinutes, null);
  assert.equal(taiwan.movement.speedKmh, 20);
  assert.equal(taiwan.forecastPoints[0].validAt, '2026-10-23T18:00:00.000Z');
  assert.equal(taiwan.forecastPoints[0].tauHours, 12);
  assert.equal(taiwan.forecastPoints[0].probabilityRadiusKm, 150);
  assert.equal(taiwan.cone, null);
  assert.equal(taiwan.coneStatus, 'not_provided');
  assert.equal(taiwan.geometryCycleId, taiwan.cycleId);
  assert.equal(taiwan.track.type, 'LineString');
  assert.equal(storms[1].id, 'cwa-2026-ty2');
  assert.equal(storms[1].track.type, 'MultiLineString');
  for (const part of storms[1].track.coordinates)
    for (let i = 1; i < part.length; i++)
      assert.ok(Math.abs(part[i][0] - part[i - 1][0]) <= 180);
});

test('CWA analysis timestamps reject impossible calendar dates and preserve valid leap days and offsets', () => {
  const cases = [
    {
      at: '2026-02-29T14:00:00+08:00',
      now: Date.parse('2026-03-01T06:00:00.000Z'),
      valid: false,
    },
    {
      at: '2026-04-31T14:00:00+08:00',
      now: Date.parse('2026-05-01T06:00:00.000Z'),
      valid: false,
    },
    {
      at: '2024-02-29T14:00:00+08:00',
      now: Date.parse('2024-02-29T06:00:00.000Z'),
      valid: true,
      expected: '2024-02-29T06:00:00.000Z',
    },
    {
      at: '2026-05-01T14:00:00+08:00',
      now: Date.parse('2026-05-01T06:00:00.000Z'),
      valid: true,
      expected: '2026-05-01T06:00:00.000Z',
    },
  ];

  for (const scenario of cases) {
    const value = structuredClone(product());
    const root = value.cwaopendata;
    root.Sent = new Date(scenario.now).toISOString();
    const [storm] = root.Dataset.TropicalCyclones.TropicalCyclone;
    root.Dataset.TropicalCyclones.TropicalCyclone = [storm];
    storm.AnalysisData.Fix = [fix(scenario.at, 121.5, 20)];
    delete storm.ForecastData;

    if (scenario.valid) {
      const [parsed] = parseCwaCyclones(value, scenario.now);
      assert.equal(parsed.positionAt, scenario.expected);
    } else {
      assert.throws(() => parseCwaCyclones(value, scenario.now));
    }
  }
});

test('provider merge uses stable ids, keeps NOAA priority on an identity match, and ignores name collisions', () => {
  const nhc = { id: 'shared-id', provider: 'nhc', name: 'CHAMPI' };
  const duplicate = { id: 'shared-id', provider: 'cwa', name: 'CHAMPI' };
  const sameName = { id: 'cwa-2026-td2', provider: 'cwa', name: 'CHAMPI' };
  assert.deepEqual(mergeCycloneProviders([nhc], [duplicate, sameName]), [
    nhc,
    sameName,
  ]);
});

test('two CWA storms with the same name retain distinct source ids', () => {
  const value = product();
  value.cwaopendata.Dataset.TropicalCyclones.TropicalCyclone[1].TyphoonName =
    'CHAMPI';
  const storms = parseCwaCyclones(value, NOW);
  assert.equal(storms.filter((storm) => storm.name === 'CHAMPI').length, 2);
  assert.notEqual(storms[0].id, storms[1].id);
});

test('CWA keeps a valid current marker when future positions are absent or expire', () => {
  const value = product();
  value.cwaopendata.Dataset.TropicalCyclones.TropicalCyclone[0].ForecastData =
    {};
  const [withoutForecast] = parseCwaCyclones(value, NOW);
  assert.deepEqual(withoutForecast.position, {
    longitude: 121.5,
    latitude: 20,
  });
  assert.equal(withoutForecast.geometryStatus, 'unavailable');
  assert.equal(withoutForecast.track, null);
  assert.deepEqual(withoutForecast.forecastPoints, []);

  const [current] = parseCwaCyclones(product(), NOW);
  const pruned = pruneCwaForecasts(
    [current],
    Date.parse('2026-10-23T17:00:00Z'),
  )[0];
  assert.equal(pruned.forecastPoints.length, 2);
  assert.equal(pruned.forecastPoints[0].validAt, '2026-10-23T18:00:00.000Z');
  const expiringProduct = product();
  expiringProduct.cwaopendata.Dataset.TropicalCyclones.TropicalCyclone[0].ForecastData.Fix =
    [forecast(6, 123, 21)];
  const [expiring] = parseCwaCyclones(expiringProduct, NOW);
  const expired = pruneCwaForecasts(
    [expiring],
    Date.parse('2026-10-23T17:00:00Z'),
  )[0];
  assert.equal(expired.geometryStatus, 'unavailable');
  assert.equal(expired.track, null);
  assert.deepEqual(expired.forecastPoints, []);
});

test('CWA parser rejects stale, future, timezone-free, mixed-cycle, and invalid-coordinate products', () => {
  const cases = [
    { status: 'Test' },
    { sent: '2026-10-24T14:26:05+08:00' },
    { sent: '2026-10-23T14:26:05' },
    { coordinate: 181 },
    { mixedCycle: true },
    { unit: true },
  ];
  for (const change of cases) {
    const value = product();
    if (change.status) value.cwaopendata.Status = change.status;
    if (change.sent) value.cwaopendata.Sent = change.sent;
    if (change.coordinate)
      value.cwaopendata.Dataset.TropicalCyclones.TropicalCyclone[0].ForecastData.Fix[0].CoordinateLongitude =
        '361';
    if (change.mixedCycle)
      value.cwaopendata.Dataset.TropicalCyclones.TropicalCyclone[0].ForecastData.Fix[1].InitTime =
        '2026-10-23T15:00:00+08:00';
    if (change.unit)
      value.cwaopendata.Dataset.TropicalCyclones.TropicalCyclone[0].ForecastData.Fix[0].RadiusOf70PercentProbability.Radius[
        '@unit'
      ] = 'nmi';
    assert.throws(
      () => parseCwaCyclones(value, NOW),
      /invalid_cwa_cyclone_data/,
    );
  }

  const old = product();
  old.cwaopendata.Dataset.TropicalCyclones.TropicalCyclone[0].AnalysisData.Fix =
    [fix('2026-10-22T17:59:00+00:00', 121, 20)];
  assert.throws(() => parseCwaCyclones(old, NOW), /invalid_cwa_cyclone_data/);
});

test('CWA fetch uses a fixed endpoint, server Authorization header, timeout, cap, and sanitized errors', async () => {
  const calls = [];
  const fetched = await fetchCwaCyclones({
    apiKey: KEY,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return Response.json(apiProduct());
    },
    now: () => NOW,
  });
  assert.equal(fetched.configured, true);
  assert.equal(calls[0].url, CWA_CYCLONE_API_URL);
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.headers.Authorization, KEY);
  assert.equal(calls[0].options.headers.Accept, 'application/json');
  assert.equal(
    await fetchCwaCyclones({ apiKey: '' }).then((x) => x.configured),
    false,
  );
  await assert.rejects(
    fetchCwaCyclones({
      apiKey: KEY,
      maxBytes: 10,
      fetchImpl: async () => new Response(JSON.stringify(product())),
    }),
    /too large/,
  );
  await assert.rejects(
    fetchCwaCyclones({
      apiKey: KEY,
      fetchImpl: async () =>
        new Response('private upstream detail', { status: 429 }),
    }),
    (error) =>
      !error.message.includes(KEY) && !error.message.includes('private'),
  );
  let requestSignal;
  const timeout = fetchCwaCyclones({
    apiKey: KEY,
    timeoutMs: 5,
    fetchImpl: async (_url, options) => {
      requestSignal = options.signal;
      return new Promise((_, reject) =>
        requestSignal.addEventListener(
          'abort',
          () => reject(requestSignal.reason),
          {
            once: true,
          },
        ),
      );
    },
  });
  await assert.rejects(timeout);
  assert.equal(requestSignal.aborted, true);
});

function serveCycloneProxy(options) {
  let handler;
  cycloneProxy({ now: () => NOW, ...options }).configureServer({
    middlewares: {
      use(route, next) {
        assert.equal(route, '/api/cyclones');
        handler = next;
      },
    },
  });
  return async (headers = {}) => {
    const response = new EventEmitter();
    response.writeHead = (status, headers) => {
      response.statusCode = status;
      response.headers = headers;
    };
    response.setHeader = (name, value) => {
      response.headers ||= {};
      response.headers[name] = value;
    };
    response.end = (body) => {
      response.body = body;
    };
    await handler({ url: '/', method: 'GET', headers, socket: {} }, response);
    return { ...response, json: JSON.parse(response.body) };
  };
}

test('the shared cyclone endpoint merges configured CWA forecasts and keeps NOAA keyless', async () => {
  const calls = [];
  const request = serveCycloneProxy({
    cwaApiKey: KEY,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url === CWA_CYCLONE_API_URL) return Response.json(apiProduct());
      if (url.includes('CurrentStorms.json'))
        return Response.json({ activeStorms: [] });
      throw new Error('unexpected provider request');
    },
  });
  const refused = await request({ 'sec-fetch-site': 'cross-site' });
  assert.equal(refused.statusCode, 403);
  assert.equal(
    calls.length,
    0,
    'cross-site requests do not reach either provider',
  );
  const response = await request();
  assert.equal(response.statusCode, 200);
  assert.equal(response.json.unavailable, false);
  assert.equal(response.json.partial, false);
  assert.deepEqual(response.json.providers, {
    nhc: 'available',
    cwa: 'available',
  });
  assert.equal(response.json.storms.length, 2);
  assert.equal(response.json.storms[0].provider, 'cwa');
  assert.equal(
    response.json.storms[0].forecastPoints[0].validAt,
    '2026-10-23T18:00:00.000Z',
  );
  assert.doesNotMatch(JSON.stringify(response.json), new RegExp(KEY));
  assert.equal(
    calls.some((call) => call.url.includes('CurrentStorms.json')),
    true,
  );
  assert.equal(
    calls.find((call) => call.url === CWA_CYCLONE_API_URL).options.headers
      .Authorization,
    KEY,
  );
  await request();
  assert.equal(calls.length, 2, 'five-minute shared cache serves both sources');
});

test('a configured CWA outage is partial and does not erase NOAA storm data', async () => {
  const nhcStatus = {
    activeStorms: [
      {
        id: 'ep152026',
        name: 'Fifteen-E',
        classification: 'TS',
        intensity: '35',
        pressure: '1000',
        longitudeNumeric: -125.8,
        latitudeNumeric: 15.5,
        movementDir: 255,
        movementSpeed: 12,
        lastUpdate: '2026-10-23T06:00:00Z',
        forecastAdvisory: {
          advNum: '010',
          issuance: '2026-10-23T06:00:00Z',
          url: 'https://www.nhc.noaa.gov/text/MIATCMEP5.shtml',
        },
      },
    ],
  };
  const shapes = [
    { type: 'Point', coordinates: [-125.8, 15.5] },
    {
      type: 'LineString',
      coordinates: [
        [-125.8, 15.5],
        [-128, 15],
      ],
    },
    {
      type: 'Polygon',
      coordinates: [
        [
          [-126, 15],
          [-128, 15],
          [-127, 17],
          [-126, 15],
        ],
      ],
    },
  ];
  const request = serveCycloneProxy({
    cwaApiKey: KEY,
    fetchImpl: async (url) => {
      if (url === CWA_CYCLONE_API_URL)
        return new Response('private CWA detail', { status: 503 });
      if (url.includes('CurrentStorms.json')) return Response.json(nhcStatus);
      const index = Number(url.match(/\/(\d)\/query/)[1]) - 5;
      return Response.json({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: {
              idp_source: `ep152026-010_5day_${['pts', 'lin', 'pgn'][index]}`,
              advisnum: '10',
              tau: index === 0 ? 0 : undefined,
              maxwind: 35,
              gust: 45,
            },
            geometry: shapes[index],
          },
        ],
      });
    },
  });
  const response = await request();
  assert.equal(response.json.partial, true);
  assert.equal(response.json.unavailable, false);
  assert.equal(response.json.providers.cwa, 'unavailable');
  assert.equal(response.json.storms.length, 1);
  assert.equal(response.json.storms[0].id, 'ep152026');
  assert.doesNotMatch(
    JSON.stringify(response.json),
    /private CWA detail|cwa-test-key/,
  );
});

test('last-good CWA data is retained with a stale marker during an outage', async () => {
  let clock = NOW;
  let cwaDown = false;
  const request = serveCycloneProxy({
    now: () => clock,
    cwaApiKey: KEY,
    fetchImpl: async (url) => {
      if (url === CWA_CYCLONE_API_URL)
        return cwaDown
          ? new Response('private CWA detail', { status: 503 })
          : Response.json(apiProduct());
      if (url.includes('CurrentStorms.json'))
        return Response.json({ activeStorms: [] });
      throw new Error('unexpected provider request');
    },
  });
  const fresh = await request();
  assert.equal(fresh.json.stale, false);
  clock += 300_001;
  cwaDown = true;
  const stale = await request();
  assert.equal(stale.json.stale, true);
  assert.equal(stale.json.partial, true);
  assert.equal(stale.json.providers.cwa, 'degraded');
  assert.equal(stale.json.storms.length, 2);
  assert.equal(stale.json.storms[0].forecastPoints.length, 2);
  assert.doesNotMatch(
    JSON.stringify(stale.json),
    /private CWA detail|cwa-test-key/,
  );
});
