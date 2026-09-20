// functions/api/cctv/[[path]].test.mjs
/**
 * Contract tests for the `/api/cctv/*` Pages Function.
 *
 * No real network: every upstream call is served by a stubbed
 * `globalThis.fetch`, which also lets us assert the SSRF rule — the Function
 * must only ever fetch URLs that came from the server-registered catalog
 * (here: `CCTV_SOURCES_JSON`), never one the client supplied.
 *
 * The shared source catalog is cached per process for CCTV_SOURCE_CACHE_MS, so
 * the first request in this file establishes the catalog for the rest of them;
 * the tests below are ordered to rely on that (same guarantee the dev
 * middleware gives a dev server session).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { onRequest } from './[[path]].js';
import { streetViewFallback } from '../../../src/data/cctvSources.js';

const CCTV_SOURCES_JSON = JSON.stringify([
  {
    id: 'cam-a',
    name: 'Congress & 6th',
    city: 'Austin',
    cityId: 'austin',
    provider: 'Test Provider',
    lat: 30.2672,
    lon: -97.7431,
    headingDeg: 90,
    feedType: 'image',
    url: 'https://upstream.example/frames/cam-a.jpg',
    snapshotUrl: 'https://upstream.example/frames/cam-a.jpg',
    sourceKind: 'configured',
  },
  {
    id: 'cam-video',
    name: 'Loop Cam',
    city: 'Austin',
    lat: 30.27,
    lon: -97.74,
    // Only mp4/webm/hls are "video" feeds (isVideoFeedType): mjpeg is served
    // frame-by-frame like a still camera.
    feedType: 'hls',
    url: 'https://upstream.example/stream/cam-video.m3u8',
    sourceKind: 'configured',
  },
  {
    id: 'cam-bare',
    name: 'No URL Cam',
    city: 'Austin',
    lat: 30.28,
    lon: -97.73,
    feedType: 'image',
    sourceKind: 'configured',
  },
]);

/** Build a Pages-Functions-style context. */
const ctx = (path, { env = {}, headers = {} } = {}) => ({
  request: new Request(`https://example.com${path}`, { headers }),
  env,
});

/** Base env: a configured catalog, so no live open-data pack is fetched. */
const baseEnv = () => ({ CCTV_SOURCES_JSON });

/**
 * Install a fetch stub. Unrecognized hosts answer 403 so a test that expects no
 * upstream call fails loudly instead of hanging.
 */
function stubFetch(impl) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    calls.push({ url: String(url), init });
    if (impl) return impl(String(url), init);
    return Promise.resolve(new Response('forbidden', { status: 403 }));
  };
  return {
    calls,
    restore() { globalThis.fetch = original; },
  };
}

test('/sources returns the shared catalog shape with no upstream fetch', async () => {
  const stub = stubFetch();
  try {
    const res = await onRequest(ctx('/api/cctv/sources', { env: baseEnv() }));
    assert.equal(res.status, 200);
    assert.match(res.headers.get('Content-Type') || '', /^application\/json/);
    assert.equal(res.headers.get('Cache-Control'), 'no-store');

    const body = await res.json();
    assert.ok(Array.isArray(body.sources), 'sources must be an array');
    assert.equal(body.sources.length, 3);
    const cam = body.sources.find((s) => s.id === 'cam-a');
    assert.equal(cam.name, 'Congress & 6th');
    assert.equal(cam.provider, 'Test Provider');
    assert.equal(cam.lat, 30.2672);
    assert.equal(cam.feedType, 'image');
    assert.equal(cam.sourceKind, 'configured');
    assert.equal('license' in cam, true);
    // The whole point of the Function: no key, no keyless upstream needed when
    // a catalog is configured.
    assert.equal(stub.calls.length, 0, 'a configured catalog must not trigger open-data fetches');
  } finally {
    stub.restore();
  }
});

test('/stream/:id reports feedType and proxy URLs, and works for unknown ids', async () => {
  const stub = stubFetch();
  try {
    const known = await (await onRequest(ctx('/api/cctv/stream/cam-video', { env: baseEnv() }))).json();
    assert.equal(known.id, 'cam-video');
    assert.equal(known.feedType, 'hls');
    assert.equal(known.mediaUrl, '/api/cctv/media/cam-video');
    assert.equal(known.frameUrl, '/api/cctv/frame/cam-video');
    // cam-video declares no provider → the shared default, as in dev.
    assert.equal(known.provider, 'Configured CCTV Source');

    // An unknown camera is a 200 with a fallback payload, exactly like dev.
    const unknown = await (await onRequest(ctx('/api/cctv/stream/who-dis', { env: baseEnv() }))).json();
    assert.equal(unknown.id, 'who-dis');
    assert.equal(unknown.feedType, 'image');
    assert.equal(unknown.mediaUrl, null);
    assert.equal(unknown.sourceKind, 'fallback');
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test('/media/:id streams the upstream body through and forwards Range', async () => {
  const upstreamBody = '#EXTM3U\nsegment0.ts\n';
  const stub = stubFetch((url, _init) => {
    assert.equal(url, 'https://upstream.example/stream/cam-video.m3u8');
    return Promise.resolve(new Response(upstreamBody, {
      status: 206,
      headers: {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Content-Length': String(upstreamBody.length),
        'Content-Range': 'bytes 0-3/18',
        'Accept-Ranges': 'bytes',
      },
    }));
  });
  try {
    const res = await onRequest(ctx('/api/cctv/media/cam-video', {
      env: baseEnv(),
      headers: { Range: 'bytes=0-3' },
    }));
    assert.equal(res.status, 206);
    assert.equal(res.headers.get('Content-Type'), 'application/vnd.apple.mpegurl');
    assert.equal(res.headers.get('Content-Range'), 'bytes 0-3/18');
    assert.equal(res.headers.get('X-CCTV-Source'), 'live-media');
    assert.equal(res.headers.get('Accept-Ranges'), 'bytes');
    assert.equal(await res.text(), upstreamBody);
    // The client's Range header rides along to the upstream.
    assert.equal(stub.calls[0].init.headers.Range, 'bytes=0-3');
  } finally {
    stub.restore();
  }
});

test('/media/:id returns the dev 404 JSON shape when no URL is configured', async () => {
  const stub = stubFetch();
  try {
    const res = await onRequest(ctx('/api/cctv/media/cam-bare', { env: baseEnv() }));
    assert.equal(res.status, 404);
    assert.match(res.headers.get('Content-Type') || '', /^application\/json/);
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual(await res.json(), { error: 'No media URL configured for this camera' });
    assert.equal(stub.calls.length, 0, 'a camera with no upstream URL must not be fetched');

    // Same shape for a camera the catalog has never heard of.
    const unknown = await onRequest(ctx('/api/cctv/media/who-dis', { env: baseEnv() }));
    assert.equal(unknown.status, 404);
    assert.deepEqual(await unknown.json(), { error: 'No media URL configured for this camera' });
  } finally {
    stub.restore();
  }
});

test('/frame/:id prefers the upstream snapshot and stamps X-CCTV-Source', async () => {
  const stub = stubFetch((url) => {
    assert.equal(url, 'https://upstream.example/frames/cam-a.jpg');
    return Promise.resolve(new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { 'Content-Type': 'image/jpeg' },
    }));
  });
  try {
    const res = await onRequest(ctx('/api/cctv/frame/cam-a', { env: baseEnv() }));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Content-Type'), 'image/jpeg');
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
    assert.equal(res.headers.get('X-CCTV-Source'), 'upstream-image');
    assert.equal(stub.calls.length, 1, 'exactly one upstream fetch: the registered snapshot URL');
  } finally {
    stub.restore();
  }
});

test('/frame/:id falls through to the synthetic SVG when upstream fails', async () => {
  const stub = stubFetch(() => Promise.resolve(new Response('nope', { status: 503 })));
  try {
    // No GOOGLE_MAPS_API_KEY in env → the Street View tier is skipped entirely.
    const res = await onRequest(ctx('/api/cctv/frame/cam-a', { env: baseEnv() }));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Content-Type'), 'image/svg+xml');
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
    assert.equal(res.headers.get('X-CCTV-Source'), 'synthetic');
    const svg = await res.text();
    assert.match(svg, /<svg[^>]*width="960"/);
    assert.match(svg, /UPSTREAM UNAVAILABLE/, 'a configured camera reports its upstream as down');
    assert.equal(stub.calls.length, 1, 'the upstream is tried once, then the chain gives up');
  } finally {
    stub.restore();
  }
});

test('/frame/:id never fetches a client-supplied URL (SSRF)', async () => {
  const SSRF_TARGETS = [
    'http://169.254.169.254/latest/meta-data/',
    'https://evil.example/steal.jpg',
  ];
  const stub = stubFetch((url) => {
    assert.ok(!SSRF_TARGETS.includes(url), `must not fetch a client-supplied URL: ${url}`);
    return Promise.resolve(new Response('nope', { status: 404 }));
  });
  try {
    // ?upstream= is the classic SSRF vector: a camera with no configured URL
    // plus an attacker-chosen URL must still resolve to the synthetic frame.
    const res = await onRequest(ctx(
      `/api/cctv/frame/cam-bare?upstream=${encodeURIComponent(SSRF_TARGETS[0])}&label=Lobby`,
      { env: baseEnv() },
    ));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('X-CCTV-Source'), 'synthetic');
    assert.equal(stub.calls.length, 0, 'no upstream fetch at all for a camera with no registered URL');
    const svg = await res.text();
    assert.match(svg, /NO UPSTREAM CONFIGURED/);
  } finally {
    stub.restore();
  }
});

test('/health reports per-camera state accumulated by the other routes', async () => {
  const stub = stubFetch(() => Promise.resolve(new Response('nope', { status: 503 })));
  try {
    await onRequest(ctx('/api/cctv/frame/cam-a', { env: baseEnv() }));
    const res = await onRequest(ctx('/api/cctv/health', { env: baseEnv() }));
    assert.equal(res.status, 200);
    assert.match(res.headers.get('Content-Type') || '', /^application\/json/);
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
    const body = await res.json();
    assert.ok(Array.isArray(body.cameras));
    const entry = body.cameras.find((c) => c.id === 'cam-a');
    assert.ok(entry, 'the frame request must have recorded health for cam-a');
    assert.equal(entry.status, 'degraded');
    assert.equal(entry.sourceKind, 'synthetic');
    assert.equal(typeof entry.updatedAt, 'number');
  } finally {
    stub.restore();
  }
});

test('unknown sub-paths get the dev 404 JSON shape', async () => {
  const stub = stubFetch();
  try {
    for (const path of ['/api/cctv', '/api/cctv/nope', '/api/cctv/frame']) {
      const res = await onRequest(ctx(path, { env: baseEnv() }));
      assert.equal(res.status, 404, path);
      assert.match(res.headers.get('Content-Type') || '', /^application\/json/);
      assert.deepEqual(await res.json(), { error: 'not found' });
    }
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test('an empty catalog still serves the contract shapes without upstream calls', async () => {
  const stub = stubFetch(() => Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })));
  try {
    // CCTV_PREFER_AUSTIN=0 disables the live packs, so this catalog is empty
    // and nothing is fetched — the CCTV layer degrades to synthetic frames.
    const res = await onRequest(ctx('/api/cctv/frame/nobody', {
      env: { CCTV_PREFER_AUSTIN: '0' },
    }));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('X-CCTV-Source'), 'synthetic');
    assert.match(await res.text(), /NO UPSTREAM CONFIGURED/);
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

// ── Upstream failure ladder (media proxy) ──────────────────────────────────
// Past the configured-URL gate the media proxy has four outcomes. The tests
// above pin the happy stream and the no-URL 404; these pin the rest, each one
// read back through the health tracker the /health route publishes — a camera
// that degrades must say so somewhere a user can see.

/** Read one camera's accumulated health entry. */
const healthFor = async (cameraId) => {
  const res = await onRequest(ctx('/api/cctv/health', { env: baseEnv() }));
  return (await res.json()).cameras.find((camera) => camera.id === cameraId);
};

test('/media/:id relays the upstream HTTP status and marks the camera degraded', async () => {
  const stub = stubFetch((url) => {
    assert.equal(url, 'https://upstream.example/stream/cam-video.m3u8');
    return Promise.resolve(new Response('upstream is down', { status: 503 }));
  });
  try {
    const res = await onRequest(ctx('/api/cctv/media/cam-video', { env: baseEnv() }));
    assert.equal(res.status, 503, 'the upstream status is relayed, not flattened to 502');
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual(await res.json(), { error: 'Upstream returned 503' });

    const entry = await healthFor('cam-video');
    assert.equal(entry.status, 'degraded');
    assert.equal(entry.sourceKind, 'upstream');
    assert.equal(entry.label, 'Configured CCTV Source', 'the catalog fills the provider in');
    assert.equal(entry.message, 'Upstream HTTP 503');
  } finally {
    stub.restore();
  }
});

test('/media/:id reports a video feed answering with a non-video body but still streams it', async () => {
  const stub = stubFetch(() => Promise.resolve(new Response('#EXTM3U\n', {
    status: 200,
    headers: { 'Content-Type': 'text/plain' },
  })));
  try {
    const res = await onRequest(ctx('/api/cctv/media/cam-video', { env: baseEnv() }));
    assert.equal(res.status, 200, 'the bytes still flow — the mismatch is reported, not fatal');
    assert.equal(await res.text(), '#EXTM3U\n');
    assert.equal(res.headers.get('X-CCTV-Source'), 'live-media');

    const entry = await healthFor('cam-video');
    assert.equal(entry.status, 'degraded', 'the type mismatch is still surfaced to /health');
    assert.equal(entry.message, 'Unexpected media type text/plain');
  } finally {
    stub.restore();
  }
});

test('/media/:id refuses an upstream that declares an oversized fixed body', async () => {
  let cancelled = false;
  // A plain object on purpose: the declared length has to survive to the
  // passthrough check, and the handler must cancel — not drain — the body.
  const oversized = {
    ok: true,
    status: 200,
    headers: new Headers({
      'Content-Type': 'video/mp4',
      'Content-Length': String(65 * 1024 * 1024),
    }),
    body: { cancel: () => { cancelled = true; return Promise.resolve(); } },
  };
  const stub = stubFetch(() => Promise.resolve(oversized));
  try {
    const res = await onRequest(ctx('/api/cctv/media/cam-video', { env: baseEnv() }));
    assert.equal(res.status, 502);
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual(await res.json(), { error: 'Upstream media exceeds size cap' });
    assert.equal(cancelled, true, 'the rejected upstream body is cancelled, never buffered');
  } finally {
    stub.restore();
  }
});

test('/media/:id answers 502 when the upstream never answers, and records why', async () => {
  const stub = stubFetch(() => Promise.reject(new Error('connection reset')));
  try {
    const res = await onRequest(ctx('/api/cctv/media/cam-video', { env: baseEnv() }));
    assert.equal(res.status, 502, 'a dark upstream is a bounded failure, not a hung request');
    assert.deepEqual(await res.json(), { error: 'Media proxy failed' });

    const entry = await healthFor('cam-video');
    assert.equal(entry.status, 'degraded');
    assert.equal(entry.sourceKind, 'upstream');
    assert.equal(entry.message, 'Media upstream timed out');
  } finally {
    stub.restore();
  }
});

// ── Street View tier + the last-resort error shape ──────────────────────────

test('/frame/:id falls back to a Street View frame when a server key is configured', async () => {
  let streetViewUrl = '';
  const stub = stubFetch((url) => {
    streetViewUrl = url;
    return Promise.resolve(new Response(new Uint8Array([9, 9, 9]), {
      status: 200,
      headers: { 'Content-Type': 'image/jpeg' },
    }));
  });
  try {
    const res = await onRequest(ctx('/api/cctv/frame/cam-bare', {
      env: { ...baseEnv(), GOOGLE_MAPS_API_KEY: 'test-key' },
    }));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Content-Type'), 'image/jpeg');
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
    assert.equal(res.headers.get('X-CCTV-Source'), 'streetview');
    assert.deepEqual(new Uint8Array(await res.arrayBuffer()), new Uint8Array([9, 9, 9]));
    assert.equal(stub.calls.length, 1, 'only the Street View call: a URL-less camera has no upstream');

    const params = new URL(streetViewUrl).searchParams;
    assert.equal(params.get('location'), '30.28,-97.73', 'the pose comes from the registered camera');
    assert.equal(params.get('key'), 'test-key', 'the key never leaves the server');
    assert.equal(params.get('size'), '960x540');

    const entry = await healthFor('cam-bare');
    assert.equal(entry.status, 'degraded', 'a stand-in frame is not a healthy camera');
    assert.equal(entry.sourceKind, 'streetview');
    assert.equal(entry.label, 'Google Street View');
    assert.equal(entry.message, 'Fallback Street View frame');
  } finally {
    stub.restore();
  }
});

test('a malformed camera id in the path degrades to the 500 JSON shape', async () => {
  const stub = stubFetch(() => { throw new Error('must not be reached'); });
  try {
    // `%zz` is not a valid escape, so decoding the id throws; the Function has
    // to answer its own error shape instead of letting the worker throw.
    const res = await onRequest(ctx('/api/cctv/frame/%zz'));
    assert.equal(res.status, 500);
    assert.match(res.headers.get('Content-Type') || '', /^application\/json/);
    assert.deepEqual(await res.json(), { error: 'CCTV proxy error' });
    assert.equal(stub.calls.length, 0, 'nothing is fetched for an undecodable id');
  } finally {
    stub.restore();
  }
});

// ── Street View fallback input clamps (body-cap/bbox-clamp sweep) ──────────
// streetViewFallback is shared by both runtimes; out-of-range or hostile
// inputs must never become a Google quota call.
test('Street View fallback rejects off-planet coordinates without fetching', async () => {
  const stub = stubFetch(() => { throw new Error('must not fetch'); });
  try {
    for (const coords of [
      { lat: 91, lon: 0 },
      { lat: -91, lon: 0 },
      { lat: 0, lon: 181 },
      { lat: 0, lon: -181 },
      { lat: Number.NaN, lon: 0 },
    ]) {
      const result = await streetViewFallback({
        ...coords,
        heading: 90,
        fov: 90,
        pitch: 0,
        apiKey: 'test-key',
      });
      assert.equal(result, null, JSON.stringify(coords));
    }
    assert.equal(stub.calls.length, 0, 'no off-planet coordinate may reach Google');
  } finally {
    stub.restore();
  }
});

test('Street View fallback normalizes heading and clamps fov/pitch into the upstream URL', async () => {
  let captured;
  const stub = stubFetch((url) => {
    captured = url;
    return Promise.resolve(new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'Content-Type': 'image/jpeg' } }));
  });
  try {
    const result = await streetViewFallback({
      lat: 30.2672,
      lon: -97.7431,
      heading: 405,
      fov: 999,
      pitch: -120,
      apiKey: 'test-key',
    });
    assert.equal(result?.ok, true);
    const params = new URL(captured).searchParams;
    assert.equal(params.get('heading'), '45', 'heading wraps into [0, 360)');
    assert.equal(params.get('fov'), '120', 'fov clamps to the Google max');
    assert.equal(params.get('pitch'), '-40', 'pitch clamps to the Google min');
  } finally {
    stub.restore();
  }
});
