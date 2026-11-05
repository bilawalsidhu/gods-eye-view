import test from 'node:test';
import assert from 'node:assert/strict';
import * as geo from '../../../geo/index.js';
import { PerspectiveCamera } from 'three';
import { constantRgba } from '../../shared/color.js';
import { createEarthquakesNavaraRenderer } from './navara.js';

test('Navara earthquake effect is lazy, releases replaced textures and detaches on repeated destroy', () => {
  const registered = [],
    effects = [],
    requests = [];
  const view = {
    camera: {},
    registerEffect(key, desc) {
      registered.push([key, desc]);
    },
    addEffect(config) {
      const h = {
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
      effects.push(h);
      return h;
    },
  };
  const engine = {
    render: {
      request(reason) {
        requests.push(reason);
      },
    },
  };
  const renderer = createEarthquakesNavaraRenderer(engine, {
    view,
    EffectDesc: class {},
    NavaraEffect: class {},
  });
  assert.equal(effects.length, 0);
  renderer.setVisible(true);
  assert.equal(effects.length, 0);
  const disc = {
    position: geo.cartesian3.fromDegrees(30, 20),
    baseRadius: 32000,
    color: constantRgba(1, 0, 0),
    fillAlpha: 0.4,
    usgsId: 'us-fixture',
    mag: 5,
    place: 'Fixture',
    time: 1000,
    depthKm: 8,
  };
  renderer.replace([disc]);
  assert.equal(effects.length, 1);
  const owner = effects[0].config.gevEarthquakeGround.owner;
  const old = owner.state;
  let disposed = 0;
  for (const t of [
    old.edges.texture,
    old.packed.texture,
    old.gridTexture,
    old.candidates.texture,
  ])
    t.addEventListener('dispose', () => disposed++);
  const record = renderer.records(1)[0];
  assert.equal(record.id, 'us-fixture');
  record.id = 'mutated';
  assert.equal(renderer.records(1)[0].id, 'us-fixture');
  renderer.replace([disc]);
  assert.equal(disposed, 4);
  assert.notEqual(owner.state, old);
  renderer.setVisible(false);
  assert.deepEqual(renderer.records(1), []);
  assert.deepEqual(effects[0].updates.at(-1), { visible: false });
  renderer.destroy();
  renderer.destroy();
  assert.equal(effects[0].deleted, 1);
  renderer.replace([disc]);
  assert.equal(effects.length, 1);
  const second = createEarthquakesNavaraRenderer(engine, {
    view,
    EffectDesc: class {},
    NavaraEffect: class {},
  });
  second.destroy();
  assert.equal(registered.length, 1);
});

test('static screen data uploads once and invalidates for camera, projection and viewport changes', () => {
  let owner;
  const view = {
    camera: {},
    registerEffect() {},
    addEffect(config) {
      owner = config.gevEarthquakeGround.owner;
      return { update() {}, delete() {} };
    },
  };
  const renderer = createEarthquakesNavaraRenderer(
    { render: { request() {} } },
    { view, EffectDesc: class {}, NavaraEffect: class {} },
  );
  renderer.setVisible(true);
  const position = geo.cartesian3.fromDegrees(30, 20);
  renderer.replace([
    {
      position,
      baseRadius: 32000,
      color: constantRgba(1, 0, 0),
      fillAlpha: 0.4,
    },
  ]);
  const camera = new PerspectiveCamera(60, 1.6, 1, 30000000);
  camera.position.set(position.x * 1.1, position.y * 1.1, position.z * 1.1);
  camera.lookAt(position.x, position.y, position.z);
  camera.updateMatrixWorld(true);
  const viewport = { width: 1280, height: 800 };
  const context = { getInputBuffer: () => viewport };
  const version = () => owner.state.packed.texture.version;
  owner.state.update(camera, context);
  let previous = version();
  assert.ok(
    owner.state.candidates.width > 1,
    'positive visible feature occupies grid cells',
  );
  for (let i = 0; i < 100; i++) owner.state.update(camera, context);
  assert.equal(version(), previous, 'unchanged frames do not upload geometry');
  camera.position.x += 10;
  camera.updateMatrixWorld(true);
  owner.state.update(camera, context);
  assert.equal(version(), ++previous);
  camera.fov = 45;
  camera.updateProjectionMatrix();
  owner.state.update(camera, context);
  assert.equal(version(), ++previous);
  viewport.width = 1600;
  owner.state.update(camera, context);
  assert.equal(version(), ++previous);
  owner.state.update(camera, context);
  assert.equal(version(), previous);
  renderer.destroy();
});
