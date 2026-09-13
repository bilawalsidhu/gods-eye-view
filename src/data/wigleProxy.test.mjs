// src/data/wigleProxy.test.mjs
// WiGLE proxy: credential gating, viewport validation, caching, budget, and
// error sanitisation. No network — the upstream is a recorded-shape fixture
// injected through `fetchImpl`. See src/data/fixtures/README.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { wigleProxy, wigleClientError } from '../../server/providers/wigle.js';

const SEARCH_BODY = readFileSync(
  fileURLToPath(new URL('./fixtures/wigle-network-search.json', import.meta.url)),
  'utf8',
);

const BOX = '?south=30.26&west=-97.75&north=30.28&east=-97.73';

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

function routesOf(plugin) {
  const routes = new Map();
  plugin.configureServer({
    middlewares: { use: (path, handler) => routes.set(path, handler) },
  });
  return routes;
}

/** Each test gets its own cache dir so the 24h disk cache cannot leak between them. */
function freshCacheDir() {
  return mkdtempSync(join(tmpdir(), 'gev-wigle-'));
}

/** Run `fn` with WiGLE credentials present, restoring the previous env after. */
async function withCredentials(fn) {
  const prev = { ...process.env };
  process.env.WIGLE_API_NAME = 'test-name';
  process.env.WIGLE_API_TOKEN = 'test-token';
  delete process.env.WIGLE_DAILY_QUERY_BUDGET;
  try {
    return await fn();
  } finally {
    process.env = prev;
  }
}

test('wigleProxy: /status reports whether credentials are configured', async () => {
  const routes = routesOf(wigleProxy({ cacheDir: freshCacheDir() }));
  const handler = routes.get('/api/wigle/status');

  const prev = { ...process.env };
  delete process.env.WIGLE_API_NAME;
  delete process.env.WIGLE_API_TOKEN;
  let exchange = fakeExchange('/');
  handler(exchange.req, exchange.res);
  assert.equal(JSON.parse(exchange.res.body).hasKey, false);
  process.env = prev;

  await withCredentials(() => {
    exchange = fakeExchange('/');
    handler(exchange.req, exchange.res);
    assert.equal(JSON.parse(exchange.res.body).hasKey, true);
  });
});

test('wigleProxy: without credentials the layer is unavailable, not simulated', async () => {
  const prev = { ...process.env };
  delete process.env.WIGLE_API_NAME;
  delete process.env.WIGLE_API_TOKEN;
  let called = false;
  const routes = routesOf(
    wigleProxy({
      cacheDir: freshCacheDir(),
      fetchImpl: async () => {
        called = true;
        return new Response(SEARCH_BODY, { status: 200 });
      },
    }),
  );
  const { req, res } = fakeExchange(`/${BOX}`);
  await routes.get('/api/wigle/search')(req, res);
  process.env = prev;

  assert.equal(res.statusCode, 503);
  const payload = JSON.parse(res.body);
  assert.equal(payload.available, false);
  assert.deepEqual(payload.networks, []);
  assert.equal(called, false, 'no upstream call without credentials');
});

test('wigleProxy: normalizes results and drops untriangulated 0,0 rows', async () => {
  await withCredentials(async () => {
    const routes = routesOf(
      wigleProxy({
        cacheDir: freshCacheDir(),
        fetchImpl: async () => new Response(SEARCH_BODY, { status: 200 }),
      }),
    );
    const { req, res } = fakeExchange(`/${BOX}`);
    await routes.get('/api/wigle/search')(req, res);
    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.available, true);
    // The fixture has 4 rows; the 0,0 untriangulated one must not survive.
    assert.equal(payload.networks.length, 3);
    assert.ok(payload.networks.every((n) => n.latitude !== 0 || n.longitude !== 0));
  });
});

test('wigleProxy: a repeat viewport is served from cache without a second query', async () => {
  await withCredentials(async () => {
    let calls = 0;
    const routes = routesOf(
      wigleProxy({
        cacheDir: freshCacheDir(),
        fetchImpl: async () => {
          calls += 1;
          return new Response(SEARCH_BODY, { status: 200 });
        },
      }),
    );
    const handler = routes.get('/api/wigle/search');
    for (let i = 0; i < 3; i += 1) {
      const { req, res } = fakeExchange(`/${BOX}`);
      await handler(req, res);
      assert.equal(res.statusCode, 200);
    }
    assert.equal(calls, 1, 'WiGLE allowance is small — repeats must not re-query');
  });
});

test('wigleProxy: rejects an oversized or malformed viewport before spending a query', async () => {
  await withCredentials(async () => {
    let calls = 0;
    const routes = routesOf(
      wigleProxy({
        cacheDir: freshCacheDir(),
        fetchImpl: async () => {
          calls += 1;
          return new Response(SEARCH_BODY, { status: 200 });
        },
      }),
    );
    const handler = routes.get('/api/wigle/search');
    for (const query of [
      '?south=30&west=-98&north=40&east=-97', // 10 degrees tall
      '?south=30.26&west=-97.75&north=30.25&east=-97.73', // inverted
      '?south=abc&west=-97.75&north=30.28&east=-97.73', // non-numeric
      '', // absent
    ]) {
      const { req, res } = fakeExchange(`/${query}`);
      await handler(req, res);
      assert.equal(res.statusCode, 400, `${query || '(empty)'} should be refused`);
    }
    assert.equal(calls, 0, 'no upstream query for a refused viewport');
  });
});

test('wigleProxy: stops at the local daily budget', async () => {
  await withCredentials(async () => {
    process.env.WIGLE_DAILY_QUERY_BUDGET = '2';
    let calls = 0;
    const routes = routesOf(
      wigleProxy({
        cacheDir: freshCacheDir(),
        fetchImpl: async () => {
          calls += 1;
          return new Response(SEARCH_BODY, { status: 200 });
        },
      }),
    );
    const handler = routes.get('/api/wigle/search');
    // Distinct viewports so the cache cannot absorb them.
    const boxes = [30.26, 30.36, 30.46, 30.56].map(
      (s) => `?south=${s}&west=-97.75&north=${s + 0.02}&east=-97.73`,
    );
    const statuses = [];
    for (const query of boxes) {
      const { req, res } = fakeExchange(`/${query}`);
      await handler(req, res);
      statuses.push(res.statusCode);
    }
    assert.equal(calls, 2, 'the budget caps upstream queries at the configured limit');
    assert.ok(statuses.includes(429), 'the caller is told the budget is exhausted');
  });
});

test('wigleProxy: does not relay upstream message text to the browser', async () => {
  await withCredentials(async () => {
    const leak = 'SECRET-UPSTREAM-DETAIL-xyzzy';
    const routes = routesOf(
      wigleProxy({
        cacheDir: freshCacheDir(),
        fetchImpl: async () =>
          new Response(JSON.stringify({ success: false, message: leak }), { status: 401 }),
      }),
    );
    const { req, res } = fakeExchange(`/${BOX}`);
    await routes.get('/api/wigle/search')(req, res);
    assert.equal(res.statusCode, 401);
    assert.ok(!res.body.includes(leak), 'upstream message must not reach the client');
    assert.match(res.body, /credentials/i, 'but the actionable distinction survives');
  });
});

test('wigleProxy: treats HTTP 200 with success:false as a failure', async () => {
  await withCredentials(async () => {
    const routes = routesOf(
      wigleProxy({
        cacheDir: freshCacheDir(),
        fetchImpl: async () =>
          new Response(JSON.stringify({ success: false, message: 'too many queries' }), {
            status: 200,
          }),
      }),
    );
    const { req, res } = fakeExchange(`/${BOX}`);
    await routes.get('/api/wigle/search')(req, res);
    assert.equal(res.statusCode, 502);
    assert.deepEqual(JSON.parse(res.body).networks, []);
  });
});

test('wigleProxy: a non-JSON body fails cleanly instead of throwing', async () => {
  await withCredentials(async () => {
    const routes = routesOf(
      wigleProxy({
        cacheDir: freshCacheDir(),
        fetchImpl: async () => new Response('<html>gateway timeout</html>', { status: 200 }),
      }),
    );
    const { req, res } = fakeExchange(`/${BOX}`);
    await routes.get('/api/wigle/search')(req, res);
    assert.equal(res.statusCode, 502);
    assert.ok(!res.body.includes('<html>'), 'upstream body is not echoed');
  });
});

test('wigleProxy: rejects a non-GET method', async () => {
  await withCredentials(async () => {
    const routes = routesOf(wigleProxy({ cacheDir: freshCacheDir() }));
    const { req, res } = fakeExchange(`/${BOX}`, { method: 'POST' });
    await routes.get('/api/wigle/search')(req, res);
    assert.equal(res.statusCode, 405);
  });
});

test('wigleClientError: preserves the distinctions that change what the user does', () => {
  assert.match(wigleClientError(401), /credentials/i);
  assert.match(wigleClientError(403), /credentials/i);
  assert.match(wigleClientError(429), /allowance/i);
  assert.equal(wigleClientError(500), 'WiGLE request failed');
});
