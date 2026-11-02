import { createGroundCellDisplay } from '../../shared/render/navaraGroundCells.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngineEvent } from '../../../globe/contract.js';
import * as geo from '../../../geo/index.js';
import { createFirmsNavaraRenderer } from './navara.js';
const settle = () => new Promise((resolve) => setImmediate(resolve));
function harness() {
  const effects = [],
    registered = [],
    requests = [],
    input = new Map();
  const frames = {
    preUpdate: createEngineEvent(),
    preRender: createEngineEvent(),
  };
  const position = geo.cartesian3.fromDegrees(0, 0, 4000000);
  const engine = {
    frames,
    host: { size: () => ({ width: 1280, height: 800 }) },
    movers: {
      createSet() {
        throw new Error('cells do not allocate sprite movers');
      },
    },
    render: { request: (reason) => requests.push(reason) },
    camera: {
      livePosition: position,
      moveEnd: createEngineEvent(),
      viewRectangle: () => ({ west: -1, south: -0.5, east: 1, north: 0.5 }),
      pose: () => ({
        position,
        cartographic: { longitude: 0, latitude: 0, height: 4000000 },
        direction: { x: -1, y: 0, z: 0 },
        up: { x: 0, y: 0, z: 1 },
        right: { x: 0, y: 1, z: 0 },
        heading: 0,
        pitch: -Math.PI / 2,
        roll: 0,
        fovy: 1,
      }),
    },
    projector: {
      worldToWindow: (point, result) =>
        Object.assign(result ?? {}, { x: 10, y: 20 }),
      horizonVisible: () => true,
    },
    input: {
      on(type, listener) {
        input.set(type, listener);
        return () => input.delete(type);
      },
    },
  };
  const view = {
    camera: {},
    registerEffect: (key, desc) => registered.push([key, desc]),
    addEffect(config) {
      const handle = {
        config,
        updates: [],
        deleted: 0,
        update(value) {
          this.updates.push(value);
        },
        delete() {
          this.deleted++;
        },
      };
      effects.push(handle);
      return handle;
    },
  };
  const options = { view, EffectDesc: class {}, NavaraEffect: class {} };
  return {
    engine,
    options,
    effects,
    registered,
    requests,
    input,
    frames,
    renderer: createFirmsNavaraRenderer(engine, options),
  };
}
const cell = {
  west: 0,
  south: 0,
  east: 1,
  north: 1,
  color: { red: 1, green: 0, blue: 0, alpha: 0.3 },
};
test('ground changes are atomic, lazy and dispose replaced and destroyed GPU textures once', async () => {
  const h = harness(),
    r = h.renderer;
  r.setVisible(true);
  assert.equal(h.effects.length, 0);
  r.clearCells();
  r.addCell(cell);
  r.addCell({ ...cell, west: 1, east: 2 });
  assert.equal(h.effects.length, 0);
  await settle();
  assert.equal(h.effects.length, 1);
  const owner = h.effects[0].config.gevFirmsGround.owner;
  assert.equal(owner.state.count, 2);
  let disposed = 0;
  for (const t of [
    owner.state.packed.texture,
    owner.state.gridTexture,
    owner.state.candidates.texture,
  ])
    t.addEventListener('dispose', () => disposed++);
  r.clearCells();
  r.addCell(cell);
  await settle();
  assert.equal(owner.state.count, 1);
  assert.equal(disposed, 3);
  r.setVisible(false);
  assert.equal(r.dataSource.show, false);
  assert.deepEqual(h.effects[0].updates.at(-1), { visible: false });
  r.clearCells();
  r.addCell(cell);
  r.destroy();
  r.destroy();
  const before = h.requests.length;
  await settle();
  assert.equal(h.requests.length, before);
  assert.equal(h.effects[0].deleted, 1);
  assert.equal(h.frames.preUpdate.numberOfListeners, 0);
  const second = createFirmsNavaraRenderer(h.engine, h.options);
  second.destroy();
  assert.equal(h.registered.length, 1);
});
test('GNSS and FIRMS share one ground pass without hiding or destroying one another', async () => {
  const h = harness();
  const gnss = createGroundCellDisplay(h.engine, h.options, 0);
  const fire = h.renderer;
  try {
    fire.setVisible(true);
    fire.addCell(cell);
    await settle();
    gnss.replace([cell, cell]);
    gnss.setVisible(true);
    const owner = h.effects[0].config.gevFirmsGround.owner;
    assert.equal(h.effects.length, 1);
    assert.equal(owner.state.count, 3);
    gnss.setVisible(false);
    assert.equal(owner.state.count, 1);
    gnss.setVisible(true);
    fire.destroy();
    assert.equal(owner.state.count, 2);
    assert.equal(h.effects[0].deleted, 0);
  } finally {
    fire.destroy();
    gnss.destroy();
  }
  assert.equal(h.effects[0].deleted, 1);
});

test('FIRMS selection uses actual engine event picks and releases its dispatcher subscriptions', () => {
  const h = harness(),
    r = h.renderer;
  r.setVisible(true);
  const handler = r.createInputHandler();
  let event;
  handler.setInputAction((value) => (event = value), 'click');
  assert.equal(h.input.size, 4);
  const picked = { id: 'sibling-contact' };
  h.input.get('click')({ position: { x: 10, y: 20 }, picked, drilled: [] });
  assert.equal(r.pick(event.position, event), picked);
  assert.equal(r.view.camera.moveEnd, h.engine.camera.moveEnd);
  assert.equal(r.view.scene.preRender, h.engine.frames.preRender);
  assert.deepEqual(r.viewRectangle({}), {
    west: -1,
    south: -0.5,
    east: 1,
    north: 0.5,
  });
  assert.deepEqual(r.project({}, {}), { x: 10, y: 20 });
  event = null;
  r.setVisible(false);
  h.input.get('click')({ position: { x: 10, y: 20 }, picked, drilled: [] });
  assert.equal(event, null);
  handler.destroy();
  handler.destroy();
  assert.equal(h.input.size, 0);
  r.destroy();
});
