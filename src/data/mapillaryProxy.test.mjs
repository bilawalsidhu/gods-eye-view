import test from 'node:test';
import assert from 'node:assert/strict';

import {
  mapillaryProxy,
  mapillaryRetryAfterSec,
  mapillaryStartCapturedAt,
  normalizeMapillaryProxyImage,
  validMapillaryBox,
} from '../../server/providers/mapillary.js';

test('Mapillary bbox validator enforces a small non-dateline area', () => {
  const valid = validMapillaryBox(
    new URLSearchParams({
      west: '-97.75',
      south: '30.25',
      east: '-97.70',
      north: '30.30',
    }),
  );
  assert.deepEqual(valid, {
    west: -97.75,
    south: 30.25,
    east: -97.7,
    north: 30.3,
  });
  assert.equal(
    validMapillaryBox(
      new URLSearchParams({
        west: '-1',
        south: '-1',
        east: '1',
        north: '1',
      }),
    ),
    null,
  );
  assert.equal(
    validMapillaryBox(
      new URLSearchParams({
        west: '179',
        south: '0',
        east: '-179',
        north: '0.01',
      }),
    ),
    null,
  );
});

test('proxy mapper bounds fields and drops invalid thumbnail schemes', () => {
  const mapped = normalizeMapillaryProxyImage({
    id: 42,
    computed_geometry: { type: 'Point', coordinates: [4.9, 52.37] },
    captured_at: 1_700_000_000_000,
    computed_compass_angle: 12.5,
    creator: { id: '7', username: 'mapper\nname' },
    camera_type: 'Perspective',
    make: 'Road Cam',
    model: 'Dash 1',
    thumb_1024_url: 'https://images.example.test/large.jpg',
    thumb_256_url: 'javascript:alert(1)',
    ignored: 'not forwarded',
  });
  assert.equal(mapped.id, '42');
  assert.deepEqual(mapped.creator, { id: '7', username: 'mapper name' });
  assert.equal('thumb_256_url' in mapped, false);
  assert.equal(mapped.thumb_1024_url, 'https://images.example.test/large.jpg');
  assert.equal(mapped.camera_type, 'perspective');
  assert.equal(mapped.make, 'Road Cam');
  assert.equal(mapped.model, 'Dash 1');
  assert.equal('ignored' in mapped, false);
});

test('capture-date ranges become deterministic Graph API lower bounds', () => {
  const now = Date.UTC(2026, 8, 10, 12, 0, 0);
  assert.equal(mapillaryStartCapturedAt('all', now), null);
  assert.equal(
    mapillaryStartCapturedAt('30d', now),
    '2026-08-11T12:00:00.000Z',
  );
  assert.equal(
    mapillaryStartCapturedAt('12m', now),
    '2025-09-10T12:00:00.000Z',
  );
  assert.equal(mapillaryStartCapturedAt('unexpected', now), undefined);
});

test('retry-after parsing is bounded and deterministic', () => {
  assert.equal(mapillaryRetryAfterSec('12.2'), 13);
  assert.equal(mapillaryRetryAfterSec('garbage'), 30);
  assert.equal(mapillaryRetryAfterSec('9999'), 300);
});

function installedHandler() {
  let handler = null;
  mapillaryProxy().configureServer({
    middlewares: {
      use(path, next) {
        assert.equal(path, '/api/mapillary/images');
        handler = next;
      },
    },
  });
  return handler;
}

function invoke(handler, url) {
  return new Promise((resolve) => {
    const result = { status: null, headers: null, body: '' };
    handler(
      { method: 'GET', url, socket: { remoteAddress: '127.0.0.1' } },
      {
        headersSent: false,
        writeHead(status, headers) {
          result.status = status;
          result.headers = headers;
        },
        end(body) {
          result.body = body || '';
          resolve(result);
        },
      },
    );
  });
}

test('proxy keeps the token server-side and reuses a fresh bbox cache entry', async () => {
  const originalToken = process.env.MAPILLARY_ACCESS_TOKEN;
  const originalFetch = globalThis.fetch;
  process.env.MAPILLARY_ACCESS_TOKEN = 'secret-token';
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls += 1;
    assert.equal(url.hostname, 'graph.mapillary.com');
    assert.equal(url.searchParams.has('access_token'), false);
    assert.equal(url.searchParams.has('start_captured_at'), true);
    assert.equal(options.headers.Authorization, 'OAuth secret-token');
    return new Response(
      JSON.stringify({
        data: [
          {
            id: '1',
            geometry: { type: 'Point', coordinates: [4.9, 52.37] },
          },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };
  try {
    const handler = installedHandler();
    const url = '?west=4.89&south=52.36&east=4.91&north=52.38&range=30d';
    const first = await invoke(handler, url);
    const second = await invoke(handler, url);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(calls, 1);
    assert.equal(JSON.parse(second.body).status, 'cached');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.MAPILLARY_ACCESS_TOKEN;
    else process.env.MAPILLARY_ACCESS_TOKEN = originalToken;
  }
});

test('proxy rejects unsupported date ranges before contacting upstream', async () => {
  const originalToken = process.env.MAPILLARY_ACCESS_TOKEN;
  const originalFetch = globalThis.fetch;
  process.env.MAPILLARY_ACCESS_TOKEN = 'secret-token';
  globalThis.fetch = async () => {
    throw new Error('should not fetch');
  };
  try {
    const response = await invoke(
      installedHandler(),
      '?west=4.89&south=52.36&east=4.91&north=52.38&range=forever',
    );
    assert.equal(response.status, 400);
    assert.deepEqual(JSON.parse(response.body), { error: 'invalid_range' });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.MAPILLARY_ACCESS_TOKEN;
    else process.env.MAPILLARY_ACCESS_TOKEN = originalToken;
  }
});

test('proxy reports a missing token without touching upstream', async () => {
  const originalToken = process.env.MAPILLARY_ACCESS_TOKEN;
  delete process.env.MAPILLARY_ACCESS_TOKEN;
  try {
    const response = await invoke(
      installedHandler(),
      '?west=4.89&south=52.36&east=4.91&north=52.38',
    );
    assert.equal(response.status, 503);
    assert.deepEqual(JSON.parse(response.body), { error: 'no_key' });
  } finally {
    if (originalToken !== undefined)
      process.env.MAPILLARY_ACCESS_TOKEN = originalToken;
  }
});
