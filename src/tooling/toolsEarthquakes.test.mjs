/**
 * Offline tests for the `earthquakes` OnDemand tool plugin
 * (server/tools/earthquakes.js) through the real tools route + registry.
 * USGS FDSN is mocked with `t.mock.method(globalThis, 'fetch', …)`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolsHandler } from '../../server/serverless/tools-route.js';
import { toolIndex } from '../../server/tools/registry.js';
import {
  plugin,
  tools,
  earthquakeParamSpec,
  sourceQuery,
  mapSourceFailure,
} from '../../server/tools/earthquakes.js';
import { ALLOWED_PARAMS } from '../../server/sources/usgs-earthquakes.js';

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

const fdsnFixture = () => ({
  type: 'FeatureCollection',
  metadata: {
    generated: Date.UTC(2026, 8, 18, 12, 0, 0),
    url: 'https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson',
    title: 'USGS Earthquakes',
    status: 200,
    api: '1.14.1',
    count: 2,
  },
  features: [
    {
      type: 'Feature',
      id: 'us7000test1',
      properties: {
        mag: 5.1,
        place: '120 km S of Gulf test point',
        time: Date.UTC(2026, 8, 18, 11, 30, 0),
        url: 'https://earthquake.usgs.gov/earthquakes/eventpage/us7000test1',
        tsunami: 0,
        alert: 'green',
        magType: 'mww',
      },
      geometry: { type: 'Point', coordinates: [-90.12, 26.55, 10.0] },
    },
    {
      type: 'Feature',
      id: 'us7000test2',
      properties: {
        mag: 4.6,
        place: '30 km NE of another test point',
        time: Date.UTC(2026, 8, 18, 9, 0, 0),
        url: 'https://earthquake.usgs.gov/earthquakes/eventpage/us7000test2',
        tsunami: 1,
        alert: null,
        magType: 'mb',
      },
      geometry: { type: 'Point', coordinates: [-88.4, 28.1, 22.5] },
    },
  ],
});

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

test('plugin descriptor; the whitelist is exactly the adapter ALLOWED_PARAMS + mode', () => {
  assert.equal(plugin.id, 'earthquakes');
  assert.equal(plugin.name, 'OnDemand Spatial Earthquake Search (USGS)');
  assert.equal(plugin.category, 'Research');
  assert.ok(plugin.conversationStarters.length >= 3);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'earthquake_search');
  assert.equal(tools[0].cacheSeconds, 60);
  assert.deepEqual(Object.keys(earthquakeParamSpec()), [...ALLOWED_PARAMS, 'mode']);
  assert.deepEqual(Object.keys(tools[0].params), [...ALLOWED_PARAMS, 'mode']);
  for (const rule of Object.values(tools[0].params)) assert.equal(Boolean(rule.required), false);
  assert.deepEqual(tools[0].params.orderby.values, ['time', 'time-asc', 'magnitude', 'magnitude-asc']);
  assert.deepEqual(tools[0].params.mode.values, ['query', 'count']);
  assert.equal(sourceQuery({ minmagnitude: 4.5, limit: 3, orderby: 'time', mode: 'query', skip: undefined }), 'minmagnitude=4.5&limit=3&orderby=time&mode=query');
});

test('mapSourceFailure(): 1:1 status + code mapping of the Gate 3 route failures', () => {
  assert.deepEqual(mapSourceFailure(400, { error: 'invalid_query', message: 'Unknown parameter(s): foo', unknown: ['foo'] }), {
    ok: false,
    status: 400,
    error: { code: 'unknown_param', message: 'Unknown parameter(s): foo', param: 'foo' },
  });
  assert.deepEqual(mapSourceFailure(400, { error: 'invalid_query', message: 'Invalid limit: expected an integer >= 1', unknown: [] }), {
    ok: false,
    status: 400,
    error: { code: 'invalid_query', message: 'Invalid limit: expected an integer >= 1' },
  });
  assert.deepEqual(mapSourceFailure(404, { error: 'usgs_rejected', detail: 'Not Found' }), {
    ok: false,
    status: 404,
    error: { code: 'usgs_rejected', message: 'Not Found' },
  });
  assert.equal(mapSourceFailure(504, { error: 'usgs_timeout', detail: 'The operation was aborted due to timeout' }).error.code, 'usgs_timeout');
  assert.equal(mapSourceFailure(503, { error: 'usgs_unavailable', detail: 'Service Unavailable' }).status, 503);
  assert.deepEqual(mapSourceFailure(502, { error: 'sources_error' }).error.code, 'sources_error');
  assert.equal(mapSourceFailure(0, null).status, 502);
});

test('earthquake_search: circle query → USGS GeoJSON normalised, provenance + provider passed through, cached 60 s', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push(String(url));
    return jsonResponse(fdsnFixture());
  });
  const res = await invoke(
    handler,
    '/earthquake_search?latitude=27&longitude=-90&maxradiuskm=1500&starttime=2026-09-17&minmagnitude=4.5&limit=3',
  );
  assert.equal(res.status, 200, res.text);
  assert.equal(res.headers['x-tools-route'], 'ondemand-spatial');
  assert.match(res.headers['cache-control'], /s-maxage=60/);
  const { body } = res;
  assert.equal(body.ok, true);
  assert.equal(body.tool, 'earthquake_search');
  assert.equal(body.params.limit, 3);
  assert.equal(body.params.orderby, 'time');
  assert.equal(body.params.mode, 'query');
  assert.equal(body.data.source, 'USGS');
  assert.equal(body.data.coverage, 'observed');
  assert.equal(body.data.mode, 'query');
  assert.equal(body.data.count, 2);
  assert.equal(body.data.events.length, 2);
  assert.deepEqual(body.data.events[0], {
    id: 'us7000test1',
    time_utc: '2026-09-18T11:30:00.000Z',
    magnitude: 5.1,
    mag_type: 'mww',
    depth_km: 10,
    lat: 26.55,
    lon: -90.12,
    place: '120 km S of Gulf test point',
    tsunami: 0,
    alert: 'green',
    url: 'https://earthquake.usgs.gov/earthquakes/eventpage/us7000test1',
    source: 'USGS',
    coverage: 'observed',
    retrieved_at_utc: body.data.events[0].retrieved_at_utc,
  });
  assert.equal(body.data.events[1].tsunami, 1);
  assert.equal(body.data.query.latitude, '27');
  assert.equal(body.provenance.source, 'USGS FDSN Event Web Service');
  assert.match(body.provenance.url, /^https:\/\/earthquake\.usgs\.gov\/fdsnws\/event\/1\/query\?/);
  assert.match(body.provenance.url, /format=geojson/);
  assert.equal(body.provenance.generated, '2026-09-18T12:00:00.000Z');
  assert.match(body.provenance.license, /public domain/);
  assert.equal(body.provider.status, 'live');
  assert.equal(body.provider.source, 'USGS FDSN Event Web Service');
  assert.equal(body.provider.count, 2);
  assert.equal(calls.length, 1);
  const upstream = new URL(calls[0]);
  assert.equal(upstream.origin + upstream.pathname, 'https://earthquake.usgs.gov/fdsnws/event/1/query');
  assert.equal(upstream.searchParams.get('starttime'), '2026-09-17T00:00:00Z');
  assert.equal(upstream.searchParams.get('minmagnitude'), '4.5');
  assert.equal(upstream.searchParams.get('maxradiuskm'), '1500');
  assert.equal(upstream.searchParams.get('limit'), '3');
  assert.equal(upstream.searchParams.get('orderby'), 'time');
  assert.equal(upstream.searchParams.get('format'), 'geojson');
  assert.equal(upstream.searchParams.has('mode'), false, 'mode is a local switch, never forwarded');
});

test('earthquake_search: mode=count uses the FDSN count endpoint and returns count only', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push(String(url));
    return jsonResponse({ count: 27, maxAllowed: 20000 });
  });
  const res = await invoke(handler, '/earthquake_search?minmagnitude=5&starttime=2026-09-11&mode=count');
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.data.mode, 'count');
  assert.equal(res.body.data.count, 27);
  assert.deepEqual(res.body.data.events, []);
  assert.equal(res.body.provider.count, 27);
  assert.match(calls[0], /^https:\/\/earthquake\.usgs\.gov\/fdsnws\/event\/1\/count\?/);
});

test('earthquake_search: validation — unknown_param at the tool, adapter rules mapped 1:1 (no fetch)', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('network must not be used on a validation failure');
  });
  const unknown = await invoke(handler, '/earthquake_search?minmagnitude=5&bogus=1');
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.error.code, 'unknown_param');
  assert.equal(unknown.body.error.param, 'bogus');
  assert.equal(unknown.headers['cache-control'], 'no-store');
  const badTime = await invoke(handler, '/earthquake_search?starttime=yesterday');
  assert.equal(badTime.status, 400);
  assert.equal(badTime.body.error.code, 'invalid_param');
  assert.equal(badTime.body.error.param, 'starttime');
  const badMag = await invoke(handler, '/earthquake_search?minmagnitude=11');
  assert.equal(badMag.status, 400);
  assert.equal(badMag.body.error.param, 'minmagnitude');
  const badOrder = await invoke(handler, '/earthquake_search?orderby=depth');
  assert.equal(badOrder.status, 400);
  assert.equal(badOrder.body.error.param, 'orderby');
  // adapter-level rules pass through with the route's own code
  const partialCircle = await invoke(handler, '/earthquake_search?latitude=27&longitude=-90');
  assert.equal(partialCircle.status, 400);
  assert.equal(partialCircle.body.error.code, 'invalid_query');
  assert.match(partialCircle.body.error.message, /circle search requires/);
  const mixed = await invoke(handler, '/earthquake_search?latitude=27&longitude=-90&maxradiuskm=10&minlatitude=1');
  assert.equal(mixed.status, 400);
  assert.equal(mixed.body.error.code, 'invalid_query');
  assert.match(mixed.body.error.message, /mutually exclusive/);
  const inverted = await invoke(handler, '/earthquake_search?minlatitude=10&maxlatitude=5');
  assert.equal(inverted.status, 400);
  assert.match(inverted.body.error.message, /minlatitude must be <= maxlatitude/);
  const calendar = await invoke(handler, '/earthquake_search?starttime=2026-02-30');
  assert.equal(calendar.status, 400);
  assert.equal(calendar.body.error.code, 'invalid_query');
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('earthquake_search: USGS failures keep the Gate 3 status + code (400 rejected, 503 unavailable, 504 timeout)', async (t) => {
  const rejectedMock = t.mock.method(globalThis, 'fetch', async () =>
    new Response('Bad Request: minmagnitude out of range', { status: 400 }),
  );
  const rejected = await invoke(handler, '/earthquake_search?minmagnitude=9.5');
  assert.equal(rejected.status, 400, rejected.text);
  assert.equal(rejected.body.error.code, 'usgs_rejected');
  assert.match(rejected.body.error.message, /Bad Request/);
  assert.equal(rejectedMock.mock.callCount(), 1, '4xx is never retried');

  const unavailableMock = t.mock.method(globalThis, 'fetch', async () =>
    new Response('Service Unavailable', { status: 503 }),
  );
  const unavailable = await invoke(handler, '/earthquake_search?minmagnitude=6');
  assert.equal(unavailable.status, 503, unavailable.text);
  assert.equal(unavailable.body.ok, false);
  assert.equal(unavailable.body.error.code, 'usgs_unavailable');
  assert.equal(unavailableMock.mock.callCount(), 2, 'one retry on 5xx');

  const timeoutMock = t.mock.method(globalThis, 'fetch', async () => {
    throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  });
  const timeout = await invoke(handler, '/earthquake_search?minmagnitude=7');
  assert.equal(timeout.status, 504, timeout.text);
  assert.equal(timeout.body.error.code, 'usgs_timeout');
  assert.equal(timeoutMock.mock.callCount(), 2, 'one retry on timeout');

  const malformedMock = t.mock.method(globalThis, 'fetch', async () =>
    new Response('<html>not json</html>', { status: 200 }),
  );
  const malformed = await invoke(handler, '/earthquake_search?minmagnitude=7.5');
  assert.equal(malformed.status, 502, malformed.text);
  assert.equal(malformed.body.error.code, 'usgs_unavailable');
  assert.equal(malformedMock.mock.callCount(), 1);
});

test('earthquake_search: no env value ever leaks into a response', async (t) => {
  const sentinels = {
    NASA_FIRMS_MAP_KEY: 'sentinel-firms-key-a1b2c3',
    TOMTOM_API_KEY: 'sentinel-tomtom-key-d4e5f6',
    AISSTREAM_API_KEY: 'sentinel-aisstream-key-g7h8i9',
  };
  const saved = Object.fromEntries(Object.keys(sentinels).map((k) => [k, process.env[k]]));
  Object.assign(process.env, sentinels);
  t.mock.method(globalThis, 'fetch', async () => jsonResponse(fdsnFixture()));
  try {
    const ok = await invoke(handler, '/earthquake_search?minmagnitude=4.5&limit=2');
    const bad = await invoke(handler, '/earthquake_search?latitude=1');
    for (const res of [ok, bad]) {
      for (const value of Object.values(sentinels)) {
        assert.ok(!res.text.includes(value), `env value must never appear in a tool response (${res.status})`);
      }
    }
    assert.equal(ok.status, 200);
    assert.equal(bad.status, 400);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
