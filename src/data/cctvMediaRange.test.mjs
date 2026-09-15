// Client `Range` handling for the CCTV media proxy. The route used to relay
// req.headers.range verbatim to a third-party upstream; these pin what is now
// allowed through, both as string policy and through the mounted route with an
// injected upstream.
//
// Run with: npm test   (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { Readable } from 'node:stream';
import { cctvProxy } from '../../server/providers/cctv.js';
import { sanitizeCctvRangeHeader } from '../../server/providers/cctv/range.js';
import { CCTV_MEDIA_MAX_BODY_BYTES as CAP } from '../../server/providers/cctv/constants.js';

test('single well-formed byte ranges pass through canonicalized', () => {
  assert.equal(sanitizeCctvRangeHeader('bytes=0-1023'), 'bytes=0-1023');
  // A single range that names the same byte twice is legal.
  assert.equal(sanitizeCctvRangeHeader('bytes=7-7'), 'bytes=7-7');
  // The unit is case-insensitive (RFC 7233 §2.1); surrounding space is legal.
  assert.equal(sanitizeCctvRangeHeader('  BYTES=0-99  '), 'bytes=0-99');
});

test('multi-range is dropped so the upstream never answers multipart/byteranges', () => {
  // The relay forwards Content-Length/Content-Range and caps on a single
  // declared body; a multipart response defeats that accounting.
  assert.equal(sanitizeCctvRangeHeader('bytes=0-1,2-3'), '');
  assert.equal(sanitizeCctvRangeHeader('bytes=0-1, 100-200, 300-'), '');
});

test('malformed, non-byte and CR/LF-bearing values are dropped, not forwarded', () => {
  for (const bad of [
    'bytes=abc-def',
    'bytes=',
    'bytes=-',
    'bytes=1-2-3',
    '0-100', // no unit
    'items=0-100', // a unit the proxy does not understand
    'bytes=1.5-2',
    'bytes=-0', // zero-length suffix is unsatisfiable
    'bytes=0x10-0x20',
    'bytes=+5-10',
    'bytes=-5-10',
    // An outbound request refuses to carry these, and the failure used to be
    // written into the camera's health message.
    'bytes=0-10\r\nX-Injected: 1',
    'bytes=0-10\nHost: evil.example',
  ]) {
    assert.equal(
      sanitizeCctvRangeHeader(bad),
      '',
      `expected drop: ${JSON.stringify(bad)}`,
    );
  }
});

test('non-string and empty inputs yield no Range header', () => {
  // req.headers.range is undefined on a normal GET, and Node hands back an
  // array when a client sends the header twice.
  assert.equal(sanitizeCctvRangeHeader(undefined), '');
  assert.equal(sanitizeCctvRangeHeader(null), '');
  assert.equal(sanitizeCctvRangeHeader(''), '');
  assert.equal(sanitizeCctvRangeHeader('   '), '');
  assert.equal(sanitizeCctvRangeHeader(['bytes=0-1', 'bytes=2-3']), '');
  assert.equal(sanitizeCctvRangeHeader(42), '');
});

test('every accepted form is bounded to the relay body cap', () => {
  // Explicit span.
  assert.equal(
    sanitizeCctvRangeHeader('bytes=0-999999999999'),
    `bytes=0-${CAP - 1}`,
  );
  assert.equal(
    sanitizeCctvRangeHeader('bytes=1000-999999999999'),
    `bytes=1000-${1000 + CAP - 1}`,
  );
  // Open-ended: bounded too, rather than asking an upstream for a whole file
  // of unknown size.
  assert.equal(
    sanitizeCctvRangeHeader('bytes=500-'),
    `bytes=500-${500 + CAP - 1}`,
  );
  // Suffix: bounded to one span of the tail.
  assert.equal(sanitizeCctvRangeHeader('bytes=-500'), 'bytes=-500');
  assert.equal(sanitizeCctvRangeHeader('bytes=-999999999999'), `bytes=-${CAP}`);
  // Exactly at the cap, and comfortably under it, are untouched.
  assert.equal(
    sanitizeCctvRangeHeader(`bytes=0-${CAP - 1}`),
    `bytes=0-${CAP - 1}`,
  );
  assert.equal(sanitizeCctvRangeHeader('bytes=0-1048575'), 'bytes=0-1048575');
});

test('inverted and unsafe-integer positions are dropped', () => {
  assert.equal(sanitizeCctvRangeHeader('bytes=500-100'), '');
  // Beyond Number.MAX_SAFE_INTEGER the arithmetic silently loses precision.
  assert.equal(sanitizeCctvRangeHeader('bytes=99999999999999999-'), '');
  // Absurd digit counts are refused before any Number() conversion.
  assert.equal(sanitizeCctvRangeHeader(`bytes=0-${'9'.repeat(64)}`), '');
});

// ---------------------------------------------------------------------------
// The mounted route, with the upstream injected through globalThis.fetch.
// ---------------------------------------------------------------------------

const CAMERA = {
  id: 'range-fixture',
  name: 'Range fixture',
  lat: 30.27,
  lon: -97.74,
  feedType: 'video',
  url: 'https://upstream.invalid/live.mp4',
};

/** A minimal upstream Response with a streaming body. */
function upstreamResponse({ status = 206, headers = {}, body = 'payload' }) {
  const store = new Map(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => store.get(String(name).toLowerCase()) ?? null },
    body:
      body === null
        ? null
        : Readable.toWeb(Readable.from([Buffer.from(String(body))])),
    arrayBuffer: async () => Buffer.from(String(body)),
  };
}

/** Collects what a handler wrote, the way a Node ServerResponse would. */
function recordingResponse() {
  const chunks = [];
  let finished;
  const done = new Promise((resolve) => {
    finished = resolve;
  });
  const res = {
    statusCode: 0,
    headers: {},
    writableEnded: false,
    body: '',
    writeHead(status, headers) {
      res.statusCode = status;
      res.headers = headers || {};
    },
    write(chunk) {
      chunks.push(Buffer.from(chunk));
      return true;
    },
    end(chunk) {
      if (chunk) chunks.push(Buffer.from(chunk));
      res.writableEnded = true;
      res.body = Buffer.concat(chunks).toString('utf8');
      finished();
    },
    on() {},
    once() {},
    emit() {},
    destroy() {},
  };
  return { res, done };
}

/**
 * Mount the real provider, serve one camera, and answer its upstream from the
 * supplied function.
 */
function mount(t, respond) {
  const before = {
    json: process.env.CCTV_SOURCES_JSON,
    file: process.env.CCTV_SOURCES_FILE,
    austin: process.env.CCTV_FORCE_AUSTIN,
  };
  process.env.CCTV_SOURCES_JSON = JSON.stringify([CAMERA]);
  process.env.CCTV_SOURCES_FILE = 'absent-source-file.json';
  process.env.CCTV_FORCE_AUSTIN = '0';
  const nativeFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    requests.push({
      url: String(url),
      headers: init.headers || {},
      signal: init.signal || null,
    });
    return respond({ url: String(url), init });
  };
  t.after(() => {
    globalThis.fetch = nativeFetch;
    for (const [name, value] of [
      ['CCTV_SOURCES_JSON', before.json],
      ['CCTV_SOURCES_FILE', before.file],
      ['CCTV_FORCE_AUSTIN', before.austin],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  let handler = null;
  const plugin = cctvProxy();
  plugin.configureServer({
    middlewares: {
      use: (_route, fn) => {
        handler = fn;
      },
    },
  });
  assert.ok(handler, 'the CCTV provider must mount a middleware');

  /** Drive one request through the mounted handler. */
  const call = async (path, headers = {}) => {
    const { res, done } = recordingResponse();
    await handler({ url: path, headers, method: 'GET', on() {} }, res);
    await done;
    return res;
  };
  /** Read the camera's current health entry. */
  const health = async () => {
    const res = await call('/health');
    return JSON.parse(res.body).cameras.find(({ id }) => id === CAMERA.id);
  };
  return { call, health, requests, handler: (req, res) => handler(req, res) };
}

test('a canonical range reaches the upstream and its 206 is passed through', async (t) => {
  const app = mount(t, () =>
    upstreamResponse({
      status: 206,
      headers: {
        'content-type': 'video/mp4',
        'content-range': 'bytes 0-1023/4096',
        'content-length': '1024',
        'accept-ranges': 'bytes',
      },
      body: 'partial',
    }),
  );
  const res = await app.call(`/media/${CAMERA.id}`, { range: 'bytes=0-1023' });
  assert.equal(app.requests.at(-1).headers.Range, 'bytes=0-1023');
  assert.equal(res.statusCode, 206);
  assert.equal(res.headers['Content-Range'], 'bytes 0-1023/4096');
  assert.equal(res.headers['Accept-Ranges'], 'bytes');
  assert.equal(res.body, 'partial');
});

test('an unbounded seek is bounded before it is forwarded', async (t) => {
  const app = mount(t, () =>
    upstreamResponse({
      status: 206,
      headers: { 'content-type': 'video/mp4' },
      body: 'tail',
    }),
  );
  await app.call(`/media/${CAMERA.id}`, { range: 'bytes=500-' });
  assert.equal(app.requests.at(-1).headers.Range, `bytes=500-${500 + CAP - 1}`);
});

test('a rejected range is dropped and the request proceeds without one', async (t) => {
  const app = mount(t, () =>
    upstreamResponse({
      status: 200,
      headers: { 'content-type': 'video/mp4' },
      body: 'whole body',
    }),
  );
  const res = await app.call(`/media/${CAMERA.id}`, {
    range: 'bytes=0-10\r\nX-Injected: 1',
  });
  // Documented choice: drop the header rather than answer 400, so a client
  // that sends something this proxy will not carry still gets its media.
  assert.equal(app.requests.at(-1).headers.Range, undefined);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, 'whole body');
});

test('a rejected range leaves the camera health report untouched', async (t) => {
  const app = mount(t, () =>
    upstreamResponse({
      status: 200,
      headers: { 'content-type': 'video/mp4' },
      body: 'whole body',
    }),
  );
  await app.call(`/media/${CAMERA.id}`, {
    range: 'bytes=0-10\r\nX-Injected: 1',
  });
  const entry = await app.health();
  assert.equal(entry.status, 'ok');
  // The client's own string must never appear in a report other callers read.
  assert.doesNotMatch(JSON.stringify(entry), /X-Injected/);
});

test('a multi-range request is served whole rather than as multipart', async (t) => {
  const app = mount(t, ({ init }) =>
    upstreamResponse({
      status: init?.headers?.Range ? 206 : 200,
      headers: {
        'content-type': init?.headers?.Range
          ? 'multipart/byteranges; boundary=x'
          : 'video/mp4',
      },
      body: 'whole body',
    }),
  );
  const res = await app.call(`/media/${CAMERA.id}`, {
    range: 'bytes=0-1,2-3',
  });
  assert.equal(app.requests.at(-1).headers.Range, undefined);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Content-Type'], 'video/mp4');
});

test('an upstream 416 is reported as the upstream status, not as a proxy error', async (t) => {
  const app = mount(t, () =>
    upstreamResponse({
      status: 416,
      headers: { 'content-range': 'bytes */1024' },
      body: null,
    }),
  );
  const res = await app.call(`/media/${CAMERA.id}`, {
    range: `bytes=${2 ** 40}-${2 ** 40 + 10}`,
  });
  assert.equal(res.statusCode, 416);
  assert.match(res.body, /416/);
  const entry = await app.health();
  assert.equal(entry.status, 'degraded');
  assert.equal(entry.message, 'Upstream HTTP 416');
});

test('an upstream that ignores the range still serves its whole body', async (t) => {
  const app = mount(t, () =>
    upstreamResponse({
      status: 200,
      headers: { 'content-type': 'video/mp4', 'content-length': '10' },
      body: 'whole body',
    }),
  );
  const res = await app.call(`/media/${CAMERA.id}`, { range: 'bytes=0-1023' });
  assert.equal(app.requests.at(-1).headers.Range, 'bytes=0-1023');
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, 'whole body');
});

test('an oversized declared body is refused even when a bounded range asked for it', async (t) => {
  const app = mount(t, () =>
    upstreamResponse({
      status: 206,
      headers: {
        'content-type': 'video/mp4',
        'content-length': String(CAP + 1),
      },
      body: 'too big',
    }),
  );
  const res = await app.call(`/media/${CAMERA.id}`, { range: 'bytes=0-1023' });
  assert.equal(res.statusCode, 502);
  assert.match(res.body, /exceeds size cap/);
});

test('a client that disconnects mid-stream stops the upstream read', async (t) => {
  // A live feed with no end of its own, counting what it is asked to produce.
  let produced = 0;
  let stopped = false;
  const endlessBody = () =>
    Readable.toWeb(
      Readable.from(
        (async function* () {
          try {
            for (;;) {
              produced += 1;
              yield Buffer.from('frame-chunk-');
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
          } finally {
            stopped = true;
          }
        })(),
      ),
    );
  const app = mount(t, () => ({
    ok: true,
    status: 206,
    headers: {
      get: (name) =>
        String(name).toLowerCase() === 'content-type' ? 'video/mp4' : null,
    },
    body: endlessBody(),
    arrayBuffer: async () => Buffer.alloc(0),
  }));

  const server = http.createServer((req, res) => {
    req.url = req.url.replace('/api/cctv', '') || '/';
    Promise.resolve(app.handler(req, res)).catch(() => {});
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  const failures = [];
  const onUncaught = (error) => failures.push(error);
  process.on('uncaughtException', onUncaught);
  t.after(() => process.off('uncaughtException', onUncaught));

  await new Promise((resolve, reject) => {
    const request = http.get(
      {
        host: '127.0.0.1',
        port,
        path: `/media/${CAMERA.id}`.replace(/^/, '/api/cctv'),
        headers: { Range: 'bytes=0-1023' },
      },
      (response) => {
        response.once('data', () => {
          // Walk away mid-body, the way a browser does when the operator
          // switches camera.
          request.destroy();
          resolve();
        });
        response.on('error', () => resolve());
      },
    );
    request.on('error', reject);
  });

  await new Promise((resolve) => setTimeout(resolve, 150));
  const afterDisconnect = produced;
  await new Promise((resolve) => setTimeout(resolve, 400));
  // The point: the camera host is no longer being read from. Without the
  // release this counter keeps climbing for as long as the upstream will feed.
  assert.equal(
    produced,
    afterDisconnect,
    `the upstream was still being read after the client left (${afterDisconnect} → ${produced} chunks)`,
  );
  assert.equal(stopped, true, 'the upstream body was never released');
  assert.deepEqual(
    failures.map((error) => error?.message),
    [],
    'a client walking away must not fault the server',
  );
  const entry = await app.health();
  // The camera was serving fine; the client left. Nothing about that is a
  // camera fault other viewers should see.
  assert.equal(entry.status, 'ok');
});

test('a client that leaves before the headers arrive cancels the upstream request', async (t) => {
  // The camera is slow, or dead: nothing comes back until the request is
  // cancelled. Everything worth testing here happens before any header.
  let aborted = false;
  const app = mount(t, ({ init }) => {
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        aborted = true;
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
    });
  });

  const server = http.createServer((req, res) => {
    req.url = req.url.replace('/api/cctv', '') || '/';
    Promise.resolve(app.handler(req, res)).catch(() => {});
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  const failures = [];
  const onUncaught = (error) => failures.push(error);
  process.on('uncaughtException', onUncaught);
  t.after(() => process.off('uncaughtException', onUncaught));

  const request = http.get({
    host: '127.0.0.1',
    port,
    path: `/api/cctv/media/${CAMERA.id}`,
    headers: { Range: 'bytes=0-1023' },
  });
  request.on('error', () => {});
  // Let the route reach its upstream request, then walk away before it answers.
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(app.requests.length, 1, 'the upstream request went out');
  assert.equal(aborted, false, 'nothing was cancelled while the client waited');
  request.destroy();
  await new Promise((resolve) => setTimeout(resolve, 250));

  assert.equal(aborted, true, 'the upstream request outlived the client');
  assert.deepEqual(
    failures.map((error) => error?.message),
    [],
    'a client leaving early must not fault the server',
  );
  // The camera did nothing wrong; the viewer left.
  const entry = await app.health();
  assert.notEqual(entry?.status, 'degraded');
});

test('a folded CR/LF range never reaches the upstream through a real client', async (t) => {
  // Node's own parser, not a hand-built headers object, so the reachability of
  // this shape through an ordinary HTTP request is shown rather than assumed.
  const app = mount(t, () =>
    upstreamResponse({
      status: 200,
      headers: { 'content-type': 'video/mp4' },
      body: 'whole body',
    }),
  );
  const server = http.createServer((req, res) => {
    req.url = req.url.replace('/api/cctv', '') || '/';
    Promise.resolve(app.handler(req, res)).catch(() => {});
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  // A client can fold a value across a continuation line; Node's parser
  // rejoins it, so what the route sees contains whitespace a header cannot
  // carry back out.
  const raw = await new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(
        `GET /api/cctv/media/${CAMERA.id} HTTP/1.1\r\n` +
          'Host: 127.0.0.1\r\n' +
          'Range: bytes=0-10\r\n\tX-Injected: 1\r\n' +
          'Connection: close\r\n\r\n',
      );
    });
    let text = '';
    socket.on('data', (chunk) => {
      text += chunk.toString('utf8');
    });
    socket.on('end', () => resolve(text));
    socket.on('error', reject);
  });

  // Either Node's parser refuses the request outright, or it reaches the route
  // and the route drops the value — but it must never be forwarded.
  const reachedRoute = app.requests.length > 0;
  assert.match(raw, /^HTTP\/1\.1 (200|400)/);
  if (reachedRoute) {
    assert.equal(
      app.requests.at(-1).headers.Range,
      undefined,
      'nothing was forwarded',
    );
    assert.match(raw, /^HTTP\/1\.1 200/);
  } else {
    assert.match(raw, /^HTTP\/1\.1 400/);
  }
  console.log(
    `    [range] folded CR/LF request ${reachedRoute ? 'reached the route and was dropped' : 'was refused by the HTTP parser'}`,
  );
  const entry = await app.health();
  assert.doesNotMatch(JSON.stringify(entry ?? {}), /X-Injected/);
});

test('two sequential seeks are served as two partial responses', async (t) => {
  const app = mount(t, ({ init }) => {
    const range = init?.headers?.Range || '';
    const [, first, last] = /bytes=(\d+)-(\d+)/.exec(range) || [];
    return upstreamResponse({
      status: 206,
      headers: {
        'content-type': 'video/mp4',
        'content-range': `bytes ${first}-${last}/4096`,
        'content-length': String(Number(last) - Number(first) + 1),
        'accept-ranges': 'bytes',
      },
      body: `chunk-${first}`,
    });
  });
  const first = await app.call(`/media/${CAMERA.id}`, { range: 'bytes=0-99' });
  const second = await app.call(`/media/${CAMERA.id}`, {
    range: 'bytes=100-199',
  });
  assert.equal(app.requests[0].headers.Range, 'bytes=0-99');
  assert.equal(app.requests[1].headers.Range, 'bytes=100-199');
  assert.equal(first.statusCode, 206);
  assert.equal(second.statusCode, 206);
  assert.equal(first.headers['Content-Range'], 'bytes 0-99/4096');
  assert.equal(second.headers['Content-Range'], 'bytes 100-199/4096');
  assert.equal(first.body, 'chunk-0');
  assert.equal(second.body, 'chunk-100');
});
