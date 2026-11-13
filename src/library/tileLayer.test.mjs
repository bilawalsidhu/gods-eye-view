import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createLibraryTileLayer, minimumTerrainLevelFor } from './layers.js';
import { LIBRARY_ENTRIES, libraryEntry } from './catalog.js';
import { libraryTileUrl } from './manifest.js';
import { createLibrarySource } from './source.js';

/** A tiles entry without its border outline, so no network is touched. */
function entryWithoutOutline(id) {
  const entry = libraryEntry(id);
  const { outline: _outline, ...display } = entry.display;
  return { ...entry, display };
}

function globeViewer() {
  return {
    scene: { globe: { show: true } },
    imageryLayers: new Cesium.ImageryLayerCollection(),
    dataSources: { add: async () => {}, remove: () => {} },
  };
}

const source = { tileTemplate: (entry) => entry.source.url };
const tileProvider = (url) =>
  new Cesium.UrlTemplateImageryProvider({
    url,
    tilingScheme: new Cesium.WebMercatorTilingScheme(),
  });

test('aerial imagery drapes above every other imagery layer', async () => {
  const viewer = globeViewer();
  const collection = viewer.imageryLayers;
  const base = collection.addImageryProvider(
    tileProvider('https://base.example.org/{z}/{x}/{y}.png'),
  );
  const photos = createLibraryTileLayer(
    entryWithoutOutline('ign-orthophotos-france'),
    { source, cesium: Cesium },
  );
  await photos.init(viewer);
  await photos.enable(viewer);
  const top = () => collection.get(collection.length - 1);
  assert.equal(collection.length, 2);
  assert.notEqual(top(), base);
  const ign = top();

  // A drape added later (weather, another library basemap) goes under it.
  const weather = collection.addImageryProvider(
    tileProvider('https://weather.example.org/{z}/{x}/{y}.png'),
  );
  assert.equal(top(), ign);
  assert.equal(collection.indexOf(weather), 1);

  // IGN's dark blue "no imagery here" fill is drawn transparent, and its
  // tiles are requested only inside the France bbox.
  assert.ok(
    ign.colorToAlpha.equals(Cesium.Color.fromCssColorString('#0a3b59')),
  );
  assert.ok(ign.colorToAlphaThreshold > 0 && ign.colorToAlphaThreshold < 0.05);
  const west = Cesium.Math.toDegrees(ign.imageryProvider.rectangle.west);
  assert.ok(Math.abs(west - -5.5) < 1e-9);

  // Off: the drape and its listener are gone, so later layers stay put.
  await photos.disable();
  assert.equal(collection.contains(ign), false);
  const later = collection.addImageryProvider(
    tileProvider('https://later.example.org/{z}/{x}/{y}.png'),
  );
  assert.equal(top(), later);
});

test('a non-aerial tile layer keeps its place and its own colours', async () => {
  const viewer = globeViewer();
  const collection = viewer.imageryLayers;
  const topo = createLibraryTileLayer(entryWithoutOutline('usgs-topo'), {
    source,
    cesium: Cesium,
  });
  await topo.init(viewer);
  await topo.enable(viewer);
  const drape = collection.get(0);
  collection.addImageryProvider(
    tileProvider('https://weather.example.org/{z}/{x}/{y}.png'),
  );
  assert.equal(collection.indexOf(drape), 0);
  assert.equal(drape.colorToAlpha, undefined);
  await topo.destroy();
});

test('every shipped aerial photo entry is clipped to its coverage', () => {
  const aerial = LIBRARY_ENTRIES.filter((entry) => entry.display.aerial);
  assert.ok(aerial.length >= 60, 'the Open Imagery Register entries ship');
  for (const entry of aerial) {
    // Kept on top, an unclipped drape would cover the whole globe with the
    // provider's out-of-area fill.
    assert.equal(entry.source.bounded, true, entry.id);
    assert.ok(entry.imagery?.resolution, `${entry.id} names its resolution`);
  }
});

test('bbox and TMS templates become the URLs Cesium and the proxy request', () => {
  const source = createLibrarySource({
    entries: [],
    base: '/api/library',
    storage: null,
  });
  const wms = {
    id: 'example-wms',
    source: {
      fetch: 'browser-direct',
      url: 'https://w.example.org/wms?bbox={bbox-epsg-3857}&width=256',
    },
  };
  assert.equal(
    source.tileTemplate(wms),
    'https://w.example.org/wms?bbox={westProjected},{southProjected},{eastProjected},{northProjected}&width=256',
  );
  assert.equal(
    source.tileTemplate({
      ...wms,
      source: { ...wms.source, fetch: 'proxied' },
    }),
    '/api/library/tile/example-wms/{z}/{x}/{y}',
  );
  // The proxy fills the same tile's bounds in EPSG:3857 metres.
  assert.equal(
    libraryTileUrl(wms.source.url, 1, 1, 0),
    'https://w.example.org/wms?bbox=0.000,0.000,20037508.343,20037508.343&width=256',
  );
  assert.equal(
    libraryTileUrl('https://t.example.org/{z}/{x}/{reverseY}.png', 3, 2, 1),
    'https://t.example.org/3/2/6.png',
  );
});

test('an entry too dense to draw zoomed out is hidden below its scale', async () => {
  const cadastre = entryWithoutOutline('kartverket-cadastre');
  assert.equal(cadastre.source.minZoom, 14);
  assert.equal(minimumTerrainLevelFor(cadastre), 13);
  // Small coverage, or a low minimum zoom, draws at every scale.
  assert.equal(
    minimumTerrainLevelFor(libraryEntry('lee-county-fl')),
    undefined,
  );
  assert.equal(
    minimumTerrainLevelFor(libraryEntry('ign-orthophotos-france')),
    undefined,
  );

  // Switched on zoomed out, then zoomed further out: no globe tile coarser
  // than level 13 takes imagery from it, so no z14 tile is ever requested.
  const viewer = globeViewer();
  const layer = createLibraryTileLayer(cadastre, { source, cesium: Cesium });
  await layer.init(viewer);
  await layer.enable(viewer);
  const imagery = viewer.imageryLayers.get(viewer.imageryLayers.length - 1);
  const terrain = new Cesium.EllipsoidTerrainProvider();
  for (const level of [0, 4, 12])
    assert.equal(
      imagery._createTileImagerySkeletons({ level, data: {} }, terrain),
      false,
      `globe level ${level} takes no cadastre imagery`,
    );
  await layer.disable();
  assert.equal(viewer.imageryLayers.length, 0);
});
