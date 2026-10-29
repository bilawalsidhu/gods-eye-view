import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakeEngine } from '../../../globe/testing/fakeEngine.js';
import { createCctvNavaraRenderer } from './navara.js';

function fixture(t) {
  const engine = createFakeEngine({ kind: 'navara' });
  const pickers = new Set();
  engine.picker.registerMeshPicker = (pick) => {
    pickers.add(pick);
    return () => pickers.delete(pick);
  };
  const descriptors = new Map();
  const view = {
    registerMesh: (key, value) => descriptors.set(key, value),
    addMesh(config) {
      const key = Object.keys(config)[0];
      const desc = new (descriptors.get(key))(view, {}, config);
      desc.createMesh();
      return { delete: () => desc.onDestroy() };
    },
  };
  class MeshDesc {
    onDestroy() {}
  }
  const state = { _recordById: new Map() };
  const renderer = createCctvNavaraRenderer(engine, {
    state,
    services: {},
    view,
    MeshDesc,
  });
  renderer.attach();
  t.after(() => renderer.destroy());
  return { engine, renderer, state, pickers };
}

test('CCTV focus uses the engine sphere-flight fields and native range/pitch', (t) => {
  const { engine, renderer } = fixture(t);
  let flight;
  engine.camera.flyToSphere = (sphere, options) => {
    flight = { sphere, options };
  };
  const position = { x: 100, y: 200, z: 300 };
  renderer.focus({ position, camera: { headingDeg: 84, rangeM: 126 } }, 0.2);
  assert.deepEqual(flight, {
    sphere: { center: position, radius: 45.36 },
    options: {
      heading: (84 * Math.PI) / 180,
      pitch: (-22 * Math.PI) / 180,
      range: 280,
      duration: 0.2,
      easing: 'cubicInOut',
    },
  });
});

test('CCTV markers own position snapshots and batch mutations without idle writes', (t) => {
  const { engine, renderer } = fixture(t);
  renderer.createMarkers();
  const position = { x: 6378137, y: 10, z: 20 };
  const marker = renderer.createMarker({ id: 'camera' }, position);
  renderer.restoreOrder();
  const store = engine.fake.moverSet('cctv').store;
  position.y = 35;
  marker.position = position;
  engine.fake.frame();
  assert.equal(store.positions[1], 35);
  position.y = 42;
  assert.equal(
    marker.position.y,
    35,
    'a caller cannot mutate the retained position',
  );
  engine.fake.resetCalls();
  marker.position = { ...marker.position };
  marker.color = marker.color.withAlpha(marker.color.alpha);
  renderer.restoreOrder();
  assert.equal(engine.fake.callsOf('render.request').length, 0);
  renderer.setMarkersVisible(false);
  renderer.restoreOrder();
  assert.equal(store.shows[0], 0);
});

test('CCTV picking requires actual owned primitives, and destroy removes its picker', (t) => {
  const { engine, renderer, state, pickers } = fixture(t);
  renderer.createMarkers();
  const position = { x: 6378137, y: 10, z: 20 };
  renderer.createMarker({ id: 'a' }, position);
  state._recordById.set('a', {});
  assert.equal(
    renderer.extractPickedCameraId({ id: 'a', owner: 'sibling' }),
    null,
  );
  assert.equal(renderer.extractPickedCameraId({ id: 'a', owner: 'cctv' }), 'a');
  const p = {
    mount: position,
    tl: position,
    tr: position,
    br: position,
    bl: position,
  };
  const lines = renderer.createCoverage('a', p);
  lines[0].show = true;
  assert.equal(
    renderer.extractPickedCameraId({ id: lines[0].id, owner: lines[0].id }),
    'a',
  );
  renderer.removeCoverageEntity(lines[0]);
  assert.equal(
    renderer.extractPickedCameraId({ id: lines[0].id, owner: lines[0].id }),
    null,
  );
  renderer.destroy();
  renderer.destroy();
  assert.equal(pickers.size, 0);
  assert.equal(engine.lines.list().length, 0);
  assert.equal(engine.movers.list().length, 0);
});
