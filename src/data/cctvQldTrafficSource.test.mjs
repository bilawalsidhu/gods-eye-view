import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadQldTrafficSourcesFromOpenData,
  normalizeQldTrafficImageUrl,
  qldTrafficCameraCredit,
  qldTrafficApiKey,
  qldTrafficApiUrl,
  qldTrafficCameraToSource,
} from '../../server/providers/cctv/sources.js';
import {
  QLDTRAFFIC_FLOODCAMS_URL,
  QLDTRAFFIC_MAX_CATALOG_BYTES,
  QLDTRAFFIC_WEBCAMS_URL,
} from '../../server/providers/cctv/constants.js';

const feature = (overrides = {}, props = {}) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [153.026, -27.4705] },
  properties: {
    id: 5,
    url: 'https://api.qldtraffic.qld.gov.au/v1/webcams/5',
    description: 'Brisbane CBD - Riverside Expressway - North',
    direction: 'North',
    district: 'Metropolitan',
    locality: 'Brisbane City',
    postcode: '4000',
    image_url:
      'https://cameras.qldtraffic.qld.gov.au/Metropolitan/Riverside_Expwy_nth.jpg',
    ...props,
  },
  ...overrides,
});

test('QLDtraffic API key is server-side and sent as the documented apikey query param', () => {
  assert.equal(
    qldTrafficApiKey({ QLDTRAFFIC_API_KEY: '  qld-123  ' }),
    'qld-123',
  );
  const url = new URL(qldTrafficApiUrl(QLDTRAFFIC_WEBCAMS_URL, 'qld-123'));
  assert.equal(url.origin, 'https://api.qldtraffic.qld.gov.au');
  assert.equal(url.searchParams.get('apikey'), 'qld-123');
});

test('QLDtraffic image URLs are upgraded to HTTPS and pinned to the official host', () => {
  assert.equal(
    normalizeQldTrafficImageUrl(
      'http://cameras.qldtraffic.qld.gov.au/cameras/riverside.jpg',
    ),
    'https://cameras.qldtraffic.qld.gov.au/cameras/riverside.jpg',
  );
  assert.equal(
    normalizeQldTrafficImageUrl(
      'https://qldtraffic.qld.gov.au.evil.test/cameras/riverside.jpg',
    ),
    null,
  );
  assert.equal(normalizeQldTrafficImageUrl('not a url'), null);
});

test('QLDtraffic image URLs carrying credentials, a port or another QLD host are refused', () => {
  // URL.origin drops userinfo, so an origin-only pin would let catalog data
  // put credentials into the proxied frame request.
  for (const raw of [
    'https://user:pass@cameras.qldtraffic.qld.gov.au/Metropolitan/a.jpg',
    'https://user@cameras.qldtraffic.qld.gov.au/Metropolitan/a.jpg',
    'http://cameras.qldtraffic.qld.gov.au:8080/Metropolitan/a.jpg',
    'https://qldtraffic.qld.gov.au/Metropolitan/a.jpg',
  ]) {
    assert.equal(normalizeQldTrafficImageUrl(raw), null, raw);
  }
});

test('QLDtraffic credits each camera to its provided_by owner', () => {
  const tmr = 'State of Queensland (Department of Transport and Main Roads)';
  for (const spelling of [
    'Department of Transport and Main Roads',
    'Transport and Main Roads',
    'Dept of Transport & Main Roads',
    'TMR',
    '',
    null,
    undefined,
    { name: 'not a string' },
  ]) {
    assert.equal(qldTrafficCameraCredit(spelling), tmr, String(spelling));
  }
  assert.equal(
    qldTrafficCameraCredit('  Douglas Shire Council '),
    'Douglas Shire Council',
  );
  const council = qldTrafficCameraToSource(
    feature({}, { provided_by: 'Cook Shire Council' }),
    'floodcam',
  );
  assert.equal(council.credit, 'Cook Shire Council');
  assert.equal(qldTrafficCameraToSource(feature(), 'webcam').credit, tmr);
});

test('QLDtraffic webcam feature maps to a CCTV image source', () => {
  const source = qldTrafficCameraToSource(feature(), 'webcam');
  assert.equal(source.id, 'qldtraffic-webcam-5');
  assert.equal(source.name, 'Brisbane CBD - Riverside Expressway - North');
  assert.equal(source.city, 'Brisbane City');
  assert.equal(source.provider, 'QLD Traffic');
  assert.equal(source.lat, -27.4705);
  assert.equal(source.lon, 153.026);
  assert.equal(source.headingDeg, 0);
  assert.equal(source.headingConfidence, 'high');
  assert.equal(source.sourceKind, 'qldtraffic-webcam');
  assert.match(source.license, /CC BY 4\.0 AU/);
  assert.equal(source.url, source.snapshotUrl);
});

test('QLDtraffic floodcam feature is namespaced separately', () => {
  const source = qldTrafficCameraToSource(
    feature({}, { id: 5, direction: '' }),
    'floodcam',
  );
  assert.equal(source.id, 'qldtraffic-floodcam-5');
  assert.equal(source.provider, 'QLD Traffic Flood Cameras');
  assert.equal(source.sourceKind, 'qldtraffic-floodcam');
  assert.equal(source.headingConfidence, 'low');
  assert.ok(Number.isFinite(source.headingDeg));
});

test('QLDtraffic mapping rejects off-host images and unusable coordinates', () => {
  assert.equal(
    qldTrafficCameraToSource(
      feature({}, { image_url: 'https://evil.example/frame.jpg' }),
      'webcam',
    ),
    null,
  );
  assert.equal(
    qldTrafficCameraToSource(
      feature({ geometry: { type: 'Point', coordinates: [151.2, -33.8] } }),
      'webcam',
    ),
    null,
  );
  assert.equal(
    qldTrafficCameraToSource(feature({}, { id: '' }), 'webcam'),
    null,
  );
});

test('QLDtraffic loader fetches webcams and floodcams only when a key is configured', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const saved = process.env.QLDTRAFFIC_API_KEY;
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requested.push(String(url));
    return Response.json({ type: 'FeatureCollection', features: [feature()] });
  });
  try {
    delete process.env.QLDTRAFFIC_API_KEY;
    assert.deepEqual(await loadQldTrafficSourcesFromOpenData(), []);
    assert.deepEqual(requested, []);

    process.env.QLDTRAFFIC_API_KEY = 'qld-123';
    const cameras = await loadQldTrafficSourcesFromOpenData();
    assert.deepEqual(
      requested.map((url) => new URL(url).origin + new URL(url).pathname),
      [QLDTRAFFIC_WEBCAMS_URL, QLDTRAFFIC_FLOODCAMS_URL],
    );
    assert.deepEqual(
      requested.map((url) => new URL(url).searchParams.get('apikey')),
      ['qld-123', 'qld-123'],
    );
    assert.deepEqual(cameras.map((camera) => camera.id).sort(), [
      'qldtraffic-floodcam-5',
      'qldtraffic-webcam-5',
    ]);
  } finally {
    if (saved === undefined) delete process.env.QLDTRAFFIC_API_KEY;
    else process.env.QLDTRAFFIC_API_KEY = saved;
  }
});

/** Run the loader with a key and one fetch mock; restore the env afterwards. */
async function loadWith(t, respond) {
  t.mock.method(console, 'log', () => {});
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args.join(' ')));
  const saved = process.env.QLDTRAFFIC_API_KEY;
  process.env.QLDTRAFFIC_API_KEY = 'qld-123';
  t.mock.method(globalThis, 'fetch', async (url) =>
    respond(new URL(String(url)).pathname),
  );
  try {
    return { cameras: await loadQldTrafficSourcesFromOpenData(), warnings };
  } finally {
    if (saved === undefined) delete process.env.QLDTRAFFIC_API_KEY;
    else process.env.QLDTRAFFIC_API_KEY = saved;
  }
}

const okFeed = () =>
  Response.json({ type: 'FeatureCollection', features: [feature()] });

test('QLDtraffic catalog refuses a declared oversized body and keeps the other feed', async (t) => {
  let cancelled = false;
  const { cameras, warnings } = await loadWith(t, (path) => {
    if (path === '/v1/webcams') return okFeed();
    // The body itself is small valid JSON, so only the declared length can
    // keep it out (and an uncapped reader would accept it at once).
    const json = new TextEncoder().encode(
      JSON.stringify({ type: 'FeatureCollection', features: [feature()] }),
    );
    let sentBody = false;
    const body = new ReadableStream({
      pull(controller) {
        if (sentBody) return controller.close();
        sentBody = true;
        controller.enqueue(json);
      },
      cancel() {
        cancelled = true;
      },
    });
    return new Response(body, {
      headers: {
        'content-type': 'application/json',
        'content-length': String(QLDTRAFFIC_MAX_CATALOG_BYTES + 1),
      },
    });
  });
  assert.deepEqual(
    cameras.map((c) => c.id),
    ['qldtraffic-webcam-5'],
  );
  assert.ok(cancelled, 'oversized body is cancelled, not drained');
  assert.ok(
    warnings.some((w) => /RESPONSE_TOO_LARGE/.test(w)),
    warnings.join('\n'),
  );
});

test('QLDtraffic catalog stops a chunked body that crosses the cap while streaming', async (t) => {
  // Valid JSON just over the cap, sent without a Content-Length, so only the
  // running cap (not a parse error) can keep this feed out. Finite, so an
  // uncapped reader finishes instead of growing without bound.
  const encoder = new TextEncoder();
  const head = encoder.encode('{"type":"FeatureCollection","features":[');
  const tail = encoder.encode(`${JSON.stringify(feature())}]}`);
  const pad = new Uint8Array(1024 * 1024).fill(0x20);
  const parts = [head];
  for (let n = 0; n * pad.byteLength <= QLDTRAFFIC_MAX_CATALOG_BYTES; n += 1)
    parts.push(pad);
  parts.push(tail);
  let sent = 0;
  const { cameras } = await loadWith(t, (path) => {
    if (path === '/v1/floodcams') return okFeed();
    const queue = [...parts];
    const body = new ReadableStream({
      pull(controller) {
        const next = queue.shift();
        if (!next) return controller.close();
        sent += next.byteLength;
        controller.enqueue(next);
      },
    });
    return new Response(body, {
      headers: { 'content-type': 'application/json' },
    });
  });
  assert.deepEqual(
    cameras.map((c) => c.id),
    ['qldtraffic-floodcam-5'],
  );
  assert.ok(
    sent <= QLDTRAFFIC_MAX_CATALOG_BYTES + 2 * pad.byteLength,
    `read stopped near the cap (sent ${sent})`,
  );
});

test('QLDtraffic catalog cancels redirect and error bodies it does not read', async (t) => {
  const cancelled = [];
  const unread = (status, path) =>
    new Response(
      new ReadableStream({
        cancel() {
          cancelled.push(path);
        },
      }),
      {
        status,
        headers: status === 302 ? { location: 'https://evil.example/' } : {},
      },
    );
  const { cameras } = await loadWith(t, (path) =>
    unread(path === '/v1/webcams' ? 302 : 503, path),
  );
  assert.deepEqual(cameras, []);
  assert.deepEqual(cancelled.sort(), ['/v1/floodcams', '/v1/webcams']);
});
