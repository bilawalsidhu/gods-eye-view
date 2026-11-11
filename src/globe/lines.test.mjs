import assert from 'node:assert/strict';
import test from 'node:test';
import * as geo from '../geo/index.js';
import {
  createLineRegistry,
  densifyGeodesic,
  flattenPositions,
  normalizeLineOptions,
  TACTICAL_DASH,
} from './lines.js';

test('line options get the contract defaults and refuse bad values', () => {
  const line = normalizeLineOptions({
    id: 'trail',
    widthPx: 2,
    color: [1, 0, 0, 1],
  });
  assert.equal(line.arc, 'none');
  assert.equal(line.depthFailAlpha, 0);
  assert.equal(line.dash, null);
  assert.equal(line.modelMatrix, null);
  const tactical = normalizeLineOptions({
    id: 'orbit',
    widthPx: 3,
    color: [0, 1, 1, 0.95],
    dash: 'tactical',
    arc: 'geodesic',
    depthFailAlpha: 0.3,
    modelMatrix: [...geo.matrix4.IDENTITY],
  });
  assert.deepEqual(tactical.dash, { kind: 'tactical', ...TACTICAL_DASH });
  const dashed = normalizeLineOptions({
    id: 'path',
    widthPx: 2,
    color: [1, 1, 1, 1],
    dash: { lengthPx: 16, gapPx: 8 },
  });
  assert.deepEqual(dashed.dash, { kind: 'pixels', lengthPx: 16, gapPx: 8 });
  for (const options of [
    {},
    { id: 'a', widthPx: 0, color: [1, 1, 1, 1] },
    { id: 'a', widthPx: 1, color: [1, 1, 1] },
    { id: 'a', widthPx: 1, color: [1, 1, 1, 1], arc: 'rhumb' },
    { id: 'a', widthPx: 1, color: [1, 1, 1, 1], depthFailAlpha: 2 },
    { id: 'a', widthPx: 1, color: [1, 1, 1, 1], dash: 'dotted' },
    { id: 'a', widthPx: 1, color: [1, 1, 1, 1], modelMatrix: [1, 2] },
  ])
    assert.throws(() => normalizeLineOptions(options), TypeError);
});

test('positions flatten from Cartesian3 lists or flat arrays', () => {
  assert.deepEqual(
    [
      ...flattenPositions([
        { x: 1, y: 2, z: 3 },
        { x: 4, y: 5, z: 6 },
      ]),
    ],
    [1, 2, 3, 4, 5, 6],
  );
  assert.deepEqual(
    [...flattenPositions(new Float64Array([1, 2, 3]))],
    [1, 2, 3],
  );
  assert.throws(() => flattenPositions([{ x: 1, y: 2 }]), TypeError);
  assert.throws(() => flattenPositions(new Float64Array([1, 2])), TypeError);
});

test('geodesic densification follows the great circle with interpolated height', () => {
  const a = geo.cartesian3.fromDegrees(0, 0, 1000);
  const b = geo.cartesian3.fromDegrees(10, 0, 3000);
  const flat = densifyGeodesic(flattenPositions([a, b]), Math.PI / 180);
  const count = flat.length / 3;
  assert.equal(count, 11, 'one point per degree');
  for (let index = 0; index < count; index++) {
    const point = geo.cartographic.fromCartesian(
      geo.cartesian3.create(
        flat[index * 3],
        flat[index * 3 + 1],
        flat[index * 3 + 2],
      ),
    );
    assert.ok(Math.abs(geo.math.toDegrees(point.latitude)) < 1e-9);
    assert.ok(Math.abs(geo.math.toDegrees(point.longitude) - index) < 1e-6);
    assert.ok(Math.abs(point.height - (1000 + 200 * index)) < 1e-3);
  }
});

test('the registry builds engine lines, lists them and refuses duplicates', () => {
  const calls = [];
  const { lines, destroyAll } = createLineRegistry((options) => ({
    setPositions: (flat) => calls.push(['positions', options.id, flat.length]),
    setColor: (rgba) => calls.push(['color', rgba]),
    setModelMatrix: (m) => calls.push(['matrix', m.length]),
    show: (visible) => calls.push(['show', visible]),
    destroy: () => calls.push(['destroy', options.id]),
  }));
  const line = lines.createLine({ id: 't', widthPx: 2, color: [1, 1, 1, 1] });
  line.setPositions([
    { x: 1, y: 2, z: 3 },
    { x: 4, y: 5, z: 6 },
  ]);
  line.setColor([0, 0, 0, 1]);
  line.setModelMatrix([...geo.matrix4.IDENTITY]);
  line.show(false);
  assert.deepEqual(lines.list(), [{ id: 't', points: 2, shown: false }]);
  assert.throws(
    () => lines.createLine({ id: 't', widthPx: 1, color: [1, 1, 1, 1] }),
    /already/,
  );
  assert.throws(() => line.setColor([1, 1]), TypeError);
  destroyAll();
  assert.deepEqual(lines.list(), []);
  assert.deepEqual(calls.at(-1), ['destroy', 't']);
  assert.throws(() => line.show(true), /destroyed/);
});

test('the tactical dash is the launches mission-orbit pattern', async () => {
  const policy = await import('../layers/launches/policy.js');
  assert.deepEqual(TACTICAL_DASH, {
    groups: policy.MISSION_ORBIT_PATTERN_GROUPS,
    dashes: policy.MISSION_ORBIT_DASHES_PER_GROUP,
  });
});

test('segment batches copy endpoints and styles, commit atomically and share line ids', () => {
  const draws = [];
  let destroyed = 0;
  const registry = createLineRegistry(() => ({
    setSegments: (items) => draws.push(items),
    show() {},
    destroy() {
      destroyed++;
    },
  }));
  const options = { id: 'stems', widthPx: 3.5, color: [1, 0, 0, 0.5] };
  const batch = registry.lines.createSegments(options);
  assert.throws(() => registry.lines.createLine(options), /already exists/);
  assert.throws(() => registry.lines.createSegments(options), /already exists/);
  const positions = new Float64Array([1, 2, 3, 4, 5, 6]);
  const color = [0, 1, 0, 1];
  batch.replace([{ positions, color, widthPx: 2, pickId: 'first' }]);
  positions[0] = 99;
  color[0] = 1;
  assert.equal(draws.length, 0);
  for (const item of [
    { positions: new Float64Array([1, 2, 3]) },
    { positions, widthPx: 0 },
    { positions, color: [1, 2] },
  ])
    assert.throws(() => batch.replace([item]), TypeError);
  batch.commit();
  assert.equal(draws[0][0].positions[0], 1);
  assert.deepEqual(draws[0][0].color, [0, 1, 0, 1]);
  assert.equal(draws[0][0].widthPx, 2);
  batch.commit();
  assert.equal(draws.length, 1, 'clean commit does not rebuild');
  batch.show(false);
  batch.replace([]);
  batch.commit();
  assert.deepEqual(registry.lines.list(), [
    { id: 'stems', points: 0, shown: false, pickIds: [] },
  ]);
  registry.destroyAll();
  batch.destroy();
  assert.equal(destroyed, 1);
  assert.throws(() => batch.commit(), /destroyed/);
  assert.throws(() => batch.replace([]), /destroyed/);
  assert.throws(() => batch.show(true), /destroyed/);
  assert.deepEqual(registry.lines.list(), []);
});
