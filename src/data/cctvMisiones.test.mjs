import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadMisionesSources,
  misionesCameraToSource,
  normalizeMisionesLocations,
  MISIONES_CATALOG_URL,
  MISIONES_MAX_CATALOG_BYTES,
} from '../../server/providers/cctv/misiones.js';
import { createCctvCatalog } from '../../server/providers/cctv/catalog.js';

const research = JSON.parse(
  fs.readFileSync(
    new URL('../../docs/data/cctv-misiones-2026-10-14.json', import.meta.url),
    'utf8',
  ),
);
// Synthetic test input, never an assertion about a real installation.
const position = {
  latitude: -27.5,
  longitude: -55.9,
  crs: 'WGS84',
  verification_source: 'synthetic test fixture',
};
const locations = {
  cameras: [{ camera_id: 'cam02', verified_camera_position: position }],
};
const row = (overrides = {}) => ({
  status: true,
  url: 'https://stream.camarasdemisiones.com/cam02/index.m3u8',
  title: 'Arco / Acceso Posadas',
  cover: 'https://untrusted.example/cover.jpg',
  ...overrides,
});

test('research references and candidates never become camera positions', () => {
  assert.equal(research.cameras.length, 8);
  assert.equal(
    research.cameras.filter((camera) => camera.reference_point).length,
    5,
  );
  assert.equal(
    research.cameras.filter((camera) => camera.candidate_camera_position)
      .length,
    2,
  );
  assert.deepEqual(normalizeMisionesLocations(research), {});
  for (const camera of research.cameras) {
    assert.equal(camera.verified_camera_position, null);
    assert.equal(
      misionesCameraToSource(row({ url: camera.stream_url }), research),
      null,
    );
  }
});

test('installation coordinates do not imply calibrated pose', () => {
  const camera = misionesCameraToSource(row(), locations);
  assert.equal(camera.id, 'misiones-cam02');
  assert.equal(camera.lat, position.latitude);
  assert.equal(camera.lon, position.longitude);
  assert.equal(camera.feedType, 'hls');
  assert.equal(camera.url, row().url);
  assert.equal(camera.snapshotUrl, '');
  assert.equal(camera.headingConfidence, 'low');
  assert.equal(camera.poseSource, undefined);
  assert.match(camera.license, /unverified/);
  assert.match(camera.credit, /Cámaras de Misiones/);
  const sanJose = misionesCameraToSource(
    row({ url: row().url.replace('cam02', 'cam03') }),
    { cameras: [{ camera_id: 'cam03', verified_camera_position: position }] },
  );
  assert.equal(sanJose.city, 'San José');
});

test('invalid, unsourced and duplicate positions fail closed', () => {
  for (const patch of [
    { latitude: null },
    { latitude: '-27.5' },
    { latitude: false },
    { latitude: NaN },
    { latitude: -55.9, longitude: -27.5 },
    { latitude: 0, longitude: 0 },
    { verification_source: '' },
    { verification_source: null },
    { crs: 'EPSG:3857' },
  ]) {
    const candidate = {
      cameras: [
        {
          camera_id: 'cam02',
          verified_camera_position: { ...position, ...patch },
        },
      ],
    };
    assert.equal(misionesCameraToSource(row(), candidate), null);
  }
  for (const value of [null, [], {}, { cameras: [] }])
    assert.deepEqual(normalizeMisionesLocations(value), {});
  assert.deepEqual(
    normalizeMisionesLocations({
      cameras: [...locations.cameras, ...locations.cameras],
    }),
    {},
  );
});

test('only pinned camera URLs and non-offline records register', () => {
  for (const url of [
    'https://stream.camarasdemisiones.com/tv/index.m3u8',
    'https://stream.camarasdemisiones.com/cam09/index.m3u8',
    'https://www.youtube.com/embed/example',
    'http://stream.camarasdemisiones.com/cam02/index.m3u8',
    'https://stream.camarasdemisiones.com.evil.example/cam02/index.m3u8',
    'https://user:pass@stream.camarasdemisiones.com/cam02/index.m3u8',
    'https://stream.camarasdemisiones.com/cam02/../cam02/index.m3u8',
    row().url + '?token=example',
    row().url + '#fragment',
  ])
    assert.equal(misionesCameraToSource(row({ url }), locations), null);
  for (const status of [false, 0, '0', 'false', 'OFFLINE', 'disabled', 'down'])
    assert.equal(misionesCameraToSource(row({ status }), locations), null);
  assert.equal(
    misionesCameraToSource(row({ status: undefined }), locations).id,
    'misiones-cam02',
  );
  assert.equal(
    misionesCameraToSource(row({ title: 'x'.repeat(300) }), locations).name
      .length,
    120,
  );
});

const setup = (t) => {
  const keys = [
    'CCTV_MISIONES_ENABLED',
    'CCTV_MISIONES_LOCATIONS_FILE',
    'CCTV_SOURCES_FILE',
    'CCTV_SOURCES_JSON',
    'CCTV_FORCE_AUSTIN',
    'CCTV_PREFER_AUSTIN',
  ];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-misiones-'));
  const file = path.join(directory, 'locations.json');
  fs.writeFileSync(file, JSON.stringify(locations));
  for (const key of keys) delete process.env[key];
  process.env.CCTV_MISIONES_ENABLED = '1';
  process.env.CCTV_MISIONES_LOCATIONS_FILE = file;
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'log', () => {});
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, file };
};

test('Misiones filters and deduplicates the mixed catalog', async (t) => {
  setup(t);
  const requests = [];
  const cameras = await loadMisionesSources({
    fetchImpl: async (url, options) => {
      requests.push(url);
      assert.equal(options.redirect, 'error');
      assert.equal(
        options.headers['User-Agent'],
        'gods-eye-view-cctv-proxy/1.0',
      );
      return Response.json([
        row(),
        row({ title: 'duplicate' }),
        row({ url: 'https://radio.example/live.mp3' }),
        row({ url: row().url.replace('cam02', 'cam03') }),
      ]);
    },
  });
  assert.deepEqual(requests, [MISIONES_CATALOG_URL]);
  assert.deepEqual(
    cameras.map((camera) => camera.id),
    ['misiones-cam02'],
  );
  assert.equal(cameras[0].name, 'Arco / Acceso Posadas');
});

test('Misiones requires opt-in and a verified position', async (t) => {
  const { file } = setup(t);
  let calls = 0;
  const options = {
    fetchImpl: async () => {
      calls++;
      return Response.json([row()]);
    },
  };
  for (const flag of [undefined, '', '0', 'true']) {
    if (flag === undefined) delete process.env.CCTV_MISIONES_ENABLED;
    else process.env.CCTV_MISIONES_ENABLED = flag;
    assert.deepEqual(await loadMisionesSources(options), []);
  }
  process.env.CCTV_MISIONES_ENABLED = '1';
  for (const content of [
    '{}',
    '{bad',
    ' '.repeat(65537),
    JSON.stringify(research),
  ]) {
    fs.writeFileSync(file, content);
    assert.deepEqual(await loadMisionesSources(options), []);
  }
  delete process.env.CCTV_MISIONES_LOCATIONS_FILE;
  assert.deepEqual(await loadMisionesSources(options), []);
  process.env.CCTV_MISIONES_LOCATIONS_FILE = file + '.missing';
  assert.deepEqual(await loadMisionesSources(options), []);
  assert.equal(calls, 0);
});

test('failed and oversized catalogs yield no camera', async (t) => {
  setup(t);
  for (const response of [
    new Response('', { status: 403 }),
    new Response('', {
      status: 302,
      headers: { Location: 'https://elsewhere.example/' },
    }),
    new Response('x'.repeat(MISIONES_MAX_CATALOG_BYTES + 1)),
    new Response('x', {
      headers: { 'content-length': String(MISIONES_MAX_CATALOG_BYTES + 1) },
    }),
    new Response('not JSON'),
    Response.json({ streams: [row()] }),
  ])
    assert.deepEqual(
      await loadMisionesSources({ fetchImpl: async () => response }),
      [],
    );
  assert.deepEqual(
    await loadMisionesSources({
      fetchImpl: async () => {
        throw new Error('offline');
      },
    }),
    [],
  );
});

test('the catalog registry respects the Misiones opt-in', async (t) => {
  const { directory } = setup(t);
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requested.push(String(url));
    return Response.json(String(url) === MISIONES_CATALOG_URL ? [row()] : []);
  });
  const sources = await createCctvCatalog({ sourceRoot: directory })();
  assert.ok(requested.includes(MISIONES_CATALOG_URL));
  assert.deepEqual(
    sources
      .filter((source) => source.pack === 'misiones')
      .map((source) => source.id),
    ['misiones-cam02'],
  );
  requested.length = 0;
  delete process.env.CCTV_MISIONES_ENABLED;
  const disabled = await createCctvCatalog({ sourceRoot: directory })();
  assert.equal(requested.includes(MISIONES_CATALOG_URL), false);
  assert.equal(disabled.some((source) => source.pack === 'misiones'), false);
});
