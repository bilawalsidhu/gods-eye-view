import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clipTileRing,
  militaryOutlineLines,
  mergeMilitaryFragments,
} from './militaryTileGeometry.js';
const ring = (w, s, e, n) => [
  [w, s],
  [e, s],
  [e, n],
  [w, n],
  [w, s],
];
const record = (id, footprint, extra = {}) => ({
  id,
  featureKey: id,
  footprint,
  sources: [{ name: 'OpenStreetMap', id }],
  ...extra,
});
test('tile cores discard buffers and their artificial outline edges', () => {
  const box = { west: 0, east: 1, south: 0, north: 1 };
  const clipped = clipTileRing(ring(-1, 0.2, 2, 0.8), box);
  assert.deepEqual(militaryOutlineLines(clipped, box), [
    [
      [0, 0.2],
      [1, 0.2],
    ],
    [
      [1, 0.8],
      [0, 0.8],
    ],
  ]);
});
test('touching parcels and tile fragments merge with weighted interior centroid and stable pan ids', () => {
  const aliases = new Map();
  const a = record('a', ring(0, 0, 1, 1)),
    b = record('b', ring(1, 0, 3, 1));
  const [first] = mergeMilitaryFragments([a, b], aliases);
  assert.equal(first.longitude, 1.5);
  assert.equal(first.latitude, 0.5);
  assert.equal(first.footprints.length, 2);
  const [pan] = mergeMilitaryFragments(
    [b, record('c', ring(3, 0, 4, 1))],
    aliases,
  );
  assert.equal(pan.id, first.id);
  assert.equal(
    mergeMilitaryFragments([a, record('far', ring(10, 10, 11, 11))]).length,
    2,
  );
});
test('centroid outside a concave footprint snaps inside instead of landing in the gap', () => {
  const r = [
    [0, 0],
    [3, 0],
    [3, 1],
    [1, 1],
    [1, 3],
    [0, 3],
    [0, 0],
  ];
  const [m] = mergeMilitaryFragments([record('u', r)]);
  assert.ok(m.longitude < 1 || m.latitude < 1);
});
test('holes remain holes and disconnected pieces of one mapped feature have one id', () => {
  const outer = ring(0, 0, 4, 4),
    hole = ring(1, 1, 3, 3);
  const a = record('a', outer, { rings: [outer, hole] });
  const [m] = mergeMilitaryFragments([a, record('a', ring(5, 0, 6, 1))]);
  assert.equal(m.footprints.length, 2);
  assert.equal(m.footprints[0].length, 2);
  assert.ok(
    !(m.longitude > 1 && m.longitude < 3 && m.latitude > 1 && m.latitude < 3),
  );
});

test('a pan that hides connecting parcels keeps one marker with its known installation id', () => {
  const aliases = new Map();
  const a = record('a', ring(0, 0, 1, 1));
  const bridge = record('bridge', ring(1, 0, 2, 1));
  const b = record('b', ring(2, 0, 3, 1));
  const [full] = mergeMilitaryFragments([a, bridge, b], aliases);
  const pan = mergeMilitaryFragments([a, b], aliases);
  assert.equal(pan.length, 1);
  assert.equal(pan[0].id, full.id);
  assert.equal(pan[0].footprints.length, 2);
});

test('joining known groups also updates aliases for their currently offscreen parcels', () => {
  const aliases = new Map();
  const a = record('a', ring(0, 0, 1, 1));
  const b = record('b', ring(2, 0, 3, 1));
  const c = record('c', ring(3, 0, 4, 1));
  assert.equal(mergeMilitaryFragments([a, b, c], aliases).length, 2);
  const [joined] = mergeMilitaryFragments(
    [a, record('bridge', ring(1, 0, 2, 1)), b],
    aliases,
  );
  assert.equal(aliases.get('unknown:c'), joined.id);
  const pan = mergeMilitaryFragments([a, c], aliases);
  assert.equal(pan.length, 1);
  assert.equal(pan[0].id, joined.id);
});

test('quantization gaps within a tile stay separate; coarse identities do not fuse detailed sites', () => {
  const aliases = new Map();
  const a = record('a', ring(0, 0, 1, 1), { tileZoom: 10, tileEpsilon: 0.1 });
  const b = record('b', ring(1.05, 0, 2, 1), {
    tileZoom: 10,
    tileEpsilon: 0.1,
  });
  assert.equal(mergeMilitaryFragments([a, b], aliases).length, 2);
  mergeMilitaryFragments([a, { ...b, footprint: ring(1, 0, 2, 1) }], aliases);
  const detail = mergeMilitaryFragments(
    [
      { ...a, tileZoom: 14 },
      { ...b, tileZoom: 14 },
    ],
    aliases,
  );
  assert.equal(detail.length, 2);
  assert.notEqual(detail[0].id, detail[1].id);
  const left = { ...a, tileBounds: { west: 0, east: 1, south: 0, north: 1 } };
  const right = {
    ...b,
    footprint: ring(1, 0.05, 2, 1),
    tileBounds: { west: 1, east: 2, south: 0, north: 1 },
  };
  assert.equal(mergeMilitaryFragments([left, right]).length, 1);
});
