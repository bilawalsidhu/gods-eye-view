import test from 'node:test';
import assert from 'node:assert/strict';
import { planImport } from './geoImportPlan.js';
import { emptyRecords } from './geoImportRecords.js';
import * as limits from './geoImportLimits.js';

const ring = [
  [0, 0, 100],
  [1, 0, 100],
  [1, 1, 100],
  [0, 1, 100],
];
const polygon = (options = {}) => ({
  rings: [ring],
  fill: [1, 0, 0, 1],
  outline: { color: [0, 1, 0, 1], widthPx: 5 },
  raised: true,
  ...options,
});
const overlay = (options = {}) => ({
  url: 'local-image',
  color: [1, 1, 1, 1],
  rectangle: { west: 0, south: 0, east: 2, north: 1 },
  rotation: 0,
  drawOrder: 0,
  ...options,
});

for (const [name, record, ceilings, counts] of [
  [
    'ground fill without outline',
    polygon({ raised: false }),
    {},
    [1, 0, 0, 1, 0],
  ],
  ['raised fill and outline', polygon(), {}, [0, 1, 1, 1, 0]],
  [
    'open ring at vertex limit',
    polygon(),
    { MAX_RAISED_VERTICES: ring.length },
    [0, 1, 1, 1, 0],
  ],
  [
    'closed ring at vertex limit',
    polygon({ rings: [[...ring, ring[0]]] }),
    { MAX_RAISED_VERTICES: ring.length },
    [0, 1, 1, 1, 0],
  ],
  ['outline only', polygon({ fill: null }), {}, [0, 1, 0, 1, 0]],
  [
    'vertex limit keeps outline',
    polygon(),
    { MAX_RAISED_VERTICES: 3 },
    [0, 1, 0, 1, 1],
  ],
  [
    'ring limit skips polygon',
    polygon(),
    { MAX_RAISED_RINGS: 0 },
    [0, 0, 0, 0, 1],
  ],
  [
    'short hole is skipped',
    polygon({
      rings: [
        ring,
        [
          [0.2, 0.2],
          [0.3, 0.2],
        ],
      ],
    }),
    {},
    [0, 1, 1, 1, 0],
  ],
  [
    'short outer never promotes hole',
    polygon({
      rings: [
        [
          [0, 0],
          [1, 0],
        ],
        ring,
      ],
      outline: null,
    }),
    {},
    [0, 0, 0, 0, 0],
  ],
])
  test(name, () => {
    const records = { ...emptyRecords(), polygons: [record] };
    const before = structuredClone(records);
    const plan = planImport(records, ceilings);
    assert.deepEqual(
      [
        plan.ground.length,
        plan.lines.length,
        plan.meshes.length,
        plan.report.drawn,
        plan.report.undrawn,
      ],
      counts,
    );
    assert.deepEqual(records, before);
    if (plan.lines.length) assert.equal(plan.lines[0].widthPx, 1);
  });

for (const [name, record, drawable] of [
  ['unturned image', overlay(), true],
  ['full turn', overlay({ rotation: 360 }), true],
  ['turn past 360', overlay({ rotation: 405 }), true],
  [
    'across antimeridian',
    overlay({
      rectangle: { west: 179, south: -1, east: -179, north: 1 },
      rotation: 30,
    }),
    true,
  ],
  [
    'near pole',
    overlay({
      rectangle: { west: 0, south: 85, east: 2, north: 86 },
      rotation: 30,
    }),
    true,
  ],
  [
    'past pole',
    overlay({
      rectangle: { west: 0, south: 88, east: 20, north: 90 },
      rotation: 45,
    }),
    false,
  ],
  [
    'all longitudes tinted',
    overlay({
      rectangle: { west: -180, south: -1, east: 180, north: 1 },
      color: [0.5, 1, 1, 1],
    }),
    true,
  ],
])
  test(name, () => {
    const plan = planImport({ ...emptyRecords(), overlays: [record] });
    assert.equal(plan.overlays.length, Number(drawable));
    assert.equal(plan.report.undrawn, Number(!drawable));
    if (drawable) assert.equal(plan.overlays[0].order, limits.OVERLAY_ORDER);
  });

test('altitudes, look grouping and budgets are planned without decoding images', () => {
  const icon = { image: { url: 'pin' }, color: [1, 1, 1, 1] };
  const records = {
    ...emptyRecords(),
    points: ['ground', 'relative', 'absolute'].map((altitude) => ({
      position: [2, 3, 40],
      altitude,
      icon,
    })),
    overlays: Array.from({ length: 9 }, (_, i) =>
      overlay({
        drawOrder: 9 - i,
        rotation: 30,
        color: [i / 9, 1, 1, 0.8],
      }),
    ),
  };
  const context = {
    images: new Map([
      ['pin', { width: 1000, height: 1000 }],
      ['local-image', { width: 8192, height: 8192 }],
    ]),
  };
  const plan = planImport(records, undefined, context);
  assert.deepEqual(
    plan.pins.map((p) => p.depth),
    ['always', 'normal'],
  );
  assert.deepEqual(
    plan.pins.flatMap((p) => p.pins.map((pin) => [pin.height, pin.offset])),
    [
      [null, 0],
      [null, 40],
      [40, 0],
    ],
  );
  assert.deepEqual(
    plan.overlays.map((o) => o.record.drawOrder),
    [1, 2, 3, 4, 5, 6, 7, 8, 9],
  );
  assert.ok(
    plan.overlays.reduce(
      (sum, o) => sum + o.canvas.width * o.canvas.height,
      0,
    ) <= limits.OVERLAY_PIXEL_BUDGET,
  );
  assert.ok(plan.pins.every((look) => look.maxSide <= limits.MAX_ICON_SIDE));
  assert.equal(plan.report.drawn, 12);
  assert.deepEqual(plan.images, []);
});

test('decode failures retain the untransformed layer and report unsupported raised images', () => {
  const records = {
    ...emptyRecords(),
    points: [
      {
        position: [0, 0],
        altitude: 'ground',
        icon: { image: { url: 'missing' } },
      },
    ],
    overlays: [
      overlay({ url: 'missing', rotation: 30 }),
      overlay({ url: 'missing', altitudeMode: 'absolute', altitude: 100 }),
    ],
  };
  const plan = planImport(records, undefined, {
    images: new Map([['missing', null]]),
  });
  assert.equal(plan.pins[0].draw, false);
  assert.equal(plan.overlays[0].canvas, null);
  assert.deepEqual(plan.overlays[0].rectangle, records.overlays[0].rectangle);
  assert.deepEqual(plan.report, {
    drawn: 1,
    undrawn: 1,
    kinds: { raisedOverlay: 1 },
  });
  assert.deepEqual(
    plan.undrawn.map((item) => item.reason),
    ['raisedOverlay', 'icon'],
  );
});

for (const [altitudeMode, altitude, url, expectedHeight] of [
  ['absolute', -100, 'local-image', -100],
  ['absolute', 200, 'local-image', 200],
  ['relative', 200, 'local-image', null],
  ['ground', 200, 'local-image', null],
  ['absolute', 200, null, 200],
])
  test(`overlay altitude ${altitudeMode} ${altitude}, image ${Boolean(url)}`, async () => {
    const { cartographic } = await import('../geo/index.js');
    const record = overlay({ altitudeMode, altitude, url, rotation: 30 });
    const plan = planImport({ ...emptyRecords(), overlays: [record] });
    assert.equal(plan.report.drawn, 1);
    assert.equal(plan.report.undrawn, 0);
    assert.equal(plan.meshes.length, Number(expectedHeight !== null));
    if (expectedHeight !== null) {
      const positions = plan.meshes[0].positions;
      for (let i = 0; i < positions.length; i += 3) {
        const height = cartographic.fromCartesian({
          x: positions[i],
          y: positions[i + 1],
          z: positions[i + 2],
        }).height;
        assert.ok(Math.abs(height - expectedHeight) < 0.001);
      }
    }
  });

test('equal overlay orders retain document order', () => {
  const a = overlay({ name: 'a', drawOrder: 3 });
  const b = overlay({ name: 'b', drawOrder: -1 });
  const c = overlay({ name: 'c', drawOrder: 3 });
  const plan = planImport({ ...emptyRecords(), overlays: [a, b, c] });
  assert.deepEqual(
    plan.overlays.map((item) => item.record.name),
    ['b', 'a', 'c'],
  );
});
