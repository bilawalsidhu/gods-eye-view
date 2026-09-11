import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../vite.config.js', import.meta.url), 'utf8');

// Same extraction harness as src/proxyErrorResponses.test.mjs: run the real
// middleware against injected upstreams. Top-level closing braces sit in column
// zero, so the first one after the declaration ends the function.
function extract(name) {
  const start = source.search(new RegExp(`(?:export )?(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, `${name} must exist`);
  const end = source.indexOf('\n}', start);
  return source.slice(start, end + 2).replace(/^export /, '');
}

/** Read a limiter's declared caps straight from the source it ships with. */
function declaredCap(constName) {
  const decl = `const ${constName} = makeRateLimiter(`;
  const at = source.indexOf(decl);
  assert.ok(at >= 0, `${constName} must be a makeRateLimiter instance`);
  const args = source.slice(at + decl.length, source.indexOf(');', at));
  const caps = new Function(`return ${args}`)();
  assert.ok(caps.max > 0 && caps.globalMax > caps.max, `${constName} needs a per-IP and global cap`);
  return caps;
}

const OPENSKY_CAP = declaredCap('_openSkyTrackRateLimiter');
const ADSBLOL_CAP = declaredCap('_adsbLolTraceRateLimiter');

/**
 * Instantiate trackBackfillProxies with fresh limiters so each test starts on an
 * empty window, and record every upstream URL the plugin actually fetches.
 */
function fixture({ token = 'fixture-token', respond } = {}) {
  const upstreamCalls = [];
  const helpers = ['makeRateLimiter', 'clientKey', 'readCappedResponseText'].map(extract).join('\n');
  const deps = {
    RATE_LIMITER_MAX_KEYS: 2000,
    getOpenSkyToken: async () => token,
    fetch: async (url) => {
      upstreamCalls.push(String(url));
      return respond ? respond(String(url)) : new Response('{"path":[]}', { status: 200 });
    },
  };
  const build = new Function(
    ...Object.keys(deps),
    `${helpers}
${extract('trackBackfillProxies')}
const _openSkyTrackRateLimiter = makeRateLimiter(${JSON.stringify(OPENSKY_CAP)});
const _adsbLolTraceRateLimiter = makeRateLimiter(${JSON.stringify(ADSBLOL_CAP)});
return trackBackfillProxies();`,
  );
  const plugin = build(...Object.values(deps));
  const routes = new Map();
  plugin.configureServer({ middlewares: { use(route, handler) { routes.set(route, handler); } } });

  return {
    upstreamCalls,
    async request(route, query, peer = '10.0.0.1') {
      const res = {
        headers: {},
        statusCode: 0,
        setHeader(name, value) { this.headers[name] = value; },
        end(body) { this.body = body; },
      };
      await routes.get(route)({ url: `${route}?${query}`, socket: { remoteAddress: peer } }, res);
      return res;
    },
  };
}

const hex6 = (n) => n.toString(16).padStart(6, '0');

test('distinct icao24 values cannot outrun the OpenSky track limiter', async () => {
  const app = fixture();
  const statuses = [];
  for (let i = 0; i < OPENSKY_CAP.max + 5; i += 1) {
    statuses.push((await app.request('/api/opensky-track', `icao24=${hex6(i)}`)).statusCode);
  }
  assert.equal(statuses.filter((s) => s === 200).length, OPENSKY_CAP.max);
  assert.equal(statuses.filter((s) => s === 429).length, 5);
  // A fresh cache key per request must no longer mint a fresh credit spend.
  assert.equal(app.upstreamCalls.length, OPENSKY_CAP.max);
});

test('a throttled track request is generic and retryable', async () => {
  const app = fixture();
  for (let i = 0; i < OPENSKY_CAP.max; i += 1) await app.request('/api/opensky-track', `icao24=${hex6(i)}`);
  const limited = await app.request('/api/opensky-track', 'icao24=ffffff');
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.headers['Retry-After'], '5');
  assert.equal(limited.headers['Cache-Control'], 'no-store');
  assert.deepEqual(JSON.parse(limited.body), { error: 'Rate limit exceeded' });
  assert.doesNotMatch(limited.body, /fixture-token|opensky-network/);
});

test('repeat lookups of one aircraft stay cached and spend no quota', async () => {
  const app = fixture();
  for (let i = 0; i < OPENSKY_CAP.max * 3; i += 1) {
    assert.equal((await app.request('/api/opensky-track', 'icao24=abc123')).statusCode, 200);
  }
  // Re-selecting the same aircraft is the interactive case and must never throttle.
  assert.equal(app.upstreamCalls.length, 1);
});

test('the limiter is keyed per client, not shared across callers', async () => {
  const app = fixture();
  for (let i = 0; i < OPENSKY_CAP.max; i += 1) await app.request('/api/opensky-track', `icao24=${hex6(i)}`, '10.0.0.1');
  assert.equal((await app.request('/api/opensky-track', 'icao24=aaaaaa', '10.0.0.1')).statusCode, 429);
  assert.equal((await app.request('/api/opensky-track', 'icao24=bbbbbb', '10.0.0.2')).statusCode, 200);
});

test('adsb.lol trace backfill is throttled on its own budget', async () => {
  const app = fixture();
  const statuses = [];
  for (let i = 0; i < ADSBLOL_CAP.max + 3; i += 1) {
    statuses.push((await app.request('/api/adsblol/trace', `hex=${hex6(i)}`)).statusCode);
  }
  assert.equal(statuses.filter((s) => s === 429).length, 3);
  assert.equal(app.upstreamCalls.length, ADSBLOL_CAP.max);
  // Separate buckets: exhausting adsb.lol must not close the OpenSky route.
  assert.equal((await app.request('/api/opensky-track', 'icao24=abc123')).statusCode, 200);
});

test('malformed ids are still rejected before any quota is spent', async () => {
  const app = fixture();
  assert.equal((await app.request('/api/opensky-track', 'icao24=nothex')).statusCode, 400);
  assert.equal((await app.request('/api/adsblol/trace', 'hex=zzz')).statusCode, 400);
  assert.equal(app.upstreamCalls.length, 0);
});

test('upstream failures stay sanitized under the limiter', async () => {
  const app = fixture({ respond: () => new Response('upstream stack detail', { status: 503 }) });
  const res = await app.request('/api/opensky-track', 'icao24=abc123');
  assert.equal(res.statusCode, 503);
  assert.deepEqual(JSON.parse(res.body), { error: 'Track source HTTP 503' });
});
