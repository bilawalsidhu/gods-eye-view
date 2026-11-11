// Self-hosted map endpoints: what an operator sets, what the browser receives,
// and which hosts the default globe then asks for.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createBrowserViteConfig } from '../../build/vite.js';
import { createDefaultMapSources } from './defaultSources.js';

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
