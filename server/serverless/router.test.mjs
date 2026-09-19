import test from 'node:test';
import assert from 'node:assert/strict';
import { createMountRouter } from './router.js';

/** Minimal Connect-shaped mock response: enough for the router + assertions. */
function mockRes() {
  return {
    statusCode: 200,
    headersSent: false,
    writableEnded: false,
    headers: {},
    body: '',
    setHeader(name, value) {
      this.headers[name] = value;
    },
    getHeader(name) {
      return this.headers[name];
    },
    end(chunk) {
      this.headersSent = true;
      this.writableEnded = true;
      if (chunk !== undefined) this.body += chunk;
    },
  };
}

function mockReq(url, { method = 'GET' } = {}) {
  return { url, method, headers: {} };
}

test('exact mount: handler sees "/" and originalUrl is preserved', () => {
  const router = createMountRouter();
  let seen = null;
  router.use('/api/firms', (req, res) => {
    seen = { url: req.url, originalUrl: req.originalUrl };
    res.end('ok');
  });
  const req = mockReq('/api/firms');
  const res = mockRes();
  router.handle(req, res);
  assert.deepEqual(seen, { url: '/', originalUrl: '/api/firms' });
  assert.equal(res.body, 'ok');
});

test('sub-path: remainder after the mount is passed through', () => {
  const router = createMountRouter();
  let seenUrl = null;
  router.use('/api/firms', (req, res) => {
    seenUrl = req.url;
    res.end();
  });
  router.handle(mockReq('/api/firms/status'), mockRes());
  assert.equal(seenUrl, '/status');
});

test('"." boundary: a mount matches a dotted suffix immediately after it', () => {
  const router = createMountRouter();
  let seenUrl = null;
  router.use('/api/firms', (req, res) => {
    seenUrl = req.url;
    res.end();
  });
  router.handle(mockReq('/api/firms.json'), mockRes());
  assert.equal(seenUrl, '/.json');
});

test('non-match: /api/firmsx must NOT match a mount at /api/firms', () => {
  const router = createMountRouter();
  let firmsCalled = false;
  let fallbackUrl = null;
  router.use('/api/firms', (req, res) => {
    firmsCalled = true;
    res.end();
  });
  router.use('/', (req, res) => {
    fallbackUrl = req.url;
    res.end('fallback');
  });
  const res = mockRes();
  router.handle(mockReq('/api/firmsx'), res);
  assert.equal(firmsCalled, false);
  assert.equal(fallbackUrl, '/api/firmsx');
  assert.equal(res.body, 'fallback');
});

test('query preservation: the query string survives the mount rewrite', () => {
  const router = createMountRouter();
  let seenUrl = null;
  router.use('/api/firms', (req, res) => {
    seenUrl = req.url;
    res.end();
  });
  router.handle(mockReq('/api/firms/status?x=1&y=2'), mockRes());
  assert.equal(seenUrl, '/status?x=1&y=2');
});

test('leading-slash normalisation: an empty remainder becomes "/" and a bare query becomes "/?..."', () => {
  const router = createMountRouter();
  const seen = [];
  router.use('/api/firms', (req, res) => {
    seen.push(req.url);
    res.end();
  });
  router.handle(mockReq('/api/firms'), mockRes());
  router.handle(mockReq('/api/firms?x=1'), mockRes());
  assert.deepEqual(seen, ['/', '/?x=1']);
});

test('next() fallthrough: req.url is restored to the original path for the next layer', () => {
  const router = createMountRouter();
  const calls = [];
  router.use('/api/x', (req, res, next) => {
    calls.push({ layer: 'x', url: req.url });
    next(); // does not handle it — falls through
  });
  router.use('/', (req, res) => {
    calls.push({ layer: 'root', url: req.url });
    res.end('handled-by-root');
  });
  const res = mockRes();
  router.handle(mockReq('/api/x/sub?q=1'), res);
  assert.deepEqual(calls, [
    { layer: 'x', url: '/sub?q=1' },
    // Restored to the ORIGINAL path before the root layer's own match/rewrite ran.
    { layer: 'root', url: '/api/x/sub?q=1' },
  ]);
  assert.equal(res.body, 'handled-by-root');
});

test('error handling: a thrown error yields a 500 with a generic body (no stack leak)', () => {
  const router = createMountRouter();
  router.use('/api/boom', () => {
    throw new Error('sensitive internal detail');
  });
  const res = mockRes();
  const originalError = console.error;
  console.error = () => {}; // the router logs server-side; keep test output clean
  try {
    router.handle(mockReq('/api/boom'), res);
  } finally {
    console.error = originalError;
  }
  assert.equal(res.statusCode, 500);
  const parsed = JSON.parse(res.body);
  assert.deepEqual(parsed, { error: 'proxy_error' });
  assert.ok(!res.body.includes('sensitive internal detail'));
});

test('error handling: an async handler that rejects also yields the 500 proxy_error body', async () => {
  const router = createMountRouter();
  router.use('/api/boom', async () => {
    throw new Error('async failure');
  });
  const res = mockRes();
  const originalError = console.error;
  console.error = () => {};
  await new Promise((resolve) => {
    // The router dispatches the async rejection through a microtask; give it
    // a turn before asserting.
    router.handle(mockReq('/api/boom'), res);
    setImmediate(resolve);
  });
  console.error = originalError;
  assert.equal(res.statusCode, 500);
  assert.deepEqual(JSON.parse(res.body), { error: 'proxy_error' });
});

test('error handling: next(err) with no error-handling layer left reaches the default 500', () => {
  const router = createMountRouter();
  router.use('/api/a', (req, res, next) => next(new Error('a failed')));
  router.use('/api/a', (req, res) => {
    // Plain (non-4-arg) handler registered after an error: Connect skips it.
    res.end('should not run');
  });
  const res = mockRes();
  const originalError = console.error;
  console.error = () => {};
  router.handle(mockReq('/api/a'), res);
  console.error = originalError;
  assert.equal(res.statusCode, 500);
  assert.deepEqual(JSON.parse(res.body), { error: 'proxy_error' });
});

test('no layer matches and no `done` was supplied: default 404 JSON', () => {
  const router = createMountRouter();
  router.use('/api/only-this', (req, res) => res.end());
  const res = mockRes();
  router.handle(mockReq('/other'), res);
  assert.equal(res.statusCode, 404);
  assert.deepEqual(JSON.parse(res.body), { error: 'Not Found' });
});

test('a custom `done` callback overrides the default terminal handler', () => {
  const router = createMountRouter();
  let doneErr = 'unset';
  router.handle(mockReq('/unmatched'), mockRes(), (err) => {
    doneErr = err;
  });
  assert.equal(doneErr, undefined);
});

test('use() without a path defaults to root and matches every request', () => {
  const router = createMountRouter();
  let seenUrl = null;
  router.use((req, res) => {
    seenUrl = req.url;
    res.end();
  });
  router.handle(mockReq('/anything/at/all?x=1'), mockRes());
  assert.equal(seenUrl, '/anything/at/all?x=1');
});
