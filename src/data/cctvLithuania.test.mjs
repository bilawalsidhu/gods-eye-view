import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  lithuaniaCameraToSource,
  loadLithuaniaSources,
  LITHUANIA_CAMERAS_URL,
  LITHUANIA_LOCATIONS_URL,
  LITHUANIA_MAX_CATALOG_BYTES,
} from '../../server/providers/cctv/lithuania.js';
import { createCctvCatalog } from '../../server/providers/cctv/catalog.js';

const row = {
  id: 72,
  name: 'Vilnius A1 10,04',
  x: 576154,
  y: 6056867,
  image:
    'https://eismoinfo.lt/eismoinfo-backend/image-provider/camera/last?id=72',
};
const feature = {
  id: '72',
  points: [{ point: [54.642550940833566, 25.17981587877114] }],
};
const layers = [{ layer: 'VKR', features: [feature] }];

test('Lithuania joins by ID and uses WGS84 latitude/longitude, never LKS-94 metres', () => {
  const camera = lithuaniaCameraToSource(row, feature);
  assert.equal(camera.id, 'lithuania-72');
  assert.equal(camera.lat, 54.642550940833566);
  assert.equal(camera.lon, 25.17981587877114);
  assert.equal(camera.name, 'Vilnius A1 10,04');
  assert.equal(camera.feedType, 'image');
  assert.equal(camera.headingConfidence, 'low');
  assert.equal(camera.url, row.image);
  assert.match(camera.credit, /Via Lietuva/);
});

test('invalid joins, coordinates and image destinations cannot enter the proxy registry', () => {
  for (const invalid of [
    null,
    { ...feature, id: '8' },
    { ...feature, points: [] },
    { ...feature, points: [{ point: [25.18, 54.64] }] },
    { ...feature, points: [{ point: [576154, 6056867] }] },
    { ...feature, points: [{ point: [null, 25] }] },
  ]) {
    assert.equal(lithuaniaCameraToSource(row, invalid), null);
  }
  for (const image of [
    'http://eismoinfo.lt/eismoinfo-backend/image-provider/camera/last?id=72',
    row.image.replace('eismoinfo.lt', 'eismoinfo.lt.evil.test'),
    row.image.replace('https://', 'https://user:pass@'),
    row.image.replace('id=72', 'id=8'),
    'http://127.0.0.1/private',
    '',
    null,
  ]) {
    assert.equal(lithuaniaCameraToSource({ ...row, image }, feature), null);
  }
  assert.equal(
    lithuaniaCameraToSource(
      { ...row, image: row.image + '&extra=ignored' },
      feature,
    ).url,
    row.image,
  );
  assert.equal(lithuaniaCameraToSource(null, feature), null);
});

function mockCatalogs(t) {
  const requested = [];
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requested.push(String(url));
    if (url === LITHUANIA_CAMERAS_URL) {
      assert.equal(options.redirect, 'manual');
      return Response.json([row, row, { ...row, id: 999 }]);
    }
    if (url === LITHUANIA_LOCATIONS_URL) return Response.json(layers);
    return Response.json([]);
  });
  return requested;
}

test('loader deduplicates and omits cameras without matching published coordinates', async (t) => {
  const requested = mockCatalogs(t);
  assert.deepEqual(
    (await loadLithuaniaSources()).map((c) => c.id),
    ['lithuania-72'],
  );
  assert.deepEqual(
    requested.sort(),
    [LITHUANIA_CAMERAS_URL, LITHUANIA_LOCATIONS_URL].sort(),
  );
});

/** Run one catalog refresh with CCTV_LITHUANIA_ENABLED set to `flag`
 * (undefined leaves it unset), restoring the environment afterwards. */
async function runCatalogWithLithuaniaFlag(t, flag) {
  const requested = mockCatalogs(t);
  const saved = process.env.CCTV_LITHUANIA_ENABLED;
  try {
    if (flag === undefined) delete process.env.CCTV_LITHUANIA_ENABLED;
    else process.env.CCTV_LITHUANIA_ENABLED = flag;
    const sources = await createCctvCatalog({ sourceRoot: '/nonexistent' })();
    return { requested, sources };
  } finally {
    if (saved === undefined) delete process.env.CCTV_LITHUANIA_ENABLED;
    else process.env.CCTV_LITHUANIA_ENABLED = saved;
  }
}

test('CCTV_LITHUANIA_ENABLED=1 wires the Lithuania pack into the catalog', async (t) => {
  const { sources } = await runCatalogWithLithuaniaFlag(t, '1');
  assert.equal(
    sources.find((c) => c.id === 'lithuania-72')?.cityId,
    'lithuania',
  );
});

// The camera endpoints are the eismoinfo.lt website backend, not a service the
// open-data statement lists, so an install that has not opted in must never
// contact them.
for (const [label, flag] of [
  ['an unset CCTV_LITHUANIA_ENABLED', undefined],
  ['an empty CCTV_LITHUANIA_ENABLED', ''],
  ['CCTV_LITHUANIA_ENABLED=0', '0'],
  ['CCTV_LITHUANIA_ENABLED=true', 'true'],
]) {
  test(`${label} makes no Lithuania request`, async (t) => {
    const { requested, sources } = await runCatalogWithLithuaniaFlag(t, flag);
    assert.ok(requested.length > 0, 'the other packs still refreshed');
    assert.equal(
      requested.some((href) => href.includes('eismoinfo.lt')),
      false,
      'the pack never reaches its upstream',
    );
    assert.ok(!sources.some((c) => c.cityId === 'lithuania'));
  });
}

test('a failed catalog cancels the sibling request instead of waiting for the timeout', async (t) => {
  t.mock.method(console, 'warn', () => {});
  let siblingSignal;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url === LITHUANIA_CAMERAS_URL) {
      return new Response('', { status: 503 });
    }
    siblingSignal = options.signal;
    // Never settles on its own; only an abort ends it.
    return new Promise((_, reject) => {
      options.signal.addEventListener('abort', () =>
        reject(options.signal.reason),
      );
    });
  });
  assert.deepEqual(await loadLithuaniaSources(), []);
  assert.equal(siblingSignal?.aborted, true);
  assert.notEqual(siblingSignal.reason?.name, 'TimeoutError');
});

test('a redirected catalog is reported as not followed', async (t) => {
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args.join(' ')));
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response('', {
        status: 302,
        headers: { Location: 'http://127.0.0.1/' },
      }),
  );
  assert.deepEqual(await loadLithuaniaSources(), []);
  assert.ok(warnings.some((line) => /redirects are not followed/.test(line)));
});

test('failed, redirected, malformed and oversized catalogs degrade to an empty pack', async (t) => {
  t.mock.method(console, 'warn', () => {});
  for (const makeResponse of [
    () => new Response('', { status: 503 }),
    () =>
      new Response('', {
        status: 302,
        headers: { Location: 'http://127.0.0.1/' },
      }),
    () => new Response('invalid json'),
    () => Response.json({ unexpected: true }),
    () =>
      new Response('[]', {
        headers: { 'Content-Length': String(LITHUANIA_MAX_CATALOG_BYTES + 1) },
      }),
  ]) {
    t.mock.method(globalThis, 'fetch', async () => makeResponse());
    assert.deepEqual(await loadLithuaniaSources(), []);
  }
});
