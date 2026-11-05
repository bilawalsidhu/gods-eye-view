import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import * as geo from '../../../geo/index.js';
import { createTransitSpriteBanks } from './navaraSprites.js';
import { createTransitNavaraView } from './navaraView.js';
import { perspectiveProjectedRotation } from '../../../data/iconOrientation.js';
import { createTransitNavaraTrail, transitTrailFrame } from './navaraTrail.js';

const atlas = { canvas: {}, cells: { bus: [0, 0, 1, 1], tram: [0, 0, 1, 1] } };
function moverEngine() {
  const sets = [];
  return {
    sets,
    movers: {
      createSet(options) {
        const set = {
          options,
          rows: [],
          commits: 0,
          disposed: 0,
          set(i, fields) {
            this.rows[i] ??= {};
            for (const [key, value] of Object.entries(fields))
              if (value !== undefined)
                this.rows[i][key] = structuredClone(value);
          },
          setCount(value) {
            this.count = value;
          },
          commit() {
            this.commits++;
          },
          destroy() {
            this.disposed++;
          },
          ready: () => true,
        };
        sets.push(set);
        return set;
      },
    },
  };
}
const spec = (id) => ({
  id,
  image: 'bus',
  width: 20,
  height: 20,
  position: { x: 1, y: 2, z: 3 },
});
test('moving bank commits do not upload the static fleet; equal setters are idle', async () => {
  const engine = moverEngine(),
    banks = createTransitSpriteBanks(engine, { drawAtlas: async () => atlas });
  await banks.ready;
  const [stationary, moving] = banks.collections;
  stationary.show = moving.show = true;
  for (let i = 0; i < 800; i++) stationary.add(spec(`static-${i}`));
  const source = spec('moving'),
    marker = moving.add(source);
  banks.flush();
  const [staticSet, movingSet] = engine.sets;
  const initial = staticSet.commits;
  source.position.x = 99;
  assert.equal(marker.position.x, 1, 'creation copies mutable coordinates');
  const scratch = { x: 4, y: 5, z: 6 };
  banks.inFrame(() => {
    marker.position = scratch;
    marker.rotation = 0.3;
  });
  scratch.x = 100;
  assert.equal(marker.position.x, 4, 'assignment copies mutable coordinates');
  assert.equal(staticSet.commits, initial);
  const count = movingSet.commits;
  banks.inFrame(() => {
    marker.position = { x: 4, y: 5, z: 6 };
    marker.rotation = 0.3;
    marker.show = true;
    marker.width = 20;
    marker.color = marker.color.clone();
  });
  assert.equal(movingSet.commits, count);
  assert.equal(staticSet.count, 800);
  assert.equal(movingSet.count, 1);
  const migrated = stationary.add({
    ...spec('moving'),
    position: marker.position,
    rotation: marker.rotation,
  });
  moving.remove(marker);
  banks.flush();
  assert.equal(migrated.id, marker.id);
  assert.deepEqual(migrated.position, marker.position);
  assert.equal(movingSet.count, 0);
  banks.destroy();
  banks.destroy();
  assert.ok(engine.sets.every((set) => set.disposed === 1));
});

test('a late atlas cannot resurrect destroyed transit banks', async () => {
  let resolve;
  const engine = moverEngine();
  const banks = createTransitSpriteBanks(engine, {
    drawAtlas: () =>
      new Promise((done) => {
        resolve = done;
      }),
  });
  banks.collections[0].add(spec('late'));
  await Promise.resolve();
  banks.destroy();
  resolve(atlas);
  await banks.ready;
  assert.equal(engine.sets.length, 0);
});

test('Navara course projection agrees with native across near, far and oblique cameras', () => {
  const canvas = {
    clientWidth: 1280,
    clientHeight: 800,
    width: 1280,
    height: 800,
  };
  const camera = new Cesium.Camera({
    canvas,
    drawingBufferWidth: 1280,
    drawingBufferHeight: 800,
    mapProjection: new Cesium.GeographicProjection(),
    mode: Cesium.SceneMode.SCENE3D,
  });
  const scene = {
    camera,
    canvas,
    drawingBufferWidth: 1280,
    drawingBufferHeight: 800,
    mapProjection: new Cesium.GeographicProjection(),
    frameState: { mode: Cesium.SceneMode.SCENE3D },
  };
  const engine = {
    camera: {
      pose: () => ({
        position: camera.positionWC,
        cartographic: camera.positionCartographic,
        direction: camera.directionWC,
        right: camera.rightWC,
        up: camera.upWC,
        heading: camera.heading,
        pitch: camera.pitch,
        roll: camera.roll,
        fovy: camera.frustum.fovy,
        aspectRatio: camera.frustum.aspectRatio,
      }),
    },
    projector: {
      worldToWindow: (point, out) =>
        Cesium.SceneTransforms.worldToWindowCoordinates(scene, point, out),
      horizonVisible: () => true,
    },
    host: { size: () => ({ width: 1280, height: 800 }) },
  };
  for (const height of [600, 20000, 1000000])
    for (const heading of [0, 1.2, 3.1]) {
      camera.setView({
        destination: Cesium.Cartesian3.fromDegrees(-97.7431, 30.2672, height),
        orientation: { heading, pitch: -0.8, roll: 0 },
      });
      const view = createTransitNavaraView(engine);
      for (const course of [0, 90, 180, 270]) {
        const position = Cesium.Cartesian3.fromDegrees(-97.7401, 30.2682, 10);
        const expected = perspectiveProjectedRotation(
          scene,
          position,
          course,
          0,
        );
        assert.ok(
          Math.abs(view.rotation(position, course, 0) - expected) < 1e-10,
        );
      }
    }
});

test('ground trail updates clip uniforms without replacing corridor textures and releases them', () => {
  const created = [],
    requests = [];
  const view = {
    registerEffect() {},
    addEffect(config) {
      const handle = {
        config,
        updates: [],
        removed: 0,
        update(v) {
          this.updates.push(v);
        },
        delete() {
          this.removed++;
        },
      };
      created.push(handle);
      return handle;
    },
  };
  const engine = {
    host: { canvas: { width: 1280 }, size: () => ({ width: 1280 }) },
    render: { request: (reason) => requests.push(reason) },
  };
  const trail = createTransitNavaraTrail(engine, {
    view,
    EffectDesc: class {},
    NavaraEffect: class {},
  });
  const segment = {
    fromSeq: 1,
    toSeq: 2,
    fromT: 0,
    toT: 15000,
    positions: [
      geo.cartesian3.fromDegrees(-97.7431, 30.2672, 10),
      geo.cartesian3.fromDegrees(-97.7431, 30.2674, 30),
    ],
  };
  const frame = transitTrailFrame(segment);
  assert.ok(frame.length > 20 && frame.length < 25);
  assert.ok(Math.abs(geo.cartesian3.dot(frame.up, frame.east)) < 1e-9);
  trail.replaceHistory({ revision: 1, segments: [segment] });
  const owner = created[0].config.gevTransitGround.owner;
  const texture = owner.state.packed.texture;
  let disposed = 0;
  texture.addEventListener('dispose', () => disposed++);
  for (let i = 0; i < 100; i++)
    trail.setDisplaySample(
      { displayT: i * 100, fromSeq: 1, toSeq: 2, fraction: i / 150 },
      segment.positions[0],
    );
  assert.equal(owner.state.packed.texture, texture);
  assert.equal(trail.diagnostics().rebuilds, 1);
  assert.equal(owner.active, 0);
  trail.setDisplaySample(
    { displayT: 16000, fromSeq: 2, toSeq: 2, fraction: 1 },
    segment.positions[1],
  );
  assert.equal(owner.active, -1);
  trail.destroy();
  trail.destroy();
  assert.equal(disposed, 1);
  assert.equal(created[0].removed, 1);
});
