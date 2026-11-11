// Self-hosted map endpoints: what an operator sets, what the browser receives,
// and which hosts the default globe then asks for.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as Cesium from 'cesium';
import { createBrowserViteConfig } from '../../build/vite.js';
import { terrainHeightsProxy } from '../../server/providers/terrain.js';
import { createDefaultMapSources } from './defaultSources.js';
import { terrainHeightsUrl, terrainUrlSetting } from './sourceSettings.js';

const TEMPLATE = 'https://tiles.example.test/world/{z}/{x}/{y}.png';

function esriSlot(registry) {
  return registry.sources.find(
    ({ descriptor }) => descriptor.id === 'esri-imagery',
  );
}

/** The URL the provider fetches for one tile, without touching the network. */
async function tileUrl(provider, x, y, level) {
  const original = Cesium.Resource.prototype.fetchImage;
  let asked;
  Cesium.Resource.prototype.fetchImage = function fetchImage() {
    asked = this.url;
    return Promise.resolve(new Cesium.Resource({ url: 'data:,' }));
  };
  try {
    await provider.requestImage(x, y, level);
  } finally {
    Cesium.Resource.prototype.fetchImage = original;
  }
  return asked;
}

test('GEV_BASEMAP_URL reaches the browser only as a validated https template', () => {
  const define = (options) => createBrowserViteConfig(options).define;
  assert.equal(
    define({})['import.meta.env.GEV_BASEMAP_URL'],
    undefined,
    'unset keeps the Esri default and exposes nothing',
  );
  assert.equal(define({ basemapUrl: '  ' })['import.meta.env.GEV_BASEMAP_URL'], undefined);
  const set = define({ basemapUrl: ` ${TEMPLATE} `, basemapAttribution: ' Own ortho ' });
  assert.equal(set['import.meta.env.GEV_BASEMAP_URL'], JSON.stringify(TEMPLATE));
  assert.equal(set['import.meta.env.GEV_BASEMAP_ATTRIBUTION'], '"Own ortho"');
  assert.equal(
    define({ basemapUrl: 'https://t.example.test/{z}/{x}/{reverseY}.jpg' })[
      'import.meta.env.GEV_BASEMAP_ATTRIBUTION'
    ],
    '""',
  );
  for (const refused of [
    'http://tiles.example.test/{z}/{x}/{y}.png',
    'https://u:p@tiles.example.test/{z}/{x}/{y}.png',
    'https://tiles.example.test/tile.png',
    'tiles.example.test/{z}/{x}/{y}.png',
  ])
    assert.throws(
      () => createBrowserViteConfig({ basemapUrl: refused }),
      /GEV_BASEMAP_URL must be an https URL template/,
      refused,
    );
});

test('a configured basemap replaces Esri, keeps its share-link id and never falls back to OSM', async () => {
  const registry = createDefaultMapSources({
    basemapUrl: TEMPLATE,
    basemapAttribution: 'Ortho <2026> & partners',
  });
  const slot = esriSlot(registry);
  assert.equal(registry.defaultId, 'esri-imagery');
  assert.equal(slot.descriptor.id, 'esri-imagery');
  assert.equal(slot.descriptor.label, 'Basemap');
  assert.equal(slot.credit, 'Ortho &lt;2026&gt; &amp; partners');
  assert.equal(slot.constructionFallback, undefined);
  assert.equal(slot.tileFailureFallback, undefined);
  const provider = await slot.imagery();
  assert.ok(provider instanceof Cesium.UrlTemplateImageryProvider);
  assert.equal(
    await tileUrl(provider, 3, 2, 2),
    'https://tiles.example.test/world/2/3/2.png',
  );
});

test('without a basemap setting the keyless globe keeps Esri and its OSM fallback', () => {
  const slot = esriSlot(createDefaultMapSources());
  assert.equal(slot.descriptor.label, 'Esri Satellite');
  assert.equal(slot.constructionFallback.id, 'osm');
  assert.equal(slot.tileFailureFallback.id, 'osm');
});

test('GEV_TERRAIN_URL reaches the browser as an https URL, or null for flat terrain', () => {
  const define = (terrainUrl) =>
    createBrowserViteConfig({ terrainUrl }).define['import.meta.env.GEV_TERRAIN_URL'];
  assert.equal(define(undefined), undefined, 'unset keeps Re:Earth');
  assert.equal(define(''), undefined);
  assert.equal(define(' None '), 'null');
  assert.equal(
    define('https://dem.example.test/mesh/'),
    '"https://dem.example.test/mesh"',
  );
  for (const refused of ['http://dem.example.test/mesh', 'flat', 'off'])
    assert.throws(
      () => createBrowserViteConfig({ terrainUrl: refused }),
      /GEV_TERRAIN_URL must be an https quantized-mesh URL or none/,
      refused,
    );
});

test('the keyless terrain follows GEV_TERRAIN_URL, and none asks nothing', async (t) => {
  const asked = [];
  t.mock.method(Cesium.CesiumTerrainProvider, 'fromUrl', async (resource) => {
    asked.push(resource.url);
    return { resource };
  });
  const create = (terrainUrl) =>
    esriSlot(createDefaultMapSources({ terrainUrl })).terrain.create();

  const flat = await create(null);
  assert.ok(flat.provider instanceof Cesium.EllipsoidTerrainProvider);
  assert.equal(flat.fallback, undefined, 'flat by choice is not retried');
  assert.deepEqual(asked, []);

  await create('https://dem.example.test/mesh');
  await create(undefined);
  assert.deepEqual(asked, [
    'https://dem.example.test/mesh',
    'https://terrain.reearth.land/cesium-mesh/ellipsoid',
  ]);
});

/** The /api/terrain/heights handler, as the server installs it. */
async function heightsRoute(t, heightsUrl) {
  const dir = await mkdtemp(path.join(tmpdir(), 'gev-self-hosted-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let route;
  terrainHeightsProxy({
    cachePath: path.join(dir, 'terrain.json'),
    heightsUrl,
  }).configureServer({ middlewares: { use: (_path, handler) => (route = handler) } });
  return (url) =>
    new Promise((resolve, reject) => {
      const res = {
        headersSent: false,
        setHeader() {},
        writeHead(status) {
          this.status = status;
          this.headersSent = true;
        },
        end(body) {
          resolve({ status: this.status, body: JSON.parse(body) });
        },
      };
      const req = { method: 'GET', url, headers: {}, socket: { remoteAddress: '127.0.0.1' } };
      Promise.resolve(route(req, res)).catch(reject);
    });
}

test('the heights proxy keeps Re:Earth by default and asks no one once terrain is set', async (t) => {
  const asked = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    asked.push(new URL(String(url)).origin + new URL(String(url)).pathname);
    return Response.json({ results: [{ ellipsoid: 150 }] });
  });
  const setting = (value) => terrainHeightsUrl(terrainUrlSetting(value));

  const off = await (await heightsRoute(t, setting('none')))('/?points=1,2');
  assert.equal(off.status, 503);
  assert.deepEqual(asked, [], 'none never reaches an upstream');

  const own = await (
    await heightsRoute(t, setting('https://dem.example.test/mesh'))
  )('/?points=1,2');
  assert.equal(own.status, 503, 'quantized mesh has no point-heights API');
  assert.deepEqual(asked, []);
  const keyless = await (await heightsRoute(t, setting(undefined)))('/?points=3,4');
  assert.equal(keyless.status, 200);
  assert.deepEqual(asked, ['https://terrain.reearth.land/heights.json']);
});
