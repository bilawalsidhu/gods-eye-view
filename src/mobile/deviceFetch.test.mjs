import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeviceFetch } from './deviceFetch.js';
import { createOverpassDirectSource } from './adapters/overpassDirect.js';
import {
  createCctvDirectSource,
  setCctvCatalog,
} from './adapters/cctvDirect.js';

/** Stub native transport: records requests, answers canned payloads. */
function stubTransport(handler) {
  const calls = [];
  const transport = {
    request: async (options) => {
      calls.push(options);
      return handler(options, calls);
    },
  };
  return { calls, transport };
}

const jsonBytes = (payload) =>
  new TextEncoder().encode(JSON.stringify(payload));

test('device fetch answers real Responses through the stub transport', async () => {
  const { calls, transport } = stubTransport((options) => ({
    status: 200,
    headers: { 'content-type': 'application/json' },
    data: jsonBytes({ ok: true }),
    url: options.url,
  }));
  const fetchImpl = createDeviceFetch({ transport });
  const response = await fetchImpl('https://nowcoast.noaa.gov/x', {});
  assert.ok(response instanceof Response);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/json');
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://nowcoast.noaa.gov/x');
});

test('device fetch enforces the registry before touching the transport', async () => {
  const { calls, transport } = stubTransport(() => {
    throw new Error('transport must not run for refused hosts');
  });
  const fetchImpl = createDeviceFetch({ transport });
  await assert.rejects(fetchImpl('https://evil.example/x', {}), (error) => {
    assert.equal(error.code, 'UPSTREAM_NOT_ALLOWED');
    return true;
  });
  assert.equal(calls.length, 0);
});

test('device fetch applies mirror and catalog init', async () => {  const { transport } = stubTransport(() => ({
    status: 200,
    headers: {},
    data: new Uint8Array(0),
    url: 'https://o.example/api/interpreter',
  }));
  try {
    createDeviceFetch({
      transport,
      mirrors: ['https://o.example/api/interpreter'],
      cctvCatalog: [{ id: 'c1', name: 'Cam 1' }],
    });
    // Mirrors configured: the factory no longer throws for missing mirrors.
    const overpass = createOverpassDirectSource({
      fetchImpl: async () => new Response('{}'),
    });
    assert.ok(typeof overpass.query === 'function');
    const cctv = createCctvDirectSource({
      fetchImpl: async () => new Response('{}'),
    });
    assert.deepEqual(
      (await cctv.getCatalog()).map((camera) => camera.id),
      ['c1'],
    );
  } finally {
    setCctvCatalog([]);
  }
});

test('device fetch forwards redirect and surfaces the final URL', async () => {
  const { calls, transport } = stubTransport((options) => ({
    status: 200,
    headers: { 'content-type': 'text/plain' },
    data: new TextEncoder().encode('moved'),
    url: 'https://nowcoast.noaa.gov/final',
  }));
  const fetchImpl = createDeviceFetch({ transport });
  const redirected = await fetchImpl('https://nowcoast.noaa.gov/start', {
    redirect: 'error',
  });
  assert.equal(calls[0].redirect, 'error');
  assert.equal(redirected.url, 'https://nowcoast.noaa.gov/final');
  assert.equal(redirected.redirected, true);

  const direct = await fetchImpl('https://nowcoast.noaa.gov/final', {});
  assert.equal(calls[1].redirect, 'follow');
  assert.equal(direct.url, 'https://nowcoast.noaa.gov/final');
  assert.equal(direct.redirected, false);
});
