import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  radiosondesProxy,
  sondeRetryCooldownMs,
  POLL_LEASE_MS,
  IDLE_CLOSE_MS,
  FLUSH_MS,
  MAX_SSE_QUEUED_BYTES,
} from './radiosondes.js';
import { encodeRemainingLength } from './sondehub/mqtt.js';
const start = 1_800_000_000_000;
const raw = (time = start, serial = 'TEST123') => ({
  serial,
  datetime: time,
  time_received: time,
  lat: 50,
  lon: 10,
  alt: 15000,
  uploader_callsign: 'PRIVATE',
  uploader_position: [0, 0],
  uploader_future: 'private',
  rssi: -12,
  snr: 42,
});
const response = (value, options) =>
  new Response(JSON.stringify(value), options);
const settle = () => new Promise(setImmediate);
function clock() {
  let value = start,
    next = 0;
  const timers = new Map();
  const schedule = (fn, delay, repeat) => {
    const id = ++next;
    timers.set(id, { fn, at: value + delay, repeat });
    return id;
  };
  return {
    now: () => value,
    timers,
    setTimeoutImpl: (fn, delay) => schedule(fn, delay, 0),
    clearTimeoutImpl: (id) => timers.delete(id),
    setIntervalImpl: (fn, delay) => schedule(fn, delay, delay),
    clearIntervalImpl: (id) => timers.delete(id),
    async advance(ms) {
      const end = value + ms;
      for (;;) {
        const candidate = [...timers]
          .filter(([, t]) => t.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!candidate) break;
        const [id, timer] = candidate;
        value = timer.at;
        if (timer.repeat) timer.at += timer.repeat;
        else timers.delete(id);
        timer.fn();
        await settle();
      }
      value = end;
      await settle();
    },
  };
}
function harness(t, fetcher) {
  const time = clock(),
    sockets = [],
    calls = [],
    mounts = [];
  class Socket extends EventEmitter {
    constructor(url, protocol, options) {
      super();
      this.url = url;
      this.protocol = protocol;
      this.options = options;
      this.sent = [];
      this.terminated = false;
      sockets.push(this);
    }
    send(value) {
      this.sent.push(value);
    }
    terminate() {
      this.terminated = true;
      this.emit('close');
    }
    live() {
      this.emit('open');
      this.emit('message', Buffer.from('20020000', 'hex'));
      this.emit('message', Buffer.from('9003000100', 'hex'));
    }
    batch(frames) {
      const topic = Buffer.from([0, 5, ...Buffer.from('batch')]);
      const body = Buffer.concat([topic, Buffer.from(JSON.stringify(frames))]);
      this.emit(
        'message',
        Buffer.concat([
          Buffer.from([0x30]),
          encodeRemainingLength(body.length),
          body,
        ]),
      );
    }
  }
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (fetcher) return fetcher(url, options, time);
    if (url.endsWith('/websocket'))
      return new Response('wss://ws-reader.v2.sondehub.org/', {
        headers: { 'content-type': 'text/plain' },
      });
    return response(
      url.includes('/sonde/')
        ? [raw(time.now())]
        : { TEST123: raw(time.now()) },
    );
  };
  const plugin = radiosondesProxy({
    ...time,
    fetchImpl,
    WebSocketImpl: Socket,
  });
  const server = {
    middlewares: { use: (path, handler) => mounts.push({ path, handler }) },
    httpServer: new EventEmitter(),
  };
  plugin.configureServer(server);
  plugin.configurePreviewServer(server);
  t.after(() => plugin.closeBundle());
  async function request(
    url = '/snapshot',
    {
      method = 'GET',
      ip = '127.0.0.1',
      headers = {},
      queuedBytes = 0,
      bufferWrites = false,
    } = {},
  ) {
    const req = Object.assign(new EventEmitter(), {
      url,
      method,
      headers: { host: 'localhost', ...headers },
      socket: { remoteAddress: ip },
    });
    const res = Object.assign(new EventEmitter(), {
      headers: {},
      chunks: [],
      destroyed: false,
      writableLength: queuedBytes,
      setHeader(k, v) {
        this.headers[k] = v;
      },
      writeHead(status, values) {
        this.statusCode = status;
        Object.assign(this.headers, values);
      },
      write(chunk) {
        this.chunks.push(chunk);
        if (bufferWrites) this.writableLength += Buffer.byteLength(chunk);
        return true;
      },
      end(chunk = '') {
        this.chunks.push(chunk);
        this.writableEnded = true;
      },
      destroy() {
        this.destroyed = true;
        this.emit('close');
      },
    });
    await mounts[0].handler(req, res);
    return { req, res, body: () => JSON.parse(res.chunks.join('')) };
  }
  return { time, sockets, calls, mounts, plugin, server, request };
}
const events = (res, type) =>
  res.chunks
    .filter((v) => v.startsWith(`event: ${type}\n`))
    .map((v) => JSON.parse(v.split('data: ')[1]));
test('construction inert; both hooks, admission, method/path/query validation precede upstream work', async (t) => {
  const h = harness(t);
  assert.equal(h.calls.length, 0);
  assert.equal(h.time.timers.size, 0);
  assert.equal(h.sockets.length, 0);
  assert.deepEqual(
    h.mounts.map((m) => m.path),
    ['/api/radiosondes', '/api/radiosondes'],
  );
  assert.equal(
    (
      await h.request('/stream', {
        headers: { 'sec-fetch-site': 'cross-site' },
      })
    ).res.statusCode,
    403,
  );
  const post = await h.request('/snapshot', { method: 'POST' });
  assert.equal(post.res.statusCode, 405);
  assert.equal(post.res.headers.Allow, 'GET');
  assert.equal((await h.request('/unknown')).res.statusCode, 404);
  for (const serial of ['', '../x', 'x', 'abc%2Fdef'])
    assert.equal(
      (await h.request(`/track?serial=${serial}`)).res.statusCode,
      400,
    );
  assert.equal(h.calls.length, 0);
  assert.equal(h.time.timers.size, 0);
});
test('first subscriber starts one identified batch-only connection and receives snapshot then coalesced private-field-free diffs', async (t) => {
  const h = harness(t);
  const first = await h.request('/stream');
  await settle();
  assert.equal(first.res.headers['Content-Type'], 'text/event-stream');
  assert.match(first.res.chunks[0], /retry: 5000/);
  assert.equal(events(first.res, 'snapshot').length, 1);
  assert.equal(h.sockets.length, 1);
  const socket = h.sockets[0];
  assert.equal(socket.protocol, 'mqtt');
  assert.equal(socket.options.perMessageDeflate, true);
  assert.match(
    socket.options.headers['User-Agent'],
    /^gods-eye-view-radiosondes-proxy\/1.0/,
  );
  assert.ok(
    h.calls.every(
      (c) =>
        c.options.headers['User-Agent'] ===
        socket.options.headers['User-Agent'],
    ),
  );
  socket.live();
  assert.equal(socket.sent[1].toString('hex'), '820a00010005626174636800');
  assert.match(socket.sent[0].toString(), /gev-[a-f0-9]{12}/);
  const second = await h.request('/stream', { ip: 'other' });
  assert.equal(h.sockets.length, 1);
  await h.time.advance(2000);
  socket.batch([raw(h.time.now()), raw(h.time.now() + 1)]);
  assert.equal(events(first.res, 'frames').length, 2);
  assert.deepEqual(
    events(first.res, 'frames')[1].frames,
    [],
    'completion metadata does not resend contacts',
  );
  await h.time.advance(2000);
  const diffs = events(first.res, 'frames');
  assert.equal(diffs.at(-1).frames.length, 1);
  assert.doesNotMatch(
    first.res.chunks.join(''),
    /PRIVATE|private|uploader|rssi|snr/,
  );
  assert.equal(events(second.res, 'frames').length, 2);
  const poll = await h.request('/snapshot');
  assert.equal(poll.res.statusCode, 200);
  assert.equal(poll.body().stale, false);
  first.req.emit('close');
  second.req.emit('close');
  h.server.httpServer.emit('close');
  assert.equal(socket.terminated, true);
  assert.equal(h.time.timers.size, 0);
});
test('subsequent SSE messages contain only changed serials and unchanged contacts are never resent', async (t) => {
  const h = harness(t, (url) =>
    url.endsWith('/websocket')
      ? new Response('wss://ws-reader.v2.sondehub.org/')
      : response([raw(start, 'FIRST123'), raw(start, 'OTHER123')]),
  );
  const first = await h.request('/stream');
  await settle();
  h.sockets[0].live();
  await h.time.advance(FLUSH_MS);
  const second = await h.request('/stream', { ip: 'second' });
  assert.equal(events(second.res, 'snapshot')[0].frames.length, 2);
  for (let i = 0; i < 10; i++) {
    h.sockets[0].batch([raw(h.time.now(), 'FIRST123')]);
    await h.time.advance(FLUSH_MS);
  }
  assert.equal(events(second.res, 'snapshot').length, 1);
  assert.equal(events(first.res, 'snapshot').length, 1);
  const deltas = events(second.res, 'frames');
  assert.equal(deltas.length, 10);
  assert.ok(
    deltas.every(
      ({ frames }) => frames.length === 1 && frames[0].serial === 'FIRST123',
    ),
  );
});
for (const event of ['frames', 'heartbeat']) {
  test(`SSE ${event} queue cap includes the next write and disconnects before buffering it`, async (t) => {
    const h = harness(t);
    const stream = await h.request('/stream', { bufferWrites: true });
    await settle();
    h.sockets[0].live();
    await h.time.advance(FLUSH_MS);
    stream.res.writableLength = MAX_SSE_QUEUED_BYTES - 1;
    const writes = stream.res.chunks.length;
    if (event === 'frames') h.sockets[0].batch([raw(h.time.now())]);
    await h.time.advance(event === 'frames' ? FLUSH_MS : 25_000 - FLUSH_MS);
    assert.equal(stream.res.destroyed, true);
    assert.equal(stream.res.chunks.length, writes);
    assert.ok(stream.res.writableLength <= MAX_SSE_QUEUED_BYTES);
    if (event === 'frames') {
      // A disconnected client releases the stream slot immediately.
      for (let i = 0; i < 64; i++)
        assert.equal(
          (await h.request('/stream', { ip: `replacement-${i}` })).res
            .statusCode,
          200,
        );
    }
  });
}
test('an overflowing initial stream never starts acquisition', async (t) => {
  const initial = harness(t);
  const overflow = await initial.request('/stream', {
    queuedBytes: MAX_SSE_QUEUED_BYTES - 1,
    bufferWrites: true,
  });
  assert.equal(overflow.res.destroyed, true);
  assert.equal(overflow.res.chunks.length, 0);
  assert.equal(initial.calls.length, 0);
  assert.equal(initial.time.timers.size, 0);
});
test('documented serial-to-object backfill populates snapshots and rolling tracks before MQTT', async (t) => {
  const h = harness(t);
  await h.request('/stream');
  await settle();
  const snapshot = await h.request('/snapshot');
  assert.equal(snapshot.res.statusCode, 200);
  assert.deepEqual(
    snapshot.body().frames.map((f) => f.serial),
    ['TEST123'],
  );
  const track = await h.request('/track?serial=TEST123');
  assert.equal(track.body().track.length, 1);
  assert.doesNotMatch(
    JSON.stringify(snapshot.body()),
    /PRIVATE|uploader|rssi|snr/,
  );
});
test('disposing the feed aborts pending acquisition and history requests and clears demand timers', async (t) => {
  const h = harness(
    t,
    (url, { signal }) =>
      new Promise((resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        }),
      ),
  );
  assert.equal((await h.request()).res.statusCode, 202);
  const history = h.request('/history?serial=TEST123');
  await settle();
  assert.equal(
    h.calls.length,
    3,
    'backfill, discovery and history acquire independently',
  );
  assert.ok(h.calls.every(({ options }) => !options.signal.aborted));
  h.plugin.closeBundle();
  await history;
  assert.ok(h.calls.every(({ options }) => options.signal.aborted));
  assert.equal(h.time.timers.size, 0);
  assert.equal(h.sockets.length, 0);
});
test('cold snapshots return building until backfill supplies data, then 200 before MQTT is live', async (t) => {
  let finishBackfill;
  const h = harness(t, (url) =>
    url.endsWith('/websocket')
      ? new Response('wss://ws-reader.v2.sondehub.org/')
      : new Promise((resolve) => (finishBackfill = resolve)),
  );
  for (let i = 0; i < 2; i++) {
    const cold = await h.request();
    assert.equal(cold.res.statusCode, 202);
    assert.deepEqual(cold.body(), { status: 'building' });
    assert.equal(cold.res.headers['Retry-After'], '1');
    assert.equal(cold.res.headers['Content-Type'], 'application/json');
    assert.equal(cold.res.headers['Cache-Control'], 'no-store');
    assert.equal(cold.res.headers['X-Data-Stale'], undefined);
  }
  assert.equal(
    h.calls.filter((c) => c.url.includes('?last=')).length,
    1,
    'cold readers share the initial backfill',
  );
  finishBackfill(response({ TEST123: raw() }));
  await settle();
  const ready = await h.request();
  assert.equal(ready.res.statusCode, 200);
  assert.equal(ready.res.headers['Retry-After'], undefined);
  assert.equal(ready.body().upstream, 'connecting');
  assert.equal(ready.body().stale, true);
  assert.deepEqual(
    ready.body().frames.map((f) => f.serial),
    ['TEST123'],
  );
  assert.equal(h.sockets.length, 1);
});
test('recent backfill is published as a partial snapshot before older history completes', async (t) => {
  const pending = new Map();
  const h = harness(t, (url) =>
    url.endsWith('/websocket')
      ? new Response('wss://ws-reader.v2.sondehub.org/')
      : new Promise((resolve) =>
          pending.set(new URL(url).searchParams.get('last'), resolve),
        ),
  );
  const stream = await h.request('/stream');
  assert.equal((await h.request()).res.statusCode, 202);
  assert.deepEqual(
    [...pending.keys()],
    ['1800'],
    'the recent window must be requested first',
  );
  pending.get('1800')(response({ RECENT123: raw(start, 'RECENT123') }));
  await settle();
  assert.deepEqual([...pending.keys()], ['1800', '10800']);
  const partial = await h.request();
  assert.equal(partial.res.statusCode, 200);
  assert.equal(partial.body().partial, true);
  assert.equal(partial.body().stale, true);
  assert.deepEqual(
    partial.body().frames.map((f) => f.serial),
    ['RECENT123'],
  );
  assert.equal(events(stream.res, 'frames').at(-1).partial, true);
  assert.doesNotMatch(
    JSON.stringify(partial.body()),
    /PRIVATE|uploader|rssi|snr/,
  );
  pending.get('10800')(
    response({ OLDER123: raw(start - 3_600_000, 'OLDER123') }),
  );
  await settle();
  const complete = await h.request();
  assert.equal(complete.body().partial, false);
  assert.deepEqual(
    complete
      .body()
      .frames.map((f) => f.serial)
      .sort(),
    ['OLDER123', 'RECENT123'],
  );
  await h.time.advance(FLUSH_MS);
  assert.equal(events(stream.res, 'frames').at(-1).partial, false);
});
test('MQTT supplies a partial snapshot and first SSE frames while the first REST window is pending', async (t) => {
  const h = harness(t, (url) =>
    url.endsWith('/websocket')
      ? new Response('wss://ws-reader.v2.sondehub.org/')
      : new Promise(() => {}),
  );
  const stream = await h.request('/stream');
  await settle();
  assert.equal(h.sockets.length, 1, 'REST must not block MQTT connection');
  h.sockets[0].live();
  h.sockets[0].batch([raw()]);
  const partial = await h.request();
  assert.equal(partial.res.statusCode, 200);
  assert.equal(partial.body().partial, true);
  assert.equal(partial.body().stale, false);
  assert.equal(events(stream.res, 'frames').at(-1).frames.length, 1);
  assert.equal(
    h.time.now(),
    start,
    'first data bypasses the 2 s steady-state flush',
  );
});
test('failed older backfill retains the valid partial sample and its receipt time', async (t) => {
  const h = harness(t, (url) => {
    if (url.endsWith('/websocket'))
      return new Response('wss://ws-reader.v2.sondehub.org/');
    return new URL(url).searchParams.get('last') === '1800'
      ? response([raw()])
      : response({ TEST123: { serial: 'TEST123', lat: 91 } });
  });
  await h.request();
  await settle();
  const partial = await h.request();
  assert.equal(partial.res.statusCode, 200);
  assert.equal(partial.body().partial, true);
  assert.equal(partial.body().fetchedAt, start);
  assert.equal(partial.body().frames.length, 1);
});
test('completing an overlapping backfill clears partial over SSE even without new frames', async (t) => {
  let finishOlder;
  const h = harness(t, (url) => {
    if (url.endsWith('/websocket'))
      return new Response('wss://ws-reader.v2.sondehub.org/');
    return new URL(url).searchParams.get('last') === '1800'
      ? response([raw()])
      : new Promise((resolve) => (finishOlder = resolve));
  });
  const stream = await h.request('/stream');
  await settle();
  assert.equal(events(stream.res, 'frames').at(-1)?.partial, true);
  finishOlder(response([raw()]));
  await settle();
  await h.time.advance(FLUSH_MS);
  assert.deepEqual(events(stream.res, 'frames').at(-1).frames, []);
  assert.equal(events(stream.res, 'frames').at(-1).partial, false);
});
test('an empty backfill stays building through discovery and MQTT connection until a live empty snapshot', async (t) => {
  let finishDiscovery;
  const h = harness(t, (url) =>
    url.endsWith('/websocket')
      ? new Promise((resolve) => (finishDiscovery = resolve))
      : response([]),
  );
  await h.request();
  await settle();
  assert.equal((await h.request()).res.statusCode, 202);
  finishDiscovery(new Response('wss://ws-reader.v2.sondehub.org/'));
  await settle();
  assert.equal((await h.request()).res.statusCode, 202);
  h.sockets[0].live();
  const empty = await h.request();
  assert.equal(empty.res.statusCode, 200);
  assert.deepEqual(empty.body().frames, []);
  assert.equal(empty.body().upstream, 'live');
  assert.equal(empty.res.headers['Retry-After'], undefined);
});
for (const failure of ['HTTP', 'invalid backfill', 'rate limit']) {
  test(`a real ${failure} ends building with its failure status and cooldown`, async (t) => {
    let finishBackfill;
    const h = harness(t, (url) =>
      url.endsWith('/websocket')
        ? new Response('wss://ws-reader.v2.sondehub.org/')
        : new Promise((resolve) => (finishBackfill = resolve)),
    );
    assert.equal((await h.request()).res.statusCode, 202);
    finishBackfill(
      failure === 'invalid backfill'
        ? response({ TEST123: { serial: 'TEST123', lat: 91 } })
        : response(
            {},
            {
              status: failure === 'rate limit' ? 429 : 500,
              headers: { 'Retry-After': '60' },
            },
          ),
    );
    await settle();
    const code = failure === 'rate limit' ? 429 : 502;
    const retrySec = failure === 'rate limit' ? 60 : 15;
    const failed = await h.request();
    assert.equal(failed.res.statusCode, code);
    assert.deepEqual(failed.body(), {
      error:
        failure === 'rate limit'
          ? 'radiosondes_rate_limited'
          : 'radiosondes_unavailable',
    });
    assert.equal(failed.res.headers['Retry-After'], String(retrySec));
    await h.time.advance(1000);
    assert.equal(
      (await h.request()).res.headers['Retry-After'],
      String(retrySec - 1),
    );
    assert.equal(
      h.calls.length,
      2,
      'cooldown prevents further REST work after initial backfill and discovery',
    );
    await h.time.advance(retrySec * 1000);
    assert.equal(
      (await h.request()).res.statusCode,
      502,
      'expiry alone cannot turn a failed start into building',
    );
  });
}
test('an empty feed with a real MQTT failure returns 502 and its reconnect delay', async (t) => {
  const h = harness(t, (url) =>
    url.endsWith('/websocket')
      ? new Response('wss://ws-reader.v2.sondehub.org/')
      : response([]),
  );
  await h.request();
  await settle();
  h.sockets[0].emit('error', Error('synthetic broker failure'));
  const failed = await h.request();
  assert.equal(failed.res.statusCode, 502);
  assert.deepEqual(failed.body(), { error: 'radiosondes_unavailable' });
  assert.equal(failed.res.headers['Retry-After'], '5');
});
test('plain-text discovery trims a validated non-fallback URL without cooling down history', async (t) => {
  const endpoint = 'wss://ws-test.v2.sondehub.org/mqtt';
  const h = harness(t, (url) => {
    if (url.endsWith('/websocket'))
      return new Response(`  ${endpoint}\n`, {
        headers: { 'content-type': 'text/plain' },
      });
    return response(url.includes('/sonde/') ? [raw()] : { TEST123: raw() });
  });
  await h.request('/stream');
  await settle();
  assert.equal(h.sockets[0].url, endpoint);
  assert.equal(
    h.calls.find((c) => c.url.endsWith('/websocket')).options.headers.Accept,
    'text/plain',
  );
  const history = await h.request('/history?serial=TEST123');
  assert.equal(history.res.statusCode, 200);
  assert.equal(history.body().track.length, 1);
  assert.equal(h.calls.filter((c) => c.url.includes('/sonde/')).length, 1);
});
test('stream cap and per-client opens limiter return fixed 429 codes', async (t) => {
  const h = harness(t);
  for (let i = 0; i < 64; i++)
    await h.request('/stream', { ip: `client-${i}` });
  const busy = await h.request('/stream', { ip: '65th' });
  assert.equal(busy.res.statusCode, 429);
  assert.equal(busy.body().error, 'busy');
  const h2 = harness(t);
  for (let i = 0; i < 10; i++) {
    const s = await h2.request('/stream');
    s.req.emit('close');
  }
  assert.equal((await h2.request('/stream')).body().error, 'rate_limited');
});
test('polling leases start/hold the feed and idle-close exactly ten minutes after demand expires', async (t) => {
  const h = harness(t);
  const cold = await h.request();
  assert.equal(cold.res.statusCode, 202);
  await settle();
  assert.equal(h.sockets.length, 1);
  h.sockets[0].live();
  for (let i = 0; i < 4; i++) {
    await h.time.advance(60_000);
    h.sockets[0].batch([raw(h.time.now())]);
    await h.request();
  }
  const stream = await h.request('/stream');
  stream.req.emit('close');
  await h.time.advance(POLL_LEASE_MS + IDLE_CLOSE_MS - 1);
  // Watchdog can recycle a silent socket; idle ownership still holds the feed.
  assert.ok(h.time.timers.size > 0);
  await h.time.advance(1);
  assert.equal(h.time.timers.size, 0);
  assert.ok(h.sockets.every((s) => s.terminated));
});
test('SSE-only demand closes at 600 s, watchdog degrades at 120 s and terminates at 300 s; reconnect backfill is throttled', async (t) => {
  const h = harness(t);
  const stream = await h.request('/stream');
  await settle();
  const socket = h.sockets[0];
  socket.live();
  await h.time.advance(120_000);
  assert.equal(events(stream.res, 'status').at(-1).upstream, 'degraded');
  const stale = await h.request();
  assert.equal(stale.body().stale, true);
  assert.equal(stale.res.headers['X-Data-Stale'], 'true');
  await h.time.advance(180_000);
  assert.equal(socket.terminated, true);
  await h.time.advance(5000);
  assert.equal(h.sockets.length, 2);
  assert.deepEqual(
    h.calls
      .filter((c) => c.url.includes('?last='))
      .map((c) => new URL(c.url).searchParams.get('last')),
    ['1800', '10800'],
  );
  h.sockets[1].live();
  h.sockets[1].batch([raw(h.time.now())]);
  stream.req.emit('close');
  await h.time.advance(IDLE_CLOSE_MS - 1);
  assert.ok(h.time.timers.size > 0);
  await h.time.advance(1);
  assert.equal(h.time.timers.size, 0);
});
test('history is bounded, single-flight, TTL-cached, stale on failure, and only redirects to HTTPS S3 subdomains', async (t) => {
  let historyCalls = 0,
    location = 'https://bucket.s3.amazonaws.com/flight.json',
    fail = false;
  const h = harness(t, async (url) => {
    if (url.includes('/sonde/')) {
      historyCalls++;
      if (fail) return response({}, { status: 500 });
      return new Response(null, { status: 302, headers: { location } });
    }
    if (url.startsWith('https://bucket.')) return response([raw()]);
    return response([]);
  });
  const [a, b] = await Promise.all([
    h.request('/history?serial=TEST123'),
    h.request('/history?serial=TEST123'),
  ]);
  assert.equal(a.res.statusCode, 200);
  assert.deepEqual(a.body(), b.body());
  assert.equal(historyCalls, 1);
  await h.request('/history?serial=TEST123');
  assert.equal(historyCalls, 1);
  await h.time.advance(600001);
  fail = true;
  const stale = await h.request('/history?serial=TEST123');
  assert.equal(stale.body().stale, true);
  assert.equal(stale.body().fetchedAt, start);
  await h.time.advance(3 * 3600000);
  assert.equal(
    (await h.request('/history?serial=TEST123')).res.statusCode,
    502,
  );
  for (const bad of [
    'https://evil.example/file',
    'http://bucket.s3.amazonaws.com/file',
    'https://amazonaws.com/file',
    'https://bucket.s3.amazonaws.com.evil.example/file',
  ]) {
    location = bad;
    fail = false;
    await h.time.advance(16000);
    assert.equal(
      (await h.request('/history?serial=OTHER123')).res.statusCode,
      502,
    );
  }
});
test('REST body cap and shared Retry-After cooldown clamp prevent repeated requests', async (t) => {
  let mode = 'large';
  const h = harness(t, async () =>
    mode === 'large'
      ? response([], {
          headers: { 'content-length': String(17 * 1024 * 1024) },
        })
      : response({}, { status: 429, headers: { 'retry-after': '9999999' } }),
  );
  assert.equal(
    (await h.request('/history?serial=TEST123')).res.statusCode,
    502,
  );
  const before = h.calls.length;
  assert.equal(
    (await h.request('/history?serial=OTHER123')).res.statusCode,
    502,
  );
  assert.equal(h.calls.length, before);
  await h.time.advance(16000);
  mode = '429';
  const rate = await h.request('/history?serial=TEST123');
  assert.equal(rate.res.statusCode, 429);
  assert.equal(rate.body().error, 'radiosondes_rate_limited');
  assert.equal(rate.res.headers['Retry-After'], '3600');
  const total = h.calls.length;
  await h.request('/history?serial=OTHER123');
  await h.request();
  await settle();
  assert.equal(h.calls.length, total);
  assert.equal(sondeRetryCooldownMs('1', start), 5000);
  assert.equal(sondeRetryCooldownMs(null, start), 60000);
  assert.equal(
    sondeRetryCooldownMs(new Date(start + 20000).toUTCString(), start),
    20000,
  );
});

test('concurrent 429 responses never shorten the shared cooldown', async (t) => {
  const replies = [];
  const h = harness(t, () => new Promise((resolve) => replies.push(resolve)));
  const a = h.request('/history?serial=FIRST123'),
    b = h.request('/history?serial=OTHER123');
  await settle();
  assert.equal(replies.length, 2);
  replies[0](response({}, { status: 429, headers: { 'retry-after': '60' } }));
  await a;
  await h.time.advance(1000);
  replies[1](response({}, { status: 429, headers: { 'retry-after': '5' } }));
  const second = await b;
  assert.equal(second.res.headers['Retry-After'], '59');
  const third = await h.request('/history?serial=THIRD123');
  assert.equal(third.res.headers['Retry-After'], '59');
  assert.equal(h.calls.length, 2);
});

test('history limits in-flight serials and evicts the oldest of sixteen cache entries', async (t) => {
  const pending = [];
  const h = harness(t, () => new Promise((resolve) => pending.push(resolve)));
  const requests = Array.from({ length: 8 }, (_, i) =>
    h.request(`/history?serial=SON${i}`, { ip: `ip-${i}` }),
  );
  await settle();
  const busy = await h.request('/history?serial=SON8');
  assert.equal(busy.res.statusCode, 429);
  assert.equal(busy.body().error, 'busy');
  pending.forEach((resolve) => resolve(response([])));
  await Promise.all(requests);
  const h2 = harness(t, (url) => response([raw(start, url.split('/').at(-1))]));
  for (let i = 0; i < 17; i++)
    await h2.request(`/history?serial=SON${i}`, { ip: `cache-${i}` });
  assert.equal(h2.calls.length, 17);
  await h2.request('/history?serial=SON0', { ip: 'new' });
  assert.equal(h2.calls.length, 18);
});

test('reverse-ordered backfill seeds the path before admitting its latest frame', async (t) => {
  const h = harness(t, (url) =>
    url.endsWith('/websocket')
      ? new Response('wss://ws-reader.v2.sondehub.org/')
      : response([raw(start), raw(start - 10000)]),
  );
  await h.request('/stream');
  await settle();
  const result = await h.request('/track?serial=TEST123');
  assert.deepEqual(
    result.body().track.map((p) => p.timeMs),
    [start - 10000, start],
  );
  assert.doesNotMatch(
    JSON.stringify(result.body()),
    /uploader|PRIVATE|rssi|snr/,
  );
});
