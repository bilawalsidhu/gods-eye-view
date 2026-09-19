// src/data/gtfsRtProxy.test.mjs
//
// Pins the dev GTFS-RT middleware (`vite/proxies/gtfsrt.js`) end to end with
// a captured connect handler, a mocked upstream fetch, and REAL fixture
// bytes. The motivating defect: the middleware relayed protobuf through a
// UTF-8 text reader, so every feed was corrupted in dev (the browser saw
// "unsupported wire type 4" on real Metro Transit bytes, 2026-09-19) while
// the Pages Function twin — which uses arrayBuffer() — was fine. These tests
// exist so byte fidelity can never regress silently again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { gtfsRtProxy } from '../../vite/proxies/gtfsrt.js';
import { decodeGtfsRtFeed } from './gtfsRtDecode.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));

/** Capture the middleware registration without a real Vite server. */
function fakeServer() {
  const routes = [];
  return {
    routes,
    server: { middlewares: { use: (path, fn) => routes.push({ path, fn }) } },
  };
}

/** Minimal connect-style req/res stubs; `res.body` collects every byte written. */
function stubReqRes(url = 'metro-mn') {
  const headers = {};
  const state = { statusCode: 0, ended: false };
  const chunks = [];
  const req = { method: 'GET', url };
  const res = {
    writeHead(code, hdrs) {
      state.statusCode = code;
      Object.assign(headers, hdrs || {});
    },
    get writableEnded() { return state.ended; },
    end(body) {
      if (body) chunks.push(Uint8Array.from(Buffer.from(body)));
      state.ended = true;
    },
  };
  return {
    req,
    res,
    out: () => Buffer.concat(chunks),
    status: () => state.statusCode,
    headers,
  };
}

/** Replace globalThis.fetch with a fixture-backed fake for the duration of fn. */
async function withUpstreamBytes(bytes, chunkSize, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    new ReadableStream({
      start(controller) {
        for (let i = 0; i < bytes.length; i += chunkSize) {
          controller.enqueue(bytes.slice(i, i + chunkSize));
        }
        controller.close();
      },
    }),
    { status: 200, headers: { 'Content-Type': 'application/x-protobuf' } },
  );
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
}

async function runMiddleware(url) {
  const plugin = gtfsRtProxy();
  const { routes, server } = fakeServer();
  plugin.configureServer(server);
  assert.equal(routes.length, 1, 'middleware must mount exactly one route');
  assert.equal(routes[0].path, '/api/gtfsrt');
  const { req, res, out, status, headers } = stubReqRes(url);
  await routes[0].fn(req, res);
  return { out: out(), status: status(), headers };
}

test('gtfsRtProxy: real MBTA fixture bytes survive the dev middleware byte-identically', async () => {
  const fixture = new Uint8Array(readFileSync(`${FIXTURES}mbta-vehicle-positions.pb`));
  await withUpstreamBytes(fixture, 8192, async () => {
    const { out, status, headers } = await runMiddleware('mbta');
    assert.equal(status, 200);
    assert.equal(headers['Content-Type'], 'application/x-protobuf');
    assert.ok(out.equals(Buffer.from(fixture)),
      'relayed bytes must equal upstream bytes exactly');
    assert.equal(headers['X-GTFSRT-Bytes'], String(out.length));
  });
});

test('gtfsRtProxy: real Metro Transit fixture decodes after the relay (the live-smoke defect)', async () => {
  const fixture = new Uint8Array(readFileSync(`${FIXTURES}metro-mn-vehicle-positions.pb`));
  await withUpstreamBytes(fixture, 1024, async () => {
    const { out } = await runMiddleware('metro-mn');
    assert.ok(out.equals(Buffer.from(fixture)), 'relay must be byte-identical');
    const feed = decodeGtfsRtFeed(new Uint8Array(out));
    assert.ok(feed.entities.length >= 100,
      `real metro-mn snapshot must decode (${feed.entities.length} entities)`);
  });
});

test('gtfsRtProxy: non-UTF-8 garbage bytes are NOT mangled (the exact text-reader failure)', async () => {
  // Every byte here is either invalid standalone UTF-8 or a broken sequence
  // prefix; the old text path turned these into U+FFFD replacement runs.
  const garbage = Uint8Array.from([0x0a, 0xff, 0xfe, 0x80, 0x81, 0xfe, 0xff, 0xc0,
    0xf5, 0xed, 0xa0, 0x80, 0x00, 0x7f, 0xc2, 0x10]);
  await withUpstreamBytes(garbage, 3, async () => {
    const { out } = await runMiddleware('metro-mn');
    assert.ok(out.equals(Buffer.from(garbage)),
      `byte-fidelity violated: ${out.toString('hex')} != ${Buffer.from(garbage).toString('hex')}`);
  });
});

test('gtfsRtProxy: oversized declared Content-Length is refused without reading', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('x', {
    status: 200,
    headers: { 'Content-Length': String(64 * 1024 * 1024) },
  });
  try {
    const { out, status } = await runMiddleware('mbta');
    assert.equal(status, 502, 'oversized upstream must be refused');
    assert.match(out.toString(), /too large/,
      'only the JSON error body may be relayed, never the upstream bytes');
  } finally {
    globalThis.fetch = original;
  }
});

test('gtfsRtProxy: unknown feed id is refused before any upstream fetch', async () => {
  const original = globalThis.fetch;
  let upstreamCalled = false;
  globalThis.fetch = async () => { upstreamCalled = true; return new Response('x'); };
  try {
    const { out, status } = await runMiddleware('not-a-feed');
    assert.equal(status, 403);
    assert.equal(upstreamCalled, false, 'unknown feeds must never reach the network');
    assert.match(out.toString(), /not allowed/);
  } finally {
    globalThis.fetch = original;
  }
});
