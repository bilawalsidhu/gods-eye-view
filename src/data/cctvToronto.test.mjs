import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseRescuCameraList,
  torontoCameraToSource,
  loadTorontoSourcesFromOpenData,
} from '../../server/providers/cctv/sources.js';
import {
  TORONTO_RESCU_LIST_URL,
  TORONTO_RESCU_IMAGE_ORIGIN,
  TORONTO_MAX_CATALOG_BYTES,
  DEFAULT_CCTV_MAX_SOURCES,
} from '../../server/providers/cctv/constants.js';
import { CAMERA_CODE_MAX_CHARS } from '../../server/providers/cctv/normalize.js';
import { allocateSourceCap } from '../../server/providers/cctv/cap.js';
import { createCctvCatalog } from '../../server/providers/cctv/catalog.js';

/**
 * A response whose body is a live stream, plus a flag that flips when the
 * stream is cancelled. A rejection path that returns without cancelling holds
 * the transport open, so the flag is what the refusal tests actually assert.
 */
const streamingResponse = (init = {}) => {
  const state = { cancelled: false };
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('j'));
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { response: new Response(body, init), state };
};

/** One RESCU row, shaped like the live `tmcearthcameras.json` payload. */
const row = (overrides = {}) => ({
  Number: '8048',
  Name: 'BATHURST ST & BLOOR ST W',
  Latitude: '43.665249',
  Longitude: '-79.41114',
  D1: 'n',
  D2: 'e',
  D3: 's',
  D4: 'w',
  Group: 'Arterial',
  ...overrides,
});

/** The city wraps the list in a JSONP callback; this is that envelope. */
const jsonp = (rows) =>
  `jsonTMCEarthCamerasCallback(${JSON.stringify({ Data: rows })});`;

test('a RESCU row maps to a source on the constructed frame URL', () => {
  const source = torontoCameraToSource(row());
  assert.equal(source.id, 'toronto-8048');
  assert.equal(source.name, 'BATHURST ST & BLOOR ST W');
  assert.equal(source.city, 'Toronto');
  assert.equal(source.cityId, 'toronto');
  assert.equal(source.provider, 'City of Toronto');
  assert.equal(source.lat, 43.665249);
  assert.equal(source.lon, -79.41114);
  assert.equal(source.feedType, 'image');
  assert.equal(source.sourceKind, 'toronto-rescu-open-data');
  assert.equal(
    source.license,
    'Contains information licensed under the Open Government Licence – Toronto',
  );
  assert.equal(
    source.url,
    `${TORONTO_RESCU_IMAGE_ORIGIN}loc8048.jpg`,
    'the documented loc####.jpg convention',
  );
  assert.equal(source.url, source.snapshotUrl);
  assert.ok(source.url.startsWith(TORONTO_RESCU_IMAGE_ORIGIN));
});

test('the frame URL is built from the camera number, never read from the payload', () => {
  // The list carries no URL field at all, so an added one must stay inert: the
  // frame proxy is pinned to the city origin by construction.
  const planted = torontoCameraToSource(
    row({
      url: 'https://evil.example/x.jpg',
      snapshotUrl: 'https://evil.example/x.jpg',
      Url: 'https://evil.example/x.jpg',
    }),
  );
  assert.equal(planted.url, `${TORONTO_RESCU_IMAGE_ORIGIN}loc8048.jpg`);
  assert.equal(planted.snapshotUrl, planted.url);

  // A number that is not plain digits cannot reach the URL builder: path
  // traversal and absolute URLs are refused outright rather than escaped.
  for (const Number_ of [
    '../../etc/passwd',
    '8048/../../x',
    'https://evil.example/1',
    '80 48',
    '8048.jpg',
    '-8048',
    '',
    '   ',
    null,
  ]) {
    assert.equal(
      torontoCameraToSource(row({ Number: Number_ })),
      null,
      `refused: ${String(Number_)}`,
    );
  }
});

test('the comparison directions never become a camera heading', () => {
  // D1-D4 are the city's *comparison image* directions (static 2016 reference
  // stills served from ComparisonImages/), not a facing for the live frame:
  // these cameras pan. The letters read like a compass and map trivially onto
  // one (n -> 0, w -> 270), so the temptation to wire them up is real — and a
  // heading derived from them would be confidently wrong for every camera in
  // the city. Nobody may "fix" this.
  const base = torontoCameraToSource(row());
  for (const dirs of [
    { D1: 'n', D2: 'e', D3: 's', D4: 'w' },
    { D1: '', D2: 'e', D3: '', D4: 'w' },
    { D1: '', D2: '', D3: '', D4: '' },
    { D1: 's', D2: '', D3: '', D4: '' },
  ]) {
    const source = torontoCameraToSource(row(dirs));
    assert.equal(source.headingConfidence, 'low');
    assert.ok(Number.isFinite(source.headingDeg));
    // Same id, same fallback heading, whatever the directions say.
    assert.equal(source.headingDeg, base.headingDeg);
  }
});

test('the two cameras at one intersection are kept apart', () => {
  // 8047 and 8048 are both "BATHURST ST & BLOOR ST W", five metres apart. They
  // are distinct units, so both survive, and the id-hash fallback fans their
  // gizmos apart instead of stacking them on one bearing.
  const a = torontoCameraToSource(
    row({ Number: '8047', Latitude: '43.665223', Longitude: '-79.411083' }),
  );
  const b = torontoCameraToSource(row());
  assert.equal(a.id, 'toronto-8047');
  assert.equal(b.id, 'toronto-8048');
  assert.notEqual(a.url, b.url);
  assert.notEqual(a.headingDeg, b.headingDeg);
});

test('rows outside Toronto and unusable geometry are dropped', () => {
  // Calgary: a plausible lat/lon, but not a Toronto camera.
  assert.equal(
    torontoCameraToSource(row({ Latitude: '51.0453', Longitude: '-114.1413' })),
    null,
  );
  // Null island, and the empty strings that would become it.
  assert.equal(
    torontoCameraToSource(row({ Latitude: '0', Longitude: '0' })),
    null,
  );
  assert.equal(
    torontoCameraToSource(row({ Latitude: '', Longitude: '' })),
    null,
  );
  assert.equal(
    torontoCameraToSource(row({ Latitude: 'north', Longitude: 'west' })),
    null,
  );
  assert.equal(torontoCameraToSource({}), null);
  assert.equal(torontoCameraToSource(null), null);
});

test('a nameless row still gets a label', () => {
  const source = torontoCameraToSource(row({ Name: '   ' }));
  assert.equal(source.name, 'Toronto Camera 8048');
});

test('the JSONP envelope is unwrapped, and only that envelope', () => {
  assert.deepEqual(parseRescuCameraList(jsonp([row()])), [row()]);
  // Whitespace and a missing trailing semicolon are both tolerated.
  assert.equal(
    parseRescuCameraList(`\n  ${jsonp([row()]).replace(/;$/, '')}  \n`).length,
    1,
  );
  // Should the city ever drop the wrapper, the bare document still parses.
  assert.equal(
    parseRescuCameraList(JSON.stringify({ Data: [row()] })).length,
    1,
  );

  // Anything else yields no cameras rather than a thrown loader.
  for (const text of [
    'otherCallback({"Data":[]})',
    'jsonTMCEarthCamerasCallback(',
    'jsonTMCEarthCamerasCallback({"Data":',
    '{"Data":"not-an-array"}',
    '{"nope":[]}',
    '<html>503</html>',
    '',
    null,
  ]) {
    assert.deepEqual(parseRescuCameraList(text), [], `rejected: ${text}`);
  }
});

test('the loader reads the keyless list and collapses duplicate numbers', async (t) => {
  t.mock.method(console, 'log', () => {});
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requested.push(String(url));
    return new Response(
      jsonp([
        row(),
        // Same camera number twice: one camera, not two.
        row({ Name: 'BATHURST ST & BLOOR ST W (duplicate)' }),
        row({
          Number: '8001',
          Name: 'YORK ST & BREMNER BLVD / RAPTORS WAY',
          Latitude: '43.643120',
          Longitude: '-79.381386',
        }),
        row({ Number: '../evil' }),
      ]),
    );
  });
  const cameras = await loadTorontoSourcesFromOpenData();
  assert.deepEqual(requested, [TORONTO_RESCU_LIST_URL]);
  assert.deepEqual(
    cameras.map((camera) => camera.id),
    // Nearest downtown first: York & Bremner is at the core, Bathurst & Bloor
    // is three kilometres out.
    ['toronto-8001', 'toronto-8048'],
  );
  assert.equal(cameras[1].name, 'BATHURST ST & BLOOR ST W');
});

test('an upstream failure yields an empty pack and releases the response', async (t) => {
  t.mock.method(console, 'warn', () => {});
  // A 503 can still arrive with a streaming body; returning without cancelling
  // it would hold the connection until the socket times out.
  const failed = streamingResponse({ status: 503 });
  t.mock.method(globalThis, 'fetch', async () => failed.response);
  assert.deepEqual(await loadTorontoSourcesFromOpenData(), []);
  assert.equal(failed.state.cancelled, true, 'the failed body is cancelled');

  t.mock.restoreAll();
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('network down');
  });
  assert.deepEqual(await loadTorontoSourcesFromOpenData(), []);
});

test('the list fetch refuses redirects and oversized bodies', async (t) => {
  t.mock.method(console, 'warn', () => {});
  // A redirect is never followed: the list host cannot be steered. Its body is
  // a live stream, so the test also proves the refusal releases the transport.
  const seen = [];
  const redirected = streamingResponse({
    status: 302,
    headers: { location: 'https://evil.example/cameras.json' },
  });
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    seen.push([String(url), init.redirect]);
    return redirected.response;
  });
  assert.deepEqual(await loadTorontoSourcesFromOpenData(), []);
  assert.deepEqual(seen, [[TORONTO_RESCU_LIST_URL, 'manual']]);
  assert.equal(
    redirected.state.cancelled,
    true,
    'the redirect body is cancelled',
  );

  // A body over the cap is refused rather than buffered.
  t.mock.restoreAll();
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async () => {
    return new Response(jsonp([row()]), {
      headers: {
        'content-length': String(TORONTO_MAX_CATALOG_BYTES + 1),
      },
    });
  });
  assert.deepEqual(await loadTorontoSourcesFromOpenData(), []);

  // So is a body that only declares its size once it is already too long.
  t.mock.restoreAll();
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async () => {
    const oversized = 'x'.repeat(TORONTO_MAX_CATALOG_BYTES + 1024);
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(oversized));
          controller.close();
        },
      }),
    );
  });
  assert.deepEqual(await loadTorontoSourcesFromOpenData(), []);
});

test('the unselected label is the intersection, trimmed to the code width', () => {
  assert.equal(torontoCameraToSource(row()).code, 'BATHURST ST & BLOOR ST W');
  const long = torontoCameraToSource(
    row({
      Name: 'BAYVIEW AVE & POTTERY RD / PRIVATE ACCESS @ 620m SOUTH OF - 550 BAYVIEW AVE (EVERGREEN)',
    }),
  );
  assert.ok(long.code.length <= CAMERA_CODE_MAX_CHARS);
  assert.ok(long.code.endsWith('…'));
  assert.ok(long.code.startsWith('BAYVIEW AVE & POTTERY'));
});

test('a reduced catalog cap thins every pack instead of dropping Toronto', () => {
  // Toronto merges last in LIVE_PACKS, so a positional slice would delete it
  // outright. The round-robin allocation must give it its share.
  const lane = (name, count) => ({
    name,
    sources: Array.from({ length: count }, (_, i) => ({ id: `${name}-${i}` })),
  });
  const { sources, packs } = allocateSourceCap(
    [lane('austin', 250), lane('calgary', 215), lane('toronto', 336)],
    30,
  );
  assert.equal(sources.length, 30);
  assert.deepEqual(
    packs.map((p) => [p.name, p.kept]),
    [
      ['austin', 10],
      ['calgary', 10],
      ['toronto', 10],
    ],
  );
  // Toronto contributes its own highest-priority cameras, in its own order.
  assert.deepEqual(
    sources.filter((s) => s.id.startsWith('toronto-')).map((s) => s.id),
    Array.from({ length: 10 }, (_, i) => `toronto-${i}`),
  );
});

/**
 * Serve the RESCU list to the Toronto endpoint and an empty payload to every
 * other pack, so one catalog refresh exercises the registration without
 * reaching the network. Returns the URLs that were requested.
 */
const runCatalogWithMockedUpstreams = async (t) => {
  const requested = [];
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async (url) => {
    const href = String(url);
    requested.push(href);
    if (href === TORONTO_RESCU_LIST_URL) {
      return new Response(
        jsonp([
          row({
            Number: '8001',
            Name: 'YORK ST & BREMNER BLVD / RAPTORS WAY',
            Latitude: '43.643120',
            Longitude: '-79.381386',
          }),
          row(),
        ]),
      );
    }
    return Response.json([]);
  });
  const sources = await createCctvCatalog({ sourceRoot: '/nonexistent' })();
  return { requested, sources };
};

test('the pack is registered, so its cameras reach the served catalog', async (t) => {
  const saved = { ...process.env };
  try {
    delete process.env.CCTV_SOURCES_FILE;
    delete process.env.CCTV_SOURCES_JSON;
    delete process.env.CCTV_TORONTO_ENABLED;
    const { requested, sources } = await runCatalogWithMockedUpstreams(t);
    assert.ok(
      requested.includes(TORONTO_RESCU_LIST_URL),
      'the registered lane reaches its upstream',
    );
    assert.deepEqual(
      sources.filter((s) => s.cityId === 'toronto').map((s) => s.id),
      ['toronto-8001', 'toronto-8048'],
      'Toronto cameras reach the served catalog through the registered lane',
    );
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key];
    }
    Object.assign(process.env, saved);
  }
});

test('CCTV_TORONTO_ENABLED=0 keeps the lane from being loaded at all', async (t) => {
  const saved = { ...process.env };
  try {
    delete process.env.CCTV_SOURCES_FILE;
    delete process.env.CCTV_SOURCES_JSON;
    process.env.CCTV_TORONTO_ENABLED = '0';
    const { requested, sources } = await runCatalogWithMockedUpstreams(t);
    assert.equal(
      requested.includes(TORONTO_RESCU_LIST_URL),
      false,
      'the disabled lane never reaches its upstream',
    );
    assert.deepEqual(
      sources.filter((s) => s.cityId === 'toronto'),
      [],
    );
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key];
    }
    Object.assign(process.env, saved);
  }
});

test('the shipped catalog ceiling is not raised to make room for this pack', () => {
  assert.equal(DEFAULT_CCTV_MAX_SOURCES, 4000);
});
