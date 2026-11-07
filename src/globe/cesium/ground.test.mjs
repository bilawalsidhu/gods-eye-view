import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { normalizeGroundItem } from '../ground.js';
import { createCesiumGround, groundInstances } from './ground.js';
import { createFakeViewer } from './testing/fakeViewer.mjs';

// Cesium's Material types its uniforms against the browser's image and
// canvas classes; Node has none of them.
for (const name of [
  'HTMLCanvasElement',
  'HTMLImageElement',
  'HTMLVideoElement',
  'ImageBitmap',
  'OffscreenCanvas',
])
  globalThis[name] ??= class {};

const items = (kind, list) =>
  list.map((item, index) => normalizeGroundItem(kind, item, index));

test('fills batch into GroundPrimitive instances, outlines into ground polylines', () => {
  const options = { id: 'zones', kind: 'polygon' };
  const { fills, lines } = groundInstances(
    options,
    items('polygon', [
      {
        rings: [
          [
            [0, 0],
            [1, 0],
            [1, 1],
          ],
          [
            [0.6, 0.2],
            [0.8, 0.2],
            [0.8, 0.4],
          ],
        ],
        fill: [1, 0, 0, 0.5],
        outline: { color: [1, 1, 1, 1], widthPx: 2 },
      },
      {
        rings: [
          [
            [2, 0],
            [3, 0],
            [3, 1],
          ],
        ],
        outline: { color: [0, 0, 1, 1], widthPx: 3 },
      },
    ]),
  );
  assert.equal(fills.length, 1, 'an item without a fill adds none');
  assert.ok(fills[0].geometry instanceof Cesium.PolygonGeometry);
  assert.deepEqual(fills[0].id, { gevGroundSet: 'zones', instance: 0 });
  assert.equal(lines.length, 3, 'one outline per ring');
  assert.ok(lines[0].geometry instanceof Cesium.GroundPolylineGeometry);
  assert.equal(lines[0].geometry.loop, true);
  assert.equal(lines[0].geometry.width, 2);
  assert.deepEqual(lines[2].id, { gevGroundSet: 'zones', instance: 1 });
  const corridors = groundInstances(
    { id: 'roads', kind: 'corridor' },
    items('corridor', [
      {
        positions: [
          [0, 0],
          [1, 0],
        ],
        color: [1, 1, 1, 1],
        widthPx: 4,
      },
      {
        positions: [
          [0, 1],
          [1, 1],
        ],
        color: [1, 1, 1, 1],
        widthM: 30,
      },
    ]),
  );
  assert.ok(corridors.fills[0].geometry instanceof Cesium.CorridorGeometry);
  assert.equal(corridors.lines[0].geometry.width, 4);
  const shapes = groundInstances(
    { id: 'shapes', kind: 'disc' },
    items('disc', [{ center: [0, 0], radiusM: 500, fill: [1, 1, 1, 1] }]),
  );
  assert.ok(shapes.fills[0].geometry instanceof Cesium.EllipseGeometry);
});

test('sets join scene.groundPrimitives in order and rebuild on commit', () => {
  const viewer = createFakeViewer();
  const added = [];
  viewer.scene.groundPrimitives = {
    add: (value) => added.push(value),
    remove: (value) => added.splice(added.indexOf(value), 1),
  };
  const made = [];
  const fake = (type) => (options) => {
    const primitive = {
      type,
      options,
      ready: false,
      destroy() {},
      isDestroyed: () => false,
    };
    made.push(primitive);
    return primitive;
  };
  const renders = [];
  const part = createCesiumGround(viewer, {
    requestRender: (reason) => renders.push(reason),
    factories: { fills: fake('fills'), lines: fake('lines') },
  });
  const high = part.ground.createSet({ id: 'high', kind: 'cell', order: 2 });
  const low = part.ground.createSet({
    id: 'low',
    kind: 'cell',
    pickable: true,
    drape: 'tiles',
  });
  assert.equal(added.length, 1, 'one engine collection');
  const root = added[0];
  low.replace([
    {
      west: 0,
      south: 0,
      east: 1,
      north: 1,
      fill: [1, 0, 0, 1],
      outline: { color: [1, 1, 1, 1], widthPx: 2 },
      pickId: 'cell-1',
    },
  ]);
  low.commit();
  assert.equal(root.length, 2);
  assert.equal(root.get(0).get(0), made[0], 'the lower order first');
  assert.deepEqual(
    made.map(({ type }) => type),
    ['fills', 'lines'],
  );
  const [fills] = made;
  assert.equal(
    fills.options.classificationType,
    Cesium.ClassificationType.CESIUM_3D_TILE,
  );
  assert.equal(fills.options.allowPicking, true);
  assert.equal(low.ready(), false, 'built in workers');
  fills.ready = true;
  made[1].ready = true;
  assert.equal(low.ready(), true);
  assert.deepEqual(
    part.identify({ id: { gevGroundSet: 'low', instance: 0 } }),
    { owner: 'low', instance: 0, id: 'cell-1', pickable: true },
  );
  high.replace([
    { west: 0, south: 0, east: 1, north: 1, fill: [1, 1, 1, 1], pickId: 'x' },
  ]);
  high.commit();
  assert.equal(made.at(-1).options.allowPicking, false);
  assert.equal(
    part.identify({ id: { gevGroundSet: 'high', instance: 0 } }).pickable,
    false,
  );
  assert.equal(part.identify({ id: 'entity' }), null);
  part.destroy();
  assert.equal(added.length, 0);
});

test('a glow, a pulse or a dash draws through its own material, timed every frame', () => {
  const viewer = createFakeViewer();
  viewer.scene.groundPrimitives = { add() {}, remove() {} };
  const made = [];
  const fake = (type) => (options) => {
    const primitive = {
      type,
      options,
      ready: false,
      destroy() {},
      isDestroyed: () => false,
    };
    made.push(primitive);
    return primitive;
  };
  const renders = [];
  const part = createCesiumGround(viewer, {
    requestRender: (reason) => renders.push(reason),
    factories: { fills: fake('fills'), lines: fake('lines') },
  });
  const line = (lat, extra) => ({
    positions: [
      [0, lat],
      [1, lat],
    ],
    color: [1, 0, 0, 1],
    widthPx: 9,
    ...extra,
  });
  const pulse = { periodMs: 1600, min: 0.35, max: 0.75 };
  const set = part.ground.createSet({ id: 'heat', kind: 'corridor' });
  set.replace([
    line(0),
    line(1, { glow: { power: 0.25 }, pulse }),
    line(2, { glow: { power: 0.25 }, pulse }),
    line(3, { glow: { power: 0.25 }, pulse, color: [1, 1, 1, 1] }),
    line(4, { dash: { cells: 64, duty: 0.46, speed: 0.55 } }),
  ]);
  set.commit();
  // The plain line batch, then one per look and colour.
  assert.deepEqual(
    made.map(({ type }) => type),
    ['lines', 'lines', 'lines', 'lines'],
  );
  const [plain, red, white, dashed] = made;
  assert.ok(plain.options.appearance instanceof Cesium.PolylineColorAppearance);
  assert.equal(red.options.geometryInstances.length, 2);
  assert.deepEqual(
    red.options.geometryInstances.map(({ id }) => id.instance),
    [1, 2],
  );
  const material = red.options.appearance.material;
  assert.equal(material.type, 'GevGroundCorridor');
  assert.equal(material.uniforms.glowPower, 0.25);
  assert.ok(Math.abs(material.uniforms.pulsePeriod - 1.6) < 1e-9);
  assert.equal(material.uniforms.dashCells, 0, 'no dash');
  assert.equal(white.options.appearance.material.uniforms.color.green, 1);
  assert.equal(dashed.options.appearance.material.uniforms.dashCells, 64);
  assert.equal(dashed.options.appearance.material.uniforms.glowPower, 0);
  // Before every frame the materials read the time; after it, a frame more.
  const before = performance.now() / 1000;
  viewer.scene.preRender.raiseEvent();
  assert.ok(material.uniforms.time >= before);
  renders.length = 0;
  viewer.scene.postRender.raiseEvent();
  assert.ok(renders.includes('ground-animate'));
  set.show(false);
  renders.length = 0;
  viewer.scene.postRender.raiseEvent();
  assert.ok(!renders.includes('ground-animate'), 'none while hidden');
  set.show(true);
  set.destroy();
  renders.length = 0;
  viewer.scene.postRender.raiseEvent();
  assert.ok(!renders.includes('ground-animate'), 'none once destroyed');
  part.destroy();
});
