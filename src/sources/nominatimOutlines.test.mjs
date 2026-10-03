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

function client(respond) {
  const calls = [];
  const lookup = createNominatimOutlineClient({
    fetchImpl: async (url) => {
      calls.push(String(url));
      return respond(calls.length);
    },
  }).lookup;
  return { calls, lookup };
}

const reply = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers });

test('an accepted outline comes back with its polygons and is remembered', async () => {
  const { calls, lookup } = client(() =>
    reply(200, {
      status: 'OK',
      outline: {
        name: 'Bagmati Province',
        adminArea: 'Bagmati Province',
        adminLevel: 'admin1',
        class: 'boundary',
        type: 'administrative',
        polygons: [[ring]],
      },
    }),
  );
  const ask = {
    query: 'Bagmati Province',
    kind: 'admin',
    lat: 27.72,
    lon: 85.32,
  };
  const outline = await lookup(ask);
  assert.deepEqual(outline.polygons, [[ring]]);
  assert.equal(outline.class, 'boundary');
  assert.equal(outline.adminArea, 'Bagmati Province');
  assert.equal(outline.adminLevel, 'admin1');
  assert.match(
    calls[0],
    /^\/api\/geocode\/outline\?q=Bagmati\+Province&kind=admin&lat=27\.720&lon=85\.320$/,
  );
  await lookup(ask);
  assert.equal(calls.length, 1, 'one request per ask in a session');
});

test('no result is a definitive null; failures are transient undefined', async () => {
  const { lookup } = client((n) =>
    n === 1 ? reply(200, { status: 'ZERO_RESULTS', outline: null }) : reply(503, { error: 'x' }),
  );
  assert.equal(await lookup({ query: 'Nowhere', kind: 'landmark' }), null);
  assert.equal(await lookup({ query: 'Down', kind: 'landmark' }), undefined);
});

test('busy is rate-limited with its Retry-After', async () => {
  const { lookup } = client(() => reply(429, { error: 'busy' }, { 'Retry-After': '20' }));
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
  const { calls, lookup } = client(() =>
    reply(200, { status: 'OK', outline: { polygons: [[[[999, 0], [1, 1], [2, 2], [999, 0]]]] } }),
  );
  assert.equal(await lookup({ query: '', kind: 'city' }), null);
  assert.equal(await lookup({ query: 'Paris', kind: 'street' }), null);
  assert.equal(calls.length, 0);
  assert.equal(await lookup({ query: 'Paris', kind: 'city' }), undefined);
});

test('a cancelled ask sends nothing', async () => {
  const { calls, lookup } = client(() => reply(200, { status: 'ZERO_RESULTS' }));
  await assert.rejects(
    lookup({ query: 'Paris', kind: 'city' }, { signal: AbortSignal.abort() }),
    { name: 'AbortError' },
  );
  assert.equal(calls.length, 0);
});
