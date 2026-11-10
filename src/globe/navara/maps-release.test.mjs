import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { BoxGeometry, Mesh, MeshBasicMaterial, Scene } from 'three';
import { cartesian3, cartographic } from '../../geo/index.js';
import { MapSourceController } from '../../maps/controller.js';
import { createFakeEngine } from '../testing/fakeEngine.js';
import { createNavaraMaps } from './maps.js';
import { createNavaraSurface } from './surface.js';

const sdkStub = `data:text/javascript,${encodeURIComponent(`
  import { Group } from ${JSON.stringify(import.meta.resolve('three'))};
  export class ModelMesh extends Group { _releaseGeometryArrays() {} }
`)}`;
const loader = registerHooks({
  resolve(specifier, context, next) {
    return specifier === '@navaramap/three'
      ? { url: sdkStub, shortCircuit: true }
      : next(specifier, context);
  },
});
const { navaraHooks } = await import('./internals.js');
loader.deregister();
const { ModelMesh } = await import(sdkStub);

function setup(core) {
  let sequence = 0;
  const sources = new Set();
  const layers = new Map();
  const credits = new Set();
  const view = Object.assign(new EventEmitter(), {
    _isIdle: true,
    _startMainLoop() {},
    _renderer: { setAnimationLoop() {} },
    _scenes: { mrt: new Scene(), light: new Scene() },
    _meshes: new Map(),
    _eventManager: {
      stacks: { renderable_feature_changed: [] },
      removeAt() {},
    },
    viewContext: {
      renderPassOrchestrator: { passMap: { list: [] } },
      findMesh() {},
      findEffect() {},
    },
    addSource(description) {
      const source = {
        id: core?.addSource(description),
        description,
        delete() {
          assert.ok(![...layers.values()].some((l) => l.source === source));
          if (core) assert.equal(core.deleteSource(source.id), true);
          return sources.delete(source);
        },
      };
      sources.add(source);
      return source;
    },
    addLayer(description) {
      const layer = Object.assign(new EventEmitter(), description, {
        id:
          core?.addLayer({ ...description, source: description.source.id }) ??
          String(sequence++),
        update(next) {
          Object.assign(layer, next);
        },
        delete() {
          core?.deleteLayer(layer.id);
          layers.delete(layer.id);
          layer.emit('deleted');
          // The budgeted native cache emits no model removals here.
        },
      });
      layers.set(layer.id, layer);
      return layer;
    },
    findLayerById: (id) => layers.get(id),
    forceUpdate() {},
    sampleTerrainHeight: () => 0,
    attribution: {
      add: (items) => items.forEach((item) => credits.add(item)),
      remove: (items) => items.forEach((item) => credits.delete(item)),
      show() {},
    },
  });
  const hooks = navaraHooks(view);
  const adapter = createNavaraMaps(view, { setInterval: () => null });
  const { surface } = createNavaraSurface(view, hooks);
  function load(layer, visible = true) {
    const root = new ModelMesh();
    const mesh = new Mesh(
      new BoxGeometry(100, 100, 100),
      new MeshBasicMaterial(),
    );
    root.position.x = 6378137;
    root.visible = visible;
    root.add(mesh);
    root.updateMatrixWorld(true);
    view._scenes.mrt.add(root);
    view._meshes.set(root.id, root);
    let disposed = 0;
    mesh.geometry.addEventListener('dispose', () => disposed++);
    view.emit('layer', 'featureCreated', layer.id, {
      evaluator: { obj: root },
    });
    return { root, mesh, disposed: () => disposed };
  }
  return { view, hooks, ...adapter, surface, sources, layers, credits, load };
}

const place = cartographic.fromDegrees(0, 0);
const fixture = { tilesetUrl: '/__qa/tiles3d/tileset.json' };
const google = { googleApiKey: 'test-key' };

for (const [name, source] of [
  ['fixture', fixture],
  ['Google', google],
]) {
  for (const action of ['clear', 'release', 'stack', 'destroy']) {
    test(`${name} photoreal ${action} removes visible and hidden roots, geometry, source and credit`, async (t) => {
      globalThis.location = { origin: 'http://localhost' };
      t.after(() => {
        delete globalThis.location;
      });
      const state = setup();
      const { maps, surface, hooks, layers, sources, credits } = state;
      t.after(state.destroy);
      const engine = createFakeEngine({ kind: 'navara' });
      engine.maps = maps;
      t.after(() => engine.destroy());
      const controller = new MapSourceController({
        engine,
        requestRender() {},
        registry: {
          defaultId: 'osm',
          sources: [
            { descriptor: { id: 'osm', kind: 'osm' }, imagery() {} },
            { descriptor: { id: 'photoreal', kind: 'photoreal' }, ...source },
          ],
        },
      });
      t.after(() => controller.destroy());
      await controller.setStack('osm');
      await controller.setStack('photoreal');
      const layer = [...layers.values()].find((l) => l.type === '3d-tiles');
      assert.ok(layer);
      const tiles = [state.load(layer), state.load(layer, false)];
      assert.equal(surface.sampleHeightDetailed(place).source, 'tiles');
      assert.equal(hooks.tileRoots().length, 2);
      if (action === 'clear') await maps.setPhotorealTiles(null);
      if (action === 'release')
        maps.releasePhotorealTiles(maps.current().photoreal);
      if (action === 'stack') await controller.setStack('osm');
      if (action === 'destroy') state.destroy();
      assert.deepEqual(hooks.tileRoots(), []);
      assert.equal(state.view._meshes.size, 0);
      assert.ok(!sources.has(layer.source));
      assert.ok(!layers.has(layer.id));
      assert.ok(
        ![...credits].some((credit) => credit.creditLayerId === layer.id),
      );
      assert.equal(maps.photorealActive(), false);
      assert.deepEqual(surface.sampleHeightDetailed(place), {
        height: 0,
        source: 'terrain',
      });
      assert.equal(surface.sampleHeight(place), 0);
      assert.equal(
        cartographic.fromCartesian(
          surface.clampToHeight(cartesian3.fromDegrees(0, 0, 500)),
        ).height,
        0,
      );
      assert.equal(
        surface.raycast({
          origin: { x: 6379000, y: 0, z: 0 },
          direction: { x: -1, y: 0, z: 0 },
          far: 1000,
        }),
        undefined,
      );
      for (const { root, mesh, disposed } of tiles) {
        assert.equal(root.parent, null);
        assert.equal(root.children.length, 0);
        assert.equal(mesh.geometry.attributes.position, undefined);
        assert.equal(mesh.geometry.index, null);
        assert.equal(disposed(), 1);
      }
      if (action !== 'destroy') {
        const base = [...layers.values()].find((l) => l.type === 'raster');
        assert.equal(base.raster.show, true);
        assert.equal(maps.current().baseImagery.descriptor.kind, 'osm');
      }
    });
  }
}

test('replacement and a late tile decode cannot retain the old layer or remove the new one', async (t) => {
  const state = setup();
  t.after(state.destroy);
  await state.maps.setPhotorealTiles(google);
  const oldLayer = [...state.layers.values()][0];
  const old = state.load(oldLayer);
  await state.maps.setPhotorealTiles({ googleApiKey: 'replacement-key' });
  const newLayer = [...state.layers.values()][0];
  const current = state.load(newLayer);
  const late = state.load(oldLayer);
  state.maps.releasePhotorealTiles(google);
  assert.deepEqual(state.hooks.tileRoots(), [current.root]);
  assert.equal(state.view._meshes.size, 1);
  assert.equal(old.disposed(), 1);
  assert.equal(late.disposed(), 1);
  assert.equal(current.disposed(), 0);
  assert.equal(state.surface.sampleHeightDetailed(place).source, 'tiles');
});

test('native tile eviction removes the root from layer cleanup', async (t) => {
  const state = setup();
  t.after(state.destroy);
  await state.maps.setPhotorealTiles(google);
  const layer = [...state.layers.values()][0];
  const { root, disposed } = state.load(layer);
  assert.equal(layer.listenerCount('deleted'), 1);
  root.dispatchEvent({ type: 'removedFromWorld' });
  root.removeFromParent();
  state.view._meshes.delete(root.id);
  await state.maps.setPhotorealTiles(null);
  assert.equal(layer.listenerCount('deleted'), 0);
  assert.equal(disposed(), 0, 'native eviction already owns disposal');
});

test('native budgeted source deletion leaves no adapter tile roots', async (t) => {
  const { Core, initSync } = await import('@navaramap/engine');
  initSync({
    module: readFileSync(
      new URL(
        '../../../node_modules/@navaramap/engine/navara_wasm_bg.wasm',
        import.meta.url,
      ),
    ),
  });
  globalThis.location = { origin: 'http://localhost' };
  t.after(() => {
    delete globalThis.location;
  });
  for (const cacheBytes of [undefined, 768 * 1024 * 1024]) {
    const core = new Core('tiles-release-test');
    core.start();
    core.resize(1280, 800, 1);
    core.setCacheBytes(cacheBytes);
    core.changeCamera(new Float64Array([-97.7431, 30.2672, 1100]), -90, 0, 0);
    const state = setup(core);
    let added = 0;
    let removed = 0;
    try {
      await state.maps.setPhotorealTiles(fixture);
      const layer = [...state.layers.values()][0];
      for (let frame = 0; frame < 120; frame++) {
        if (frame === 60) {
          assert.equal(added, 4, 'all native fixture models loaded');
          await state.maps.setPhotorealTiles(null);
          assert.equal(core.getSourceDescription(layer.source.id), undefined);
          assert.deepEqual(state.hooks.tileRoots(), []);
          assert.equal(state.view._meshes.size, 0);
          assert.equal(
            state.surface.sampleHeightDetailed(place).source,
            'terrain',
          );
        }
        core.update(frame * 16);
        const events = core.readEvents();
        if (!events) continue;
        for (const event of events.take_data_requested()) {
          const name = new URL(event.url).pathname.split('/').at(-1);
          const bytes = readFileSync(
            new URL(
              `../../../scripts/fixtures/tiles3d/${name}`,
              import.meta.url,
            ),
          );
          core.setBufferU8(event.handle, event.bits, bytes.length, (buffer) =>
            buffer.set(bytes),
          );
          event.free();
        }
        for (const event of events.take_renderable_feature_added()) {
          state.load(layer);
          added++;
          core.markFeatureIsRendered('model', event.bits);
          event.free();
        }
        for (const event of events.take_renderable_feature_removed()) {
          removed++;
          event.free();
        }
        for (const event of events.take_mesh_added()) {
          core.setTileMeshPrepared(event.tile_handle);
          event.free();
        }
        events.free();
      }
      // Package canary: a budget suppresses the removals even after deletion.
      assert.equal(removed, cacheBytes === undefined ? 4 : 0);
    } finally {
      state.destroy();
      core.free();
    }
  }
});
