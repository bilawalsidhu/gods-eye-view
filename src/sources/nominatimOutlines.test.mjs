// Browser client for /api/geocode/outline: tri-state answers, session stop.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createNominatimOutlineClient } from './nominatimOutlines.js';

const ring = [
  [2.3, 48.8],
  [2.4, 48.8],
  [2.4, 48.9],
  [2.3, 48.9],
  [2.3, 48.8],
];

const reply = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers });

// `calls` counts outline requests only; the capability probe is answered by
// `status` and defaults to an older server without it (capability unknown).
function client(
  respond,
  { status = () => reply(404, { error: 'Not Found' }) } = {},
) {
  const calls = [];
  const probes = [];
  const lookup = createNominatimOutlineClient({
    fetchImpl: async (url) => {
      if (String(url) === '/api/geocode/status') {
        probes.push(String(url));
        return status(probes.length);
      }
      calls.push(String(url));
      return respond(calls.length);
    },
  }).lookup;
  return { calls, probes, lookup };
}

test('an accepted outline comes back with its polygons and is remembered', async () => {
  const hole = ring.map(([lon, lat]) => [
    2.35 + (lon - 2.35) / 2,
    48.85 + (lat - 48.85) / 2,
  ]);
  const { calls, lookup } = client(() =>
    reply(200, {
      status: 'OK',
      outline: {
        name: 'Paris',
        class: 'boundary',
        type: 'administrative',
        polygons: [[ring, hole]],
      },
    }),
  );
  const ask = { query: 'Paris', kind: 'city', lat: 48.85, lon: 2.35 };
  const outline = await lookup(ask);
  assert.deepEqual(outline.polygons, [[ring, hole]]);
  assert.equal(outline.class, 'boundary');
  assert.match(
    calls[0],
    /^\/api\/geocode\/outline\?q=Paris&kind=city&lat=48\.850&lon=2\.350$/,
  );
  await lookup(ask);
  assert.equal(calls.length, 1, 'one request per ask in a session');
});

test('no result is a definitive null; failures are transient undefined', async () => {
  const { lookup } = client((n) =>
    n === 1
      ? reply(200, { status: 'ZERO_RESULTS', outline: null })
      : reply(503, { error: 'x' }),
  );
  assert.equal(await lookup({ query: 'Nowhere', kind: 'landmark' }), null);
  assert.equal(await lookup({ query: 'Down', kind: 'landmark' }), undefined);
});

test('busy is rate-limited with its Retry-After', async () => {
  const { lookup } = client(() =>
    reply(429, { error: 'busy' }, { 'Retry-After': '20' }),
  );
  assert.deepEqual(await lookup({ query: 'Paris', kind: 'city' }), {
    rateLimited: true,
    retryAfterMs: 20_000,
  });
});

test('disabled, capped or missing routes stop asking for the session', async () => {
  for (const [status, body] of [
    [503, { code: 'NOMINATIM_DISABLED', retryable: false }],
    [429, { code: 'NOMINATIM_DAILY_CAP', retryable: false }],
    [404, { error: 'Not Found' }],
  ]) {
    const { calls, lookup } = client(() => reply(status, body));
    const first = await lookup({ query: 'Paris', kind: 'city' });
    assert.equal(first.unavailable, true);
    assert.equal(first.retryable, false);
    const second = await lookup({ query: 'Tokyo', kind: 'city' });
    assert.equal(second.unavailable, true);
    assert.equal(calls.length, 1, `${status}: no further requests`);
  }
});

test('bad input and malformed polygons never become outlines', async () => {
  const badRing = [
    [999, 0],
    [1, 1],
    [2, 2],
    [999, 0],
  ];
  let polygons = [[badRing]];
  const { calls, lookup } = client(() =>
    reply(200, {
      status: 'OK',
      outline: {
        polygons,
      },
    }),
  );
  assert.equal(await lookup({ query: '', kind: 'city' }), null);
  assert.equal(await lookup({ query: 'Paris', kind: 'street' }), null);
  assert.equal(calls.length, 0);
  const ask = { query: 'Paris', kind: 'city' };
  for (const malformed of [
    [[badRing]],
    [[ring, badRing]],
    [[ring], [badRing]],
    [[ring.map((_point, i) => (i === 1 ? [null, 48.8] : ring[i]))]],
    [[ring.map((_point, i) => (i === 1 ? ['2.4', 48.8] : ring[i]))]],
    [[ring.map((_point, i) => (i === 1 ? '12' : ring[i]))]],
  ]) {
    polygons = malformed;
    const before = calls.length;
    assert.equal(await lookup(ask), undefined);
    assert.equal(await lookup(ask), undefined);
    assert.equal(
      calls.length,
      before + 2,
      'malformed outlines are not remembered',
    );
  }
});

test('a cancelled ask sends nothing', async () => {
  const { calls, lookup } = client(() =>
    reply(200, { status: 'ZERO_RESULTS' }),
  );
  await assert.rejects(
    lookup({ query: 'Paris', kind: 'city' }, { signal: AbortSignal.abort() }),
    { name: 'AbortError' },
  );
  assert.equal(calls.length, 0);
});

test('a server that reports Nominatim unconfigured is never asked for outlines', async () => {
  const { calls, probes, lookup } = client(
    () => {
      throw new Error('the outline route must not be asked');
    },
    { status: () => reply(200, { configured: false }) },
  );
  const first = await lookup({ query: 'Austin High School', kind: 'landmark' });
  assert.deepEqual(first, {
    unavailable: true,
    retryable: false,
    code: 'NOMINATIM_DISABLED',
  });
  const second = await lookup({ query: 'Paris', kind: 'city' });
  assert.equal(second.unavailable, true);
  assert.equal(calls.length, 0, 'no outline request at all');
  assert.equal(probes.length, 1, 'one capability probe per session');
});

test('a configured server is asked as usual after one probe', async () => {
  const { calls, probes, lookup } = client(
    () => reply(200, { status: 'ZERO_RESULTS', outline: null }),
    { status: () => reply(200, { configured: true }) },
  );
  assert.equal(await lookup({ query: 'Nowhere', kind: 'landmark' }), null);
  assert.equal(await lookup({ query: 'Elsewhere', kind: 'landmark' }), null);
  assert.equal(calls.length, 2);
  assert.equal(probes.length, 1);
});

test('an ask cancelled while the capability probe is pending spends nothing', async () => {
  for (const [label, answer] of [
    ['configured', () => reply(200, { configured: true })],
    ['unknown', () => reply(404, { error: 'Not Found' })],
    ['unconfigured', () => reply(200, { configured: false })],
  ]) {
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const { calls, lookup } = client(
      () => reply(200, { status: 'ZERO_RESULTS', outline: null }),
      {
        status: async () => {
          await held;
          return answer();
        },
      },
    );
    const controller = new AbortController();
    const pending = lookup(
      { query: 'Paris', kind: 'city' },
      { signal: controller.signal },
    );
    controller.abort();
    release();
    await assert.rejects(pending, { name: 'AbortError' }, label);
    assert.equal(calls.length, 0, `${label}: no outline request`);
  }
});
