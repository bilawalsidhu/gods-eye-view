import { installDomClasses } from '../../testSupport/domClasses.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { normalizeGroundItem } from '../ground.js';
import { createCesiumGround, groundInstances } from './ground.js';
import { createFakeViewer } from './testing/fakeViewer.mjs';

// Cesium's Material types its uniforms against the browser's image and
// canvas classes; Node has none of them.
installDomClasses();

const items = (kind, list) =>
  list.map((item, index) => normalizeGroundItem(kind, item, index));

test('reveal and dynamic sets wait for height bounds, draw the latest path and cancel on release', async (t) => {
  const viewer = createFakeViewer();
  viewer.scene.groundPrimitives = new Cesium.PrimitiveCollection();
  let resolve;
  let loads = 0;
  t.mock.method(Cesium.GroundPrimitive, 'initializeTerrainHeights', () => {
    loads++;
    return new Promise((done) => {
      resolve = done;
    });
  });
  const part = createCesiumGround(viewer, {
    factories: {
      lines: (options) => ({
        ...options,
        ready: false,
        destroy() {},
        isDestroyed: () => false,
      }),
    },
  });
  t.after(() => part.destroy());
  const reveal = part.ground.createSet({
    id: 'reveal',
    kind: 'corridor',
    reveal: true,
  });
  const cancelled = part.ground.createSet({
    id: 'cancelled',
    kind: 'corridor',
    dynamic: true,
  });
  const path = (lon) => [
    {
      positions: [
        [0, 0],
        [lon, 1],
      ],
      color: [0, 1, 1, 1],
      widthPx: 3,
    },
  ];
  reveal.replace(path(1));
  reveal.commit();
  cancelled.replace(path(1));
  cancelled.commit();
  assert.equal(loads, 1, 'sets share the pending height bounds');
  assert.equal(reveal.ready(), false);
  reveal.replace(path(2));
  reveal.commit();
  reveal.setReveal(0.25);
  cancelled.destroy();
  resolve();
  await Promise.resolve();
  const root = viewer.scene.groundPrimitives.get(0);
  assert.equal(
    root.length,
    1,
    'released set does not return when bounds arrive',
  );
  const primitive = root.get(0).get(0);
  assert.equal(primitive.asynchronous, false);
  assert.equal(primitive.appearance.material.uniforms.reveal, 0.25);
  const end = primitive.geometryInstances[0].geometry._positions.at(-1);
  assert.ok(
    Math.abs(
      Cesium.Math.toDegrees(Cesium.Cartographic.fromCartesian(end).longitude) -
        2,
    ) < 1e-9,
  );
});

for (const kind of ['disc', 'corridor']) {
  test(`${kind} material readiness includes the globe depth after a camera move`, () => {
    const viewer = createFakeViewer();
    viewer.scene.groundPrimitives = new Cesium.PrimitiveCollection();
    viewer.scene.globe.tilesLoaded = false;
    const made = [];
    const make = (options) => {
      const primitive = {
        ...options,
        ready: true,
        destroy() {},
        isDestroyed: () => false,
      };
      made.push(primitive);
      return primitive;
    };
    const renders = [];
    const port = createCesiumGround(viewer, {
      requestRender: (reason) => renders.push(reason),
      factories: { fills: make, lines: make },
    });
    const set = port.ground.createSet({
      id: kind,
      kind,
      ...(kind === 'corridor' ? { reveal: true } : {}),
    });
    assert.equal(set.ready(), true, 'an empty set needs no surface');
    set.replace([
      kind === 'disc'
        ? {
            center: [20, 10],
            radiusM: 40000,
            fill: [0, 1, 1, 1],
            radial: {
              fillAlpha: 0.105,
              rimAlpha: 0.72,
              rimStart: 0.952,
              rimEnd: 0.985,
              emission: 0.35,
            },
          }
        : {
            positions: [
              [19.7, 10],
              [20.3, 10],
            ],
            color: [1, 0, 1, 1],
            widthPx: 12,
          },
    ]);
    set.commit();
    if (kind === 'corridor') set.setReveal(0.25);
    const material = made[0].appearance.material;
    assert.equal(set.ready(), false, 'built geometry needs a loaded surface');
    viewer.scene.postRender.raiseEvent();
    assert.ok(renders.includes('ground-build'));
    viewer.scene.globe.tilesLoaded = true;
    viewer.scene.postRender.raiseEvent();
    assert.equal(set.ready(), true);
    assert.ok(renders.includes('ground-ready'));
    renders.length = 0;
    viewer.scene.postRender.raiseEvent();
    assert.deepEqual(
      renders,
      [],
      'a ready static material stops requesting frames',
    );
    viewer.scene.globe.tilesLoaded = false;
    assert.equal(set.ready(), false, 'camera changes can load another surface');
    viewer.scene.globe.tilesLoaded = true;
    assert.equal(set.ready(), true);
    assert.equal(made.length, 1, 'surface loading never rebuilds geometry');
    assert.equal(made[0].appearance.material, material);
    if (kind === 'corridor') assert.equal(material.uniforms.reveal, 0.25);
    else {
      assert.equal(material.uniforms.rimAlpha, 0.72);
      assert.equal(material.uniforms.fillAlpha, 0.105);
    }
    port.destroy();
    assert.equal(viewer.scene.postRender.numberOfListeners, 0);
  });
}

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
  assert.equal(shapes.fills[0].geometry._semiMajorAxis, 500);
  const cells = groundInstances(
    { id: 'cells', kind: 'cell' },
    items('cell', [
      { west: 0, south: 0, east: 1, north: 1, fill: [1, 0, 0, 1] },
    ]),
  );
  assert.ok(cells.fills[0].geometry instanceof Cesium.RectangleGeometry);
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

test('corridor reveal mutates the live material and retains it through a geometry commit', () => {
  const viewer = createFakeViewer();
  viewer.scene.groundPrimitives = new Cesium.PrimitiveCollection();
  const built = [];
  const make = (options) => {
    const primitive = {
      ...options,
      ready: true,
      destroy() {},
      isDestroyed: () => false,
    };
    built.push(primitive);
    return primitive;
  };
  const port = createCesiumGround(viewer, {
    factories: { lines: make, fills: make },
  });
  const set = port.ground.createSet({
    id: 'head',
    kind: 'corridor',
    reveal: true,
  });
  const items = [
    {
      positions: [
        [20, 10],
        [20.001, 10],
      ],
      widthPx: 5,
      color: [0, 1, 0, 0.8],
    },
  ];
  set.replace(items);
  set.commit();
  const geometry = built[0].geometryInstances;
  set.setReveal(0.25);
  set.setReveal(0.5);
  assert.equal(built.length, 1);
  assert.equal(built[0].geometryInstances, geometry);
  assert.equal(built[0].appearance.material.uniforms.reveal, 0.5);
  set.replace(items);
  set.commit();
  assert.equal(built[1].appearance.material.uniforms.reveal, 0.5);
  port.destroy();
});

test('non-pickable ground fills skip pick commands and retain normal drawing', (t) => {
  const viewer = createFakeViewer();
  viewer.scene.groundPrimitives = new Cesium.PrimitiveCollection();
  const port = createCesiumGround(viewer);
  const set = port.ground.createSet({
    id: 'cells',
    kind: 'cell',
    pickable: false,
  });
  set.replace([{ west: 0, south: 0, east: 1, north: 1, fill: [1, 0, 0, 1] }]);
  set.commit();
  const fill = viewer.scene.groundPrimitives.get(0).get(0).get(0);
  assert.ok(fill instanceof Cesium.GroundPrimitive);
  let updates = 0;
  t.mock.method(Cesium.GroundPrimitive.prototype, 'update', () => updates++);
  fill.update({ passes: { pick: true } });
  assert.equal(updates, 0);
  fill.update({ passes: { render: true, pick: false } });
  assert.equal(updates, 1);
  port.destroy();
  assert.equal(fill.isDestroyed(), true);
});

test('hidden unready ground stops build frames and resumes when shown', () => {
  const viewer = createFakeViewer();
  viewer.scene.groundPrimitives = new Cesium.PrimitiveCollection();
  const requests = [];
  const primitive = () => ({
    ready: false,
    destroy() {},
    isDestroyed: () => false,
  });
  const part = createCesiumGround(viewer, {
    factories: { fills: primitive, lines: primitive },
    requestRender: (why) => requests.push(why),
  });
  const set = part.ground.createSet({ id: 'hidden', kind: 'disc' });
  set.replace([{ center: [0, 0], radiusM: 100, fill: [1, 0, 0, 1] }]);
  set.commit();
  set.show(false);
  requests.length = 0;
  viewer.scene.postRender.raiseEvent();
  assert.ok(!requests.includes('ground-build'));
  set.show(true);
  requests.length = 0;
  viewer.scene.postRender.raiseEvent();
  assert.ok(requests.includes('ground-build'));
  part.destroy();
});
