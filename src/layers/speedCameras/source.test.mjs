import assert from 'node:assert/strict';
import test from 'node:test';
import { createSpeedCameraSource } from './source.js';

const BOX = { south: -27.7, west: 152.8, north: -27.2, east: 153.3 };

/** Routing fetchImpl: answers the status probe, then the query POST. */
function routedFetch({ configured = true, onQuery } = {}) {
  // `configured` may be a boolean or a () => boolean for tests that flip the
  // server's answer mid-flight.
  const configuredNow = () =>
    typeof configured === 'function' ? configured() : configured;
  const calls = [];
  const impl = async (url, init) => {
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: init?.body,
    });
    if (url === '/api/overpass/status')
      return {
        ok: true,
        json: async () => ({ configured: configuredNow() }),
      };
    return onQuery(url, init, calls);
  };
  impl.calls = calls;
  return impl;
}

function jsonResponse(elements, extra = {}) {
  return {
    ok: true,
    headers: { get: (name) => (name === 'x-overpass-cache' ? 'MISS' : null) },
    json: async () => ({ version: 0.6, elements, ...extra }),
  };
}

test('fetch resolves normalized, deduplicated camera records', async () => {
  const fetchImpl = routedFetch({
    onQuery: (url) =>
      jsonResponse([
        {
          type: 'node',
          id: 21475863,
          lat: -27.5973715,
          lon: 152.8353603,
          tags: { highway: 'speed_camera', maxspeed: '100' },
        },
        {
          type: 'node',
          id: 21475863,
          lat: -27.5973715,
          lon: 152.8353603,
          tags: { highway: 'speed_camera', maxspeed: '100' },
        },
        {
          type: 'node',
          id: 7,
          lat: -27.5,
          lon: 152.9,
          tags: { highway: 'surveillance' },
        },
      ]),
  });
  const source = createSpeedCameraSource({ fetchImpl });
  const snapshot = await source.fetch(BOX, undefined);
  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(fetchImpl.calls[0].url, '/api/overpass/status');
  assert.equal(fetchImpl.calls[1].url, '/api/overpass');
  assert.equal(fetchImpl.calls[1].method, 'POST');
  const query = decodeURIComponent(
    fetchImpl.calls.find((c) => c.url === '/api/overpass').method === 'POST'
      ? fetchImpl.calls.find((c) => c.url === '/api/overpass').body
      : undefined,
  );
  assert.match(query, /node\["highway"="speed_camera"\]/);
  assert.match(query, /out body 1500;/);
  assert.equal(snapshot.records.length, 1);
  assert.equal(snapshot.records[0].id, 'speed-camera:21475863');
  assert.equal(snapshot.records[0].maxspeedKph, 100);
  assert.equal(snapshot.stale, false);
  assert.equal(snapshot.saturated, false);
});

test('fetch rejects unbounded and malformed boxes', async () => {
  const fetchImpl = routedFetch({
    onQuery: () => {
      throw new Error('must not be called');
    },
  });
  const source = createSpeedCameraSource({ fetchImpl });
  await assert.rejects(source.fetch(null), TypeError);
  await assert.rejects(
    source.fetch({ south: -90, west: -180, north: 90, east: 180 }),
    TypeError,
  );
  await assert.rejects(
    source.fetch({ south: 'x', west: 0, north: 1, east: 2 }),
    TypeError,
  );
  assert.equal(
    fetchImpl.calls.length,
    0,
    'a malformed box must not probe or query',
  );
});

test('fetch maps HTTP failures to honest error states', async () => {
  for (const [status, message] of [
    [429, 'Overpass rate-limited'],
    [504, 'Overpass timed out'],
    [500, 'Overpass temporarily unavailable'],
    // A plain 503 (the proxy busy, no OVERPASS_NOT_CONFIGURED code) must not
    // be labelled "not configured" — that label belongs to the payload code.
    [503, 'Overpass temporarily unavailable'],
  ]) {
    const source = createSpeedCameraSource({
      fetchImpl: routedFetch({
        onQuery: async () => ({
          ok: false,
          status,
          json: async () => ({}),
        }),
      }),
    });
    await assert.rejects(source.fetch(BOX), { message });
  }
});

test("a busy proxy's plain 503 keeps retryable:true and does not latch", async () => {
  let queries = 0;
  const source = createSpeedCameraSource({
    fetchImpl: routedFetch({
      onQuery: async () => {
        queries++;
        return {
          ok: false,
          status: 503,
          json: async () => ({
            error: 'Overpass proxy busy — try again shortly',
          }),
        };
      },
    }),
  });
  await assert.rejects(source.fetch(BOX), (error) => {
    assert.match(error.message, /temporarily unavailable/);
    assert.doesNotMatch(error.message, /not configured/);
    assert.equal(error.retryable, true);
    assert.equal(error.code, undefined);
    return true;
  });
  // Not latched: the next fetch asks again (the proxy may free up).
  await assert.rejects(source.fetch(BOX), /temporarily unavailable/);
  assert.equal(queries, 2);
});

test('an unconfigured proxy answers not-configured without a POST, once probed', async (t) => {
  let configured = false;
  const fetchImpl = routedFetch({
    configured: () => configured,
    onQuery: () => {
      if (!configured) throw new Error('the query POST must not happen');
      return jsonResponse([]);
    },
  });
  const source = createSpeedCameraSource({ fetchImpl });
  for (let i = 0; i < 3; i++) {
    await assert.rejects(source.fetch(BOX), (error) => {
      assert.match(error.message, /Overpass is not configured/);
      assert.equal(error.code, 'OVERPASS_NOT_CONFIGURED');
      assert.equal(error.retryable, false);
      return true;
    });
  }
  assert.equal(
    fetchImpl.calls.filter((call) => call.url === '/api/overpass').length,
    0,
  );
  assert.equal(
    fetchImpl.calls.filter((call) => call.url === '/api/overpass/status')
      .length,
    1,
    'the miss holds within the retry window — no probe or POST per pan',
  );
  // Past the retry window the miss is re-probed; a configured answer then
  // flows through to the query POST (an operator may set upstreams live).
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  t.mock.timers.tick(30_001);
  configured = true;
  const snapshot = await source.fetch(BOX, undefined);
  assert.equal(snapshot.records.length, 0);
  assert.equal(
    fetchImpl.calls.filter((call) => call.url === '/api/overpass').length,
    1,
    'the flipped probe lets the query through',
  );
});

test('resetCapability forgets the answer so the next fetch re-probes', async () => {
  let configured = false;
  const fetchImpl = routedFetch({
    configured: () => configured,
    onQuery: () => jsonResponse([]),
  });
  const source = createSpeedCameraSource({ fetchImpl });
  await assert.rejects(source.fetch(BOX), /Overpass is not configured/);
  assert.equal(
    fetchImpl.calls.filter((call) => call.url === '/api/overpass/status')
      .length,
    1,
  );
  // Without a reset (and inside the retry window) the miss still holds.
  await assert.rejects(source.fetch(BOX), /Overpass is not configured/);
  assert.equal(
    fetchImpl.calls.filter((call) => call.url === '/api/overpass/status')
      .length,
    1,
  );
  // The layer calls this on a fresh enable; the next fetch asks again.
  source.resetCapability();
  configured = true;
  const snapshot = await source.fetch(BOX, undefined);
  assert.equal(snapshot.records.length, 0);
  assert.equal(
    fetchImpl.calls.filter((call) => call.url === '/api/overpass/status')
      .length,
    2,
    'resetCapability forces a fresh probe',
  );
  assert.equal(
    fetchImpl.calls.filter((call) => call.url === '/api/overpass').length,
    1,
  );
});

test('a 503 OVERPASS_NOT_CONFIGURED POST latches the capability', async () => {
  let queries = 0;
  const source = createSpeedCameraSource({
    fetchImpl: routedFetch({
      // Probe says configured, but the POST still answers the capability miss
      // (an older server without the status route, or a race).
      onQuery: async () => {
        queries++;
        if (queries === 1)
          return {
            ok: false,
            status: 503,
            json: async () => ({
              error: 'Detailed OpenStreetMap queries are not configured',
              code: 'OVERPASS_NOT_CONFIGURED',
              retryable: false,
            }),
          };
        throw new Error('the second query must not happen');
      },
    }),
  });
  await assert.rejects(source.fetch(BOX), (error) => {
    assert.match(error.message, /Overpass is not configured/);
    assert.equal(error.retryable, false);
    return true;
  });
  await assert.rejects(source.fetch(BOX), /Overpass is not configured/);
  assert.equal(queries, 1, 'the latched miss short-circuits later fetches');
});

test('a failed probe falls through to the query (older server)', async () => {
  const calls = [];
  const source = createSpeedCameraSource({
    fetchImpl: async (url, init) => {
      calls.push(url);
      if (url === '/api/overpass/status')
        return { ok: false, status: 404, json: async () => ({}) };
      return jsonResponse([]);
    },
  });
  const snapshot = await source.fetch(BOX, undefined);
  assert.deepEqual(calls, ['/api/overpass/status', '/api/overpass']);
  assert.equal(snapshot.records.length, 0);
});

test('fetch rejects incomplete payloads instead of showing empty maps', async () => {
  const source = createSpeedCameraSource({
    fetchImpl: routedFetch({
      onQuery: () => jsonResponse([], { remark: 'runtime error: timed out' }),
    }),
  });
  await assert.rejects(source.fetch(BOX), {
    message: 'Overpass returned an incomplete camera response',
  });
  const malformed = createSpeedCameraSource({
    fetchImpl: routedFetch({ onQuery: () => jsonResponse(undefined) }),
  });
  await assert.rejects(malformed.fetch(BOX), {
    message: 'Overpass returned an incomplete camera response',
  });
});

test('fetch reports saturation and stale provenance', async () => {
  const elements = Array.from({ length: 1500 }, (_, i) => ({
    type: 'node',
    id: 1000 + i,
    lat: -27.5 + i * 0.0001,
    lon: 152.9,
    tags: { highway: 'speed_camera' },
  }));
  const source = createSpeedCameraSource({
    fetchImpl: routedFetch({
      onQuery: () => ({
        ok: true,
        headers: { get: () => 'STALE' },
        json: async () => ({ version: 0.6, elements }),
      }),
    }),
  });
  const snapshot = await source.fetch(BOX, undefined);
  assert.equal(snapshot.saturated, true);
  assert.equal(snapshot.stale, true);
  assert.equal(snapshot.records.length, 1500);
});

test('fetch honors abort signals mid-flight', async () => {
  const controller = new AbortController();
  let queryStarted;
  const queryStartedPromise = new Promise((r) => (queryStarted = r));
  const source = createSpeedCameraSource({
    fetchImpl: routedFetch({
      onQuery: (url, init) => {
        queryStarted();
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        });
      },
    }),
  });
  const pending = source.fetch(BOX, controller.signal);
  await queryStartedPromise; // the probe resolves first; abort mid-query
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});

test('source carries OpenStreetMap attribution', () => {
  const source = createSpeedCameraSource();
  assert.equal(source.attribution.text, '© OpenStreetMap contributors');
  assert.equal(source.label, 'OpenStreetMap · community mapped');
});
