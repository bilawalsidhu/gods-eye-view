import test from 'node:test';
import assert from 'node:assert/strict';
import * as geo from '../geo/index.js';
import {
  cellRing,
  createGroundPicks,
  createGroundRegistry,
  discRing,
  normalizeGroundItem,
  normalizeGroundSetOptions,
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
    { id: 'zones', kind: 'cell', count: 1, shown: false, order: 2 },
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
