import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadAltoParanaSources } from '../../server/providers/cctv/altoParana.js';
import { createCctvCatalog } from '../../server/providers/cctv/catalog.js';
import { normalizeSourceItem } from '../../server/providers/cctv/normalize.js';

const cameras = loadAltoParanaSources();

test('Alto Paraná has three distinct operator HLS feeds with uncertain locations and attribution', () => {
  assert.equal(cameras.length, 3);
  assert.equal(new Set(cameras.map((camera) => camera.id)).size, 3);
  assert.equal(new Set(cameras.map((camera) => camera.url)).size, 3);
  for (const camera of cameras) {
    const source = normalizeSourceItem(camera);
    assert.equal(source.feedType, 'hls');
    assert.equal(new URL(source.url).protocol, 'https:');
    assert.equal(new URL(source.url).search, '');
    assert.equal(new URL(source.sourcePageUrl).protocol, 'https:');
    assert.equal(source.headingConfidence, 'low');
    assert.ok(Number.isNaN(source.headingDeg));
    assert.equal(source.poseSource, undefined);
    assert.match(source.name, /approximate location/);
    assert.match(source.locationNote, /Approximate.*unverified/);
    assert.match(source.license, /no open video license/);
    assert.ok(source.credit.includes(source.provider));
  }
  assert.equal(cameras[1].url, 'https://www.gibarra.com.py/v1_1/cam.m3u8');
  assert.equal(cameras[2].url, 'https://www.gibarra.com.py/v2_1/cam.m3u8');
  assert.equal(cameras[1].lat, cameras[2].lat);
  assert.equal(cameras[1].lon, cameras[2].lon);
});

for (const enabled of [true, false]) {
  test(`the default catalog ${enabled ? 'includes' : 'can disable'} Alto Paraná independently of Encarnación`, async (t) => {
    const saved = { ...process.env };
    t.after(() => {
      for (const key of Object.keys(process.env)) {
        if (!(key in saved)) delete process.env[key];
      }
      Object.assign(process.env, saved);
    });
    delete process.env.CCTV_SOURCES_FILE;
    delete process.env.CCTV_SOURCES_JSON;
    process.env.CCTV_FORCE_AUSTIN = '1';
    process.env.CCTV_ENCARNACION_ENABLED = '1';
    if (enabled) delete process.env.CCTV_ALTO_PARANA_ENABLED;
    else process.env.CCTV_ALTO_PARANA_ENABLED = '0';
    const requested = [];
    t.mock.method(console, 'log', () => {});
    t.mock.method(console, 'warn', () => {});
    t.mock.method(globalThis, 'fetch', async (url) => {
      requested.push(String(url));
      return Response.json([]);
    });
    const sources = await createCctvCatalog({ sourceRoot: '/nonexistent' })();
    assert.deepEqual(
      sources
        .filter((source) => cameras.some((camera) => camera.id === source.id))
        .map((source) => source.id),
      enabled ? cameras.map((camera) => camera.id) : [],
    );
    assert.ok(sources.some((source) => source.id === 'encarnacion-sambodromo'));
    assert.ok(
      requested.every((url) => !/gibarra|logicahost|atacadoconnect/.test(url)),
    );
  });
}
