// src/data/rayhunterProxy.test.mjs
// Rayhunter tap proxy: address gating, method gating, rate limiting, and
// upstream relay. Runs without a device — the upstream is a recorded fixture
// injected through `fetchImpl`. See src/data/fixtures/README.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  fetchRayhunterUpstream,
  rayhunterProxy,
  RAYHUNTER_MAX_BODY_BYTES,
} from '../../server/providers/rayhunter.js';
import { parseRayhunterWarnings } from './rayhunterTap.js';

const fixture = (name) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');

const MANIFEST = fixture('rayhunter-qmdl-manifest.json');
const ANALYSIS = fixture('rayhunter-analysis-report.ndjson');

/** Minimal connect-style req/res pair that records what the handler sent. */
function fakeExchange(url, { method = 'GET', remoteAddress = '10.1.2.3' } = {}) {
  const res = {
    headersSent: false,
    statusCode: 0,
    headers: null,
    body: '',
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
      this.headersSent = true;
    },
    end(chunk) {
      if (chunk !== undefined) this.body += chunk;
    },
  };
  return { req: { method, url, socket: { remoteAddress } }, res };
}

/** Collect the two route handlers the plugin installs, keyed by mount path. */
function routesOf(plugin) {
  const routes = new Map();
  plugin.configureServer({
    middlewares: { use: (path, handler) => routes.set(path, handler) },
  });
  return routes;
}

const upstreamOk = (body) => async () => new Response(body, { status: 200 });

test('rayhunterProxy: relays the manifest for a private LAN address', async () => {
  const routes = routesOf(rayhunterProxy({ fetchImpl: upstreamOk(MANIFEST) }));
  const { req, res } = fakeExchange('/?base=192.168.1.1%3A8080');
  await routes.get('/api/rayhunter/manifest')(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Content-Type'], 'application/json');
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.equal(JSON.parse(res.body).current_entry.name, '1756450800');
});

test('rayhunterProxy: relays an analysis report as NDJSON', async () => {
  const routes = routesOf(rayhunterProxy({ fetchImpl: upstreamOk(ANALYSIS) }));
  const { req, res } = fakeExchange('/live?base=192.168.1.1%3A8080');
  await routes.get('/api/rayhunter/analysis')(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Content-Type'], 'application/x-ndjson');
  // The relayed body is what the client parser consumes, so pin the pairing:
  // Informational is filtered, the malformed trailing line is skipped.
  const warnings = parseRayhunterWarnings(res.body);
  assert.deepEqual(
    warnings.map((w) => w.severity),
    ['Low', 'Medium', 'High'],
  );
});

test('rayhunterProxy: refuses a public address — the SSRF case', async () => {
  let reached = false;
  const routes = routesOf(
    rayhunterProxy({
      fetchImpl: async () => {
        reached = true;
        return new Response('{}', { status: 200 });
      },
    }),
  );
  for (const base of ['8.8.8.8%3A80', '169.254.169.254%3A80', 'example.com%3A80']) {
    const { req, res } = fakeExchange(`/?base=${base}`);
    await routes.get('/api/rayhunter/manifest')(req, res);
    assert.equal(res.statusCode, 400, `${base} should be refused`);
  }
  assert.equal(reached, false, 'no upstream request may be made for a refused address');
});

test('rayhunterProxy: refuses a missing base rather than defaulting to one', async () => {
  const routes = routesOf(rayhunterProxy({ fetchImpl: upstreamOk(MANIFEST) }));
  const { req, res } = fakeExchange('/');
  await routes.get('/api/rayhunter/manifest')(req, res);
  assert.equal(res.statusCode, 400);
});

test('rayhunterProxy: rejects a non-GET method — the tap never writes', async () => {
  const routes = routesOf(rayhunterProxy({ fetchImpl: upstreamOk(MANIFEST) }));
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const { req, res } = fakeExchange('/?base=192.168.1.1%3A8080', { method });
    await routes.get('/api/rayhunter/manifest')(req, res);
    assert.equal(res.statusCode, 405, `${method} should be rejected`);
  }
});

test('rayhunterProxy: rejects a traversal-shaped recording name', async () => {
  const routes = routesOf(rayhunterProxy({ fetchImpl: upstreamOk(ANALYSIS) }));
  for (const name of ['..%2F..%2Fetc%2Fpasswd', 'a%20b', 'x'.repeat(200)]) {
    const { req, res } = fakeExchange(`/${name}?base=192.168.1.1%3A8080`);
    await routes.get('/api/rayhunter/analysis')(req, res);
    assert.equal(res.statusCode, 400, `${name} should be rejected`);
  }
});

test('rayhunterProxy: an unreachable device reads as 502, not a crash', async () => {
  const routes = routesOf(
    rayhunterProxy({
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
    }),
  );
  const { req, res } = fakeExchange('/?base=192.168.1.1%3A8080');
  await routes.get('/api/rayhunter/manifest')(req, res);
  assert.equal(res.statusCode, 502);
  // The upstream error text must not reach the browser.
  assert.ok(!res.body.includes('ECONNREFUSED'), 'upstream error text is not relayed');
});

test('rayhunterProxy: a device HTTP error becomes a 502 carrying its status', async () => {
  const routes = routesOf(
    rayhunterProxy({ fetchImpl: async () => new Response('nope', { status: 404 }) }),
  );
  const { req, res } = fakeExchange('/?base=192.168.1.1%3A8080');
  await routes.get('/api/rayhunter/manifest')(req, res);
  assert.equal(res.statusCode, 502);
  assert.match(res.body, /404/);
});

test('rayhunterProxy: rate-limits a runaway client', async () => {
  const routes = routesOf(rayhunterProxy({ fetchImpl: upstreamOk(MANIFEST) }));
  const handler = routes.get('/api/rayhunter/manifest');
  let limited = 0;
  for (let i = 0; i < 130; i += 1) {
    const { req, res } = fakeExchange('/?base=192.168.1.1%3A8080');
    await handler(req, res);
    if (res.statusCode === 429) limited += 1;
  }
  assert.ok(limited > 0, 'the limiter must engage within 130 requests');
});

test('fetchRayhunterUpstream: refuses a redirect instead of following it', async () => {
  await assert.rejects(
    fetchRayhunterUpstream('http://192.168.1.1:8080/api/qmdl-manifest', {
      fetchImpl: async () =>
        new Response(null, { status: 302, headers: { Location: 'http://8.8.8.8/' } }),
    }),
    (error) => error.code === 'RAYHUNTER_REDIRECT',
  );
});

test('fetchRayhunterUpstream: enforces the body cap while streaming', async () => {
  await assert.rejects(
    fetchRayhunterUpstream('http://192.168.1.1:8080/api/qmdl-manifest', {
      fetchImpl: async () => new Response('x'.repeat(4096), { status: 200 }),
      maxBytes: 1024,
    }),
    (error) => error.code === 'RESPONSE_TOO_LARGE',
  );
  assert.ok(RAYHUNTER_MAX_BODY_BYTES > 0);
});
