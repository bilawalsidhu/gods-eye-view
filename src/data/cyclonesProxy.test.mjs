import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  cycloneProxy,
  parseCycloneStatus,
  attachCycloneGeometry,
} from '../../server/providers/cyclones.js';

const NOW = Date.UTC(2026, 8, 16, 3, 35);
const TIME = '2026-09-16T03:00:00.000Z';
function status(overrides = {}) {
  return {
    activeStorms: [
      {
        id: 'ep152026',
        name: 'Fifteen-E',
        classification: 'PTC',
        intensity: '25',
        pressure: '1006',
        longitudeNumeric: -125.8,
        latitudeNumeric: 15.5,
        movementDir: 255,
        movementSpeed: 12,
        lastUpdate: TIME,
        forecastAdvisory: {
          advNum: '010',
          issuance: TIME,
          url: 'https://www.nhc.noaa.gov/text/MIATCMEP5.shtml',
        },
        ...overrides,
      },
    ],
  };
}
function collections(adv = '10') {
  const geometry = [
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
  return geometry.map((shape, index) => ({
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {
          idp_source: `ep152026-${adv.padStart(3, '0')}_5day_${['pts', 'lin', 'pgn'][index]}`,
          advisnum: adv,
          tau: 0,
          maxwind: 25,
          gust: 9999,
        },
        geometry: shape,
      },
    ],
  }));
}
function install(options = {}, preview = false) {
  let handler;
  const plugin = cycloneProxy({ now: () => NOW, ...options });
  plugin[preview ? 'configurePreviewServer' : 'configureServer']({
    middlewares: {
      use(path, callback) {
        assert.equal(path, '/api/cyclones');
        handler = callback;
      },
    },
  });
  const begin = (url = '/', method = 'GET') => {
    const res = new EventEmitter();
    res.writeHead = (code, headers) => {
      res.statusCode = code;
      res.headers = headers;
    };
    res.end = (body) => {
      res.body = body;
    };
    return { res, done: handler({ url, method }, res).then(() => res) };
  };
  return { begin, request: (url, method) => begin(url, method).done };
}
const body = (res) => JSON.parse(res.body);
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));
function fetcher(calls = [], data = status(), parts = collections()) {
  return async (url, options) => {
    calls.push({ url: new URL(url), options });
    return Response.json(
      url.includes('CurrentStorms')
        ? data
        : parts[Number(url.match(/\/(\d)\/query/)[1]) - 5],
    );
  };
}

test('status retains official clocks, knots, source links and finite current position', () => {
  const storm = parseCycloneStatus(status(), NOW)[0];
  assert.equal(storm.advisoryNumber, '10');
  assert.equal(storm.issuedAt, TIME);
  assert.equal(storm.positionAt, TIME);
  assert.deepEqual(storm.position, { longitude: -125.8, latitude: 15.5 });
  assert.deepEqual(storm.movement, { directionDegrees: 255, speedKt: 12 });
  assert.equal(storm.windKt, 25);
  assert.equal(storm.pressureHpa, 1006);
  assert.match(storm.advisoryUrl, /^https:\/\/www\.nhc\.noaa\.gov\/text\//);
  const missing = parseCycloneStatus(
    status({ intensity: '9999', pressure: null, movementSpeed: '' }),
    NOW,
  )[0];
  assert.equal(missing.windKt, null);
  assert.equal(missing.pressureHpa, null);
  assert.equal(missing.movement.speedKt, null);
  assert.equal(
    parseCycloneStatus(
      status({
        forecastAdvisory: {
          advNum: '10',
          issuance: TIME,
          url: 'https://www.nhc.noaa.gov.evil/secret',
        },
      }),
      NOW,
    )[0].advisoryUrl,
    null,
  );
});

test('malformed, duplicate, oversized, future and expired status is rejected rather than reported empty', () => {
  for (const payload of [
    {},
    { activeStorms: null },
    { activeStorms: Array(33).fill(status().activeStorms[0]) },
    { activeStorms: [...status().activeStorms, ...status().activeStorms] },
    status({ id: 'wp012026' }),
    status({ name: 'a'.repeat(81) }),
    status({ name: '<script>' }),
    status({ longitudeNumeric: Infinity }),
    status({ latitudeNumeric: 91 }),
    status({ lastUpdate: '2026-09-17T00:00:00.000Z' }),
    status({ lastUpdate: '2026-02-30T00:00:00.000Z' }),
    status({
      forecastAdvisory: { advNum: '10', issuance: '2026-09-15T03:00:00.000Z' },
    }),
  ])
    assert.throws(() => parseCycloneStatus(payload, NOW));
  assert.deepEqual(parseCycloneStatus({ activeStorms: [] }, NOW), []);
});

test('coherent geometry is retained with holes/dateline while older advisory geometry is omitted', () => {
  const storms = parseCycloneStatus(status(), NOW);
  const parts = collections();
  parts[1].features[0].geometry.coordinates = [
    [179, 15],
    [-179, 16],
  ];
  parts[2].features[0].geometry.coordinates.push([
    [-126.5, 15.5],
    [-127, 15.5],
    [-126.8, 16],
    [-126.5, 15.5],
  ]);
  const good = attachCycloneGeometry(storms, parts)[0];
  assert.equal(good.geometryStatus, 'current');
  assert.equal(good.geometryAdvisoryNumber, '10');
  assert.deepEqual(good.track, parts[1].features[0].geometry);
  assert.equal(good.cone.coordinates.length, 2);
  assert.equal(good.forecastPoints[0].gustKt, null);
  assert.equal(good.forecastPoints[0].tauHours, 0);
  assert.equal(
    'validAt' in good.forecastPoints[0],
    false,
    'do not fabricate point time from advisory + tau',
  );
  const old = attachCycloneGeometry(storms, collections('9'))[0];
  assert.equal(old.geometryStatus, 'pending');
  assert.equal(old.track, null);
  assert.equal(old.cone, null);
  assert.deepEqual(old.forecastPoints, []);
  assert.deepEqual(old.position, storms[0].position);
  const mixed = collections();
  mixed[2] = collections('9')[2];
  const partial = attachCycloneGeometry(storms, mixed)[0];
  assert.equal(partial.geometryStatus, 'pending');
  assert.equal(
    partial.track,
    null,
    'a new track and old cone cannot form one advisory snapshot',
  );
});

test('geometry rejects transfer truncation, duplicate tracks, invalid coordinates and structural budgets', () => {
  const storms = parseCycloneStatus(status(), NOW);
  const mutations = [
    (p) => {
      p[0].exceededTransferLimit = true;
    },
    (p) => {
      p[0].features = Array(501).fill(p[0].features[0]);
    },
    (p) => {
      p[1].features.push(p[1].features[0]);
    },
    (p) => {
      p[0].features.push(p[0].features[0]);
    },
    (p) => {
      p[0].features[0].properties.idp_source = 'ep152026-009_5day_pts';
    },
    (p) => {
      p[1].features[0].geometry.coordinates[1] = [181, 1];
    },
    (p) => {
      p[2].features[0].geometry.coordinates[0].pop();
    },
    (p) => {
      p[1].features[0].geometry.coordinates = Array(10001).fill([0, 0]);
    },
    (p) => {
      p[1].features[0].geometry = {
        type: 'MultiLineString',
        coordinates: Array.from({ length: 3 }, () => Array(9000).fill([0, 0])),
      };
    },
    (p) => {
      p[2].features[0].geometry = {
        type: 'GeometryCollection',
        geometries: [],
      };
    },
  ];
  for (const mutate of mutations) {
    const parts = collections();
    mutate(parts);
    assert.throws(() => attachCycloneGeometry(storms, parts));
  }
});

test('dev and preview serve only fixed bounded NOAA queries, caching a complete snapshot', async () => {
  for (const preview of [false, true]) {
    const calls = [];
    const { request } = install({ fetchImpl: fetcher(calls) }, preview);
    const snapshot = body(await request());
    assert.equal(snapshot.unavailable, false);
    assert.equal(snapshot.stale, false);
    assert.match(snapshot.coverage, /not worldwide/);
    assert.equal(snapshot.storms[0].geometryStatus, 'current');
    assert.equal(snapshot.fetchedAt, NOW);
    assert.equal(calls.length, 4);
    assert.equal(
      calls[0].url.href,
      'https://www.nhc.noaa.gov/CurrentStorms.json',
    );
    for (const call of calls) assert.equal(call.options.redirect, 'error');
    for (const call of calls.slice(1)) {
      assert.equal(call.url.origin, 'https://mapservices.weather.noaa.gov');
      assert.equal(call.url.searchParams.get('outSR'), '4326');
      assert.equal(call.url.searchParams.get('f'), 'geojson');
      assert.notEqual(call.url.searchParams.get('outFields'), '*');
    }
    assert.equal(
      calls[2].url.searchParams.get('outFields'),
      'idp_source,advisnum',
    );
    assert.deepEqual(body(await request()), snapshot);
    assert.equal(calls.length, 4);
  }
});

test('query/method rejection cannot redirect or widen provider work', async () => {
  let calls = 0;
  const { request } = install({
    fetchImpl: async () => {
      calls++;
      throw new Error('unexpected');
    },
  });
  for (const url of [
    '/?url=https://evil',
    '/?storm=ep152026',
    '/other',
    '/?bbox=0,0,1,1',
  ])
    assert.equal((await request(url)).statusCode, 400);
  assert.equal((await request('/', 'POST')).statusCode, 405);
  assert.equal(calls, 0);
});

test('confirmed empty status skips GIS; broken GIS keeps honest current positions', async () => {
  const calls = [];
  const empty = install({ fetchImpl: fetcher(calls, { activeStorms: [] }) });
  assert.deepEqual(body(await empty.request()).storms, []);
  assert.equal(body(await empty.request()).unavailable, false);
  assert.equal(calls.length, 1);
  const broken = install({
    fetchImpl: async (url) =>
      url.includes('CurrentStorms')
        ? Response.json(status())
        : new Response('secret detail', { status: 503 }),
  });
  const snapshot = body(await broken.request());
  assert.equal(snapshot.unavailable, false);
  assert.equal(snapshot.storms[0].geometryStatus, 'unavailable');
  assert.equal(snapshot.storms[0].track, null);
  assert.doesNotMatch(JSON.stringify(snapshot), /secret/);
});

test('five-minute TTL, failure cooldown and age-limited last-good retain original advisory/fetch clocks', async () => {
  let clock = NOW;
  let fail = false;
  let calls = 0;
  const good = fetcher();
  const { request } = install({
    now: () => clock,
    fetchImpl: async (...args) => {
      calls++;
      if (fail) throw new Error('private');
      return good(...args);
    },
  });
  await request();
  clock += 299_000;
  await request();
  assert.equal(calls, 4);
  fail = true;
  clock += 2000;
  const stale = body(await request());
  assert.equal(stale.stale, true);
  assert.equal(stale.fetchedAt, NOW);
  assert.equal(stale.storms[0].issuedAt, TIME);
  await request();
  assert.equal(calls, 5);
  clock += 12 * 3600_000;
  const expired = body(await request());
  assert.equal(expired.unavailable, true);
  assert.deepEqual(expired.storms, []);
});

test('shared refresh survives one disconnect and aborts when its last consumer leaves', async () => {
  let release;
  let signal;
  const good = fetcher();
  const { begin } = install({
    fetchImpl: async (url, options) => {
      if (url.includes('CurrentStorms')) {
        signal = options.signal;
        await new Promise((resolve, reject) => {
          release = resolve;
          signal.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        });
      }
      return good(url, options);
    },
  });
  const a = begin();
  const b = begin();
  await nextTurn();
  a.res.emit('close');
  await a.done;
  assert.equal(signal.aborted, false);
  assert.equal(a.res.body, undefined);
  release();
  assert.equal(body(await b.done).unavailable, false);
  let calls = 0;
  const cancel = install({
    fetchImpl: async (url, options) => {
      calls++;
      if (calls > 1) return good(url, options);
      signal = options.signal;
      return new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        }),
      );
    },
  });
  const c = cancel.begin();
  await nextTurn();
  c.res.emit('close');
  await c.done;
  assert.equal(signal.aborted, true);
  assert.equal(
    body(await cancel.request()).unavailable,
    false,
    'cancellation does not impose upstream failure cooldown',
  );
});

test('stream caps and whole refresh deadline cancel oversized or stalled response bodies', async () => {
  for (const stalled of [false, true]) {
    let cancelled = false;
    const { request } = install({
      timeoutMs: 15,
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(stalled ? 4 : 128 * 1024 + 1));
            },
            cancel() {
              cancelled = true;
            },
          }),
        ),
    });
    const snapshot = body(await request());
    assert.equal(snapshot.unavailable, true);
    assert.equal(cancelled, true);
  }
});

test('shared refresh caps waiting consumers and rejects redirects without exposing upstream errors', async () => {
  let release;
  const good = fetcher();
  const { request } = install({
    fetchImpl: async (url, options) => {
      if (url.includes('CurrentStorms'))
        await new Promise((resolve) => {
          release = resolve;
        });
      return good(url, options);
    },
  });
  const waiting = Array.from({ length: 32 }, () => request());
  await nextTurn();
  assert.equal((await request()).statusCode, 429);
  release();
  assert.ok((await Promise.all(waiting)).every((r) => r.statusCode === 200));
  const redirected = install({
    fetchImpl: async () =>
      new Response('private', {
        status: 302,
        headers: { Location: 'http://127.0.0.1/' },
      }),
  });
  assert.equal(body(await redirected.request()).unavailable, true);
});
