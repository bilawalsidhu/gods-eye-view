import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { Scene } from 'three';
import { createNavaraMaps } from './maps.js';

const loader = registerHooks({
  resolve(specifier, context, next) {
    return specifier === '@navaramap/three'
      ? {
          url: `data:text/javascript,${encodeURIComponent(`
            export class EffectDesc {
              constructor(view, ctx) { this.ctx = ctx; }
              onCreate() { this.createPass(); }
              onDestroy() {}
            }
          `)}`,
          shortCircuit: true,
        }
      : next(specifier, context);
  },
});
await import('./ground/globe.js');
loader.deregister();

function fakeView() {
  const view = {
    globe: {},
    scenes: { globe: new Scene(), mrt: new Scene() },
    effects: new Set(),
    effectTypes: new Map(),
    registerEffect(key, type) {
      view.effectTypes.set(key, type);
    },
    addEffect(desc) {
      const key = Object.keys(desc)[0];
      const Type = view.effectTypes.get(key);
      const effect = new Type(view, { scenes: view.scenes }, desc);
      effect.onCreate();
      const handle = {
        delete() {
          if (!view.effects.delete(handle)) return;
          effect.onDestroy();
        },
      };
      view.effects.add(handle);
      return handle;
    },
    sources: [],
    layers: [],
    shown: [],
    frames: 0,
    opened: 0,
    rasterCounts: [],
    addSource(desc) {
      const source = {
        id: `source-${view.sources.length}`,
        desc,
        delete() {
          view.sources = view.sources.filter((entry) => entry !== source);
          return true;
        },
      };
      view.sources.push(source);
      return source;
    },
    addLayer(desc) {
      const layer = {
        id: `layer-${view.layers.length}`,
        desc,
        update(next) {
          layer.desc = next;
        },
        delete() {
          view.layers = view.layers.filter((entry) => entry !== layer);
          view.rasterCounts.push(layersOf(view, 'raster').length);
        },
      };
      view.layers.push(layer);
      return layer;
    },
    attribution: {
      show() {
        view.opened++;
      },
      add(items) {
        view.shown.push(...items);
      },
      remove(items) {
        for (const item of items)
          view.shown = view.shown.filter(
            (entry) => JSON.stringify(entry) !== JSON.stringify(item),
          );
      },
    },
    forceUpdate() {
      view.frames++;
    },
  };
  return view;
}

const layersOf = (view, type) =>
  view.layers.filter((layer) => layer.desc.type === type);

test('setBaseImagery builds Navara raster layers for OSM and Esri, one at a time', async () => {
  const view = fakeView();
  const { maps } = createNavaraMaps(view);
  await maps.setBaseImagery({ kind: 'osm' });
  let [layer] = layersOf(view, 'raster');
  assert.equal(
    view.sources[0].desc.url,
    'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  );
  assert.equal(view.sources[0].desc.maxZoom, 19);
  assert.equal(layer.desc.source, view.sources[0]);
  assert.ok(
    view.shown.some((item) => /OpenStreetMap/.test(JSON.stringify(item))),
  );
  await maps.setBaseImagery({
    descriptor: { id: 'esri-imagery', kind: 'esri-imagery' },
    credit: '<a href="https://www.esri.com">Powered by Esri</a>',
  });
  assert.equal(layersOf(view, 'raster').length, 1);
  assert.equal(view.sources.length, 1);
  assert.match(
    view.sources[0].desc.url,
    /World_Imagery\/MapServer\/tile\/\{z\}\/\{y\}\/\{x\}$/,
  );
  assert.deepEqual(view.shown, [
    { attributionHtml: '<a href="https://www.esri.com">Powered by Esri</a>' },
  ]);
  assert.ok(view.frames > 0);
});

test('Sentinel-2 uses the EOX mosaic with attribution and a capped source zoom', async () => {
  const view = fakeView();
  const { maps } = createNavaraMaps(view);
  await maps.setBaseImagery({ kind: 'sentinel2' });
  assert.equal(maps.baseKind, 'sentinel2');
  assert.match(view.sources[0].desc.url, /s2cloudless-2020_3857/);
  assert.equal(view.sources[0].desc.maxZoom, 14);
  assert.match(
    view.shown[0].attributionHtml,
    /modified Copernicus Sentinel data 2020/,
  );
  await maps.setBaseImagery({ kind: 'osm' });
  assert.equal(maps.baseKind, 'osm');
});

test('the same imagery source again keeps the live layer', async () => {
  const view = fakeView();
  const { maps } = createNavaraMaps(view);
  await maps.setBaseImagery({ kind: 'osm' });
  const [layer] = view.layers;
  await maps.setBaseImagery({ kind: 'osm' });
  assert.deepEqual(view.layers, [layer]);
});

test('an imagery source Navara cannot build rejects and the current one stays', async () => {
  const view = fakeView();
  const { maps } = createNavaraMaps(view);
  await maps.setBaseImagery({ kind: 'osm' });
  await assert.rejects(maps.setBaseImagery({ kind: 'ion', style: 2 }), /ion/);
  await assert.rejects(maps.setBaseImagery({ kind: 'nope' }), TypeError);
  assert.equal(
    view.sources[0].desc.url,
    'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  );
});

test('setTerrain: keyless Re:Earth mesh, flat ellipsoid, and ion world terrain with a token', async () => {
  const view = fakeView();
  const requests = [];
  const { maps } = createNavaraMaps(view, {
    fetch: async (url) => {
      requests.push(url);
      return {
        ok: true,
        json: async () => ({
          url: 'https://assets.ion.cesium.com/asset_depot/1/CesiumWorldTerrain/v1.2/',
          accessToken: 'endpoint-token',
        }),
      };
    },
  });
  await maps.setTerrain({ id: 'keyless', create: () => {} });
  const [terrain] = layersOf(view, 'terrain');
  assert.equal(
    terrain.desc.source.desc.url,
    'https://terrain.reearth.land/cesium-mesh/ellipsoid/{z}/{x}/{y}.terrain',
  );
  assert.equal(terrain.desc.source.desc.type, 'quantized-mesh');
  // Tiles split past the mesh's level 14, so imagery can refine beyond 15.
  assert.equal(terrain.desc.source.desc.maxZoom, 14);
  assert.equal(terrain.desc.source.desc.overscaledMaxZoom, 20);
  await maps.setTerrain({ kind: 'ellipsoid' });
  assert.equal(layersOf(view, 'terrain').length, 0);
  assert.equal(view.sources.length, 0);
  await assert.rejects(maps.setTerrain({ kind: 'world' }), /token/);
  await maps.setTerrain({ kind: 'world', accessToken: 'ion-token' });
  assert.equal(
    requests[0],
    'https://api.cesium.com/v1/assets/1/endpoint?access_token=ion-token',
  );
  const [world] = layersOf(view, 'terrain');
  assert.equal(
    world.desc.source.desc.url,
    'https://assets.ion.cesium.com/asset_depot/1/CesiumWorldTerrain/v1.2/{z}/{x}/{y}.terrain?v=1.2.0',
  );
  assert.equal(world.desc.source.desc.token, 'endpoint-token');
});

test('a newer terrain request wins over an older one still resolving', async () => {
  const view = fakeView();
  let answer;
  const { maps } = createNavaraMaps(view, {
    fetch: () => new Promise((resolve) => (answer = resolve)),
  });
  const world = maps.setTerrain({ kind: 'world', accessToken: 't' });
  await maps.setTerrain({ kind: 'keyless' });
  answer({
    ok: true,
    json: async () => ({ url: 'https://x/', accessToken: 'y' }),
  });
  await world;
  const [terrain] = layersOf(view, 'terrain');
  assert.match(terrain.desc.source.desc.url, /reearth/);
  assert.equal(layersOf(view, 'terrain').length, 1);
});

test('setPhotorealTiles shows Google 3D tiles with a browser key and the Google credit', async () => {
  const view = fakeView();
  const { maps } = createNavaraMaps(view);
  await maps.setBaseImagery({ kind: 'osm' });
  await maps.setPhotorealTiles({ googleApiKey: ' browser key ' });
  const [tiles] = layersOf(view, '3d-tiles');
  assert.equal(
    tiles.desc.source.desc.url,
    'https://tile.googleapis.com/v1/3dtiles/root.json?key=browser%20key',
  );
  assert.deepEqual(tiles.desc.model, { maxSse: 16, height: 0 });
  // Hidden, not deleted: Navara 0.2.1 stops loading terrain at the current
  // view when the last raster layer is deleted.
  const [base] = layersOf(view, 'raster');
  assert.equal(base.desc.raster?.show, false, 'base imagery not hidden');
  assert.deepEqual(view.rasterCounts, []);
  const google = view.shown.find((item) => item.creditLayerId === tiles.id);
  assert.ok(google?.logo, 'no Google logo');
  assert.equal(
    view.opened,
    0,
    'tiles must not force the attribution card open',
  );
  assert.equal(maps.photorealActive(), true);
  await maps.setPhotorealTiles(null);
  assert.equal(maps.photorealActive(), false);
  assert.equal(layersOf(view, '3d-tiles').length, 1);
  assert.equal(tiles.desc.model.show, false);
  assert.ok(!view.shown.some((item) => item.creditLayerId));
});

test('base imagery hidden by photoreal comes back; a new one replaces it without a raster gap', async () => {
  const view = fakeView();
  const { maps } = createNavaraMaps(view);
  await maps.setBaseImagery({ kind: 'osm' });
  await maps.setPhotorealTiles({ googleApiKey: 'k' });
  const [osm] = layersOf(view, 'raster');
  await maps.setPhotorealTiles(null);
  await maps.setBaseImagery({ kind: 'osm' });
  assert.deepEqual(layersOf(view, 'raster'), [osm]);
  assert.notEqual(osm.desc.raster?.show, false, 'OSM still hidden');
  view.rasterCounts.length = 0;
  await maps.setBaseImagery({ kind: 'esri-imagery' });
  const rasters = layersOf(view, 'raster');
  assert.equal(rasters.length, 1);
  assert.match(rasters[0].desc.source.desc.url, /World_Imagery/);
  assert.deepEqual(view.rasterCounts, [1], 'a raster gap while replacing');
});

test('photoreal hides the whole globe while terrain sources and sampling stay live', async (t) => {
  const view = fakeView();
  const adapter = createNavaraMaps(view);
  const { maps } = adapter;
  t.after(adapter.destroy);
  const point = { longitude: 1, latitude: 0.5 };
  await maps.setBaseImagery({ kind: 'osm' });
  await maps.setTerrain({ kind: 'keyless' });
  const [terrain] = layersOf(view, 'terrain');
  view.sampleTerrainMostDetailed = async (source) => {
    assert.equal(source, terrain.desc.source);
    return [{ height: 4200 }];
  };
  const revision = maps.terrainRevision();
  const tiles = { googleApiKey: 'k' };
  await maps.setPhotorealTiles(tiles);
  assert.equal(view.scenes.globe.visible, false);
  assert.equal(view.scenes.mrt.visible, true, 'tiles still write scene depth');
  assert.deepEqual(await adapter.sampleTerrain([point]), [4200]);
  assert.equal(maps.terrainRevision(), revision);
  assert.equal(layersOf(view, 'terrain')[0], terrain);
  assert.equal(layersOf(view, 'raster').length, 1);
  await maps.setBaseImagery({ kind: 'esri-imagery' });
  assert.equal(view.scenes.globe.visible, false);
  await maps.setPhotorealTiles(tiles);
  assert.equal(view.effects.size, 1, 'same tiles do not stack globe owners');
  await maps.setPhotorealTiles({ googleApiKey: 'replacement' });
  assert.equal(view.effects.size, 1);
  assert.equal(view.scenes.globe.visible, false);
  await maps.setPhotorealTiles(null);
  assert.equal(view.scenes.globe.visible, true);
  assert.equal(view.effects.size, 0);
  assert.equal(layersOf(view, 'raster')[0].desc.raster.show, true);
  assert.deepEqual(await adapter.sampleTerrain([point]), [4200]);
});

test('globe visibility is restored on release and destruction, including an already hidden globe', async () => {
  for (const visible of [true, false]) {
    for (const action of ['release', 'destroy']) {
      const view = fakeView();
      view.scenes.globe.visible = visible;
      const { maps, destroy } = createNavaraMaps(view);
      const tiles = { googleApiKey: 'k' };
      await maps.setPhotorealTiles(tiles);
      assert.equal(view.scenes.globe.visible, false);
      if (action === 'release') maps.releasePhotorealTiles(tiles);
      else destroy();
      assert.equal(view.scenes.globe.visible, visible);
      assert.equal(view.effects.size, 0);
      destroy();
    }
  }
});

test('a photoreal request superseded during renderer loading cannot hide the globe', async () => {
  const view = fakeView();
  const { maps, destroy } = createNavaraMaps(view);
  const pending = maps.setPhotorealTiles({ googleApiKey: 'k' });
  await maps.setPhotorealTiles(null);
  await pending;
  assert.equal(view.scenes.globe.visible, true);
  assert.equal(maps.photorealActive(), false);
  assert.equal(view.effects.size, 0);
  const next = maps.setPhotorealTiles({ googleApiKey: 'k' });
  destroy();
  await next;
  assert.equal(view.scenes.globe.visible, true);
  assert.equal(view.layers.length, 0);
});

test('map switches reuse the tile cache at the same detail and release a parked source', async (t) => {
  const view = fakeView();
  const { maps, destroy } = createNavaraMaps(view);
  t.after(destroy);
  const tiles = { googleApiKey: 'k' };
  await maps.setBaseImagery({ kind: 'osm' });
  await maps.setPhotorealTiles(tiles);
  const [layer] = layersOf(view, '3d-tiles');
  const source = layer.desc.source;
  for (let i = 0; i < 3; i++) {
    await maps.setPhotorealTiles(null);
    assert.equal(maps.photorealActive(), false);
    assert.equal(layer.desc.model.show, false);
    await maps.setBaseImagery({ kind: 'osm' });
    assert.equal(layersOf(view, 'raster')[0].desc.raster.show, true);
    await maps.setPhotorealTiles(tiles);
    assert.equal(maps.photorealActive(), true);
    assert.equal(layersOf(view, '3d-tiles')[0], layer);
    assert.equal(layer.desc.source, source);
    assert.deepEqual(layer.desc.model, { maxSse: 16, height: 0, show: true });
    assert.equal(view.sources.length, 2);
  }
  await maps.setPhotorealTiles(null);
  maps.releasePhotorealTiles(tiles);
  assert.equal(layersOf(view, '3d-tiles').length, 0);
  assert.ok(!view.sources.includes(source));
  assert.equal(view.scenes.globe.visible, true);
});

test('photoreal without a browser key rejects and changes nothing', async () => {
  const view = fakeView();
  const { maps } = createNavaraMaps(view);
  await assert.rejects(
    maps.setPhotorealTiles({ descriptor: { kind: 'photoreal' }, tileset: {} }),
    /browser key/,
  );
  assert.equal(maps.photorealActive(), false);
  assert.equal(view.layers.length, 0);
});

test('destroy removes every layer, source and credit it added', async () => {
  const view = fakeView();
  const { maps, destroy } = createNavaraMaps(view);
  await maps.setBaseImagery({ kind: 'osm' });
  await maps.setTerrain({ kind: 'keyless' });
  await maps.setPhotorealTiles({ googleApiKey: 'k' });
  destroy();
  assert.deepEqual(view.layers, []);
  assert.deepEqual(view.sources, []);
  assert.deepEqual(view.shown, []);
});

test('current() returns the passed sources: base while the globe shows, tiles while they show', async () => {
  const view = fakeView();
  const { maps } = createNavaraMaps(view);
  const osm = { kind: 'osm' };
  const esri = { kind: 'esri-imagery' };
  const tiles = { kind: 'photoreal', googleApiKey: 'k' };
  assert.deepEqual(maps.current(), { baseImagery: null, photoreal: null });
  await maps.setBaseImagery(osm);
  assert.deepEqual(maps.current(), { baseImagery: osm, photoreal: null });
  await maps.setPhotorealTiles(tiles);
  assert.equal(maps.current().baseImagery, null, 'tiles replace the base');
  assert.equal(maps.current().photoreal, tiles);
  // Imagery chosen while the tiles show goes on the hidden globe.
  await maps.setBaseImagery(esri);
  const [raster] = layersOf(view, 'raster');
  assert.match(raster.desc.source.desc.url, /World_Imagery/);
  assert.equal(
    raster.desc.raster?.show,
    false,
    'the new layer shows over tiles',
  );
  assert.ok(
    !view.shown.some((item) => /esri/i.test(JSON.stringify(item))),
    'its credit shows over tiles',
  );
  assert.equal(maps.current().baseImagery, esri);
  assert.equal(maps.current().photoreal, tiles);
  await maps.setPhotorealTiles(null);
  assert.deepEqual(maps.current(), { baseImagery: esri, photoreal: null });
  assert.notEqual(raster.desc.raster?.show, false, 'base not back');
  assert.ok(
    view.shown.some((item) => /esri/i.test(JSON.stringify(item))),
    'credit not back',
  );
});

test('the same tiles under a new source object count as that source', async () => {
  const view = fakeView();
  const { maps } = createNavaraMaps(view);
  const first = { kind: 'photoreal', googleApiKey: 'k' };
  const second = { kind: 'photoreal', googleApiKey: 'k' };
  await maps.setPhotorealTiles(first);
  await maps.setPhotorealTiles(second);
  assert.equal(maps.current().photoreal, second);
  assert.equal(layersOf(view, '3d-tiles').length, 1);
});

test('releasePhotorealTiles forgets the source and takes its tiles away if shown', async () => {
  const view = fakeView();
  const { maps } = createNavaraMaps(view);
  const tiles = { kind: 'photoreal', googleApiKey: 'k' };
  await maps.setPhotorealTiles(tiles);
  maps.releasePhotorealTiles({ kind: 'photoreal', googleApiKey: 'k' });
  assert.equal(maps.photorealActive(), true, 'another object released it');
  maps.releasePhotorealTiles(tiles);
  maps.releasePhotorealTiles(tiles);
  assert.equal(maps.photorealActive(), false);
  assert.equal(maps.current().photoreal, null);
  assert.equal(layersOf(view, '3d-tiles').length, 0);
});

test('after a map change Navara keeps redrawing while tiles arrive, then stops', async () => {
  const view = fakeView();
  const timers = [];
  let now = 0;
  const { maps, destroy } = createNavaraMaps(view, {
    setInterval: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearInterval: (timer) => {
      if (timer) timer.cleared = true;
    },
    now: () => now,
  });
  const tick = (ms) => {
    for (let t = 0; t < ms; t += 250) {
      now += 250;
      for (const timer of timers) if (!timer.cleared) timer.fn();
    }
  };
  await maps.setBaseImagery({ kind: 'osm' });
  const afterChange = view.frames;
  tick(1000);
  // Navara 0.2.1 can report idle and stop drawing before a raster tile it
  // fetched arrives: the engine asks for frames for a while after a change.
  assert.ok(view.frames >= afterChange + 4, `frames ${view.frames}`);
  tick(10_000);
  const settled = view.frames;
  tick(5_000);
  assert.equal(view.frames, settled, 'idle again once the window ends');
  assert.ok(
    timers.every((timer) => timer.cleared),
    'no timer left running',
  );
  // Another change opens a new window; destroy ends it.
  await maps.setBaseImagery({ kind: 'esri-imagery' });
  tick(500);
  assert.ok(view.frames > settled + 1);
  destroy();
  const atDestroy = view.frames;
  tick(2000);
  assert.equal(view.frames, atDestroy);
});

test('world terrain publishes endpoint credits and removes them on replacement', async () => {
  const view = fakeView();
  const { maps, destroy } = createNavaraMaps(view, {
    fetch: async () => ({
      ok: true,
      json: async () => ({
        url: 'https://terrain.example/',
        accessToken: 'temporary',
        attributions: [{ html: 'Terrain provider', collapsible: false }],
      }),
    }),
  });
  await maps.setTerrain({ kind: 'world', accessToken: 'configured' });
  assert.ok(
    view.shown.some((credit) => credit.attributionHtml === 'Terrain provider'),
  );
  assert.ok(view.opened > 0);
  await maps.setTerrain({ kind: 'ellipsoid' });
  assert.deepEqual(view.shown, []);
  destroy();
});

test('terrainRevision counts terrain shown or cleared; sampling reads the shown source', async () => {
  const view = fakeView();
  const sampled = [];
  view.sampleTerrainMostDetailed = async (source, positions) => {
    sampled.push({ source, positions });
    return positions.map(({ lat, lng }) => ({ lat, lng, height: lat + lng }));
  };
  const navara = createNavaraMaps(view);
  const { maps } = navara;
  const place = { longitude: Math.PI / 4, latitude: Math.PI / 6, height: 0 };
  assert.deepEqual(await navara.sampleTerrain([place]), [0], 'the ellipsoid');
  await maps.setTerrain({ kind: 'keyless' });
  assert.equal(maps.terrainRevision(), 1);
  const [height] = await navara.sampleTerrain([place]);
  assert.ok(Math.abs(height - 75) < 1e-9);
  assert.equal(sampled[0].source, layersOf(view, 'terrain')[0].desc.source);
  await maps.setTerrain({ kind: 'keyless' });
  assert.equal(maps.terrainRevision(), 1, 'the same terrain again');
  await maps.setTerrain({ kind: 'ellipsoid' });
  assert.equal(maps.terrainRevision(), 2);
  await maps.setTerrain({ kind: 'ellipsoid' });
  assert.equal(maps.terrainRevision(), 2, 'nothing to clear');
});
