// OPENSKY TRACK BACKFILL — the credit budget the per-icao cache does not guard.
//
// `/api/opensky-track` spends 4 OpenSky credits per call against the same
// ~4000/day account as `/api/opensky`. Its 60s per-icao cache bounds MEMORY,
// not spend: `icao24` is six hex digits, so a caller that varies it walks past
// the cache into a live, credit-consuming call every time.
//
// These cases drive the real exported route handlers. No network: `fetch` is
// stubbed per test and restored afterwards, so a case that reaches upstream
// fails loudly rather than making a request.
//
// NOTE: the 429 cooldown is module-scoped state in `opensky.js` and, once set,
// stays set for the life of the process (bounded 30s…30min). The case that
// arms it therefore runs LAST, and nothing after it may assume a clear
// governor. Node runs each test file in its own process, so this is contained.
//
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trackBackfillProxies } from '../server/providers/aircraft/tracks.js';
import {
  openSkyProxy,
  openSkyCooldownRemainingMs,
} from '../server/providers/aircraft/opensky.js';

/** Collect a plugin's routes into a path → handler map. */
function install(plugin) {
  const routes = new Map();
  const server = {
    middlewares: {
      use(path, handler) {
        routes.set(path, handler);
      },
    },
  };
  plugin.configureServer(server);
  return routes;
}

function request(handler, { url = '/', remoteAddress = '127.0.0.1' } = {}) {
  return new Promise((resolve, reject) => {
    const headers = new Map();
    const req = { method: 'GET', url, headers: {}, socket: { remoteAddress } };
    const res = {
      statusCode: 200,
      setHeader(name, value) {
        headers.set(String(name).toLowerCase(), String(value));
      },
      writeHead(status, hdrs = {}) {
        this.statusCode = status;
        for (const [name, value] of Object.entries(hdrs))
          headers.set(String(name).toLowerCase(), String(value));
      },
      end(body = '') {
        let parsed = null;
        try {
          parsed = body ? JSON.parse(String(body)) : null;
        } catch {
          parsed = String(body);
        }
        resolve({
          statusCode: this.statusCode,
          headers: Object.fromEntries(headers),
          body: parsed,
        });
      },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

/** Replace global fetch for one test, restoring it afterwards. */
function stubFetch(t, impl) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  t.after(() => {
    globalThis.fetch = original;
  });
}

/** An OpenSky /tracks/all answer, shaped like the real one. */
const trackOk = () =>
  new Response(JSON.stringify({ path: [] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

test('a caller cycling icao24 cannot walk past the per-icao cache unthrottled', async (t) => {
  let upstreamCalls = 0;
  stubFetch(t, async () => {
    upstreamCalls += 1;
    return trackOk();
  });
  const track = install(trackBackfillProxies()).get('/api/opensky-track');

  const allowed = [];
  for (let i = 0; i < 30; i += 1) {
    // A DIFFERENT icao24 every time: each one is a fresh cache key, which is
    // exactly the path the 60s cache cannot see.
    const icao24 = (0x400000 + i).toString(16).padStart(6, '0');
    allowed.push(await request(track, { url: `/?icao24=${icao24}` }));
  }
  assert.equal(
    allowed.filter((r) => r.statusCode === 429).length,
    0,
    'the first 30 distinct lookups in a minute are ordinary use',
  );

  const refused = await request(track, { url: '/?icao24=4affff' });
  assert.equal(refused.statusCode, 429, 'the 31st distinct lookup is refused');
  assert.deepEqual(refused.body, { error: 'Rate limit exceeded' });
  assert.ok(
    Number(refused.headers['retry-after']) >= 1,
    'a refusal tells the caller when to come back',
  );
  assert.equal(
    upstreamCalls,
    30,
    'the refused request never reached OpenSky — the point is the credits',
  );
});

test('each client gets its own quota rather than sharing one bucket', async (t) => {
  stubFetch(t, async () => trackOk());
  const track = install(trackBackfillProxies()).get('/api/opensky-track');

  for (let i = 0; i < 30; i += 1)
    await request(track, {
      url: `/?icao24=${(0x500000 + i).toString(16)}`,
      remoteAddress: '198.51.100.7',
    });
  const exhausted = await request(track, {
    url: '/?icao24=5affff',
    remoteAddress: '198.51.100.7',
  });
  assert.equal(exhausted.statusCode, 429);

  const neighbour = await request(track, {
    url: '/?icao24=5abbbb',
    remoteAddress: '198.51.100.8',
  });
  assert.notEqual(
    neighbour.statusCode,
    429,
    'one noisy host must not take the layer away from everyone else',
  );
});

test('adsb.lol traces are metered too, for the operator IP reputation', async (t) => {
  stubFetch(t, async () => new Response('{"trace":[]}', { status: 200 }));
  const trace = install(trackBackfillProxies()).get('/api/adsblol/trace');

  for (let i = 0; i < 30; i += 1)
    await request(trace, { url: `/?hex=${(0x600000 + i).toString(16)}` });
  const refused = await request(trace, { url: '/?hex=6affff' });
  assert.equal(refused.statusCode, 429);
});

test('a malformed icao24 is still rejected before any upstream call', async (t) => {
  let upstreamCalls = 0;
  stubFetch(t, async () => {
    upstreamCalls += 1;
    return trackOk();
  });
  const track = install(trackBackfillProxies()).get('/api/opensky-track');
  const bad = await request(track, { url: '/?icao24=nothex' });
  assert.equal(bad.statusCode, 400);
  assert.equal(upstreamCalls, 0);
});

test('the governor is clear until OpenSky says otherwise', () => {
  assert.equal(openSkyCooldownRemainingMs(), 0);
  // Injectable clock: a cooldown in the past never reads as active.
  assert.equal(openSkyCooldownRemainingMs(Date.now() + 60_000), 0);
});

// --- LAST: arming the cooldown is one-way for this process (see file header).
test('while /api/opensky is in its credit cooldown, track backfill stands down', async (t) => {
  let trackUpstreamCalls = 0;
  stubFetch(t, async (url) => {
    if (
      String(url).includes('/api/states/all') ||
      String(url).includes('states/all')
    ) {
      // OpenSky refusing for budget: this is what arms the shared governor.
      return new Response('{}', {
        status: 429,
        headers: { 'x-rate-limit-retry-after-seconds': '120' },
      });
    }
    trackUpstreamCalls += 1;
    return trackOk();
  });

  const states = install(openSkyProxy()).get('/api/opensky');
  await request(states, { url: '/' });
  assert.ok(
    openSkyCooldownRemainingMs() > 0,
    'the 429 from OpenSky arms the shared cooldown',
  );

  const track = install(trackBackfillProxies()).get('/api/opensky-track');
  const refused = await request(track, { url: '/?icao24=7a1b2c' });
  assert.equal(
    refused.statusCode,
    429,
    'a cold backfill during the cooldown is refused, not minted',
  );
  assert.ok(
    Number(refused.headers['retry-after']) > 1,
    'the refusal carries the remaining cooldown, not a fixed guess',
  );
  assert.equal(
    trackUpstreamCalls,
    0,
    'no credits are spent while the account is already out of budget',
  );
});
