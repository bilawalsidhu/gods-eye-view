import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { normalizeGroundItem } from '../ground.js';
import { createCesiumGround, groundInstances } from './ground.js';
import { createFakeViewer } from './testing/fakeViewer.mjs';

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
