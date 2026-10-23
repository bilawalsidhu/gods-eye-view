// OPENSKY TRACK BACKFILL — the credit budget the per-icao cache does not guard.
//
// `/api/flights/track` spends 4 OpenSky credits per call from the `/tracks/*`
// bucket. OpenSky keeps three independent daily buckets (`/states/*`,
// `/tracks/*`, `/flights/*`), so this route neither spends nor is blocked by
// the `/states/all` budget `/api/flights` governs. Its 60s per-icao cache
// bounds MEMORY, not spend: `icao24` is six hex digits, so a caller that varies
// it walks past the cache into a live, credit-consuming call every time.
//
// These cases drive the real exported route handlers. No network: `fetch` is
// stubbed per test and restored afterwards, so a case that reaches upstream
// fails loudly rather than making a request.
//
// NOTE: the `/states/all` cooldown is module-scoped state in `opensky.js` and,
// once set, stays set for the life of the process (bounded 30s…30min). The case
// that arms it therefore runs LAST. The tracks cooldown lives in each
// `trackBackfillProxies()` instance, so every test gets a clear one.
//
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trackBackfillProxies } from '../server/providers/aircraft/tracks.js';
import { openSkyProxy } from '../server/providers/aircraft/opensky.js';

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
  const track = install(trackBackfillProxies()).get('/api/flights/track');

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
  assert.equal(
    refused.headers['retry-after'],
    '60',
    'a refusal names the limiter window, not a shorter guess',
  );
  assert.equal(
    upstreamCalls,
    30,
    'the refused request never reached OpenSky — the point is the credits',
  );
});

test('each client gets its own quota rather than sharing one bucket', async (t) => {
  stubFetch(t, async () => trackOk());
  const track = install(trackBackfillProxies()).get('/api/flights/track');

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
  const trace = install(trackBackfillProxies()).get('/api/military/track');

  for (let i = 0; i < 30; i += 1)
    await request(trace, { url: `/?hex=${(0x600000 + i).toString(16)}` });
  const refused = await request(trace, { url: '/?hex=6affff' });
  assert.equal(refused.statusCode, 429);
});

test('the two routes meter separately, since they spend different upstreams', async (t) => {
  stubFetch(t, async (url) =>
    String(url).includes('adsb.lol')
      ? new Response('{"trace":[]}', { status: 200 })
      : trackOk(),
  );
  const routes = install(trackBackfillProxies());
  const track = routes.get('/api/flights/track');
  const trace = routes.get('/api/military/track');

  for (let i = 0; i < 30; i += 1)
    await request(track, { url: `/?icao24=${(0x610000 + i).toString(16)}` });
  assert.equal(
    (await request(track, { url: '/?icao24=61ffff' })).statusCode,
    429,
  );
  const military = await request(trace, { url: '/?hex=62aaaa' });
  assert.equal(
    military.statusCode,
    200,
    'spending the OpenSky quota leaves the adsb.lol one untouched',
  );
});

test('a 429 from /tracks stands every other icao24 down until it clears', async (t) => {
  let upstreamCalls = 0;
  stubFetch(t, async () => {
    upstreamCalls += 1;
    return new Response('{}', {
      status: 429,
      headers: { 'x-rate-limit-retry-after-seconds': '120' },
    });
  });
  const track = install(trackBackfillProxies()).get('/api/flights/track');

  const first = await request(track, { url: '/?icao24=71a001' });
  assert.equal(first.statusCode, 429);
  assert.equal(upstreamCalls, 1);

  // A DIFFERENT key: the per-icao cache cannot see it, only the cooldown can.
  const second = await request(track, { url: '/?icao24=71a002' });
  assert.equal(second.statusCode, 429, 'refused locally');
  assert.equal(
    upstreamCalls,
    1,
    'the /tracks bucket is empty, so no further credits are asked for',
  );
  const retryAfter = Number(second.headers['retry-after']);
  assert.ok(
    retryAfter > 60 && retryAfter <= 120,
    `the refusal carries OpenSky's remaining cooldown (got ${retryAfter})`,
  );
});

test('a cached track is still served while /tracks is cooling', async (t) => {
  let cooling = false;
  stubFetch(t, async () =>
    cooling
      ? new Response('{}', {
          status: 429,
          headers: { 'x-rate-limit-retry-after-seconds': '120' },
        })
      : trackOk(),
  );
  const track = install(trackBackfillProxies()).get('/api/flights/track');

  assert.equal(
    (await request(track, { url: '/?icao24=72b001' })).statusCode,
    200,
  );
  cooling = true;
  assert.equal(
    (await request(track, { url: '/?icao24=72b002' })).statusCode,
    429,
  );
  const replay = await request(track, { url: '/?icao24=72b001' });
  assert.equal(
    replay.statusCode,
    200,
    'replaying a fetched body costs nothing',
  );
});

test('a malformed icao24 is still rejected before any upstream call', async (t) => {
  let upstreamCalls = 0;
  stubFetch(t, async () => {
    upstreamCalls += 1;
    return trackOk();
  });
  const track = install(trackBackfillProxies()).get('/api/flights/track');
  const bad = await request(track, { url: '/?icao24=nothex' });
  assert.equal(bad.statusCode, 400);
  assert.equal(upstreamCalls, 0);
});

// --- LAST: arming the /states/all cooldown is one-way for this process.
test('a /states/all 429 does not block track backfill: separate OpenSky buckets', async (t) => {
  let trackUpstreamCalls = 0;
  stubFetch(t, async (url) => {
    if (String(url).includes('states/all')) {
      return new Response('{}', {
        status: 429,
        headers: { 'x-rate-limit-retry-after-seconds': '120' },
      });
    }
    trackUpstreamCalls += 1;
    return trackOk();
  });

  const states = install(openSkyProxy()).get('/api/flights');
  await request(states, { url: '/' });

  const track = install(trackBackfillProxies()).get('/api/flights/track');
  const backfill = await request(track, { url: '/?icao24=7a1b2c' });
  assert.equal(
    backfill.statusCode,
    200,
    'the /tracks bucket still has credits, so the trail is fetched',
  );
  assert.equal(trackUpstreamCalls, 1);
});
