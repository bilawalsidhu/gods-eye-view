import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadEnv } from 'vite';

import {
  loadMdotSourcesFromOpenData,
  mdotCameraToSource,
} from '../../server/providers/cctv/sources.js';
import { DEFAULT_MDOT_CCTV_URL } from '../../server/providers/cctv/constants.js';
import { createCctvCatalog } from '../../server/providers/cctv/catalog.js';

const BALTIMORE_ID = '00012848007300bc004c823633235daa';
const GARRETT_ID = '0a1b2c3d4e5f60718293a4b5c6d7e8f9';

/** One CHART GetCamerasJson record, shaped like the live payload. */
const row = (fields = {}) => ({
  cameraCategories: ['Baltimore'],
  cctvIp: 'strmr5.sha.maryland.gov',
  commMode: 'ONLINE',
  description: 'I-97 AT NEW CUT ROAD',
  id: BALTIMORE_ID,
  lastCachedDataUpdateTime: 1791900000,
  lat: 39.128563,
  lon: -76.64165,
  milePost: 12.2,
  name: '502021',
  opStatus: 'OK',
  publicVideoURL: `https://chart.maryland.gov/Video/GetVideo/${BALTIMORE_ID}`,
  routeNumber: 97,
  routePrefix: 'IS',
  routeSuffix: '',
  ...fields,
});

test('a CHART record maps to live HLS on its own streamer, with the CHART still as fallback', () => {
  const source = mdotCameraToSource(row());
  assert.equal(source.id, `mdot-${BALTIMORE_ID}`);
  assert.equal(source.name, 'I-97 AT NEW CUT ROAD');
  assert.equal(source.city, 'Baltimore');
  assert.equal(source.cityId, 'mdot-baltimore');
  assert.equal(source.provider, 'MDOT SHA CHART');
  assert.equal(source.lat, 39.128563);
  assert.equal(source.lon, -76.64165);
  assert.equal(source.feedType, 'hls');
  assert.equal(
    source.url,
    `https://strmr5.sha.maryland.gov/rtplive/${BALTIMORE_ID}/playlist.m3u8`,
  );
  assert.equal(
    source.snapshotUrl,
    `https://chart.maryland.gov/wwwroot/thumbnails/${BALTIMORE_ID}.jpg`,
  );
  assert.equal(source.sourceKind, 'mdot-chart');
  assert.equal(source.headingConfidence, 'low');
  assert.equal(source.groundElevationM, 50);
});

test('a direction token in the description sets a confident heading', () => {
  const source = mdotCameraToSource(
    row({ description: 'I-695 NB AT EXIT 10' }),
  );
  assert.equal(source.headingDeg, 0);
  assert.equal(source.headingConfidence, 'high');
});

test('a compass word inside a place name is not read as the camera bearing', () => {
  // Strict parsing took "South" in "South Mountain" for 180° with high
  // confidence; these must keep the estimated fallback instead.
  for (const description of [
    'I-70 East at South Mountain',
    'MD 5 South of Waldorf',
  ]) {
    const source = mdotCameraToSource(row({ description }));
    assert.equal(source.headingConfidence, 'low', description);
    assert.equal(
      source.headingDeg,
      mdotCameraToSource(row({ description: '' })).headingDeg,
      description,
    );
  }
});

test('CHART categories become picker cities, and an unknown one falls back to Maryland', () => {
  assert.equal(
    mdotCameraToSource(row({ cameraCategories: ['Wash. DC'] })).cityId,
    'mdot-wash-dc',
  );
  assert.equal(
    mdotCameraToSource(row({ cameraCategories: ['Western MD'] }))
      .groundElevationM,
    250,
  );
  const unknown = mdotCameraToSource(row({ cameraCategories: ['Elsewhere'] }));
  assert.equal(unknown.city, 'Maryland');
  assert.equal(unknown.cityId, 'mdot-md');
});

test('CCTV_MDOT_VIDEO=0 keeps the still only', () => {
  const saved = process.env.CCTV_MDOT_VIDEO;
  process.env.CCTV_MDOT_VIDEO = '0';
  try {
    const source = mdotCameraToSource(row());
    assert.equal(source.feedType, 'image');
    assert.equal(source.url, source.snapshotUrl);
  } finally {
    if (saved === undefined) delete process.env.CCTV_MDOT_VIDEO;
    else process.env.CCTV_MDOT_VIDEO = saved;
  }
});

test('dead, misplaced, off-host or malformed records are dropped', () => {
  for (const fields of [
    { commMode: 'OFFLINE' },
    { opStatus: 'COMM_FAILURE' },
    // Philadelphia: a plausible coordinate, but outside the Maryland box.
    { lat: 39.9526, lon: -75.1652 },
    { lat: 'x' },
    { cctvIp: 'evil.example.com' },
    { cctvIp: 'strmr5.sha.maryland.gov.evil.example' },
    { id: '../../etc/passwd' },
    { id: '' },
  ]) {
    assert.equal(mdotCameraToSource(row(fields)), null, JSON.stringify(fields));
  }
  // A marginal link usually still streams, so it stays.
  assert.ok(mdotCameraToSource(row({ opStatus: 'COMM_MARGINAL' })));
  assert.equal(mdotCameraToSource(null), null);
});

test('the loader dedupes, orders by anchor, and failures degrade to an empty pack', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const requested = [];
  const fetchMock = t.mock.method(globalThis, 'fetch', async (url, init) => {
    requested.push({ url: String(url), redirect: init?.redirect });
    return Response.json([
      // Garrett County: over 100 km from every anchor, so it sorts after
      // a camera inside the Baltimore core and is the first a cap trims.
      row({
        id: GARRETT_ID,
        description: 'I-68 AT MD 42',
        cameraCategories: ['Western MD'],
        lat: 39.65,
        lon: -79.2,
      }),
      row(),
      row(),
    ]);
  });
  const cameras = await loadMdotSourcesFromOpenData();
  assert.deepEqual(requested, [
    { url: DEFAULT_MDOT_CCTV_URL, redirect: 'manual' },
  ]);
  assert.deepEqual(
    cameras.map((c) => c.id),
    [`mdot-${BALTIMORE_ID}`, `mdot-${GARRETT_ID}`],
  );

  fetchMock.mock.mockImplementation(
    async () =>
      new Response(null, {
        status: 302,
        headers: { Location: 'https://elsewhere.example/' },
      }),
  );
  assert.deepEqual(await loadMdotSourcesFromOpenData(), []);
  fetchMock.mock.mockImplementation(
    async () => new Response('nope', { status: 503 }),
  );
  assert.deepEqual(await loadMdotSourcesFromOpenData(), []);
  fetchMock.mock.mockImplementation(async () =>
    Response.json({ not: 'a list' }),
  );
  assert.deepEqual(await loadMdotSourcesFromOpenData(), []);
  fetchMock.mock.mockImplementation(async () => {
    throw new Error('offline');
  });
  assert.deepEqual(await loadMdotSourcesFromOpenData(), []);
});

const runCatalog = async (t) => {
  const requested = [];
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async (url) => {
    const href = String(url);
    requested.push(href);
    if (href === DEFAULT_MDOT_CCTV_URL) return Response.json([row()]);
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
    delete process.env.CCTV_MDOT_ENABLED;
    Object.assign(process.env, patch);
    await fn();
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key];
    }
    Object.assign(process.env, saved);
  }
};

test('the MDOT lane is wired into the catalog', async (t) => {
  await withEnv({}, async () => {
    const { requested, sources } = await runCatalog(t);
    assert.ok(requested.includes(DEFAULT_MDOT_CCTV_URL));
    const maryland = sources.filter((s) => s.provider === 'MDOT SHA CHART');
    assert.deepEqual(
      maryland.map((s) => [s.id, s.pack]),
      [[`mdot-${BALTIMORE_ID}`, 'mdot']],
    );
  });
});

test('CCTV_MDOT_ENABLED=0 keeps the lane from being loaded', async (t) => {
  await withEnv({ CCTV_MDOT_ENABLED: '0' }, async () => {
    const { requested, sources } = await runCatalog(t);
    assert.equal(requested.includes(DEFAULT_MDOT_CCTV_URL), false);
    assert.deepEqual(
      sources.filter((s) => s.provider === 'MDOT SHA CHART'),
      [],
    );
  });
});

test('dev-fresh leaves the .env Maryland switch and cap in charge', async (t) => {
  // The launcher must not default or export any CCTV_MDOT_* value: the dev
  // server fills process.env from .env only where a key is still undefined,
  // so anything the launcher set would silently shadow the file.
  const launcher = await fs.readFile(
    new URL('../../scripts/dev-fresh.sh', import.meta.url),
    'utf8',
  );
  const code = launcher
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'));
  assert.deepEqual(
    code.filter((line) => line.includes('CCTV_MDOT_')),
    [],
  );

  // With nothing inherited, a .env disable switch and cap reach the pack
  // through the same loadEnv + fill-if-undefined rule the dev server uses.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gev-mdot-env-'));
  const fillFromDotenv = async (body) => {
    await fs.writeFile(path.join(root, '.env'), body);
    const patch = {};
    for (const [key, value] of Object.entries(
      loadEnv('development', root, ''),
    )) {
      if (key.startsWith('CCTV_MDOT_') && process.env[key] === undefined)
        patch[key] = value;
    }
    return patch;
  };
  try {
    await withEnv({}, async () => {
      delete process.env.CCTV_MDOT_MAX_SOURCES;
      const disabled = await fillFromDotenv('CCTV_MDOT_ENABLED=0\n');
      assert.deepEqual(disabled, { CCTV_MDOT_ENABLED: '0' });
      Object.assign(process.env, disabled);
      const { requested } = await runCatalog(t);
      assert.equal(requested.includes(DEFAULT_MDOT_CCTV_URL), false);
    });

    await withEnv({}, async () => {
      delete process.env.CCTV_MDOT_MAX_SOURCES;
      const capped = await fillFromDotenv('CCTV_MDOT_MAX_SOURCES=8\n');
      assert.deepEqual(capped, { CCTV_MDOT_MAX_SOURCES: '8' });
      Object.assign(process.env, capped);
      t.mock.method(console, 'log', () => {});
      const rows = Array.from({ length: 20 }, (_, i) =>
        row({
          id: i.toString(16).padStart(32, '0'),
          lat: 39.2 + i * 0.01,
        }),
      );
      t.mock.method(globalThis, 'fetch', async () => Response.json(rows));
      assert.equal((await loadMdotSourcesFromOpenData()).length, 8);
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
