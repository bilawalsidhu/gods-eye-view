import test from 'node:test';
import assert from 'node:assert/strict';
import { globeMapEngine as engine } from './globeEngine.js';
import { mapEngineFor, provideMapEngine } from './engine.js';
import { bindRenderer } from '../render/rendererOf.js';
import { provideApplicationHooks } from '../render/applicationHooks.js';
import { createStubRenderer } from '../render/stub/index.js';
import { MapSourceController } from './controller.js';
import { createDefaultMapSources } from './defaultSources.js';

function scene(capabilities) {
  const renderer = createStubRenderer(capabilities ? { capabilities } : {});
  const host = {};
  bindRenderer(host, renderer);
  return { host, renderer };
}

const calls = (renderer, member) =>
  renderer.testing.calls.filter(
    (call) => call.port === 'globe' && call.member === member,
  );

test('a renderer without a map engine of its own switches through its globe port', () => {
  const { host, renderer } = scene();
  assert.equal(mapEngineFor(host), engine);
  const own = { own: true };
  provideApplicationHooks(renderer, { mapEngine: own });
  assert.equal(mapEngineFor(host), own, "the plugin's own comes first");
  const provided = { provided: true };
  provideMapEngine(provided);
  assert.equal(mapEngineFor({}), provided, 'a viewer with no renderer');
});

test('imagery layers go through the port, lowest first, and come off again', () => {
  const { host, renderer } = scene();
  const spec = engine.imagery.esri();
  assert.equal(spec.kind, 'xyz');
  assert.match(
    spec.url,
    /World_Imagery\/MapServer\/tile\/\{z\}\/\{y\}\/\{x\}$/,
  );
  const layer = engine.createImageryLayer(spec);
  engine.addImageryLayer(host, layer, 0);
  assert.deepEqual(calls(renderer, 'imagery.add')[0].args, [spec, 0]);
  assert.equal(renderer.globe.imagery.list().length, 1);
  let errors = 0;
  const off = engine.onTileError(spec, () => (errors += 1));
  assert.equal(typeof off, 'function', 'tile errors are heard');
  off();
  engine.removeImageryLayer(host, layer);
  assert.equal(renderer.globe.imagery.list().length, 0);
  assert.equal(
    engine.onTileError(spec, () => {}),
    null,
    'none once removed',
  );
  assert.equal(errors, 0);
});

test('the globe is shown and hidden through the port, read back without globe visibility', () => {
  const { host, renderer } = scene([]);
  assert.equal(engine.globeShown(host), true);
  engine.setGlobeShown(host, false);
  assert.equal(engine.globeShown(host), false);
  assert.deepEqual(calls(renderer, 'setGlobeVisible').at(-1).args, [false]);
  const visible = scene(['globeVisibility']);
  engine.setGlobeShown(visible.host, false);
  assert.equal(visible.renderer.globe.isGlobeVisible(), false);
  assert.equal(engine.globeShown(visible.host), false);
});

test('terrain is the port’s world terrain, or the ellipsoid without a token', async () => {
  const { host, renderer } = scene();
  await assert.rejects(engine.terrain.world(''), /ion token/);
  const world = await engine.terrain.world('token');
  engine.applyTerrain(host, world);
  assert.deepEqual(calls(renderer, 'setTerrain').at(-1).args, [
    { kind: 'world', requestVertexNormals: true },
  ]);
  engine.applyTerrain(host, await engine.terrain.keyless());
  assert.deepEqual(calls(renderer, 'setTerrain').at(-1).args, [
    { kind: 'ellipsoid' },
  ]);
  assert.throws(() => engine.imagery.ion(2, ''), /token/);
  assert.deepEqual(engine.imagery.ion(3, 'token'), {
    kind: 'world',
    worldStyle: 'aerialLabels',
  });
});

test('photoreal loads through the port, hides and shows, and is released', async () => {
  const { host, renderer } = scene(['photoreal']);
  const none = await engine.loadPhotoreal(host, {});
  assert.deepEqual(none, { tileset: null, route: 'none', errors: [] });
  assert.equal(calls(renderer, 'setPhotoreal').length, 0, 'no credentials');

  const tokens = { token: async () => 'session' };
  const loaded = await engine.loadPhotoreal(host, { googleTokens: tokens });
  assert.equal(loaded.route, 'google');
  const handle = loaded.tileset;
  assert.equal(engine.tilesetShown(handle), true);
  const spec = calls(renderer, 'setPhotoreal')[0].args[0];
  assert.equal(spec.provider, 'google');
  assert.equal(await spec.token(), 'session');
  assert.equal(spec.fallback, false);

  engine.showTileset(handle, false);
  assert.equal(engine.tilesetShown(handle), false);
  assert.equal(calls(renderer, 'setPhotoreal').at(-1).args[0], null);
  await engine.tilesetReady(handle);
  engine.showTileset(handle, true);
  assert.equal(calls(renderer, 'setPhotoreal').at(-1).args[0], spec);
  engine.release(handle);
  assert.equal(engine.isDestroyed(handle), true);
  assert.equal(calls(renderer, 'setPhotoreal').at(-1).args[0], null);
  const count = calls(renderer, 'setPhotoreal').length;
  engine.showTileset(handle, true);
  assert.equal(calls(renderer, 'setPhotoreal').length, count, 'never again');
});

test('a renderer without photoreal reports none, with the reason it gave', async () => {
  const { host } = scene([]);
  const result = await engine.loadPhotoreal(host, { googleApiKey: 'key' });
  assert.equal(result.tileset, null);
  assert.equal(result.route, 'none');
});

test('photoreal that fails to come back leaves the globe shown, and is tried again', async () => {
  const { host, renderer } = scene(['photoreal']);
  const loaded = await engine.loadPhotoreal(host, { googleApiKey: 'key' });
  const handle = loaded.tileset;
  engine.showTileset(handle, false);
  engine.setGlobeShown(host, false);
  // The port cannot draw photoreal any more.
  renderer.globe.setPhotoreal = async (spec) => ({
    route: 'none',
    error: { code: 'refused', message: 'refused' },
    spec,
  });
  const warn = console.warn;
  console.warn = () => {};
  try {
    engine.showTileset(handle, true);
    await assert.rejects(
      engine.tilesetReady(handle),
      /refused/,
      'the map stack hears it failed',
    );
  } finally {
    console.warn = warn;
  }
  assert.equal(engine.tilesetShown(handle), false, 'off again');
  assert.equal(engine.globeShown(host), true, 'the base is not blank');
  let tried = 0;
  renderer.globe.setPhotoreal = async () => {
    tried += 1;
    return { route: 'google' };
  };
  engine.showTileset(handle, true);
  assert.equal(tried, 1, 'a later switch tries again');
});

test('a photoreal stack that fails to come back leaves the stack before it in place', async () => {
  const { host, renderer } = scene(['photoreal']);
  const loaded = await engine.loadPhotoreal(host, { googleApiKey: 'key' });
  const errors = [];
  const controller = new MapSourceController(host, {
    registry: createDefaultMapSources({
      googleTileset: loaded.tileset,
      engine,
    }),
    engine,
    googleTileset: loaded.tileset,
    onError: (message) => errors.push(message),
  });
  await controller.setStack('esri-imagery', { silent: true });
  assert.equal(renderer.globe.imagery.list().length, 1);
  renderer.globe.setPhotoreal = async (spec) => ({
    route: spec ? 'none' : 'google',
    error: { code: 'refused', message: 'refused' },
  });
  const warn = console.warn;
  console.warn = () => {};
  try {
    await controller.setStack('photoreal', { silent: true });
  } finally {
    console.warn = warn;
  }
  assert.equal(controller.getState().activeId, 'esri-imagery');
  assert.equal(renderer.globe.imagery.list().length, 1, 'its imagery stays');
  assert.equal(engine.globeShown(host), true, 'on the shown globe');
  assert.match(errors.at(-1), /refused/);
  controller.destroy();
});
