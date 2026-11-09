import test from 'node:test';
import assert from 'node:assert/strict';
import * as geo from '../geo/index.js';
import {
  animates,
  cellRing,
  createGroundPicks,
  createGroundRegistry,
  discRing,
  normalizeGroundItem,
  normalizeGroundSetOptions,
  pulseFactor,
} from './ground.js';

test('set options are checked and defaulted', () => {
  assert.deepEqual(normalizeGroundSetOptions({ id: 'a', kind: 'disc' }), {
    id: 'a',
    kind: 'disc',
    order: 0,
    pickable: false,
    drape: 'both',
  });
  for (const bad of [
    null,
    { kind: 'disc' },
    { id: 'a', kind: 'line' },
    { id: 'a', kind: 'disc', order: Infinity },
    { id: 'a', kind: 'disc', pickable: 1 },
    { id: 'a', kind: 'disc', drape: 'water' },
  ])
    assert.throws(() => normalizeGroundSetOptions(bad), TypeError);
});

test('polygon rings drop their closing copy and stay in one piece across the antimeridian', () => {
  const item = normalizeGroundItem('polygon', {
    rings: [
      [
        [179, 0],
        [-179, 0],
        [-179, 1],
        [179, 1],
        [179, 0],
      ],
      [
        [-179.8, 0.2],
        [179.8, 0.2],
        [179.8, 0.8],
      ],
    ],
    fill: [1, 0, 0, 0.5],
    pickId: 'p',
  });
  assert.deepEqual([...item.rings[0]], [179, 0, 181, 0, 181, 1, 179, 1]);
  // The hole in the outer ring's longitudes.
  assert.deepEqual([...item.rings[1]], [180.2, 0.2, 179.8, 0.2, 179.8, 0.8]);
  assert.deepEqual(item.bounds, { west: 179, south: 0, east: 181, north: 1 });
  assert.equal(item.pickId, 'p');
  assert.equal(item.outline, null);
});

test('items of every kind are checked', () => {
  const disc = normalizeGroundItem('disc', {
    center: [20, 60],
    radiusM: 1000,
    outline: { color: [1, 1, 1, 1], widthPx: 2 },
  });
  assert.equal(disc.fill, null);
  assert.equal(disc.outline.widthPx, 2);
  assert.ok(
    disc.bounds.east - disc.bounds.west >
      2 * (disc.bounds.north - disc.bounds.south) * 0.99,
  );
  const cell = normalizeGroundItem('cell', {
    west: 179,
    south: 0,
    east: -179,
    north: 1,
  });
  assert.equal(cell.bounds.east, 181);
  const corridor = normalizeGroundItem('corridor', {
    positions: [
      [0, 0],
      [1, 0],
    ],
    color: [1, 1, 1, 1],
    widthM: 30,
  });
  assert.equal(corridor.widthM, 30);
  assert.equal(corridor.widthPx, undefined);
  for (const [kind, bad] of [
    ['polygon', { rings: [] }],
    [
      'polygon',
      {
        rings: [
          [
            [0, 0],
            [1, 0],
            [0, 0],
          ],
        ],
      },
    ],
    [
      'polygon',
      {
        rings: [
          [
            [0, 0],
            [1, 0],
            [1, 95],
          ],
        ],
      },
    ],
    ['disc', { center: [0, 0], radiusM: 0 }],
    ['disc', { center: [0, 0], radiusM: 1, outline: { color: [1, 1, 1, 1] } }],
    ['cell', { west: 0, south: 1, east: 1, north: 0 }],
    ['corridor', { positions: [[0, 0]], color: [1, 1, 1, 1], widthPx: 2 }],
    [
      'corridor',
      {
        positions: [
          [0, 0],
          [1, 1],
        ],
        color: [1, 1, 1, 1],
      },
    ],
    [
      'corridor',
      {
        positions: [
          [0, 0],
          [1, 1],
        ],
        color: [1, 1, 1, 1],
        widthPx: 1,
        widthM: 1,
      },
    ],
  ])
    assert.throws(() => normalizeGroundItem(kind, bad), TypeError, kind);
});

test('a disc ring lies at its radius; a cell ring follows its parallels', () => {
  const ring = discRing({ center: [55, 25], radiusM: 10_000 }, 32);
  assert.equal(ring.length, 64);
  const centre = geo.cartesian3.fromDegrees(55, 25);
  for (let index = 0; index < ring.length; index += 2) {
    const distance = geo.cartesian3.distance(
      centre,
      geo.cartesian3.fromDegrees(ring[index], ring[index + 1]),
    );
    assert.ok(Math.abs(distance - 10_000) < 15, `${distance}`);
  }
  const cell = normalizeGroundItem('cell', {
    west: 0,
    south: 10,
    east: 1,
    north: 11,
  });
  const flat = cellRing(cell, 0.25);
  assert.equal(flat.length / 2, 10);
  assert.deepEqual([...flat.slice(0, 4)], [0, 10, 0.25, 10]);
});

test('the registry stores on replace, draws on commit, lists, shows and destroys', () => {
  const calls = [];
  const { ground, destroyAll } = createGroundRegistry((options) => ({
    commit: (items) => calls.push(['commit', options.id, items.length]),
    show: (visible) => calls.push(['show', options.id, visible]),
    destroy: () => calls.push(['destroy', options.id]),
  }));
  const set = ground.createSet({ id: 'zones', kind: 'cell', order: 2 });
  assert.throws(
    () => ground.createSet({ id: 'zones', kind: 'cell' }),
    /exists/,
  );
  set.replace([{ west: 0, south: 0, east: 1, north: 1, fill: [1, 0, 0, 1] }]);
  assert.equal(set.count(), 0);
  assert.throws(() => set.replace([{ west: 0 }]), TypeError);
  set.commit();
  assert.equal(set.count(), 1);
  set.show(false);
  assert.deepEqual(ground.list(), [
    {
      id: 'zones',
      kind: 'cell',
      count: 1,
      shown: false,
      order: 2,
      animated: false,
    },
  ]);
  assert.equal(set.ready(), true);
  destroyAll();
  assert.deepEqual(ground.list(), []);
  assert.equal(set.ready(), false);
  assert.throws(() => set.commit(), /destroyed/);
  assert.deepEqual(calls, [
    ['commit', 'zones', 1],
    ['show', 'zones', false],
    ['destroy', 'zones'],
  ]);
});

test("a pixel corridor's glow, pulse and dash are checked and defaulted", () => {
  const line = (extra) => ({
    positions: [
      [0, 0],
      [1, 0],
    ],
    color: [1, 0, 0, 1],
    widthPx: 9,
    ...extra,
  });
  const item = normalizeGroundItem(
    'corridor',
    line({
      glow: { power: 0.25 },
      pulse: { periodMs: 1600, min: 0.35, max: 0.75 },
      dash: { cells: 64, duty: 0.46 },
    }),
  );
  assert.deepEqual(item.animation, {
    glow: { power: 0.25, taper: 1 },
    pulse: { periodMs: 1600, min: 0.35, max: 0.75 },
    dash: { cells: 64, duty: 0.46, speed: 0, gapAlpha: 0, emission: 0 },
  });
  assert.ok(Object.isFrozen(item.animation.dash));
  assert.equal(animates(item), true);
  assert.equal(
    animates(normalizeGroundItem('corridor', line({ glow: { power: 0.1 } }))),
    false,
    'a glow alone is still',
  );
  const patterned = normalizeGroundItem(
    'corridor',
    line({ dashPattern: { lengthPx: 18 } }),
  );
  assert.deepEqual(patterned.animation, {
    pattern: { lengthPx: 18, pattern: 255 },
  });
  assert.equal(
    animates(patterned),
    false,
    'a screen-space pattern does not keep rendering',
  );
  for (const extra of [
    { dashPattern: { lengthPx: 0 } },
    { dashPattern: { lengthPx: 18, pattern: 65536 } },
    { dashPattern: { lengthPx: 18, pattern: 1.5 } },
    { dashPattern: { lengthPx: 18 }, glow: { power: 0.2 } },
    { dashPattern: { lengthPx: 18 }, widthPx: undefined, widthM: 20 },
  ])
    assert.throws(
      () => normalizeGroundItem('corridor', line(extra)),
      TypeError,
    );
  assert.equal(normalizeGroundItem('corridor', line()).animation, null);
  for (const extra of [
    { glow: { power: 0.6 } },
    { glow: { power: 0.2, taper: 0 } },
    { pulse: { periodMs: -1, min: 0, max: 1 } },
    { pulse: { periodMs: 100, min: 0.5, max: 0.4 } },
    { pulse: { periodMs: 100, min: 0, max: 2 } },
    { dash: { cells: 0, duty: 0.5 } },
    { dash: { cells: 4, duty: 0 } },
    { dash: { cells: 4, duty: 0.5, gapAlpha: 2 } },
    { dash: { cells: 4, duty: 0.5, emission: -1 } },
    { dash: 'on' },
  ])
    assert.throws(
      () => normalizeGroundItem('corridor', line(extra)),
      TypeError,
      JSON.stringify(extra),
    );
  assert.throws(
    () =>
      normalizeGroundItem('corridor', {
        ...line({ pulse: { periodMs: 100, min: 0, max: 1 } }),
        widthPx: undefined,
        widthM: 10,
      }),
    /widthPx/,
  );
});

test('a pulse swings between its min and max', () => {
  const pulse = { periodMs: 2000, min: 0.2, max: 0.8 };
  assert.ok(Math.abs(pulseFactor(pulse, 0) - 0.5) < 1e-9);
  assert.ok(Math.abs(pulseFactor(pulse, 0.5) - 0.8) < 1e-9);
  assert.ok(Math.abs(pulseFactor(pulse, 1.5) - 0.2) < 1e-9);
});

test('the registry knows when a shown set animates', () => {
  const { ground, animating } = createGroundRegistry(() => ({
    commit() {},
    show() {},
    destroy() {},
  }));
  const set = ground.createSet({ id: 'route', kind: 'corridor' });
  set.replace([
    {
      positions: [
        [0, 0],
        [1, 0],
      ],
      color: [1, 1, 1, 1],
      widthPx: 9,
      dash: { cells: 8, duty: 0.5, speed: 1 },
    },
  ]);
  assert.equal(animating(), false, 'not before the commit');
  set.commit();
  assert.equal(animating(), true);
  assert.equal(ground.list()[0].animated, true);
  set.show(false);
  assert.equal(animating(), false, 'not while hidden');
  set.show(true);
  set.destroy();
  assert.equal(animating(), false, 'not once destroyed');
});

test('CPU picks find the item under the picked ground, on top first', () => {
  const states = [];
  const { ground, live } = createGroundRegistry(() => ({
    commit() {},
    show() {},
    destroy() {},
  }));
  const low = ground.createSet({ id: 'low', kind: 'cell', pickable: true });
  low.replace([
    { west: 0, south: 0, east: 2, north: 2, fill: [1, 0, 0, 1], pickId: 'a' },
    {
      west: 0.5,
      south: 0.5,
      east: 1.5,
      north: 1.5,
      fill: [1, 0, 0, 1],
      pickId: 'b',
    },
  ]);
  low.commit();
  const corridor = ground.createSet({
    id: 'roads',
    kind: 'corridor',
    pickable: true,
    order: 1,
  });
  corridor.replace([
    {
      positions: [
        [0, 3],
        [2, 3],
      ],
      color: [1, 1, 1, 1],
      widthM: 2000,
      pickId: 'road',
    },
  ]);
  corridor.commit();
  const quiet = ground.createSet({ id: 'quiet', kind: 'disc' });
  quiet.replace([
    { center: [1, 1], radiusM: 1e5, fill: [1, 1, 1, 1], pickId: 'q' },
  ]);
  quiet.commit();
  states.push(...live.values());
  let ground0 = geo.cartesian3.fromDegrees(1, 1);
  const picks = createGroundPicks({
    pickGlobe: () => ground0,
    camera: {
      livePosition: geo.cartesian3.fromDegrees(1, 1, 1e5),
      pose: () => ({ fovy: Math.PI / 3 }),
    },
    size: () => ({ width: 1000, height: 1000 }),
    sets: () => states,
  });
  const ids = () => picks({ x: 0, y: 0 }).map(({ result }) => result.id);
  assert.deepEqual(ids(), ['b', 'a'], 'the later item first; quiet left out');
  ground0 = geo.cartesian3.fromDegrees(0.2, 0.2);
  assert.deepEqual(ids(), ['a']);
  ground0 = geo.cartesian3.fromDegrees(1, 3.005);
  assert.deepEqual(ids(), ['road']);
  ground0 = geo.cartesian3.fromDegrees(1, 3.05);
  assert.deepEqual(ids(), []);
  const [hit] = picks({ x: 0, y: 0 }).concat(
    (ground0 = geo.cartesian3.fromDegrees(1, 1)) && picks({ x: 0, y: 0 }),
  );
  assert.equal(hit.onTop, -1, 'under every mover and line');
  assert.deepEqual(hit.result, { id: 'b', owner: 'low', instance: 1 });
  low.show(false);
  assert.deepEqual(ids(), []);
});

test('CPU picks skip a set draped only on the other surface', () => {
  const { ground, live } = createGroundRegistry(() => ({
    commit() {},
    show() {},
    destroy() {},
  }));
  for (const drape of ['terrain', 'tiles', 'both']) {
    const set = ground.createSet({
      id: drape,
      kind: 'disc',
      pickable: true,
      drape,
    });
    set.replace([
      { center: [1, 1], radiusM: 1e4, fill: [1, 1, 1, 1], pickId: drape },
    ]);
    set.commit();
  }
  let under = 'terrain';
  const picks = createGroundPicks({
    pickGlobe: () => geo.cartesian3.fromDegrees(1, 1),
    camera: {
      livePosition: geo.cartesian3.fromDegrees(1, 1, 1e5),
      pose: () => ({ fovy: Math.PI / 3 }),
    },
    size: () => ({ width: 1000, height: 1000 }),
    sets: () => [...live.values()],
    surface: () => under,
  });
  const ids = () =>
    picks({ x: 0, y: 0 })
      .map(({ result }) => result.id)
      .sort();
  assert.deepEqual(ids(), ['both', 'terrain']);
  under = 'tiles';
  assert.deepEqual(ids(), ['both', 'tiles']);
});

test('radial discs copy and validate their alpha envelope', () => {
  const radial = {
    fillAlpha: 0.105,
    rimAlpha: 0.72,
    rimStart: 0.952,
    rimEnd: 0.985,
    emission: 0.35,
  };
  const item = { center: [20, 10], radiusM: 100, fill: [0, 1, 1, 1], radial };
  const checked = normalizeGroundItem('disc', item);
  assert.deepEqual(checked.radial, radial);
  assert.notEqual(checked.radial, radial);
  for (const patch of [
    { fillAlpha: -1 },
    { rimAlpha: 2 },
    { rimStart: 0.99 },
    { rimEnd: 1 },
    { emission: NaN },
  ])
    assert.throws(
      () =>
        normalizeGroundItem('disc', {
          ...item,
          radial: { ...radial, ...patch },
        }),
      TypeError,
    );
  assert.throws(
    () => normalizeGroundItem('disc', { ...item, fill: null }),
    TypeError,
  );
  assert.throws(() => normalizeGroundItem('cell', item), TypeError);
});

test('pixel corridor backing keeps a wider edge and rejects invalid combinations', () => {
  const item = {
    positions: [
      [0, 0],
      [1, 1],
    ],
    widthPx: 3,
    color: [0, 1, 0, 0.8],
    backing: { widthPx: 5, color: [0.02, 0.03, 0.05, 0.8] },
  };
  assert.deepEqual(
    normalizeGroundItem('corridor', item).animation.backing,
    item.backing,
  );
  for (const backing of [
    { widthPx: 3, color: [0, 0, 0, 1] },
    { widthPx: 5, color: [0, 0, 0, 2] },
  ])
    assert.throws(
      () => normalizeGroundItem('corridor', { ...item, backing }),
      TypeError,
    );
  assert.throws(
    () =>
      normalizeGroundItem('corridor', {
        ...item,
        dashPattern: { lengthPx: 16 },
      }),
    TypeError,
  );
});
