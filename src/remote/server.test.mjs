import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { localProviderPlugins } from '../../server/providers/local.js';
import {
  REMOTE_HEARTBEAT_MS,
  createRemoteHub,
  createRemoteMiddleware,
  remoteAuthorization,
  remoteControlPlugin,
} from '../../server/providers/remote.js';

const TOKEN = 'gev-test-token-9f3a';

test('bearer comparison is exact and does not throw on a different length', () => {
  assert.equal(remoteAuthorization(undefined, ''), 'unconfigured');
  assert.equal(remoteAuthorization(undefined, TOKEN), 'unauthorized');
  assert.equal(remoteAuthorization('Basic ' + TOKEN, TOKEN), 'unauthorized');
  assert.equal(remoteAuthorization('Bearer short', TOKEN), 'unauthorized');
  assert.equal(
    remoteAuthorization('Bearer ' + 'x'.repeat(TOKEN.length), TOKEN),
    'unauthorized',
  );
  assert.equal(remoteAuthorization('bearer ' + TOKEN, TOKEN), 'ok');
  assert.equal(remoteAuthorization('Bearer ' + TOKEN, TOKEN), 'ok');
});

test('fan-out counts clients and stays inside the named session', () => {
  const timers = [];
  const hub = createRemoteHub({
    now: () => Date.UTC(2026, 0, 2),
    setTimer: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimer: (id) => {
      timers[id - 1].cleared = true;
    },
  });
  const alpha = response();
  const beta = response();
  hub.subscribe('alpha', request(), alpha);
  hub.subscribe('beta', request(), beta);
  assert.equal(timers[0].ms, REMOTE_HEARTBEAT_MS);
  timers[0].fn();
  assert.match(alpha.chunks.at(-1), /: heartbeat/);
  const one = hub.publish('alpha', { lat: 1, lon: 2 });
  assert.deepEqual(one, { delivered: 1, sessions: 1 });
  assert.match(alpha.chunks.at(-1), /"lat":1/);
  assert.equal(
    beta.chunks.some((chunk) => chunk.startsWith('data:')),
    false,
  );
  const all = hub.publish('*', { layers: { flights: true } });
  assert.deepEqual(all, { delivered: 2, sessions: 2 });
  assert.equal(
    beta.chunks.filter((chunk) => chunk.startsWith('data:')).length,
    1,
  );
  assert.deepEqual(hub.list(), [
    {
      session: 'alpha',
      clients: 1,
      connectedAt: '2026-01-02T00:00:00.000Z',
    },
    {
      session: 'beta',
      clients: 1,
      connectedAt: '2026-01-02T00:00:00.000Z',
    },
  ]);
  alpha.emit('close');
  assert.equal(timers[0].cleared, true);
  assert.deepEqual(hub.publish('alpha', { lat: 3, lon: 4 }), {
    delivered: 0,
    sessions: 0,
  });
  assert.deepEqual(
    hub.list().map((row) => row.session),
    ['beta'],
  );
});

test('push requires the bearer token and a valid view; the stream does not', async (t) => {
  const previous = process.env.REMOTE_CONTROL_TOKEN;
  delete process.env.REMOTE_CONTROL_TOKEN;
  t.after(() => {
    if (previous === undefined) delete process.env.REMOTE_CONTROL_TOKEN;
    else process.env.REMOTE_CONTROL_TOKEN = previous;
  });
  const logs = [];
  const warn = console.warn;
  const error = console.error;
  console.warn = (...args) => logs.push(args.join(' '));
  console.error = (...args) => logs.push(args.join(' '));
  t.after(() => {
    console.warn = warn;
    console.error = error;
  });

  const unconfigured = createRemoteMiddleware({});
  const denied = await call(
    unconfigured,
    request({
      method: 'POST',
      url: '/push',
      body: '{"view":{"lat":1,"lon":2}}',
    }),
  );
  assert.equal(denied.statusCode, 503);
  assert.match(bodyOf(denied), /not configured/);

  const hub = createRemoteHub({
    setTimer: () => ({ unref() {} }),
    clearTimer() {},
  });
  const middleware = createRemoteMiddleware({ token: TOKEN, hub });
  const noToken = await call(
    middleware,
    request({
      method: 'POST',
      url: '/api/remote/push',
      body: '{"view":{"lat":1,"lon":2}}',
    }),
  );
  assert.equal(noToken.statusCode, 401);
  assert.equal(bodyOf(noToken).includes(TOKEN), false);

  const badAlt = await call(
    middleware,
    request({
      method: 'POST',
      url: '/push',
      headers: { authorization: `Bearer ${TOKEN}` },
      body: '{"view":{"lat":1,"lon":2,"alt":0}}',
    }),
  );
  assert.equal(badAlt.statusCode, 400);
  assert.match(bodyOf(badAlt), /alt must be greater than 0/);

  const stream = await call(
    middleware,
    request({
      method: 'GET',
      url: '/stream?session=alpha',
    }),
  );
  assert.equal(stream.statusCode, 200);
  assert.equal(stream.headers['X-Accel-Buffering'], 'no');
  assert.equal(stream.headers['Cache-Control'], 'no-cache, no-transform');
  assert.equal(stream.headers['Content-Encoding'], 'identity');
  assert.equal(stream.flushedHeaders, true);
  assert.match(stream.chunks[0], /: connected/);

  const other = await call(
    middleware,
    request({
      method: 'GET',
      url: '/stream?session=beta',
    }),
  );
  const pushed = await call(
    middleware,
    request({
      method: 'POST',
      url: '/push',
      headers: { authorization: `Bearer ${TOKEN}` },
      body: '{"session":"alpha","view":{"lat":120,"lon":10,"alt":500}}',
    }),
  );
  assert.equal(pushed.statusCode, 200);
  assert.deepEqual(JSON.parse(bodyOf(pushed)), {
    ok: true,
    delivered: 1,
    sessions: 1,
  });
  const event = stream.chunks.find((chunk) => chunk.startsWith('data:'));
  assert.equal(JSON.parse(event.slice('data:'.length)).view.lat, 90);
  assert.equal(
    other.chunks.some((chunk) => chunk.startsWith('data:')),
    false,
  );

  const broadcast = await call(
    middleware,
    request({
      method: 'POST',
      url: '/push',
      headers: { authorization: `Bearer ${TOKEN}` },
      body: '{"session":"*","view":{"imagery":"esri-imagery"}}',
    }),
  );
  assert.deepEqual(JSON.parse(bodyOf(broadcast)), {
    ok: true,
    delivered: 2,
    sessions: 2,
  });

  const sessions = await call(
    middleware,
    request({
      method: 'GET',
      url: '/sessions',
      headers: { authorization: `Bearer ${TOKEN}` },
    }),
  );
  assert.equal(sessions.statusCode, 200);
  assert.deepEqual(
    JSON.parse(bodyOf(sessions)).map((row) => row.session),
    ['alpha', 'beta'],
  );
  const hidden = await call(
    middleware,
    request({ method: 'GET', url: '/sessions' }),
  );
  assert.equal(hidden.statusCode, 401);
  assert.equal(logs.join('\n').includes(TOKEN), false);
  assert.equal(bodyOf(sessions).includes(TOKEN), false);
});

test('the preview and dev hooks both mount the route, ahead of key setup', () => {
  const plugin = remoteControlPlugin({ token: TOKEN });
  assert.equal(plugin.name, 'remote-control');
  for (const hook of ['configureServer', 'configurePreviewServer']) {
    let mounted = null;
    plugin[hook]({
      middlewares: {
        use(path, handler) {
          mounted = { path, handler };
        },
      },
    });
    assert.equal(mounted.path, '/api/remote');
    assert.equal(typeof mounted.handler, 'function');
  }
  const names = localProviderPlugins().map((entry) => entry.name);
  assert.ok(names.indexOf('remote-control') < names.indexOf('gev-key-setup'));
  assert.equal(names.at(-1), 'gev-key-setup');
});

test('an SSE client stays connected until it goes away', async () => {
  const hub = createRemoteHub({
    setTimer: () => ({ unref() {} }),
    clearTimer() {},
  });
  const middleware = createRemoteMiddleware({ token: TOKEN, hub });
  const server = createServer((req, res) => {
    middleware(req, res, () => {
      res.statusCode = 404;
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const response = await fetch(
      `http://127.0.0.1:${port}/api/remote/stream?session=default`,
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-accel-buffering'), 'no');
    const reader = response.body.getReader();
    const first = await reader.read();
    assert.match(new TextDecoder().decode(first.value), /: connected/);
    assert.equal(hub.list()[0].clients, 1);
    await reader.cancel();
    for (let i = 0; i < 20 && hub.list().length; i += 1)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(hub.list(), []);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

function request({ method = 'GET', url = '/', headers = {}, body = '' } = {}) {
  const handlers = {};
  return {
    method,
    url,
    headers,
    body,
    socket: { setNoDelay() {} },
    on(event, fn) {
      (handlers[event] ||= []).push(fn);
      return this;
    },
    emit(event, payload) {
      for (const fn of handlers[event] || []) fn(payload);
    },
  };
}

function response() {
  const handlers = {};
  return {
    statusCode: 0,
    headers: {},
    chunks: [],
    headersSent: false,
    writeHead(status, headers) {
      this.statusCode = status;
      Object.assign(this.headers, headers || {});
      this.headersSent = true;
    },
    flushHeaders() {
      this.flushedHeaders = true;
    },
    flush() {
      this.flushed = true;
    },
    write(chunk) {
      this.chunks.push(String(chunk));
      return true;
    },
    end(payload) {
      if (payload !== undefined) this.chunks.push(String(payload));
      this.ended = true;
    },
    on(event, fn) {
      (handlers[event] ||= []).push(fn);
    },
    emit(event) {
      for (const fn of handlers[event] || []) fn();
    },
  };
}

async function call(middleware, req) {
  const res = response();
  const pending = middleware(req, res, () => {
    res.statusCode = 404;
    res.ended = true;
  });
  if (req.method === 'POST') {
    req.emit('data', Buffer.from(req.body || ''));
    req.emit('end');
  }
  await pending;
  return res;
}

function bodyOf(res) {
  return res.chunks.join('');
}
