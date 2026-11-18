import assert from 'node:assert/strict';
import inspector from 'node:inspector/promises';
import * as Cesium from 'cesium';
import test from 'node:test';
import { createCesiumDraw } from './draw.js';

// Alone in its file, so the engine has seen only these icons when it
// measures what an upsert allocates (`draw.test.mjs` covers what it draws).

/** A scene with what an icon set touches: primitives and its events. */
function fakeScene() {
  const added = [];
  return {
    added,
    postRender: new Cesium.Event(),
    preRender: new Cesium.Event(),
    camera: { positionWC: new Cesium.Cartesian3(2e7, 0, 0) },
    frameState: { mode: Cesium.SceneMode.SCENE3D },
    updateHeight: () => () => {},
    getHeight: () => undefined,
    primitives: {
      add: (primitive) => (added.push(primitive), primitive),
      remove: (primitive) => {
        const at = added.indexOf(primitive);
        if (at >= 0) added.splice(at, 1);
        return at >= 0;
      },
      length: 0,
    },
    requestRender() {},
    isDestroyed: () => false,
  };
}

test('icons moved every frame are moved without lists made for the move', async () => {
  const scene = fakeScene();
  const part = createCesiumDraw({
    scene,
    report: (error) => assert.fail(error),
  });
  const set = part.port.icons({ id: 'icons:moved-fleet' });
  const items = Array.from({ length: 500 }, (_, i) => ({
    id: `v${i}`,
    pos: { ...Cesium.Cartesian3.fromDegrees(i / 100, 10) },
    image: 'a.png',
    size: [20, 20],
    color: '#33ccff',
    rotationMode: 'screen',
    rotation: 0,
    disableDepthTest: Infinity,
    meta: { i },
  }));
  set.set(items);
  const frame = () => {
    for (const item of items) item.pos.x += 0.5;
    set.upsert(items);
  };
  for (let i = 0; i < 300; i++) frame();
  const session = new inspector.Session();
  session.connect();
  await session.post('HeapProfiler.startSampling', {
    samplingInterval: 32,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  const frames = 100;
  for (let i = 0; i < frames; i++) frame();
  const { profile } = await session.post('HeapProfiler.stopSampling');
  session.disconnect();
  // What the upsert's own patch pass allocates, built-ins it calls included.
  let bytes = 0;
  (function visit(node, inPatch) {
    const patch = inPatch || node.callFrame.functionName === 'patchDrawnIcons';
    const ownFile =
      /\/render\/cesium\/draw\.js$/.test(node.callFrame.url) ||
      !node.callFrame.url;
    if (patch && ownFile) bytes += node.selfSize;
    for (const child of node.children) visit(child, patch);
  })(profile.head, false);
  // Two lists of 500 would be ~4 KB an upsert.
  assert.ok(bytes / frames <= 256, `${bytes / frames} B per upsert`);
  set.dispose();
});
