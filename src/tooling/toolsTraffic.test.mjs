/**
 * Offline tests for the `traffic` OnDemand tool plugin (server/tools/traffic.js)
 * through the real tools route + registry. TomTom is mocked with
 * `t.mock.method(globalThis, 'fetch', …)` (200 / 401 / timeout); the keyless
 * path never fetches at all.
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createToolsHandler } from '../../server/serverless/tools-route.js';
import { toolIndex } from '../../server/tools/registry.js';
import {
  plugin,
  tools,
  classifyTomTomFailure,
  normaliseFlowSegment,
  TOMTOM_NOT_CONFIGURED_MESSAGE,
} from '../../server/tools/traffic.js';
import {
  OVERPASS_DEFAULT_UPSTREAMS,
  ROAD_NETWORK_BLOCKER,
  parseOverpassUpstreams,
  roadNetworkConfig,
} from '../../server/providers/overpass/constants.js';

const ENV_KEYS = [
  'TOMTOM_API_KEY',
  'TOMTOM_DAILY_REQUEST_BUDGET',
  'ROAD_NETWORK_SOURCE',
  'OVERPASS_UPSTREAMS',
];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

before(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});
after(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

function invoke(handler, url, method = 'GET') {
  return new Promise((resolve) => {
    const headers = {};
    const res = {
      statusCode: 200,
      setHeader: (k, v) => {
        headers[k.toLowerCase()] = v;
      },
      end: (body) =>
        resolve({
          status: res.statusCode,
          headers,
          body: body ? JSON.parse(body) : null,
          text: body || '',
        }),
    };
    handler({ url, method, on() {} }, res);
  });
}

const handler = createToolsHandler({ index: toolIndex() });
const AUSTIN = 'lat=30.2747&lon=-97.7404';

const flowSegmentFixture = (overrides = {}) => ({
  flowSegmentData: {
    frc: 'FRC2',
    currentSpeed: 37,
    freeFlowSpeed: 56,
    currentTravelTime: 118,
    freeFlowTravelTime: 78,
    confidence: 0.94,
    roadClosure: false,
    coordinates: {
      coordinate: [
        { latitude: 30.2747, longitude: -97.7404 },
        { latitude: 30.2751, longitude: -97.7399 },
        { latitude: 30.2756, longitude: -97.7393 },
      ],
    },
    '@version': 'traffic-service-flow 1.0.120',
    ...overrides,
  },
});

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

test('plugin descriptor and tool catalogue entries', () => {
  assert.equal(plugin.id, 'traffic');
  assert.equal(
    plugin.name,
    'OnDemand Spatial Street Traffic (TomTom Flow Segment Data)',
  );
  assert.equal(plugin.category, 'Research');
  assert.ok(plugin.conversationStarters.length >= 3);
  assert.match(plugin.description, /TOMTOM_API_KEY/);
  assert.match(plugin.description, /OVERPASS_UPSTREAMS/);
  assert.deepEqual(
    tools.map((t) => [t.name, t.cacheSeconds]),
    [
      ['traffic_flow_at_point', 60],
      ['road_network_status', 300],
    ],
  );
  assert.deepEqual(Object.keys(tools[0].params), ['lat', 'lon', 'zoom', 'unit']);
  assert.deepEqual(tools[0].params.unit.values, ['KMPH', 'MPH']);
  assert.deepEqual(Object.keys(tools[1].params), []);
});

test('roadNetworkConfig(): defaults, csv override, off switch, never the raw env text', () => {
  const defaults = roadNetworkConfig({});
  assert.equal(defaults.source, 'overpass');
  assert.deepEqual(defaults.upstreams, [...OVERPASS_DEFAULT_UPSTREAMS]);
  assert.equal(defaults.upstreams.length, 5);
  assert.equal(defaults.blocker, ROAD_NETWORK_BLOCKER);
  assert.equal(
    defaults.blocker,
    'Public Overpass mirrors refuse or time out for cloud egress (overpass-api.de HTTP 406, kumi.systems/private.coffee timeouts — measured 2026-09-18); set OVERPASS_UPSTREAMS to a private mirror',
  );
  assert.deepEqual(defaults.fromEnv, {
    ROAD_NETWORK_SOURCE: false,
    OVERPASS_ENDPOINTS: false,
    OVERPASS_UPSTREAMS: false,
  });
  assert.equal(defaults.endpointsSource, 'default');

  const overridden = roadNetworkConfig({
    ROAD_NETWORK_SOURCE: ' OFF ',
    OVERPASS_UPSTREAMS:
      'https://overpass.internal.example/api/interpreter, not a url ,ftp://nope.example/x, https://overpass.internal.example/api/interpreter',
  });
  assert.equal(overridden.source, 'off');
  assert.deepEqual(overridden.upstreams, [
    'https://overpass.internal.example/api/interpreter',
  ]);
  assert.deepEqual(overridden.fromEnv, {
    ROAD_NETWORK_SOURCE: true,
    OVERPASS_ENDPOINTS: false,
    OVERPASS_UPSTREAMS: true,
  });
  assert.equal(overridden.endpointsSource, 'OVERPASS_UPSTREAMS');
  assert.equal(roadNetworkConfig({ ROAD_NETWORK_SOURCE: 'banana' }).source, 'overpass');
  assert.equal(parseOverpassUpstreams(''), null);
  assert.equal(parseOverpassUpstreams('garbage, more garbage'), null);
  assert.equal(parseOverpassUpstreams(undefined), null);
  // an unusable override leaves the default list in force
  assert.deepEqual(
    roadNetworkConfig({ OVERPASS_UPSTREAMS: 'garbage' }).upstreams,
    [...OVERPASS_DEFAULT_UPSTREAMS],
  );
});

test('classifyTomTomFailure(): keyless is 503 not_configured (never 502); other reasons keep the route status', () => {
  const keyless = classifyTomTomFailure(
    503,
    { error: 'TOMTOM_API_KEY not set' },
    { status: 'unavailable', source: 'TomTom', error: 'TOMTOM_API_KEY not set - set it in Vercel to enable live traffic' },
  );
  assert.equal(keyless.status, 503);
  assert.equal(keyless.error.code, 'not_configured');
  assert.equal(keyless.error.message, TOMTOM_NOT_CONFIGURED_MESSAGE);
  assert.equal(keyless.provider.source, 'TomTom');
  assert.equal(classifyTomTomFailure(503, { error: 'TomTom rejected TOMTOM_API_KEY' }, null).error.code, 'upstream_auth');
  assert.equal(classifyTomTomFailure(503, { error: 'TomTom rate limited (retry in 30s)' }, null).error.code, 'rate_limited');
  assert.equal(classifyTomTomFailure(503, { error: 'TomTom flow segment unreachable (timed out after 10 s)' }, null).error.code, 'upstream_timeout');
  assert.equal(classifyTomTomFailure(503, { error: 'TomTom daily request budget reached' }, null).error.code, 'budget_exhausted');
  const rejected = classifyTomTomFailure(400, { error: 'TomTom rejected the flow segment request (HTTP 400)' }, null);
  assert.equal(rejected.status, 400);
  assert.equal(rejected.error.code, 'no_road_segment');
  assert.equal(classifyTomTomFailure(0, {}, null).status, 502);
  const flat = normaliseFlowSegment(flowSegmentFixture().flowSegmentData, {
    point: { lat: 1, lon: 2 },
    unit: 'MPH',
    roadNetwork: { source: 'overpass' },
  });
  assert.equal(flat.coordinatesCount, 3);
  assert.equal(flat.frc, 'FRC2');
  assert.equal(flat.unit, 'MPH');
  assert.equal(flat.roadClosure, false);
});

test('traffic_flow_at_point: keyless deployment → 503 not_configured with the TomTom provider block (no fetch)', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('network must not be used without a key');
  });
  const res = await invoke(handler, `/traffic_flow_at_point?${AUSTIN}`);
  assert.equal(res.status, 503, res.text);
  assert.notEqual(res.status, 502);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.tool, 'traffic_flow_at_point');
  assert.deepEqual(res.body.error, {
    code: 'not_configured',
    message: 'TOMTOM_API_KEY not set — set it in Vercel to enable live traffic',
  });
  assert.equal(res.body.provider.status, 'unavailable');
  assert.equal(res.body.provider.source, 'TomTom');
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers['x-tools-route'], 'ondemand-spatial');
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('traffic_flow_at_point: validation through the real registry', async () => {
  const unknown = await invoke(handler, `/traffic_flow_at_point?${AUSTIN}&radius=5`);
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.error.code, 'unknown_param');
  assert.equal(unknown.body.error.param, 'radius');
  const missing = await invoke(handler, '/traffic_flow_at_point?lat=30.27');
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error.code, 'missing_param');
  const unit = await invoke(handler, `/traffic_flow_at_point?${AUSTIN}&unit=knots`);
  assert.equal(unit.status, 400);
  assert.equal(unit.body.error.code, 'invalid_param');
  assert.equal(unit.body.error.param, 'unit');
  const zoom = await invoke(handler, `/traffic_flow_at_point?${AUSTIN}&zoom=23`);
  assert.equal(zoom.status, 400);
  assert.equal(zoom.body.error.param, 'zoom');
  const nan = await invoke(handler, '/traffic_flow_at_point?lat=abc&lon=1');
  assert.equal(nan.status, 400);
  assert.equal(nan.body.error.param, 'lat');
});

test('traffic_flow_at_point: with a key, TomTom 200 → flat segment data, provider live, no key leak', async (t) => {
  const sentinel = 'sentinel-tomtom-key-4e5f6';
  process.env.TOMTOM_API_KEY = sentinel;
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push(String(url));
    return jsonResponse(flowSegmentFixture());
  });
  try {
    const res = await invoke(handler, `/traffic_flow_at_point?${AUSTIN}&unit=MPH&zoom=12`);
    assert.equal(res.status, 200, res.text);
    assert.match(res.headers['cache-control'], /s-maxage=60/);
    const { data } = res.body;
    assert.deepEqual(data.point, { lat: 30.2747, lon: -97.7404 });
    assert.equal(data.currentSpeed, 37);
    assert.equal(data.freeFlowSpeed, 56);
    assert.equal(data.currentTravelTime, 118);
    assert.equal(data.freeFlowTravelTime, 78);
    assert.equal(data.confidence, 0.94);
    assert.equal(data.roadClosure, false);
    assert.equal(data.frc, 'FRC2');
    assert.equal(data.coordinatesCount, 3);
    assert.equal(data.unit, 'MPH');
    assert.equal(data.zoom, 12);
    assert.equal(data.stale, false);
    assert.equal(data.roadNetwork.source, 'overpass');
    assert.equal(data.roadNetwork.blocker, ROAD_NETWORK_BLOCKER);
    assert.equal(res.body.provider.status, 'live');
    assert.equal(res.body.provider.source, 'TomTom');
    assert.equal(res.body.provenance.completeness.status, 'sampled');
    assert.equal(calls.length, 1);
    assert.match(calls[0], /flowSegmentData\/absolute\/12\/json\?point=30\.27,-97\.74&unit=MPH/);
    assert.ok(!res.text.includes(sentinel), 'TOMTOM_API_KEY value must never appear in a tool response');
    assert.ok(!res.text.includes('api.tomtom.com'), 'the upstream URL must not be echoed');
  } finally {
    delete process.env.TOMTOM_API_KEY;
  }
});

test('traffic_flow_at_point: TomTom 401 → 503 upstream_auth (structured, key redacted)', async (t) => {
  const sentinel = 'sentinel-tomtom-key-rejected';
  process.env.TOMTOM_API_KEY = sentinel;
  t.mock.method(globalThis, 'fetch', async () =>
    new Response(`{"detailedError":{"code":"Unauthorized","message":"key ${sentinel} invalid"}}`, { status: 401 }),
  );
  try {
    const res = await invoke(handler, '/traffic_flow_at_point?lat=30.31&lon=-97.71');
    assert.equal(res.status, 503, res.text);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.error.code, 'upstream_auth');
    assert.match(res.body.error.message, /TomTom rejected TOMTOM_API_KEY/);
    assert.equal(res.body.provider.status, 'unavailable');
    assert.ok(!res.text.includes(sentinel), 'a rejected key must not be echoed back');
  } finally {
    delete process.env.TOMTOM_API_KEY;
  }
});

test('traffic_flow_at_point: TomTom timeout → 503 upstream_timeout after the proxy retry', async (t) => {
  process.env.TOMTOM_API_KEY = 'sentinel-tomtom-key-timeout';
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => {
    throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
  });
  try {
    const res = await invoke(handler, '/traffic_flow_at_point?lat=30.41&lon=-97.61');
    assert.equal(res.status, 503, res.text);
    assert.equal(res.body.error.code, 'upstream_timeout');
    assert.match(res.body.error.message, /timed out/);
    assert.equal(fetchMock.mock.callCount(), 2, 'one retry, then a structured failure');
    assert.ok(!res.text.includes('sentinel-tomtom-key-timeout'));
  } finally {
    delete process.env.TOMTOM_API_KEY;
  }
});

test('road_network_status: no params, default config, tomtom.configured=false while keyless, cached 300 s', async () => {
  const res = await invoke(handler, '/road_network_status');
  assert.equal(res.status, 200, res.text);
  assert.match(res.headers['cache-control'], /s-maxage=300/);
  const { data } = res.body;
  assert.equal(data.source, 'overpass');
  assert.deepEqual(data.upstreams, [...OVERPASS_DEFAULT_UPSTREAMS]);
  assert.equal(data.blocker, ROAD_NETWORK_BLOCKER);
  assert.deepEqual(data.fromEnv, { ROAD_NETWORK_SOURCE: false, OVERPASS_ENDPOINTS: false, OVERPASS_UPSTREAMS: false });
  assert.equal(data.tomtom.configured, false);
  assert.equal(data.tomtom.provider.status, 'degraded');
  assert.equal(res.body.provider.status, 'degraded');
  assert.equal(res.body.provider.error, ROAD_NETWORK_BLOCKER);
  const unknown = await invoke(handler, '/road_network_status?verbose=1');
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.error.code, 'unknown_param');
});

test('road_network_status: env override is reported (source off, private mirror) without echoing raw env text', async () => {
  process.env.ROAD_NETWORK_SOURCE = 'off';
  process.env.OVERPASS_UPSTREAMS = 'https://overpass.internal.example/api/interpreter,junk-token-xyz';
  try {
    const res = await invoke(handler, '/road_network_status');
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.data.source, 'off');
    assert.deepEqual(res.body.data.upstreams, ['https://overpass.internal.example/api/interpreter']);
    assert.deepEqual(res.body.data.fromEnv, { ROAD_NETWORK_SOURCE: true, OVERPASS_ENDPOINTS: false, OVERPASS_UPSTREAMS: true });
    assert.equal(res.body.provider.status, 'unavailable');
    assert.equal(res.body.provider.error, null);
    assert.ok(!res.text.includes('junk-token-xyz'), 'unparsed csv members are never echoed');
  } finally {
    delete process.env.ROAD_NETWORK_SOURCE;
    delete process.env.OVERPASS_UPSTREAMS;
  }
});
