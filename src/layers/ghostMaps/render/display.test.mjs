// The GhostMaps display on the globe contract, on the fake engine and on the
// Cesium engine over a stub scene: KML polygons, lines and placemarks keep
// the styles the Cesium entities had (colours, alphas, widths, scales and
// order), picks name the report part, a report drops in place, placemarks
// beyond the horizon hide, and teardown leaves nothing drawn.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import * as geo from '../../../geo/index.js';
import { createFakeEngine } from '../../../globe/testing/fakeEngine.js';
import { createFakeEventHandlers } from '../../../globe/cesium/testing/fakeViewer.mjs';
import { createCesiumMoversEngine } from '../../../testSupport/cesiumMoversEngine.mjs';
import { rgbaFromCss } from '../../shared/color.js';
import { createGhostMapsDisplay } from './display.js';

const PRODUCT = '#ff5a36';
const product = rgbaFromCss(PRODUCT);
const near = (actual, expected, label) =>
  assert.ok(
    actual.length === expected.length &&
      actual.every((value, index) => Math.abs(value - expected[index]) < 1e-6),
    `${label}: ${[...actual]} vs ${expected}`,
  );

// Records what the display hands each ground set, on any engine.
function recordGround(engine) {
  const sets = new Map();
  const createSet = engine.ground.createSet.bind(engine.ground);
  engine.ground.createSet = (options) => {
    const set = createSet(options);
    const entry = { options, items: [] };
    sets.set(options.id, entry);
    const replace = set.replace.bind(set);
    set.replace = (items) => {
      entry.items = items;
      replace(items);
    };
    return set;
  };
  return sets;
}

function fakeHarness() {
  const engine = createFakeEngine();
  return {
    name: 'the fake engine',
    engine,
    frame: () => engine.fake.frame(),
    click(picked) {
      engine.fake.script('pick', picked);
      engine.fake.input('click', { position: { x: 100, y: 100 } });
    },
    pin(id, index) {
      const { store, options } = engine.fake.moverSet(id);
      return {
        shown: index < store.count && store.shows[index] === 1,
        color: [...store.colors.slice(index * 4, index * 4 + 4)],
        sizePx: options.sprite.sizePx * store.scales[index],
        id: store.pickIds[index],
      };
    },
    count: (id) => engine.fake.moverSet(id).store.count,
  };
}

// Cesium's ground primitives as built, without a WebGL context: the
// options (instances, appearance, classification) the engine hands them.
const groundFactory = (type) => (options) => ({
  type,
  ...options,
  ready: true,
  destroy() {},
  isDestroyed: () => false,
});

function cesiumHarness() {
  const handlers = createFakeEventHandlers();
  const { engine, viewer, frame, primitive } = createCesiumMoversEngine({
    engineOptions: {
      createEventHandler: handlers.create,
      scheduleFrame: (run) => run(),
      groundFactories: {
        fills: groundFactory('fills'),
        lines: groundFactory('lines'),
      },
    },
  });
  // The stub scene has no ground collection of its own.
  viewer.scene.groundPrimitives = new Cesium.PrimitiveCollection();
  let native;
  viewer.scene.pick = () => native;
  viewer.scene.drillPick = () => (native ? [native] : []);
  return {
    name: 'the Cesium engine',
    cesium: true,
    engine,
    viewer,
    frame,
    click(picked) {
      native = !picked
        ? undefined
        : picked.ground
          ? { id: { gevGroundSet: picked.owner, instance: picked.instance } }
          : { primitive: primitive(picked.owner).get(picked.instance) };
      for (const handler of handlers.handlers)
        handler.fire(Cesium.ScreenSpaceEventType.LEFT_CLICK, {
          position: new Cesium.Cartesian2(100, 100),
        });
    },
    pin(id, index) {
      const item = primitive(id).get(index);
      const count = engine.movers.list().find((set) => set.id === id).count;
      return {
        shown: index < count && item.show,
        color: [
          item.color.red,
          item.color.green,
          item.color.blue,
          item.color.alpha,
        ],
        sizePx: item.width * item.scale,
        id: item.id,
      };
    },
    count: (id) => engine.movers.list().find((set) => set.id === id).count,
    // The ground primitives Cesium builds for a set.
    groundPrimitives(id) {
      const found = [];
      const visit = (collection) => {
        for (let index = 0; index < collection.length; index++) {
          const child = collection.get(index);
          if (child.gevGroundSet === id) found.push(child);
          else if (child instanceof Cesium.PrimitiveCollection) visit(child);
        }
      };
      visit(viewer.scene.groundPrimitives);
      return found;
    },
  };
}

const HARNESSES = [fakeHarness, cesiumHarness];

// Seams for Node: decoded icons by URL and a canvas that records draws.
function iconSeams(sizes = {}) {
  const draws = [];
  return {
    draws,
    loadImage: async (url) => {
      if (url === 'blob:broken') throw new Error('decode failed');
      const side = sizes[url] ?? 20;
      return { naturalWidth: side, naturalHeight: side };
    },
    createCanvas: () => ({
      width: 0,
      height: 0,
      getContext: () => ({ drawImage: (...args) => draws.push(args) }),
    }),
  };
}

const square = (lon, lat, size = 1) => [
  [lon, lat],
  [lon + size, lat],
  [lon + size, lat + size],
  [lon, lat + size],
];

/** Reports at the view centre (0°, 0°): a pin, a line, polygons. */
function features() {
  return new Map([
    [
      0,
      {
        style: { icon: 'blob:icon-0', iconScale: 1, iconColor: [1, 0, 0, 0.5] },
        geometries: [{ type: 'point', position: [0, 0, 120] }],
      },
    ],
    [
      1,
      {
        style: { lineWidth: 12, lineColor: [0, 1, 0, 0.75] },
        geometries: [
          {
            type: 'line',
            positions: [
              [-1, 0],
              [1, 0],
            ],
          },
          // A placemark without its own icon takes the product marker.
          { type: 'point', position: [0.5, 0.5] },
        ],
      },
    ],
    [
      2,
      {
        style: { lineWidth: 1 },
        geometries: [
          { type: 'polygon', outer: square(-0.5, -0.5), holes: [] },
          {
            type: 'polygon',
            outer: square(2, 2, 2),
            holes: [square(2.5, 2.5)],
          },
        ],
      },
    ],
    [
      3,
      {
        style: {
          fill: false,
          outline: false,
          polyColor: [0, 0, 1, 0.6],
          iconScale: 4,
        },
        geometries: [
          { type: 'polygon', outer: square(5, 5), holes: [] },
          { type: 'point', position: [5, 5] },
        ],
      },
    ],
    [
      4,
      {
        style: { polyColor: [0, 0, 1, 0.6], lineWidth: 9 },
        geometries: [{ type: 'polygon', outer: square(8, 8), holes: [] }],
      },
    ],
  ]);
}

const markerImage = (color) => `data:marker-${color}`;

async function drawn(harness, { sizes, list = features() } = {}) {
  const ground = recordGround(harness.engine);
  const seams = iconSeams(sizes);
  harness.engine.camera.setView({
    destination: geo.cartesian3.fromDegrees(0, 0, 1e7),
  });
  const display = createGhostMapsDisplay(harness.engine, seams);
  const paint = display.draw('kinetic-30d', list, PRODUCT, markerImage);
  await paint.ready;
  const prefix = 's2-ghostmaps:kinetic-30d:1';
  return {
    display,
    paint,
    ground,
    seams,
    polygons: () => ground.get(`${prefix}:polygons`),
    lines: () => ground.get(`${prefix}:lines`),
    pins: `${prefix}:pins`,
  };
}

for (const makeHarness of HARNESSES) {
  test(`polygons, lines and placemarks keep the Cesium styles (${makeHarness().name})`, async () => {
    const harness = makeHarness();
    const { polygons, lines, pins, display } = await drawn(harness, {
      sizes: { 'blob:icon-0': 32 },
    });
    const productAt = (alpha) => [
      product.red,
      product.green,
      product.blue,
      alpha,
    ];

    // Polygons: under the lines, pickable; the product colour at 0.25 or the
    // KML colour with its own alpha; outlines clamped to 1.5..6 px.
    assert.equal(polygons().options.kind, 'polygon');
    assert.equal(polygons().options.order, 0);
    assert.equal(polygons().options.pickable, true);
    const areas = polygons().items;
    assert.deepEqual(
      areas.map(({ pickId }) => pickId),
      [
        'ghostmaps:kinetic-30d:2:0',
        'ghostmaps:kinetic-30d:2:1',
        'ghostmaps:kinetic-30d:2:1:outline',
        'ghostmaps:kinetic-30d:3:0',
        'ghostmaps:kinetic-30d:4:0',
      ],
    );
    near(areas[0].fill, productAt(0.25), 'product fill');
    near(areas[0].outline.color, productAt(1), 'product outline');
    assert.equal(areas[0].outline.widthPx, 1.5);
    // With holes, the fill keeps them and the outline runs on the outer
    // ring only.
    assert.equal(areas[1].rings.length, 2);
    assert.equal(areas[1].outline, undefined);
    assert.equal(areas[2].rings.length, 1);
    assert.equal(areas[2].fill, undefined);
    assert.equal(areas[2].outline.widthPx, 1.5);
    // fill: false stays clickable, drawn transparent; outline: false has none.
    near(areas[3].fill, [0, 0, 0, 0], 'no fill');
    assert.equal(areas[3].outline, undefined);
    near(areas[4].fill, [0, 0, 1, 0.6], 'KML fill');
    assert.equal(areas[4].outline.widthPx, 6);

    // Lines: ground corridors over the polygons, clamped to 1.5..8 px.
    assert.equal(lines().options.kind, 'corridor');
    assert.equal(lines().options.order, 1);
    assert.equal(lines().options.pickable, true);
    assert.equal(lines().items.length, 1);
    assert.equal(lines().items[0].widthPx, 8);
    near(lines().items[0].color, [0, 1, 0, 0.75], 'KML line colour');
    assert.equal(lines().items[0].pickId, 'ghostmaps:kinetic-30d:1:0');

    // Placemarks: over the scene, at the icon's own size times the KML
    // scale at 0.7 (0.35..1.5); the KML colour only on the report's own icon.
    assert.equal(harness.count(pins), 3);
    const own = harness.pin(pins, 0);
    assert.equal(own.id, 'ghostmaps:kinetic-30d:0:0');
    near(own.color, [1, 0, 0, 0.5], 'icon colour');
    assert.ok(Math.abs(own.sizePx - 32 * 0.7) < 1e-6, `${own.sizePx}`);
    const marker = harness.pin(pins, 1);
    assert.equal(marker.id, 'ghostmaps:kinetic-30d:1:1');
    near(marker.color, [1, 1, 1, 1], 'marker untinted');
    assert.ok(Math.abs(marker.sizePx - 20 * 0.7) < 1e-6);
    const big = harness.pin(pins, 2);
    assert.ok(Math.abs(big.sizePx - 20 * 1.5) < 1e-6, 'scale capped at 1.5');
    const set = harness.engine.movers.list().find(({ id }) => id === pins);
    assert.equal(set.kind, 'sprite');
    if (harness.cesium) {
      // The per-instance colours and widths Cesium batches.
      const [fills, outlines] = harness.groundPrimitives(polygons().options.id);
      assert.deepEqual(
        [fills.type, outlines.type],
        ['fills', 'lines'],
        'one fill and one outline batch',
      );
      assert.equal(fills.classificationType, Cesium.ClassificationType.BOTH);
      assert.equal(fills.allowPicking, true);
      const colour = fills.geometryInstances[0].attributes.color.value;
      assert.deepEqual([...colour], [255, 90, 54, 64]);
      assert.equal(outlines.geometryInstances[0].geometry.width, 1.5);
      const [corridors] = harness.groundPrimitives(lines().options.id);
      assert.equal(corridors.geometryInstances[0].geometry.width, 8);
    } else {
      const { options } = harness.engine.fake.moverSet(pins);
      assert.equal(options.depthTest, 'always');
      assert.equal(options.pickable, true);
    }
    display.destroy();
  });

  test(`a click picks the report part under it (${makeHarness().name})`, async () => {
    const harness = makeHarness();
    const { display, polygons, pins } = await drawn(harness);
    const seen = [];
    const remove = display.onClick((click, pick) =>
      seen.push({ position: click.position, picked: pick() }),
    );
    harness.click({
      ground: true,
      owner: polygons().options.id,
      instance: 2,
      id: 'ghostmaps:kinetic-30d:2:1:outline',
    });
    harness.click({
      owner: pins,
      instance: 1,
      id: 'ghostmaps:kinetic-30d:1:1',
    });
    harness.click(undefined);
    assert.deepEqual(
      seen.map(({ picked }) => picked?.id),
      [
        'ghostmaps:kinetic-30d:2:1:outline',
        'ghostmaps:kinetic-30d:1:1',
        undefined,
      ],
    );
    assert.ok(seen.every(({ position }) => position));
    remove();
    harness.click(undefined);
    assert.equal(seen.length, 3, 'removed listener hears nothing');
    display.destroy();
  });

  test(`drop takes one report off in place; destroy leaves nothing (${makeHarness().name})`, async () => {
    const harness = makeHarness();
    const { display, paint, polygons, lines, pins } = await drawn(harness);
    const other = display.draw(
      'cip',
      new Map([
        [
          0,
          {
            style: {},
            geometries: [{ type: 'polygon', outer: square(0, 0), holes: [] }],
          },
        ],
      ]),
      '#c8ff00',
      markerImage,
    );
    await other.ready;
    assert.equal(paint.drop(1), true);
    assert.equal(lines().items.length, 0, "the report's line goes");
    assert.equal(harness.count(pins), 2, 'and its placemark');
    assert.deepEqual(
      [0, 1].map((index) => harness.pin(pins, index).id),
      ['ghostmaps:kinetic-30d:0:0', 'ghostmaps:kinetic-30d:3:1'],
    );
    assert.equal(paint.drop(2), true);
    assert.deepEqual(
      polygons().items.map(({ pickId }) => pickId),
      ['ghostmaps:kinetic-30d:3:0', 'ghostmaps:kinetic-30d:4:0'],
      'every polygon and outline of the report goes',
    );
    const committed = (id) =>
      harness.engine.ground.list().find((set) => set.id === id).count;
    assert.equal(committed(polygons().options.id), 2);
    assert.equal(paint.drop(9), true, 'an unknown report changes nothing');
    paint.destroy();
    assert.deepEqual(
      harness.engine.ground.list().map(({ id }) => id),
      ['s2-ghostmaps:cip:2:polygons', 's2-ghostmaps:cip:2:lines'],
      'the other edition stays',
    );
    assert.equal(
      harness.engine.movers.list().some(({ id }) => id === pins),
      false,
    );
    other.destroy();
    display.destroy();
    assert.deepEqual(harness.engine.ground.list(), []);
    assert.deepEqual(harness.engine.movers.list(), []);
  });

  test(`placemarks beyond the horizon hide and come back with the camera (${makeHarness().name})`, async () => {
    const harness = makeHarness();
    const list = new Map([
      [0, { style: {}, geometries: [{ type: 'point', position: [0, 0] }] }],
      [1, { style: {}, geometries: [{ type: 'point', position: [180, 0] }] }],
    ]);
    const { display, pins } = await drawn(harness, { list });
    assert.deepEqual(
      [0, 1].map((index) => harness.pin(pins, index).shown),
      [true, false],
    );
    harness.engine.camera.setView({
      destination: geo.cartesian3.fromDegrees(180, 0, 1e7),
    });
    harness.frame();
    assert.deepEqual(
      [0, 1].map((index) => harness.pin(pins, index).shown),
      [false, true],
    );
    display.destroy();
  });

  test(`icons that do not decode and degenerate shapes draw nothing (${makeHarness().name})`, async () => {
    const harness = makeHarness();
    const list = new Map([
      [
        0,
        {
          style: { icon: 'blob:broken' },
          geometries: [
            { type: 'point', position: [0, 0] },
            {
              type: 'polygon',
              outer: [
                [0, 0],
                [0, 0],
                [0, 0],
              ],
              holes: [],
            },
            { type: 'line', positions: [[1, 1]] },
          ],
        },
      ],
      [1, { style: {}, geometries: [{ type: 'point', position: [0, 0] }] }],
    ]);
    const { display, pins, polygons, lines, seams } = await drawn(harness, {
      list,
    });
    assert.equal(harness.count(pins), 1);
    assert.equal(harness.pin(pins, 0).id, 'ghostmaps:kinetic-30d:1:0');
    assert.equal(seams.draws.length, 1, 'one icon in the atlas');
    assert.deepEqual(polygons().items, []);
    assert.deepEqual(lines().items, []);
    display.destroy();
  });
}

test('an edition destroyed while its icons decode draws no placemarks', async () => {
  const engine = createFakeEngine();
  const pending = [];
  const release = () =>
    pending.forEach((resolve) =>
      resolve({ naturalWidth: 20, naturalHeight: 20 }),
    );
  const display = createGhostMapsDisplay(engine, {
    ...iconSeams(),
    loadImage: () => new Promise((resolve) => pending.push(resolve)),
  });
  const paint = display.draw('cip', features(), PRODUCT, markerImage);
  paint.destroy();
  release();
  await paint.ready;
  assert.deepEqual(engine.movers.list(), []);
  assert.deepEqual(engine.ground.list(), []);
  display.destroy();
  assert.throws(
    () => display.draw('cip', features(), PRODUCT, markerImage),
    /destroyed/,
  );
});
