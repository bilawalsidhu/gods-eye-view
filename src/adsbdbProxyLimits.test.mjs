import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const source = readFileSync(new URL('../vite.config.js', import.meta.url), 'utf8');

// Same extraction harness as src/proxyErrorResponses.test.mjs: drive the real
// middleware with injected upstreams and storage.
function extract(name) {
  const start = source.search(new RegExp(`(?:export )?(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, `${name} must exist`);
  const end = source.indexOf('\n}', start);
  return source.slice(start, end + 2).replace(/^export /, '');
}

function constant(name) {
  const line = source.match(new RegExp(`^const ${name} = .*$`, 'm'));
  assert.ok(line, `${name} must exist`);
  return line[0];
}

function numericConstant(name) {
  const value = Number(constant(name).match(/=\s*(\d+)/)?.[1]);
  assert.ok(Number.isInteger(value) && value > 0, `${name} must be a positive integer`);
  return value;
}

const MAX_ENTRIES = numericConstant('ADSBDB_CACHE_MAX_ENTRIES');
const PRUNE_TO = numericConstant('ADSBDB_CACHE_PRUNE_TO');
const RATE_CAP = Number(constant('_adsbdbRateLimiter').match(/max:\s*(\d+)/)?.[1]);

/**
 * Build the proxy over an in-memory cache file, recording upstream calls and
 * whatever the periodic flush would have written to disk.
 */
function fixture({ respond, seedCache = null } = {}) {
  const upstreamCalls = [];
  const disk = { written: null };
  let flush = null;
  const deps = {
    path,
    process: { cwd: () => '/fixture', env: {} },
    fsp: {
      readFile: async () => (seedCache ? JSON.stringify(seedCache) : Promise.reject(new Error('cache absent'))),
      stat: async () => { throw new Error('cache absent'); },
      mkdir: async () => {},
      writeFile: async (_p, body) => { disk.written = JSON.parse(body); },
    },
    fetch: async (url) => {
      upstreamCalls.push(String(url));
      return respond ? respond(String(url)) : new Response(JSON.stringify({
        response: { aircraft: { icao_type: 'B738', manufacturer: 'Boeing', type: '737', registration: 'N1' } },
      }));
    },
    console: { warn() {}, error() {} },
    setInterval: (fn) => { flush = fn; return { unref() {} }; },
    RATE_LIMITER_MAX_KEYS: 2000,
  };
  const helpers = ['makeRateLimiter', 'clientKey'].map(extract).join('\n');
  const consts = ['ADSBDB_CACHE_MAX_ENTRIES', 'ADSBDB_CACHE_PRUNE_TO', '_adsbdbRateLimiter'].map(constant).join('\n');
  const plugin = new Function(
    ...Object.keys(deps),
    `${helpers}\n${consts}\n${extract('adsbdbProxy')}\nreturn adsbdbProxy();`,
  )(...Object.values(deps));

  let middleware;
  plugin.configureServer({ middlewares: { use(_route, handler) { middleware = handler; } } });

  return {
    upstreamCalls,
    disk,
    async flushToDisk() { await flush?.(); },
    async request(url, peer = '10.0.0.1') {
      const res = {
        headersSent: false,
        writeHead(status, headers) { Object.assign(this, { status, headers, headersSent: true }); },
        end(body) { this.body = body; },
      };
      await middleware({ url, method: 'GET', socket: { remoteAddress: peer } }, res);
      return res;
    },
  };
}

const hex6 = (n) => n.toString(16).padStart(6, '0');

test('the prune ceiling leaves real headroom below it', () => {
  assert.ok(PRUNE_TO < MAX_ENTRIES, 'pruning must drop below the ceiling, or it runs on every insert');
});

test('distinct hex lookups cannot outrun the upstream limiter', async () => {
  const app = fixture();
  const statuses = [];
  for (let i = 0; i < RATE_CAP + 5; i += 1) {
    statuses.push((await app.request(`/type/${hex6(i)}`)).status);
  }
  assert.equal(statuses.filter((s) => s === 200).length, RATE_CAP);
  assert.equal(statuses.filter((s) => s === 429).length, 5);
  assert.equal(app.upstreamCalls.length, RATE_CAP);
});

test('a throttled lookup is generic and retryable', async () => {
  const app = fixture();
  for (let i = 0; i < RATE_CAP; i += 1) await app.request(`/type/${hex6(i)}`);
  const limited = await app.request('/route/ABC123');
  assert.equal(limited.status, 429);
  assert.equal(limited.headers['Retry-After'], '5');
  assert.deepEqual(JSON.parse(limited.body), { error: 'Rate limit exceeded' });
});

test('cached lookups are served without spending budget', async () => {
  const app = fixture();
  for (let i = 0; i < RATE_CAP * 2; i += 1) {
    const res = await app.request('/type/abc123');
    assert.equal(res.status, 200);
  }
  assert.equal(app.upstreamCalls.length, 1);
});

test('route and hex lookups share one client budget', async () => {
  const app = fixture();
  for (let i = 0; i < RATE_CAP; i += 1) await app.request(`/type/${hex6(i)}`);
  assert.equal((await app.request('/route/XX99')).status, 429);
  // A different caller is unaffected until the global backstop.
  assert.equal((await app.request('/route/XX99', '10.0.0.2')).status, 200);
});

test('the cache stops growing once it passes its ceiling', async () => {
  // Seed past the ceiling so the run stays short; ages ascend with the index.
  const aircraft = {};
  for (let i = 0; i < MAX_ENTRIES + 50; i += 1) aircraft[hex6(i)] = { at: 1000 + i, data: null };
  const app = fixture({ seedCache: { routes: {}, aircraft } });

  await app.request('/type/ffff01');
  await app.flushToDisk();

  const kept = Object.keys(app.disk.written.aircraft);
  assert.ok(kept.length <= MAX_ENTRIES, `cache kept ${kept.length}, ceiling is ${MAX_ENTRIES}`);
  // Oldest-first eviction: the lowest `at` values go, the newest survive.
  assert.ok(!kept.includes(hex6(0)), 'the oldest entry should have been evicted');
  assert.ok(kept.includes(hex6(MAX_ENTRIES + 49)), 'the newest seeded entry should survive');
  assert.ok(kept.includes('ffff01'), 'the entry just written should survive');
});

test('an oversized cache file is trimmed on load, before any request', async () => {
  const routes = {};
  for (let i = 0; i < MAX_ENTRIES + 500; i += 1) routes[`CS${i}`] = { at: 1000 + i, data: null };
  const app = fixture({ seedCache: { routes, aircraft: {} } });

  await app.request('/type/abc123');
  await app.flushToDisk();

  assert.ok(Object.keys(app.disk.written.routes).length <= MAX_ENTRIES);
});

test('validation and unknown-endpoint behaviour are unchanged', async () => {
  const app = fixture();
  assert.equal((await app.request('/route/!')).status, 400);
  assert.equal((await app.request('/type/nope')).status, 400);
  assert.equal((await app.request('/unknown')).status, 404);
  assert.equal(app.upstreamCalls.length, 0, 'rejected input must not reach upstream');
});

test('a missing aircraft still reports found:false, not an error', async () => {
  const app = fixture({ respond: () => new Response('{}', { status: 404 }) });
  const res = await app.request('/type/abcdef');
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { found: false });
  // The 404 is negative-cached, so a repeat costs nothing upstream.
  await app.request('/type/abcdef');
  assert.equal(app.upstreamCalls.length, 1);
});
