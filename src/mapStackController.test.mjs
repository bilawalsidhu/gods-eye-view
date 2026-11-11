import test from 'node:test';
import assert from 'node:assert/strict';
import { MapStackController } from './mapStackController.js';
import { createFakeEngine } from './globe/testing/fakeEngine.js';

test('the map stack controller applies its stacks through a given globe engine', async () => {
  const engine = createFakeEngine();
  const tileset = { show: true };
  const controller = new MapStackController({
    engine,
    googleTileset: tileset,
  });
  await controller.setStack('photoreal');
  assert.equal(
    engine.fake.callsOf('maps.setPhotorealTiles')[0].args[0].tileset,
    tileset,
  );
  await controller.setStack('osm');
  const [imagery] = engine.fake.callsOf('maps.setBaseImagery')[0].args;
  assert.equal(imagery.descriptor.id, 'osm');
  assert.ok(imagery.provider, 'a ready provider the controller built');
  assert.equal(engine.fake.callsOf('maps.setPhotorealTiles')[1].args[0], null);
  controller.destroy();
});

test('on a Navara engine the map stack controller opens on Google 3D from the browser key alone', async (t) => {
  const previous = globalThis.window;
  globalThis.window = { __GOOGLE_MAPS_API_KEY__: 'google-test' };
  t.after(() => {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  });
  const engine = createFakeEngine({ kind: 'navara' });
  const controller = new MapStackController({ engine });
  assert.equal(controller.getActiveId(), 'photoreal');
  assert.equal(controller.isStackAvailable('bing-aerial'), false);
  await controller.setStack('photoreal');
  const [photoreal] = engine.fake.callsOf('maps.setPhotorealTiles')[0].args;
  assert.equal(photoreal.kind, 'photoreal');
  assert.equal('tileset' in photoreal, false);
  controller.destroy();
  window.__GOOGLE_MAPS_API_KEY__ = '';
  const keyless = new MapStackController({
    engine: createFakeEngine({ kind: 'navara' }),
  });
  assert.equal(keyless.getActiveId(), 'esri-imagery');
  assert.equal(keyless.isStackAvailable('photoreal'), false);
  keyless.destroy();
});
