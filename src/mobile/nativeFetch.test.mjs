import test from 'node:test';
import assert from 'node:assert/strict';
import { FAMILY_HOSTS } from './upstreamRegistry.js';
import { createNativeFetch } from './nativeFetch.js';

/** Encode bytes the way CapacitorHttp does for responseType 'arraybuffer'. */
function toTransportData(bytes) {
  return Buffer.from(bytes).toString('base64');
}

/** Minimal stub of the CapacitorHttp transport surface used by nativeFetch. */
function createStubTransport({ status = 200, headers = {}, bytes = null, text = null } = {}) {
  const calls = [];
  const payload = bytes ?? new TextEncoder().encode(text ?? '');
  return {
    calls,
    request: async (options) => {
      calls.push(options);
      return {
        data: toTransportData(payload),
        headers,
        status,
        url: options.url,
      };
    },
  };
}

/** Failing transport: rejects instead of resolving (must surface, never hang). */
function createFailingTransport(message = 'boom') {
  return {
    calls: [],
    request: async (options) => {
      options; // recorded only to prove the call happened before failing
      throw new Error(message);
    },
  };
}

test('FAMILY_HOSTS covers every on-device family from the upstream inventory', () => {
  const families = Object.keys(FAMILY_HOSTS).sort();
  assert.deepEqual(families, [
    'adsbdb',
    'cctv',
    'cyclones',
    'earthquakes',
    'firePerimeters',
    'firms',
    'flights',
    'gbfs',
    'geocode',
    'google',
    'imagery',
    'launches',
    'localReceivers',
    'mapillary',
    'noaaTiles',
    'openai',
    'overpass',
    'radio',
    'route',
    'satellites',
    'terrain',
    'tomtom',
    'transit',
    'vessels',
    'weather',
    'wind',
  ]);
  for (const family of families) {
    assert.ok(
      Array.isArray(FAMILY_HOSTS[family].hosts),
      `${family} needs a hosts list`,
    );
    assert.ok(
      Array.isArray(FAMILY_HOSTS[family].paths),
      `${family} needs a paths list`,
    );
  }
});

test('allowed host+path passes through to the transport', async () => {
  const transport = createStubTransport({ text: '{"a":1}' });
  const fetchImpl = createNativeFetch({ transport });
  const response = await fetchImpl(
    'https://api.open-meteo.com/v1/forecast?latitude=1&longitude=2',
  );
  assert.equal(transport.calls.length, 1);
  assert.equal(
    transport.calls[0].url,
    'https://api.open-meteo.com/v1/forecast?latitude=1&longitude=2',
  );
  assert.equal(response.status, 200);
  assert.equal(response.ok, true);
  assert.deepEqual(await response.json(), { a: 1 });
  assert.equal(await response.text(), '{"a":1}');
});

test('unlisted host is refused before any network traffic', async () => {
  const transport = createStubTransport({ text: '{}' });
  const fetchImpl = createNativeFetch({ transport });
  let error = null;
  try {
    await fetchImpl('https://evil.example/collect');
  } catch (caught) {
    error = caught;
  }
  assert.ok(error, 'expected fetch to reject');
  assert.equal(error.code, 'UPSTREAM_NOT_ALLOWED');
  assert.equal(transport.calls.length, 0);
});

test('http URL carrying a query-string key is refused without network', async () => {
  const transport = createStubTransport({ text: '{}' });
  const fetchImpl = createNativeFetch({ transport });
  let error = null;
  try {
    await fetchImpl('http://api.open-meteo.com/v1/forecast?key=secret-value');
  } catch (caught) {
    error = caught;
  }
  assert.ok(error, 'expected fetch to reject');
  assert.equal(error.code, 'UPSTREAM_NOT_ALLOWED');
  assert.equal(transport.calls.length, 0);
});

test('allowed host with a disallowed path is refused without network', async () => {
  const transport = createStubTransport({ text: '{}' });
  const fetchImpl = createNativeFetch({ transport });
  let error = null;
  try {
    await fetchImpl('https://gbfs.lyft.com/admin/rotate-keys');
  } catch (caught) {
    error = caught;
  }
  assert.ok(error, 'expected fetch to reject');
  assert.equal(error.code, 'UPSTREAM_NOT_ALLOWED');
  assert.equal(transport.calls.length, 0);
});

test('oversized body throws RESPONSE_TOO_LARGE via the shared capped readers', async () => {
  const transport = createStubTransport({
    text: '{"data":"0123456789abcdef"}',
  });
  const fetchImpl = createNativeFetch({ transport, defaultCapBytes: 8 });
  const response = await fetchImpl('https://api.open-meteo.com/v1/forecast');
  assert.equal(response.status, 200);
  let error = null;
  try {
    await response.text();
  } catch (caught) {
    error = caught;
  }
  assert.ok(error, 'expected text() to reject');
  assert.equal(error.code, 'RESPONSE_TOO_LARGE');
});

test('transport errors surface as thrown errors instead of hanging', async () => {
  const fetchImpl = createNativeFetch({
    transport: createFailingTransport('native offline'),
  });
  await assert.rejects(
    fetchImpl('https://api.open-meteo.com/v1/forecast'),
    /native offline/,
  );
});

test('CelesTrak TLE flows through the native path to bytes (stubbed transport)', async () => {
  const tle =
    'ISS (ZARYA)\n' +
    '1 25544U 98067A   25324.517Q  .00016717  00000-0  10270-3 0  9000\n' +
    '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125332493416\n';
  const transport = createStubTransport({
    headers: { 'content-type': 'text/plain' },
    bytes: new TextEncoder().encode(tle),
  });
  const fetchImpl = createNativeFetch({ transport });
  const response = await fetchImpl(
    'https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=tle',
  );
  assert.equal(transport.calls.length, 1);
  assert.equal(response.ok, true);
  assert.equal(response.headers.get('content-type'), 'text/plain');
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.equal(new TextDecoder().decode(bytes), tle);
});
