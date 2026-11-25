import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LIBRARY_AERIAL_Z,
  clearNoData,
  createLibraryTileLayer,
  libraryImagerySpec,
  minimumTerrainLevelFor,
} from './layers.js';
import { LIBRARY_ENTRIES, libraryEntry } from './catalog.js';
import { libraryTileUrl } from './manifest.js';
import { createLibrarySource } from './source.js';
import { layerOptions } from '../render/cesium/imagery.js';
import { fakeGlobePort } from '../testSupport/fakeGlobePort.mjs';
import { bindFakeDraw } from '../testSupport/fakeDrawPort.mjs';

/** A tiles entry without its border outline, so no network is touched. */
function entryWithoutOutline(id) {
  const entry = libraryEntry(id);
  const { outline: _outline, ...display } = entry.display;
  return { ...entry, display };
}

/** A viewer whose renderer has a globe port (shown) and a draw port. */
function globeViewer(t) {
  const viewer = {};
  const globe = fakeGlobePort();
  const { draw, unbind } = bindFakeDraw(viewer, { globe });
  t.after(unbind);
  return { viewer, globe, draw };
}

const source = { tileTemplate: (entry) => entry.source.url };
const xyz = (url, zOrder) => ({
  kind: 'xyz',
  url,
  ...(zOrder ? { zOrder } : {}),
});

test('aerial imagery drapes above every other imagery layer', async (t) => {
  const { viewer, globe } = globeViewer(t);
  const base = globe.imagery.add(
    xyz('https://base.example.org/{z}/{x}/{y}.png'),
  );
  const photos = createLibraryTileLayer(
    entryWithoutOutline('ign-orthophotos-france'),
    { source },
  );
  await photos.init(viewer);
  await photos.enable(viewer);
  const top = () => globe.layers.at(-1);
  assert.equal(globe.layers.length, 2);
  assert.notEqual(top(), base);
  const ign = top();
  assert.equal(ign.spec.zOrder, LIBRARY_AERIAL_Z);

  // A drape added later (weather, another library basemap) goes under it.
  const weather = globe.imagery.add(
    xyz('https://weather.example.org/{z}/{x}/{y}.png', 4),
  );
  assert.equal(top(), ign);
  assert.equal(globe.layers.indexOf(weather), 1);

  // IGN's dark blue "no imagery here" fill is cleared tile by tile, and its
  // tiles are requested only inside the France bbox.
  assert.equal(typeof ign.spec.tileTransform, 'function');
  assert.ok(Math.abs(ign.spec.rectangle.west - -5.5) < 1e-9);
  assert.equal(ign.spec.tiling, 'webMercator');

  // Off: the drape and its listener are gone.
  await photos.disable();
  assert.equal(ign.removed, true);
  assert.equal(ign.listenerCount('tileError'), 0);
  assert.equal(globe.layers.includes(ign), false);
});

test('the no-data fill clears as a colour-to-alpha threshold does', () => {
  const fill = [10, 59, 89];
  const pixels = new Uint8ClampedArray([
    ...fill,
    255,
    // Within 0.02 of each channel: JPEG noise along the fill's edge.
    12,
    57,
    91,
    255,
    // A real pixel.
    120,
    130,
    90,
    255,
  ]);
  clearNoData(pixels, [10 / 255, 59 / 255, 89 / 255, 1], 0.02);
  assert.deepEqual([pixels[3], pixels[7], pixels[11]], [0, 0, 255]);
});

test('a non-aerial tile layer keeps its place and its own colours', async (t) => {
  const { viewer, globe } = globeViewer(t);
  const topo = createLibraryTileLayer(entryWithoutOutline('usgs-topo'), {
    source,
  });
  await topo.init(viewer);
  await topo.enable(viewer);
  const drape = globe.layers[0];
  globe.imagery.add(xyz('https://weather.example.org/{z}/{x}/{y}.png'));
  assert.equal(globe.layers.indexOf(drape), 0);
  assert.equal(drape.spec.zOrder, undefined);
  assert.equal(drape.spec.tileTransform, undefined);
  await topo.destroy();
  assert.equal(drape.removed, true);
});

test('tile errors count toward unavailable, but a provider 4xx does not', async (t) => {
  const { viewer, globe } = globeViewer(t);
  const topo = createLibraryTileLayer(entryWithoutOutline('usgs-topo'), {
    source,
  });
  await topo.init(viewer);
  await topo.enable(viewer);
  const [drape] = globe.layers;
  assert.equal(topo.getStats().countLabel, 'DRAPED');
  for (let i = 0; i < 30; i++)
    drape.fail({ tile: { x: i, y: 0, level: 3 }, status: 404 });
  assert.equal(topo.getStats().error, null);
  for (let i = 0; i < 24; i++)
    drape.fail({ tile: { x: i, y: 0, level: 3 }, status: 503 });
  assert.equal(topo.getStats().error, 'tiles unavailable');
  await topo.destroy();
});

test('with no globe shown there is nowhere to drape', async (t) => {
  const { viewer, globe } = globeViewer(t);
  globe.setGlobeVisible(false);
  const topo = createLibraryTileLayer(entryWithoutOutline('usgs-topo'), {
    source,
  });
  await topo.init(viewer);
  await topo.enable(viewer);
  assert.equal(globe.layers.length, 0);
  assert.equal(topo.getStats().status, 'idle');
  await topo.destroy();
});

test('a bbox outline draws on the ground with the drape, and goes with it', async (t) => {
  const { viewer, draw } = globeViewer(t);
  const entry = libraryEntry('usgs-topo');
  const outlined = {
    ...entry,
    coverage: { ...entry.coverage, bbox: [1, 2, 3, 4] },
    display: { ...entry.display, outline: 'bbox' },
  };
  const layer = createLibraryTileLayer(outlined, { source });
  await layer.init(viewer);
  await layer.enable(viewer);
  await new Promise((resolve) => setImmediate(resolve));
  const set = draw.find('lib-usgs-topo:outline');
  assert.ok(set, 'an outline set is drawn');
  const [ring] = [...set.items.values()];
  assert.equal(ring.mode, 'draped');
  assert.equal(ring.positions.length, 5);
  assert.equal(layer.getDiagnostics().outlineRings, 1);
  await layer.disable();
  assert.equal(set.disposed, true);
  assert.equal(layer.getDiagnostics().outlineRings, 0);
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

test('an entry too dense to draw zoomed out is hidden below its scale', async (t) => {
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

  // It keeps its minimum level and is hidden where the view is coarser, as
  // Cesium's own layer was (minimumTerrainLevel z13 on the geographic globe).
  const { viewer, globe } = globeViewer(t);
  const layer = createLibraryTileLayer(cadastre, { source });
  await layer.init(viewer);
  await layer.enable(viewer);
  const [imagery] = globe.layers;
  assert.equal(imagery.spec.minLevel, 14);
  assert.equal(imagery.spec.hiddenBelowMinLevel, true);
  assert.equal(imagery.spec.admit, undefined);
  assert.deepEqual(layerOptions(imagery.spec), { minimumTerrainLevel: 13 });
  // An entry that is not dense keeps its minimum level.
  const lee = libraryEntry('lee-county-fl');
  const spec = libraryImagerySpec(lee, lee.source.url);
  assert.equal(spec.minLevel, lee.source.minZoom ?? 0);
  assert.equal(spec.hiddenBelowMinLevel, undefined);
  assert.equal(layerOptions(spec), undefined);
  await layer.disable();
  assert.equal(globe.layers.length, 0);
});
