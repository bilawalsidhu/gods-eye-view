import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnectRouter, shadowedMounts } from './connectRouter.js';

function mockReqRes(url, method = 'GET') {
  const req = { url, method, headers: {} };
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    headersSent: false,
    writeHead(status, headers = {}) {
      this.statusCode = status;
      Object.assign(this.headers, headers);
      this.headersSent = true;
    },
    end(chunk = '') {
      this.body += chunk;
    },
  };
  return { req, res };
}

test('exact mount match rewrites req.url to root, keeping the query string', () => {
  const router = createConnectRouter();
  let seenUrl = null;
  router.use('/api/opensky', (req, res) => {
    seenUrl = req.url;
    res.writeHead(200, {});
    res.end('ok');
  });
  const { req, res } = mockReqRes('/api/opensky?lat=30.2&lon=-97.7');
  router.handle(req, res);
  assert.equal(seenUrl, '/?lat=30.2&lon=-97.7');
  assert.equal(res.statusCode, 200);
});

test('deeper path mount strips only the mount prefix', () => {
  const router = createConnectRouter();
  let seenUrl = null;
  router.use('/api/cctv', (req, res) => {
    seenUrl = req.url;
    res.writeHead(200, {});
    res.end('ok');
  });
  const { req, res } = mockReqRes('/api/cctv/sources');
  router.handle(req, res);
  assert.equal(seenUrl, '/sources');
});

test('first matching mount wins; a later, broader mount never runs', () => {
  const router = createConnectRouter();
  const hits = [];
  router.use('/api/tomtom', (_req, res) => {
    hits.push('tomtom');
    res.writeHead(200, {});
    res.end('specific');
  });
  router.use('/api', (_req, res) => {
    hits.push('catch-all');
    res.writeHead(404, {});
    res.end('fallback');
  });
  const { req, res } = mockReqRes('/api/tomtom/status');
  router.handle(req, res);
  assert.deepEqual(hits, ['tomtom']);
  assert.equal(res.body, 'specific');
});

test('an unmatched path reaches the broader mount registered after it', () => {
  const router = createConnectRouter();
  router.use('/api/tomtom', (_req, res) => {
    res.writeHead(200, {});
    res.end('specific');
  });
  router.use('/api', (_req, res) => {
    res.writeHead(404, {});
    res.end('fallback');
  });
  const { req, res } = mockReqRes('/api/unknown-thing');
  router.handle(req, res);
  assert.equal(res.body, 'fallback');
});

test('nothing matches at all: default 404 JSON', () => {
  const router = createConnectRouter();
  const { req, res } = mockReqRes('/api/anything');
  router.handle(req, res);
  assert.equal(res.statusCode, 404);
  assert.deepEqual(JSON.parse(res.body), { error: 'not_found' });
});

test('a handler that throws synchronously is turned into a 500, not an uncaught exception', () => {
  const router = createConnectRouter();
  router.use('/api/broken', () => {
    throw new Error('boom');
  });
  const { req, res } = mockReqRes('/api/broken');
  assert.doesNotThrow(() => router.handle(req, res));
  assert.equal(res.statusCode, 500);
});

test('a handler that rejects asynchronously is also turned into a 500', async () => {
  const router = createConnectRouter();
  router.use('/api/broken-async', async () => {
    throw new Error('boom');
  });
  const { req, res } = mockReqRes('/api/broken-async');
  router.handle(req, res);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(res.statusCode, 500);
});

// Parity with Vite's bundled connect (node_modules/vite/dist/node/chunks/
// dep-*.js, connect's call/handle): the same plugins run under both servers,
// so any routing difference silently sends a request to a different handler.
// Each row is [request url, what the /api/gbfs handler sees as req.url, or
// null when the request must fall through to the /api catch-all instead].
const CONNECT_PARITY = [
  ['/api/gbfs', '/'],
  ['/api/gbfs?city=austin', '/?city=austin'],
  ['/api/gbfs/station_information', '/station_information'],
  // Connect treats "." as a segment boundary, alongside "/".
  ['/api/gbfs.json', '/.json'],
  ['/api/gbfs.json?x=1', '/.json?x=1'],
  // Connect compares the prefix case-insensitively.
  ['/API/GBFS/feeds', '/feeds'],
  ['/Api/Gbfs', '/'],
  // Merely starting with the mount's name is not a match.
  ['/api/gbfsXYZ', null],
  ['/api/gbfs_extra', null],
  ['/api/gbf', null],
];

for (const [url, expectedRest] of CONNECT_PARITY) {
  test(`connect parity: ${url} -> ${expectedRest ?? 'falls through to /api'}`, () => {
    const router = createConnectRouter();
    let seen = null;
    let fellThrough = false;
    router.use('/api/gbfs', (req, res) => {
      seen = req.url;
      res.writeHead(200, {});
      res.end();
    });
    router.use('/api', (_req, res) => {
      fellThrough = true;
      res.writeHead(404, {});
      res.end();
    });
    const { req, res } = mockReqRes(url);
    router.handle(req, res);
    if (expectedRest === null) {
      assert.equal(fellThrough, true);
      assert.equal(seen, null);
    } else {
      assert.equal(seen, expectedRest);
      assert.equal(fellThrough, false);
    }
  });
}

test('shadowedMounts flags anything installed after a mount that covers it', () => {
  // The catch-all installed first swallows everything below it.
  assert.deepEqual(shadowedMounts(['/api', '/api/opensky', '/api.json']), [
    { path: '/api/opensky', coveredBy: '/api' },
    { path: '/api.json', coveredBy: '/api' },
  ]);
  // The same path twice: the second is dead.
  assert.deepEqual(shadowedMounts(['/api/gbfs', '/api/gbfs']), [
    { path: '/api/gbfs', coveredBy: '/api/gbfs' },
  ]);
  // Case-insensitive, like connect.
  assert.deepEqual(shadowedMounts(['/API', '/api/x']), [
    { path: '/api/x', coveredBy: '/API' },
  ]);
});

test('shadowedMounts accepts the real shape: specific mounts first, catch-all last', () => {
  assert.deepEqual(
    shadowedMounts([
      '/healthz',
      // A name that merely extends an earlier one is not covered by it.
      '/api/gbfs',
      '/api/gbfs-extra',
      '/api/cctv',
      '/api',
    ]),
    [],
  );
  // Root mounts are pass-through middleware, never treated as covering.
  assert.deepEqual(shadowedMounts(['/', '/api/x', '/api']), []);
});

test('calling next() falls through to the next matching mount', () => {
  const router = createConnectRouter();
  const hits = [];
  router.use('/api/thing', (_req, _res, next) => {
    hits.push('first');
    next();
  });
  router.use('/api', (_req, res) => {
    hits.push('second');
    res.writeHead(200, {});
    res.end('done');
  });
  const { req, res } = mockReqRes('/api/thing');
  router.handle(req, res);
  assert.deepEqual(hits, ['first', 'second']);
  assert.equal(res.body, 'done');
});

test('shadowedMounts lets an exactOnly parent precede its nested routes', () => {
  const paths = ['/api/flights', '/api/flights/track', '/api'];
  // Without the hint, the nested route looks unreachable...
  assert.deepEqual(shadowedMounts(paths), [
    { path: '/api/flights/track', coveredBy: '/api/flights' },
  ]);
  // ...but a parent that passes nested paths on with next() does not cover it.
  assert.deepEqual(shadowedMounts(paths, { exactOnly: ['/api/flights'] }), []);
  // It still covers an identical duplicate of itself.
  assert.deepEqual(
    shadowedMounts(['/api/flights', '/API/Flights'], {
      exactOnly: ['/api/flights'],
    }),
    [{ path: '/API/Flights', coveredBy: '/api/flights' }],
  );
});
