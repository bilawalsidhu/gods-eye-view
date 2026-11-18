import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  bayernWebcamToSource,
  loadBayernSourcesFromMap,
} from '../../server/providers/cctv/sources.js';
import {
  BAYERN_IMAGE_ORIGIN,
  DEFAULT_BAYERN_CCTV_URL,
  DEFAULT_BAYERN_MAX_SOURCES,
} from '../../server/providers/cctv/constants.js';
import { createCctvCatalog } from '../../server/providers/cctv/catalog.js';
import { fetchWithinHost } from '../../server/providers/cctv/media.js';

/** One Bavarian webcam, shaped like a `listOfWebcamsV3.json` leaf. */
const cam = (patch = {}) => ({
  id: 1034,
  lat: 50.383289,
  lon: 11.885435,
  url: 'bi/jpg/si_--b0002_4280_-1322_dinan_vinan_---toepen_0.jpg',
  angle: 310,
  route: 'B2 Hof - Töpen',
  location: '1',
  direction: 'Töpen',
  ...patch,
});

/** A nested list payload (categories -> roads -> cameras). */
const listPayload = (webcams) => ({
  groups: [{ title_de: 'Strecken', groups: [{ title_de: 'B2', webcams }] }],
});

test('a Bavarian webcam maps to a source on the pinned frame directory', () => {
  const source = bayernWebcamToSource(cam());
  assert.equal(source.id, 'de-bayern-1034');
  assert.equal(source.name, 'B2 Hof - Töpen → Töpen');
  assert.equal(source.city, 'Bayern');
  assert.equal(source.cityId, 'bayern');
  assert.equal(source.provider, 'BayernInfo (Bayerische Straßenbauverwaltung)');
  assert.equal(source.lat, 50.383289);
  assert.equal(source.lon, 11.885435);
  assert.equal(source.feedType, 'image');
  assert.equal(source.sourceKind, 'bayern-vizby');
  // The feed's angle is a real bearing, kept at low confidence.
  assert.equal(source.headingDeg, 310);
  assert.equal(source.headingConfidence, 'low');
  assert.equal(
    source.url,
    `${BAYERN_IMAGE_ORIGIN}jpg/si_--b0002_4280_-1322_dinan_vinan_---toepen_0.jpg`,
  );
  assert.equal(source.snapshotUrl, source.url);
});

test('a camera without a usable bearing falls back to a stable heading', () => {
  for (const angle of [0, -1, 361, 'n/a', undefined]) {
    const source = bayernWebcamToSource(cam({ angle }));
    assert.ok(Number.isFinite(source.headingDeg));
    assert.equal(source.headingConfidence, 'low');
  }
});

test('only frames under cam/bi/ survive: ASFINAG and escapes are dropped', () => {
  // ASFINAG (Austria) shares the list but sits under cam/asfinag/.
  assert.equal(bayernWebcamToSource(cam({ url: 'asfinag/foo/bar.jpg' })), null);
  // Path traversal out of the pinned directory.
  assert.equal(bayernWebcamToSource(cam({ url: '../asfinag/x.jpg' })), null);
  assert.equal(bayernWebcamToSource(cam({ url: 'bi/../asfinag/x.jpg' })), null);
  // Absolute, protocol-relative, and root-absolute URLs.
  assert.equal(
    bayernWebcamToSource(cam({ url: 'https://evil.test/x.jpg' })),
    null,
  );
  assert.equal(bayernWebcamToSource(cam({ url: '//evil.test/x.jpg' })), null);
  assert.equal(bayernWebcamToSource(cam({ url: '/etc/passwd' })), null);
  // Encoded separators cannot sneak past the pin.
  assert.equal(bayernWebcamToSource(cam({ url: 'bi%2f..%2fx.jpg' })), null);
});

test('missing id, bad id, and bad coordinates are rejected', () => {
  assert.equal(bayernWebcamToSource(cam({ id: undefined })), null);
  assert.equal(bayernWebcamToSource(cam({ id: 'x' })), null);
  assert.equal(bayernWebcamToSource(cam({ id: -3 })), null);
  assert.equal(bayernWebcamToSource(cam({ lat: 999 })), null);
  assert.equal(bayernWebcamToSource(cam({ lat: undefined })), null);
  assert.equal(bayernWebcamToSource(cam({ url: '' })), null);
  assert.equal(bayernWebcamToSource(null), null);
});

test('the loader walks nested groups, dedupes, and drops ASFINAG', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requested.push(String(url));
    return Response.json(
      listPayload([
        cam({ id: 1 }),
        cam({ id: 1 }), // duplicate id
        cam({ id: 2, url: 'asfinag/a/b.jpg' }), // Austrian, dropped
        cam({ id: 3, lat: 49.7, lon: 11.4 }),
      ]),
    );
  });
  const cameras = await loadBayernSourcesFromMap();
  assert.deepEqual(requested, [DEFAULT_BAYERN_CCTV_URL]);
  assert.deepEqual(
    cameras.map((c) => c.id),
    ['de-bayern-1', 'de-bayern-3'],
  );
});

test('the loader caps the pack and sorts north to south', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const many = Array.from({ length: DEFAULT_BAYERN_MAX_SOURCES + 25 }, (_, i) =>
    cam({ id: i + 1, lat: 47.5 + i * 0.01 }),
  );
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json(listPayload(many)),
  );
  const cameras = await loadBayernSourcesFromMap();
  assert.equal(cameras.length, DEFAULT_BAYERN_MAX_SOURCES);
  for (let i = 1; i < cameras.length; i += 1)
    assert.ok(cameras[i - 1].lat >= cameras[i].lat);
});

test('the loader returns [] on error, redirect, and offline', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const fetchMock = t.mock.method(
    globalThis,
    'fetch',
    async () => new Response('nope', { status: 503 }),
  );
  assert.deepEqual(await loadBayernSourcesFromMap(), []);
  fetchMock.mock.mockImplementation(
    async () =>
      new Response(null, {
        status: 302,
        headers: { Location: 'https://evil.test/' },
      }),
  );
  assert.deepEqual(await loadBayernSourcesFromMap(), []);
  fetchMock.mock.mockImplementation(async () => {
    throw new Error('offline');
  });
  assert.deepEqual(await loadBayernSourcesFromMap(), []);
});

const runCatalog = async (t) => {
  const requested = [];
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async (url) => {
    const href = String(url);
    requested.push(href);
    if (href === DEFAULT_BAYERN_CCTV_URL)
      return Response.json(listPayload([cam({ id: 7 })]));
    return Response.json([]);
  });
  const sources = await createCctvCatalog({ sourceRoot: '/nonexistent' })();
  return { requested, sources };
};

const withEnv = async (patch, fn) => {
  const saved = { ...process.env };
  try {
    delete process.env.CCTV_SOURCES_FILE;
    delete process.env.CCTV_SOURCES_JSON;
    delete process.env.CCTV_BAYERN_ENABLED;
    Object.assign(process.env, patch);
    await fn();
  } finally {
    for (const key of Object.keys(process.env))
      if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
};

test('the Bayern lane is off by default and makes no request', async (t) => {
  await withEnv({}, async () => {
    const { requested, sources } = await runCatalog(t);
    assert.equal(requested.includes(DEFAULT_BAYERN_CCTV_URL), false);
    assert.deepEqual(
      sources.filter((s) => s.cityId === 'bayern'),
      [],
    );
  });
});

test('CCTV_BAYERN_ENABLED=1 wires the lane into the catalog', async (t) => {
  await withEnv({ CCTV_BAYERN_ENABLED: '1' }, async () => {
    const { requested, sources } = await runCatalog(t);
    assert.ok(requested.includes(DEFAULT_BAYERN_CCTV_URL));
    assert.deepEqual(
      sources.filter((s) => s.cityId === 'bayern').map((s) => s.id),
      ['de-bayern-7'],
    );
  });
});

test('a redirect on the Bayern frame host stays inside cam/bi/', async () => {
  const frame = `${BAYERN_IMAGE_ORIGIN}jpg/si_x_0.jpg`;
  const redirectTo = (location) => async (url) =>
    url === frame
      ? new Response(null, { status: 302, headers: { location } })
      : new Response('frame', { headers: { 'content-type': 'image/jpeg' } });
  for (const location of ['/cam/asfinag/x.jpg', '/cam/bi/../asfinag/x.jpg'])
    assert.equal(
      await fetchWithinHost(frame, {}, redirectTo(location)),
      null,
      location,
    );
  const followed = await fetchWithinHost(
    frame,
    {},
    redirectTo('/cam/bi/jpg/si_y_0.jpg'),
  );
  assert.equal(await followed.text(), 'frame');
});
