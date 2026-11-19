import test from 'node:test';
import assert from 'node:assert/strict';
import { createImportedDrawing } from './geoImportPins.js';
import { bindFakeGroundRenderer } from '../testSupport/fakeGroundRenderer.mjs';
import { toLonLatH } from '../geo/ellipsoid.js';

const FEATURES = [
  {
    kind: 'pin',
    name: 'tower',
    lon: 1,
    lat: 2,
    height: 0,
    mode: 'absolute',
    image: 'blob:icon',
    size: [32, 32],
    scale: 1.5,
    color: [1, 0, 0, 1],
    course: 90,
    pixelOffset: { x: 0, y: -16 },
    scaleByDistance: { near: 1, nearValue: 1, far: 2, farValue: 0.1 },
    offsetScalesByDistance: true,
  },
  { kind: 'pin', lon: 3, lat: 4, height: 0, mode: 'clamp', image: null },
  {
    kind: 'line',
    name: 'walk',
    coords: [
      [1, 2, 50],
      [3, 4, 50],
    ],
    mode: 'draped',
    color: [1, 1, 0, 1],
    width: 6,
  },
  {
    kind: 'polygon',
    rings: [
      [
        [0, 0, 200],
        [1, 0, 200],
        [1, 1, 200],
      ],
    ],
    clamp: false,
    extrude: true,
    fill: [1, 0, 0, 0.8],
    outline: [0, 0, 0, 1],
    outlineWidth: 2,
  },
  {
    kind: 'wall',
    coords: [
      [1, 2, 150],
      [3, 4, 150],
    ],
    fill: [0, 1, 0, 0.5],
    outline: [0, 1, 0, 1],
  },
  {
    kind: 'overlay',
    rect: { west: 0, south: 0, east: 1, north: 1 },
    rotation: 0.3,
    image: 'blob:overlay',
  },
];

/** A drawing of `features` on a renderer double. */
function drawn(features = FEATURES) {
  const viewer = {};
  const ground = bindFakeGroundRenderer(viewer);
  const drawing = createImportedDrawing(viewer, features);
  drawing.mount();
  const items = (kind) => [
    ...ground.draw.set(drawing.ids[kind]).items.values(),
  ];
  return { ground, drawing, items };
}

test('pins draw as icons with the look their file gave them', (t) => {
  const { ground, drawing, items } = drawn();
  t.after(ground.unbind);
  const [pin, ...others] = items('icons');
  assert.deepEqual(drawing.items().icons, [pin], 'what it hands the set');
  assert.equal(others.length, 0, 'a pin with no icon draws nothing');
  assert.deepEqual(pin.pos, { lon: 1, lat: 2, height: 0 });
  assert.equal(pin.height, 'absolute');
  assert.deepEqual(
    [pin.image, pin.size, pin.scale, pin.color],
    ['blob:icon', [32, 32], 1.5, [1, 0, 0, 1]],
  );
  // As Cesium's KML icon: turned by its heading from the Earth's axis.
  assert.deepEqual(
    [pin.rotationMode, pin.alignedAxis, pin.rotation],
    ['axis', { x: 0, y: 0, z: 1 }, -Math.PI / 2],
  );
  assert.deepEqual(pin.pixelOffset, { x: 0, y: -16 });
  assert.equal(pin.offsetScalesByDistance, true);
  assert.equal(pin.scaleByDistance.farValue, 0.1);
  assert.equal(pin.disableDepthTest, undefined, 'at its own height');
  assert.deepEqual(pin.meta, { name: 'tower' });
});

test('paths, polygons, walls and overlays draw as lines and shapes', (t) => {
  const { ground, items } = drawn();
  t.after(ground.unbind);
  const [line] = items('lines');
  assert.equal(line.mode, 'draped');
  assert.equal(line.widthPx, 6);
  assert.deepEqual(line.style, { kind: 'solid', color: [1, 1, 0, 1] });
  assert.ok(
    line.positions.every((p) => Math.abs(toLonLatH(p).height) < 1e-6),
    'draped from the surface',
  );
  const [polygon, wall, overlay] = items('shapes');
  assert.equal(polygon.geometry.perPositionHeight, true);
  assert.equal(polygon.extrudeHeight, 0, 'down to the ellipsoid');
  assert.deepEqual(polygon.outline, [0, 0, 0, 1]);
  assert.equal(polygon.outlineWidth, 2);
  assert.equal(polygon.lit, true);
  assert.equal(polygon.height, undefined);
  assert.equal(wall.geometry.kind, 'wall');
  assert.deepEqual(wall.geometry.positions[0], { lon: 1, lat: 2, height: 150 });
  assert.equal(overlay.geometry.kind, 'rectangle');
  assert.equal(overlay.geometry.rotation, 0.3);
  assert.deepEqual(overlay.fill, { image: 'blob:overlay' });
  assert.equal(overlay.height, 'clampGround');
});

test('destroying a file takes its sets with it', (t) => {
  const { ground, drawing } = drawn();
  t.after(ground.unbind);
  drawing.destroy();
  assert.equal(ground.liveSets().length, 0);
  assert.deepEqual(drawing.items(), { icons: [], lines: [], shapes: [] });
});

test('hiding a file hides its sets', (t) => {
  const { ground, drawing } = drawn();
  t.after(ground.unbind);
  drawing.show = false;
  for (const id of Object.values(drawing.ids))
    assert.equal(ground.draw.set(id).show, false);
  drawing.show = true;

  assert.equal(ground.draw.set(drawing.ids.icons).show, true);
});

test('a ground pin on the bare ellipsoid stands at 0, not on its sagging tiles', async (t) => {
  const pin = { kind: 'pin', lon: 1, lat: 2, height: 0, mode: 'clamp' };
  for (const [source, sag, expected] of [
    ['ellipsoid', -46000, 0],
    ['ellipsoid', -500, 0],
    ['terrain', -30, -30],
    ['terrain', -4000, -4000],
  ]) {
    const { ground, drawing } = drawn([
      { ...pin, image: 'blob:icon' },
      { ...pin, lon: 3, image: 'blob:icon' },
    ]);
    t.after(ground.unbind);
    ground.globe.terrain = () => sag;
    const probes = [];
    ground.renderer.query.sampleHeight = async (points) => {
      probes.push(points);
      return points.map(() => ({ height: 0, source }));
    };
    await drawing.refreshGround();
    assert.deepEqual(
      drawing.items().icons.map((i) => i.pos.height),
      [expected, expected],
      `${source} ${sag}`,
    );
    assert.equal(probes.length, 2, 'asked once for the file, both ways');
    assert.deepEqual(probes[0], [{ lon: 1, lat: 2 }]);
    drawing.destroy();
  }
});

test('the ellipsoid is asked about once for each surface', async (t) => {
  const pin = { kind: 'pin', lon: 1, lat: 2, height: 0, mode: 'clamp' };
  const { ground, drawing } = drawn([{ ...pin, image: 'blob:icon' }]);
  t.after(ground.unbind);
  let version = 1;
  ground.renderer.globe.surfaceVersion = () => version;
  ground.globe.terrain = () => -30;
  let asked = 0;
  ground.renderer.query.sampleHeight = async (points) => {
    asked += 1;
    return points.map(() => ({ height: -30, source: 'terrain' }));
  };
  await drawing.refreshGround();
  await drawing.refreshGround();
  assert.equal(asked, 2, 'one probe, both ways, for the first surface');
  version = 2;
  await drawing.refreshGround();
  assert.equal(asked, 4, 'and again for the next');
  assert.equal(drawing.items().icons[0].pos.height, -30);
});

test('nothing draws after destroy, and an overlay without bounds draws nowhere', async (t) => {
  const { ground, drawing } = drawn([
    { kind: 'pin', lon: 1, lat: 2, height: 0, mode: 'clamp', image: 'b' },
    { kind: 'overlay', rect: null, color: [1, 1, 1, 1] },
  ]);
  t.after(ground.unbind);
  assert.equal(ground.draw.set(drawing.ids.shapes), undefined, 'no shapes');
  assert.equal(drawing.points().length, 1, 'framed by its pin alone');
  const pending = drawing.refreshGround();
  drawing.destroy();
  await pending;
  drawing.mount();
  await drawing.refreshGround();
  assert.equal(ground.liveSets().length, 0);
  assert.deepEqual(drawing.items(), { icons: [], lines: [], shapes: [] });
});

test('a turned overlay across the antimeridian frames there', (t) => {
  const { ground, drawing } = drawn([
    {
      kind: 'overlay',
      rect: { west: 179, south: -1, east: -179, north: 1 },
      rotation: Math.PI / 4,
      color: [1, 1, 1, 1],
    },
  ]);
  t.after(ground.unbind);
  const points = drawing.points();
  assert.equal(points.length, 4);
  for (const [lon, lat] of points) {
    assert.ok(Math.abs(lat) < 2, `latitude ${lat}`);
    assert.ok(Math.abs(lon) > 178 && Math.abs(lon) <= 180, `longitude ${lon}`);
  }
});
