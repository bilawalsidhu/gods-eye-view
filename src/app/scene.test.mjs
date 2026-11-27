import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApplicationScene } from './scene.js';
import { createApplicationRequestServices } from '../services/requests.js';
import { createStubRendererPlugin } from '../render/stub/index.js';
import { rendererOf } from '../render/rendererOf.js';

/** Start the scene on a stub renderer with `capabilities`. */
async function startOnStub(t, { capabilities = [], ...rest } = {}) {
  document.body.innerHTML = '<div id="cesiumContainer"></div>';
  const made = [];
  const deferred = [];
  t.after(async () => {
    for (const fn of deferred.reverse()) await fn();
  });
  const scene = await createApplicationScene({
    renderer: createStubRendererPlugin({ capabilities }, (renderer) =>
      made.push(renderer),
    ),
    requestServices: createApplicationRequestServices(),
    loaderStatus: { textContent: '' },
    signal: new AbortController().signal,
    defer: (fn) => deferred.push(fn),
    ...rest,
  });
  return { scene, renderer: made[0], deferred };
}

test('the scene runs on a renderer with only the required members', async (t) => {
  const { scene, renderer, deferred } = await startOnStub(t);
  assert.equal(scene.renderer, renderer);
  assert.equal(rendererOf(scene.viewer), renderer, 'the scene object is bound');
  assert.equal(
    scene.viewer.container,
    document.getElementById('cesiumContainer'),
  );
  assert.equal(scene.viewer.isDestroyed(), false);
  assert.ok(
    scene.viewer.container.contains(renderer.canvas),
    'the renderer fills the container',
  );
  // Nothing of the engine on the scene object.
  assert.deepEqual(Object.keys(scene.viewer).sort(), [
    'container',
    'isDestroyed',
  ]);
  // No hooks: each is left out, not faked.
  for (const name of ['trimStaleCommands', 'viewerDrawsEntity', 'qaHandles'])
    assert.equal(scene[name], undefined, name);
  // What the renderer does through its ports.
  assert.equal(typeof scene.keepPanelRendering, 'function');
  assert.equal(
    renderer.camera.controls.keepEarthFramed,
    undefined,
    'no framing on a renderer without it',
  );
  // Keyless, the map stack shows Esri on the globe through the globe port.
  assert.equal(scene.tileset, null);
  assert.equal(scene.mapStackController.getActiveId(), 'esri-imagery');
  const layers = renderer.globe.imagery.list();
  assert.equal(layers.length, 1, 'one base imagery layer');
  assert.ok(
    renderer.testing.calls.some(
      (call) =>
        call.port === 'globe' &&
        call.member === 'imagery.add' &&
        call.args[0]?.url?.includes('World_Imagery'),
    ),
    'Esri imagery through the port',
  );
  assert.equal(scene.mapStackController.getDrapeSurface(), 'globe');
  // The credits show in the application's own line: nothing of Esri's on
  // it, the Esri base's and the data credits in the list it opens.
  const line = document.getElementById('gev-credits');
  assert.ok(line, 'a credits line');
  assert.doesNotMatch(line.textContent, /Esri/);
  assert.match(
    document.getElementById('gev-credits-panel').textContent,
    /Esri/,
  );
  assert.ok(
    document.querySelectorAll('#gev-credits-panel li').length > 10,
    'the data credits',
  );

  // Switching stacks goes through the port too.
  await scene.mapStackController.setStack('osm');
  assert.equal(scene.mapStackController.getActiveId(), 'osm');
  assert.equal(renderer.globe.imagery.list().length, 1, 'Esri gave way');

  for (const fn of deferred.splice(0).reverse()) await fn();
  assert.equal(scene.viewer.isDestroyed(), true);
  assert.equal(rendererOf(scene.viewer), null, 'and lets go of the renderer');
  assert.equal(renderer.globe.imagery.list().length, 0, 'imagery released');
  assert.equal(document.getElementById('gev-credits'), null, 'credits gone');
});

test('the scene keeps the Earth framed where the renderer can', async (t) => {
  const { renderer, deferred } = await startOnStub(t, {
    capabilities: ['keepEarthFramed'],
  });
  assert.equal(renderer.camera.controls.keepEarthFramed, true);
  const controls = renderer.camera.controls;
  for (const fn of deferred.splice(0).reverse()) await fn();
  assert.equal(controls.keepEarthFramed, false, 'and lets go on teardown');
});

test("the scene takes a plugin's application hooks", async (t) => {
  const stub = createStubRendererPlugin({ capabilities: [] });
  const given = [];
  const handles = Object.freeze({ probe: 'qa' });
  const { scene } = await startOnStub(t, {
    renderer: {
      id: 'stub-with-hooks',
      create: (options) => stub.create(options),
      applicationHooks(made) {
        given.push(made);
        return { qaHandles: handles, ownCreditDisplay: true };
      },
    },
  });
  assert.deepEqual(given, [scene.renderer], 'asked once, for the renderer');
  assert.equal(scene.qaHandles, handles, 'QA scripts read its handles');
  assert.equal(
    document.getElementById('gev-credits'),
    null,
    'its own display shows the credits',
  );
});

test('with credentials, the photoreal base loads through the globe port', async (t) => {
  const { scene, renderer } = await startOnStub(t, {
    capabilities: ['photoreal', 'globeVisibility'],
    googleApiKey: 'stub-key',
  });
  assert.ok(scene.tileset, 'a photoreal base');
  assert.equal(scene.mapStackController.getActiveId(), 'photoreal');
  assert.equal(renderer.globe.isGlobeVisible(), false, 'the globe is hidden');
  const photoreal = renderer.testing.calls.filter(
    (call) => call.port === 'globe' && call.member === 'setPhotoreal',
  );
  assert.equal(photoreal[0]?.args[0]?.key, 'stub-key');

  // A globe stack hides photoreal through the port, and shows the globe.
  await scene.mapStackController.setStack('esri-imagery');
  assert.equal(renderer.globe.isGlobeVisible(), true);
  assert.equal(
    renderer.testing.calls
      .filter((call) => call.port === 'globe' && call.member === 'setPhotoreal')
      .at(-1).args[0],
    null,
  );
  await scene.mapStackController.setStack('photoreal');
  assert.equal(renderer.globe.isGlobeVisible(), false);
});
