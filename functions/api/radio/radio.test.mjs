import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { onRequest, resetRadioStateForTest } from './[[path]].js';
import { publicRadioHttpsUrl, radioProxyDestination } from './_broker.js';

const url = (path = '') => `https://example.com/api/radio${path}`;
const ctx = (request) => ({ request });

const UUID = '12345678-1234-4234-8234-123456789abc';

function stationRow(overrides = {}) {
  return {
    stationuuid: UUID,
    name: 'Test Radio',
    url_resolved: 'https://stream.example.org/live.mp3',
    homepage: 'https://station.example.org/',
    tags: 'news,jazz',
    language: 'English',
    country: 'United States',
    countrycode: 'US',
    state: 'Texas',
    codec: 'MP3',
    bitrate: 128,
    hls: 0,
    lastcheckok: 1,
    geo_lat: 30.2672,
    geo_long: -97.7431,
    clickcount: 42,
    ...overrides,
  };
}

/**
 * Enough healthy rows to pass the health gate: unique UUIDs within a
 * response, each row tagged for the queried category so every specialist
 * query reports coverage (same fixture approach as `src/data/radioProxy.test.mjs`).
 */
function healthyCatalog(requestedUrl) {
  const tag = new URL(String(requestedUrl)).searchParams.get('tag') || 'news';
  return Array.from({ length: 500 }, (_, index) => stationRow({
    stationuuid: `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
    name: `Station ${index}`,
    tags: `news,${tag}`,
    geo_lat: -70 + (index % 140),
    geo_long: -175 + (index % 350),
    clickcount: 1000 - index,
  }));
}

/** Replace global fetch; `impl` receives {url, init}. */
function stubFetch(impl) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (fetchUrl, init) => {
    const entry = { url: String(fetchUrl), init };
    calls.push(entry);
    return impl(entry);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function directoryFetch() {
  return stubFetch(({ url: fetchUrl }) => {
    if (fetchUrl.includes('/json/servers')) {
      return Response.json([{ name: 'de1.api.radio-browser.info' }]);
    }
    if (fetchUrl.includes('/json/url/')) return Response.json({ ok: 'true' });
    return Response.json(healthyCatalog(fetchUrl));
  });
}

beforeEach(() => resetRadioStateForTest());

test('OPTIONS answers 204 with CORS preflight headers', async () => {
  const res = await onRequest(ctx(new Request(url(), { method: 'OPTIONS' })));
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
});

test('GET /stations serves the shared broker catalog with no-store', async () => {
  const stub = directoryFetch();
  try {
    const res = await onRequest(ctx(new Request(url('/stations'))));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    const body = await res.json();
    assert.equal(body.stations.length, 500);
    assert.equal(body.acceptedGeneration, 1);
    assert.equal(body.stale, false);
    assert.equal(typeof body.catalogInstance, 'string');
    assert.equal('favicon' in body.stations[0], false);
  } finally {
    stub.restore();
  }
});

test('every outbound request honors the broker destination policy', async () => {
  const stub = directoryFetch();
  try {
    await onRequest(ctx(new Request(url('/stations'))));
    for (const call of stub.calls) {
      assert.match(call.url, /^https:\/\/[a-z0-9-]+\.api\.radio-browser\.info\//, call.url);
      assert.equal(call.init.redirect, 'manual', call.url);
    }
  } finally {
    stub.restore();
  }
});

test('catalog failure surfaces the dev 503 shape, never an HTML page', async () => {
  const stub = stubFetch(() => new Response('', { status: 302, headers: { Location: 'https://127.0.0.1/private' } }));
  try {
    const res = await onRequest(ctx(new Request(url('/stations'))));
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
    const body = await res.json();
    assert.equal(body.error, 'Radio directory is temporarily unavailable');
    assert.equal(body.degraded, true);
    assert.equal(typeof body.degradedReason, 'string');
  } finally {
    stub.restore();
  }
});

test('POST click is refused for a station this instance never served', async () => {
  const stub = stubFetch(() => { throw new Error('must not fetch'); });
  try {
    const res = await onRequest(ctx(new Request(url(`/click/${UUID}`), { method: 'POST' })));
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'Unknown radio station' });
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test('POST click for a served station answers 204 and fires the ping', async () => {
  const stub = directoryFetch();
  try {
    const served = await onRequest(ctx(new Request(url('/stations'))));
    assert.equal(served.status, 200);
    const { stations } = await served.json();
    const servedId = stations[0].id;
    const click = await onRequest(ctx(new Request(url(`/click/${servedId}`), { method: 'POST' })));
    assert.equal(click.status, 204);
    assert.equal(click.headers.get('cache-control'), 'no-store');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(stub.calls.filter((call) => call.url.includes(`/json/url/${servedId}`)).length, 1);
  } finally {
    stub.restore();
  }
});

test('wrong methods get the dev empty 405 with Allow, before any upstream work', async () => {
  const stub = stubFetch(() => { throw new Error('must not fetch'); });
  try {
    const stations = await onRequest(ctx(new Request(url('/stations'), { method: 'POST' })));
    assert.equal(stations.status, 405);
    assert.equal(stations.headers.get('allow'), 'GET');
    const click = await onRequest(ctx(new Request(url(`/click/${UUID}`), { method: 'GET' })));
    assert.equal(click.status, 405);
    assert.equal(click.headers.get('allow'), 'POST');
    assert.equal(await stations.text(), '');
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test('unknown subpaths get the dev 404 shape', async () => {
  const res = await onRequest(ctx(new Request(url('/anything-else'))));
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'Unknown radio route' });
});

test('URL policy helpers refuse unparseable input instead of throwing', () => {
  for (const junk of ['', 'not a url at all', '::::', 'https://', '%zz']) {
    assert.equal(publicRadioHttpsUrl(junk), null, JSON.stringify(junk));
    assert.equal(radioProxyDestination(junk), null, JSON.stringify(junk));
  }
  // The accepting counterparts, so the refusals above mean "parsed and
  // rejected on policy", never "every input is dropped".
  assert.equal(publicRadioHttpsUrl('https://stream.example.com/live.mp3#frag'), 'https://stream.example.com/live.mp3');
  assert.equal(
    radioProxyDestination('https://de1.api.radio-browser.info/json/stations/search?name=kpop')?.host,
    'de1.api.radio-browser.info',
  );
});
