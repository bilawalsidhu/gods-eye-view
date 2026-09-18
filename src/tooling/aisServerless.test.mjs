import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AIS_AUTH_FAILED_ERROR,
  AIS_EMPTY_SCENE_MESSAGE,
  AIS_NO_BBOX_MESSAGE,
  AISHUB_DEGRADED_ERROR,
  aisServerlessProxy,
  aisStreamSubscription,
  bboxKey,
  createAisServerlessService,
  parseBboxParam,
  roundBbox,
  sceneBboxFromQuery,
} from '../../server/providers/vessels/ais-serverless.js';
import {
  DEMO_REPLAY_AREA,
  DEMO_REPLAY_EMPTY_MESSAGE,
  DEMO_REPLAY_ERROR,
  DEMO_REPLAY_FLEET,
  DEMO_REPLAY_SOURCE,
  DEMO_REPLAY_TYPE,
  demoReplayRows,
  demoReplayTrack,
} from '../../server/providers/vessels/ais-demo-replay.js';
import {
  createKvStore,
  kvConfigFromEnv,
} from '../../server/providers/vessels/kv-store.js';
import { createLastGoodStore } from '../../server/providers/common/upstream.js';
import { createAisStreamSource } from '../../src/sources/live/standalone.js';

const GALVESTON = { lamin: 28.9, lomin: -95.5, lamax: 29.9, lomax: -94.0 };
const AUSTIN = { lamin: 28.77, lomin: -99.24, lamax: 31.77, lomax: -96.24 };
const EDGE_CACHE_CONTROL =
  'public, max-age=0, s-maxage=30, stale-while-revalidate=60';
const NO_KEY_ENV = Object.freeze({});

/** Mount a plugin on a fake Connect server and return a request helper. */
function install(plugin) {
  const routes = new Map();
  plugin.configureServer({
    middlewares: {
      use(route, handler) {
        routes.set(route, handler);
      },
    },
  });
  return async (url = '/', route = '/api/ais-live') => {
    assert.ok(routes.has(route), `registered route: ${route}`);
    const response = {
      statusCode: 200,
      headers: {},
      setHeader(key, value) {
        this.headers[key.toLowerCase()] = value;
      },
      end(body) {
        this.body = body;
      },
    };
    await routes.get(route)({ url, method: 'GET' }, response);
    response.json = response.body ? JSON.parse(response.body) : null;
    return response;
  };
}

const positionReport = (mmsi, lat, lon, secondsAgo = 5) => ({
  MessageType: 'PositionReport',
  MetaData: {
    MMSI: mmsi,
    ShipName: `SHIP ${mmsi}`,
    latitude: lat,
    longitude: lon,
    time_utc: new Date(Date.now() - secondsAgo * 1000).toISOString(),
  },
  Message: {
    PositionReport: { UserID: mmsi, Sog: 10, Cog: 90, TrueHeading: 90 },
  },
});

/**
 * A tiny in-memory WebSocket stand-in. `script(socket)` runs after the
 * subscription is sent and drives the frames the collector sees.
 */
function fakeWebSocket(script) {
  const instances = [];
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.sent = [];
      this.listeners = new Map();
      this.closed = false;
      instances.push(this);
      queueMicrotask(() => this.emit('open', {}));
    }
    addEventListener(type, handler) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(handler);
    }
    emit(type, event) {
      for (const handler of this.listeners.get(type) || []) handler(event);
    }
    message(payload) {
      this.emit('message', {
        data: typeof payload === 'string' ? payload : JSON.stringify(payload),
      });
    }
    send(text) {
      this.sent.push(JSON.parse(text));
      script?.(this);
    }
    close() {
      if (this.closed) return;
      this.closed = true;
      this.emit('close', { code: 1000 });
    }
  }
  FakeWebSocket.instances = instances;
  return FakeWebSocket;
}

const fastCollector = (extra = {}) => ({
  AISSTREAM_API_KEY: 'test-key',
  AISSTREAM_COLLECT_MS: '400',
  AISSTREAM_COLLECT_QUIET_MS: '60',
  AISSTREAM_SNAPSHOT_TTL_MS: '1000',
  ...extra,
});

// ---------------------------------------------------------------------------
// Query parsing
// ---------------------------------------------------------------------------

test('bbox parsing accepts lamin,lomin,lamax,lomax, falls back to lat/lon, and rejects garbage', () => {
  assert.deepEqual(parseBboxParam('28.9,-95.5,29.9,-94'), GALVESTON);
  assert.equal(parseBboxParam('1,2,3'), null);
  assert.equal(parseBboxParam('30,-95,29,-94'), null); // inverted
  assert.equal(parseBboxParam('a,b,c,d'), null);
  const fromPoint = sceneBboxFromQuery(
    new URLSearchParams('lat=29.3&lon=-94.8'),
  );
  assert.deepEqual(fromPoint, {
    lamin: 27.8,
    lamax: 30.8,
    lomin: -96.3,
    lomax: -93.3,
  });
  assert.equal(sceneBboxFromQuery(new URLSearchParams('maxRows=5')), null);
  assert.deepEqual(roundBbox({ lamin: 28.9, lomin: -95.51, lamax: 29.9, lomax: -94.01 }), {
    lamin: 28.75,
    lomin: -95.75,
    lamax: 30,
    lomax: -94,
  });
  assert.equal(bboxKey(roundBbox(GALVESTON)), '28.75,-95.50,30.00,-94.00');
  const subscription = aisStreamSubscription(GALVESTON, 'k');
  assert.deepEqual(subscription.BoundingBoxes, [
    [
      [28.9, -95.5],
      [29.9, -94.0],
    ],
  ]);
  assert.ok(subscription.FilterMessageTypes.includes('PositionReport'));
});

// ---------------------------------------------------------------------------
// Demo replay (the path exercised when no key is configured)
// ---------------------------------------------------------------------------

test('demo replay: twelve labelled vessels stay inside the Texas Gulf coast area and move between polls', () => {
  assert.equal(DEMO_REPLAY_FLEET.length, 12);
  const now = 1_800_000_000_000;
  const rows = demoReplayRows({ now });
  assert.equal(rows.length, 12);
  for (const row of rows) {
    assert.match(row.mmsi, /^99900000\d|^999000010|^999000011|^999000012/);
    assert.match(row.name, /^DEMO REPLAY \d+$/);
    assert.equal(row.type, DEMO_REPLAY_TYPE);
    assert.ok(row.lat >= DEMO_REPLAY_AREA.lamin && row.lat <= DEMO_REPLAY_AREA.lamax);
    assert.ok(row.lon >= DEMO_REPLAY_AREA.lomin && row.lon <= DEMO_REPLAY_AREA.lomax);
    assert.ok(row.course >= 0 && row.course < 360);
  }
  const later = demoReplayRows({ now: now + 60_000 });
  assert.notDeepEqual(
    rows.map((row) => [row.lat, row.lon]),
    later.map((row) => [row.lat, row.lon]),
  );
  // Deterministic: same clock → same positions.
  assert.deepEqual(demoReplayRows({ now }), rows);
  assert.equal(demoReplayRows({ now, bbox: AUSTIN }).length, 0);
  assert.ok(demoReplayTrack('999000001', { now }).length > 10);
  assert.deepEqual(demoReplayTrack('123456789', { now }), []);
});

test('serverless route without a key answers 200 demo replay (degraded) for Galveston, empty for Austin, idle without a bbox', async () => {
  const request = install(aisServerlessProxy({ env: NO_KEY_ENV }));

  const galveston = await request('/?bbox=28.9,-95.5,29.9,-94&maxRows=5');
  assert.equal(galveston.statusCode, 200);
  assert.equal(galveston.json.status, 'degraded');
  assert.equal(galveston.json.source, DEMO_REPLAY_SOURCE);
  assert.equal(galveston.json.error, DEMO_REPLAY_ERROR);
  assert.equal(galveston.json.rows.length, 5);
  assert.equal(galveston.json.collector.mode, 'demo');
  assert.equal(galveston.json.provider.status, 'degraded');
  assert.equal(galveston.headers['x-provider-status'], 'degraded');
  assert.equal(galveston.headers['x-provider-source'], DEMO_REPLAY_SOURCE);
  assert.equal(galveston.headers['x-provider-error'], DEMO_REPLAY_ERROR);
  assert.equal(galveston.headers['cache-control'], EDGE_CACHE_CONTROL);
  assert.equal(galveston.json.refreshing, false);
  assert.equal(galveston.json.reconnectAttempt, 0);
  assert.ok(galveston.json.newestPositionAt);

  const austin = await request('/?bbox=28.77,-99.24,31.77,-96.24');
  assert.equal(austin.statusCode, 200);
  assert.equal(austin.json.status, 'empty');
  assert.deepEqual(austin.json.rows, []);
  assert.equal(austin.json.statusMessage, DEMO_REPLAY_EMPTY_MESSAGE);
  assert.equal(austin.json.error, null);
  assert.equal(austin.headers['x-provider-status'], 'degraded');
  assert.equal(austin.headers['cache-control'], EDGE_CACHE_CONTROL);

  const point = await request('/?lat=29.3&lon=-94.8');
  assert.equal(point.json.status, 'degraded');
  assert.ok(point.json.rows.length > 0);

  const idle = await request('/?maxRows=10');
  assert.equal(idle.statusCode, 200);
  assert.equal(idle.json.status, 'idle');
  assert.equal(idle.json.statusMessage, AIS_NO_BBOX_MESSAGE);
  assert.equal(idle.headers['cache-control'], 'no-store');

  const track = await request('/track?mmsi=999000003');
  assert.equal(track.statusCode, 200);
  assert.ok(track.json.samples.length > 10);
  assert.equal(track.json.source, DEMO_REPLAY_SOURCE);
  assert.equal((await request('/track?mmsi=bad')).statusCode, 400);
  assert.deepEqual((await request('/track?mmsi=123456789')).json.samples, []);
});

// ---------------------------------------------------------------------------
// AISStream collector
// ---------------------------------------------------------------------------

test('collector: a fake socket delivering three reports (two inside the bbox) yields two live rows and concurrent requests share one socket', async () => {
  const bbox = { lamin: 53, lomin: 3, lamax: 54, lomax: 4 };
  const FakeWebSocket = fakeWebSocket((socket) => {
    socket.message(positionReport(211000001, 53.5, 3.5));
    socket.message(positionReport(211000002, 53.6, 3.6));
    socket.message(positionReport(211000003, 56.0, 3.5)); // outside
  });
  const service = createAisServerlessService({
    env: fastCollector(),
    webSocketImpl: FakeWebSocket,
    store: createLastGoodStore({ maxEntries: 4 }),
    url: 'ws://fake.test/stream',
  });
  const [first, second] = await Promise.all([
    service.snapshot({ bbox, maxRows: 100 }),
    service.snapshot({ bbox, maxRows: 100 }),
  ]);
  assert.equal(FakeWebSocket.instances.length, 1, 'requests coalesced');
  const socket = FakeWebSocket.instances[0];
  assert.equal(socket.url, 'ws://fake.test/stream');
  assert.deepEqual(socket.sent[0].BoundingBoxes, [
    [
      [53, 3],
      [54, 4],
    ],
  ]);
  assert.equal(socket.sent[0].APIKey, 'test-key');
  assert.equal(socket.closed, true, 'socket closed after the window');
  for (const response of [first, second]) {
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.status, 'live');
    assert.equal(response.body.source, 'AISStream');
    assert.deepEqual(
      response.body.rows.map((row) => row.mmsi).sort(),
      ['211000001', '211000002'],
    );
    assert.equal(response.body.collector.messages, 3);
    assert.equal(response.headers['X-Provider-Status'], 'live');
    assert.equal(response.headers['X-Provider-Count'], '2');
    assert.equal(response.headers['Cache-Control'], EDGE_CACHE_CONTROL);
  }
  assert.equal(first.body.collector.mode, 'aisstream');
  // Within the TTL the stored snapshot is served without a new socket.
  const cached = await service.snapshot({ bbox, maxRows: 1 });
  assert.equal(FakeWebSocket.instances.length, 1);
  assert.equal(cached.body.collector.mode, 'cache');
  assert.equal(cached.body.rows.length, 1);
  assert.equal(cached.body.status, 'live');
  // A sub-box of the same key with no vessel inside is a legitimate empty scene.
  const empty = await service.snapshot({
    bbox: { lamin: 53.9, lomin: 3.9, lamax: 54, lomax: 4 },
    maxRows: 10,
  });
  assert.equal(empty.body.status, 'empty');
  assert.equal(empty.body.statusMessage, AIS_EMPTY_SCENE_MESSAGE);
  assert.equal(empty.headers['X-Provider-Status'], 'live');
});

test('collector: "Api Key Is Not Valid" answers 503 auth-failed and holds off reconnecting', async () => {
  const bbox = { lamin: 10, lomin: -150, lamax: 11, lomax: -149 };
  const FakeWebSocket = fakeWebSocket((socket) => {
    socket.message({ error: 'Api Key Is Not Valid' });
    socket.close();
  });
  const service = createAisServerlessService({
    env: fastCollector(),
    webSocketImpl: FakeWebSocket,
    store: createLastGoodStore({ maxEntries: 4 }),
  });
  const response = await service.snapshot({ bbox, maxRows: 10 });
  assert.equal(response.statusCode, 503);
  assert.equal(response.body.status, 'auth-failed');
  assert.equal(response.body.error, AIS_AUTH_FAILED_ERROR);
  assert.deepEqual(response.body.rows, []);
  assert.equal(response.headers['X-Provider-Status'], 'unavailable');
  assert.equal(response.headers['Cache-Control'], 'no-store');
  const again = await service.snapshot({ bbox, maxRows: 10 });
  assert.equal(again.statusCode, 503);
  assert.equal(FakeWebSocket.instances.length, 1, 'no reconnect storm');
});

test('collector: silence after a good collection serves last-good as degraded; a socket failure serves it as stale', async () => {
  const bbox = { lamin: -40, lomin: -20, lamax: -39, lomax: -19 };
  let clock = Date.now();
  let script = (socket) => {
    socket.message(positionReport(710000001, -39.5, -19.5));
    socket.message(positionReport(710000002, -39.6, -19.4));
  };
  const FakeWebSocket = fakeWebSocket((socket) => script(socket));
  const service = createAisServerlessService({
    env: fastCollector(),
    webSocketImpl: FakeWebSocket,
    store: createLastGoodStore({ maxEntries: 4 }),
    now: () => clock,
  });
  const good = await service.snapshot({ bbox, maxRows: 10 });
  assert.equal(good.body.status, 'live');
  assert.equal(good.body.rows.length, 2);

  clock += 5_000; // past the 1 s TTL → a new collection, which stays silent
  script = () => {};
  const silent = await service.snapshot({ bbox, maxRows: 10 });
  assert.equal(FakeWebSocket.instances.length, 2);
  assert.equal(silent.statusCode, 200);
  assert.equal(silent.body.status, 'degraded');
  assert.equal(silent.body.rows.length, 2);
  assert.match(silent.body.error, /no positions in 0\.4 s .*known upstream silence.* showing last-good/);
  assert.equal(silent.headers['X-Provider-Status'], 'degraded');
  assert.equal(silent.headers['X-Provider-Age-Sec'], '5');
  assert.equal(silent.body.collector.messages, 0);
  // The silent outcome is held for the TTL: no third socket right away.
  await service.snapshot({ bbox, maxRows: 10 });
  assert.equal(FakeWebSocket.instances.length, 2);

  clock += 5_000;
  script = (socket) => socket.emit('error', { error: new Error('ECONNRESET') });
  const failed = await service.snapshot({ bbox, maxRows: 10 });
  assert.equal(FakeWebSocket.instances.length, 3);
  assert.equal(failed.statusCode, 200);
  assert.equal(failed.body.status, 'stale');
  assert.equal(failed.body.rows.length, 2);
  assert.match(failed.body.error, /AISStream unreachable \(ECONNRESET\) - showing last-good/);
  assert.equal(failed.headers['X-Provider-Status'], 'stale');
});

test('collector: silence with nothing stored is an empty scene (degraded provider); a failure with nothing stored is a 503', async () => {
  const silentBox = { lamin: -60, lomin: 100, lamax: -59, lomax: 101 };
  const FakeSilent = fakeWebSocket(() => {});
  const silentService = createAisServerlessService({
    env: fastCollector(),
    webSocketImpl: FakeSilent,
    store: createLastGoodStore({ maxEntries: 4 }),
  });
  const silent = await silentService.snapshot({ bbox: silentBox, maxRows: 10 });
  assert.equal(silent.statusCode, 200);
  assert.equal(silent.body.status, 'empty');
  assert.equal(silent.body.statusMessage, 'No vessels reported in scene');
  assert.equal(silent.headers['X-Provider-Status'], 'degraded');
  assert.match(silent.headers['X-Provider-Error'], /known upstream silence/);

  const FakeBroken = fakeWebSocket((socket) => socket.close());
  const brokenService = createAisServerlessService({
    env: fastCollector(),
    webSocketImpl: FakeBroken,
    store: createLastGoodStore({ maxEntries: 4 }),
  });
  const broken = await brokenService.snapshot({
    bbox: { lamin: -61, lomin: 120, lamax: -60, lomax: 121 },
    maxRows: 10,
  });
  assert.equal(broken.statusCode, 503);
  assert.equal(broken.body.status, 'error');
  assert.match(broken.body.error, /closed the connection/);
  assert.equal(broken.headers['X-Provider-Status'], 'unavailable');
  assert.equal(broken.headers['Cache-Control'], 'no-store');
});

// ---------------------------------------------------------------------------
// KV (Vercel KV / Upstash REST)
// ---------------------------------------------------------------------------

test('kv-store: set/get round-trip through the REST API with a bearer token; failures are swallowed', async (t) => {
  assert.equal(kvConfigFromEnv({}), null);
  const config = kvConfigFromEnv({
    UPSTASH_REDIS_REST_URL: 'https://kv.test/',
    UPSTASH_REDIS_REST_TOKEN: 'secret-token',
  });
  assert.deepEqual(config, {
    url: 'https://kv.test',
    token: 'secret-token',
    provider: 'upstash',
  });
  const calls = [];
  const values = new Map();
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url: String(url), init });
    const target = new URL(url);
    const [, verb, key] = target.pathname.split('/');
    if (verb === 'set') {
      values.set(decodeURIComponent(key), init.body);
      return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
    }
    return new Response(
      JSON.stringify({ result: values.get(decodeURIComponent(key)) ?? null }),
      { status: 200 },
    );
  });
  const kv = createKvStore({ config });
  assert.equal(kv.enabled, true);
  assert.equal(await kv.set('box', { rows: [1, 2], fetchedAt: 42 }, { ttlSec: 120 }), true);
  assert.deepEqual(await kv.get('box'), { rows: [1, 2], fetchedAt: 42 });
  assert.equal(await kv.get('missing'), null);
  assert.equal(calls[0].init.method, 'POST');
  assert.match(calls[0].url, /^https:\/\/kv\.test\/set\/ais-serverless%3Abox\?EX=120$/);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer secret-token');
  assert.match(calls[1].url, /^https:\/\/kv\.test\/get\/ais-serverless%3Abox$/);

  const warnings = [];
  globalThis.fetch.mock.mockImplementation(async () => {
    throw new Error('ENOTFOUND kv.test');
  });
  const failing = createKvStore({ config, warn: (m) => warnings.push(m) });
  assert.equal(await failing.get('box'), null);
  assert.equal(await failing.set('box', {}), false);
  assert.equal(warnings.length, 1, 'logged once');
  assert.match(warnings[0], /shared KV get failed/);
  assert.equal(createKvStore({ config: null }).enabled, false);
});

test('service: a fresh snapshot in KV is served as cache without opening a socket, and a collection is written back', async () => {
  const bbox = { lamin: 40, lomin: 20, lamax: 41, lomax: 21 };
  const key = bboxKey(roundBbox(bbox));
  const clock = Date.now();
  const remote = new Map([
    [
      key,
      {
        rows: [
          {
            mmsi: '300000001',
            name: 'SHARED',
            lat: 40.5,
            lon: 20.5,
            speed: 1,
            course: 2,
            heading: 3,
            type: '',
            destination: '',
            imo: '',
            last_position_UTC: new Date(clock - 3_000).toISOString(),
            last_position_epoch: Math.floor((clock - 3_000) / 1000),
          },
        ],
        fetchedAt: clock - 2_000,
        lastMessageAt: clock - 2_500,
        messages: 4,
        durationMs: 800,
        source: 'AISStream',
        mode: 'aisstream',
        status: 'live',
        error: null,
      },
    ],
  ]);
  const writes = [];
  const kv = {
    enabled: true,
    async get(k) {
      return remote.get(k) ?? null;
    },
    async set(k, value, options) {
      writes.push({ key: k, value, options });
      remote.set(k, value);
      return true;
    },
  };
  class NeverSocket {
    constructor() {
      throw new Error('must not open a socket for a KV hit');
    }
  }
  const service = createAisServerlessService({
    env: fastCollector({ AISSTREAM_SNAPSHOT_TTL_MS: '25000' }),
    webSocketImpl: NeverSocket,
    store: createLastGoodStore({ maxEntries: 4 }),
    kv,
    now: () => clock,
  });
  const hit = await service.snapshot({ bbox, maxRows: 10 });
  assert.equal(hit.statusCode, 200);
  assert.equal(hit.body.status, 'live');
  assert.equal(hit.body.collector.mode, 'cache');
  assert.equal(hit.body.rows[0].mmsi, '300000001');
  assert.equal(hit.headers['X-Provider-Age-Sec'], '2');

  const other = { lamin: 45, lomin: 25, lamax: 46, lomax: 26 };
  const FakeWebSocket = fakeWebSocket((socket) =>
    socket.message(positionReport(300000002, 45.5, 25.5)),
  );
  const writer = createAisServerlessService({
    env: fastCollector(),
    webSocketImpl: FakeWebSocket,
    store: createLastGoodStore({ maxEntries: 4 }),
    kv,
  });
  const collected = await writer.snapshot({ bbox: other, maxRows: 10 });
  assert.equal(collected.body.status, 'live');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].key, bboxKey(roundBbox(other)));
  assert.equal(writes[0].options.ttlSec, 120);
  assert.equal(writes[0].value.rows[0].mmsi, '300000002');
});

// ---------------------------------------------------------------------------
// AISHub fallback
// ---------------------------------------------------------------------------

test('service: AISHUB_USERNAME without an AISStream key polls AISHub once a minute and reports degraded', async (t) => {
  const bbox = { lamin: 51, lomin: 1, lamax: 52, lomax: 2 };
  const urls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    urls.push(String(url));
    return new Response(
      JSON.stringify([
        { ERROR: false, USERNAME: 'demo', RECORDS: 2 },
        [
          {
            MMSI: 244000001,
            TIME: '2026-09-18 12:00:00 GMT',
            LONGITUDE: 1.5,
            LATITUDE: 51.5,
            COG: 45.5,
            SOG: 9.1,
            HEADING: 511,
            NAME: 'HUB ONE',
            IMO: 9000001,
            TYPE: 70,
            DEST: 'ROTTERDAM',
          },
          { MMSI: 'x', LATITUDE: 'nope', LONGITUDE: 1 },
        ],
      ]),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });
  const service = createAisServerlessService({
    env: { AISHUB_USERNAME: 'demo' },
    store: createLastGoodStore({ maxEntries: 4 }),
  });
  const first = await service.snapshot({ bbox, maxRows: 10 });
  assert.equal(first.statusCode, 200);
  assert.equal(first.body.status, 'degraded');
  assert.equal(first.body.source, 'AISHub');
  assert.equal(first.body.error, AISHUB_DEGRADED_ERROR);
  assert.equal(first.body.collector.mode, 'aishub');
  assert.equal(first.headers['X-Provider-Status'], 'degraded');
  assert.deepEqual(first.body.rows, [
    {
      lat: 51.5,
      lon: 1.5,
      name: 'HUB ONE',
      mmsi: '244000001',
      imo: '9000001',
      type: '70',
      destination: 'ROTTERDAM',
      speed: 9.1,
      course: 45.5,
      heading: null,
      last_position_UTC: '2026-09-18T12:00:00.000Z',
      last_position_epoch: Date.parse('2026-09-18T12:00:00Z') / 1000,
    },
  ]);
  assert.equal(urls.length, 1);
  const target = new URL(urls[0]);
  assert.equal(target.origin + target.pathname, 'https://data.aishub.net/ws.php');
  assert.equal(target.searchParams.get('username'), 'demo');
  assert.equal(target.searchParams.get('latmin'), '51');
  assert.equal(target.searchParams.get('lonmax'), '2');
  const second = await service.snapshot({ bbox, maxRows: 10 });
  assert.equal(urls.length, 1, 'served from the 60 s cache');
  assert.equal(second.body.collector.mode, 'cache');
  assert.equal(second.body.status, 'degraded');
});

// ---------------------------------------------------------------------------
// Browser source
// ---------------------------------------------------------------------------

test('client createAisStreamSource sends the scene bbox and surfaces the provider status; a 503 carries the provider reason', async () => {
  const requests = [];
  const respond = (status, body, headers = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });
  let next = respond(
    200,
    {
      rows: demoReplayRows({ bbox: GALVESTON }),
      source: DEMO_REPLAY_SOURCE,
      status: 'degraded',
      error: DEMO_REPLAY_ERROR,
      statusMessage: null,
      refreshing: false,
      newestPositionAt: new Date().toISOString(),
      lastMessageAt: Date.now(),
      collector: { mode: 'demo' },
      provider: {
        status: 'degraded',
        source: DEMO_REPLAY_SOURCE,
        fetchedAt: new Date().toISOString(),
        ageSec: 0,
        error: DEMO_REPLAY_ERROR,
        count: 12,
      },
    },
    {
      'x-provider-status': 'degraded',
      'x-provider-source': DEMO_REPLAY_SOURCE,
      'x-provider-error': DEMO_REPLAY_ERROR,
      'x-provider-fetched-at': new Date().toISOString(),
    },
  );
  const source = createAisStreamSource({
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      return next;
    },
    origin: () => 'http://localhost',
  });
  const snapshot = await source.getSnapshot({ maxRows: 50, bbox: GALVESTON });
  const url = new URL(requests[0].url);
  assert.equal(url.pathname, '/api/ais-live');
  assert.equal(url.searchParams.get('maxRows'), '50');
  assert.equal(url.searchParams.get('bbox'), '28.9,-95.5,29.9,-94');
  assert.equal(snapshot.records.length, 12);
  assert.equal(snapshot.source, DEMO_REPLAY_SOURCE);
  assert.equal(snapshot.providerStatus, 'degraded');
  assert.equal(snapshot.providerError, DEMO_REPLAY_ERROR);
  assert.equal(snapshot.providerSource, DEMO_REPLAY_SOURCE);
  assert.equal(snapshot.collectorMode, 'demo');
  assert.equal(snapshot.transportStatus, 'degraded');
  assert.equal(snapshot.stale, false);
  assert.ok(Number.isFinite(snapshot.providerFetchedAtMs));

  next = respond(
    200,
    { rows: [], status: 'empty', statusMessage: AIS_EMPTY_SCENE_MESSAGE, source: 'AISStream' },
    { 'x-provider-status': 'live', 'x-provider-source': 'AISStream' },
  );
  const empty = await source.getSnapshot({ maxRows: 50 });
  assert.equal(new URL(requests[1].url).searchParams.has('bbox'), false);
  assert.equal(empty.statusMessage, AIS_EMPTY_SCENE_MESSAGE);
  assert.equal(empty.transportStatus, 'empty');
  assert.equal(empty.providerStatus, 'live');

  next = respond(
    200,
    { rows: [{ mmsi: '1', lat: 1, lon: 1 }], status: 'stale', source: 'AISStream' },
    { 'x-provider-status': 'stale', 'x-provider-error': 'AISStream unreachable (boom) - showing last-good' },
  );
  const stale = await source.getSnapshot({ maxRows: 50 });
  assert.equal(stale.stale, true);
  assert.equal(stale.providerStatus, 'stale');

  next = respond(
    503,
    { rows: [], status: 'auth-failed', error: AIS_AUTH_FAILED_ERROR },
    { 'x-provider-status': 'unavailable', 'x-provider-error': AIS_AUTH_FAILED_ERROR },
  );
  await assert.rejects(source.getSnapshot({ maxRows: 50, bbox: GALVESTON }), (error) => {
    assert.equal(error.message, AIS_AUTH_FAILED_ERROR);
    assert.equal(error.status, 503);
    return true;
  });

  // The dev-mode relay (no provider headers) keeps its legacy reason map.
  next = respond(503, { rows: [], status: 'missing-key', error: 'AISSTREAM_API_KEY is not set' });
  await assert.rejects(source.getSnapshot({ maxRows: 50 }), /AISSTREAM_API_KEY not set/);
});
