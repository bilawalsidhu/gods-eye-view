import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  createIconSet,
  DirtyRows,
  ICON_CULL_HEIGHT_M,
  ICON_CULL_LIFT,
  ICON_ROTATES,
  ICON_SHOWN,
} from './iconSet.js';
import {
  writeArcSegment,
  writeCourseGlide,
  writeHoldSegment,
} from './iconSegment.js';

function place(set, id, lon, course = 0) {
  const row = set.add(id, { id });
  writeHoldSegment(
    set.segments,
    row,
    Cesium.Cartesian3.fromDegrees(lon, 10, 1000),
    course,
  );
  set.segmentWritten(row);
  return row;
}

function settle(set) {
  for (const rows of Object.values(set.dirty)) rows.clear();
}

test('rows are added once per id and carry their meta', () => {
  const set = createIconSet({ capacity: 4 });
  assert.equal(set.add('a', 1), 0);
  assert.equal(set.add('b', 2), 1);
  assert.equal(set.add('a', 3), 0, 'same id, same row');
  assert.equal(set.metaAt(0), 3);
  assert.equal(set.count, 2);
  assert.equal(set.row('missing'), -1);
});

test('a new row starts hidden, unscaled, opaque white and unfocused', () => {
  const set = createIconSet();
  const row = set.add('a');
  assert.equal(set.shown(row), false);
  assert.equal(set.scale(row), 1);
  assert.equal(set.alpha(row), 1);
  assert.equal(set.focus(row), 1);
  assert.ok(Cesium.Color.equals(set.color(row), Cesium.Color.WHITE));
});

test('removing a row moves the last row into its place with all its columns', () => {
  const set = createIconSet({ capacity: 4 });
  place(set, 'a', 1);
  place(set, 'b', 2);
  const c = place(set, 'c', 3, 120);
  set.setShown(c, true);
  set.setFlag(c, ICON_ROTATES, true);
  set.setSize(c, 20, 24);
  set.setScale(c, 1.3);
  set.setColor(c, Cesium.Color.fromCssColorString('#FFB800'));
  set.setHandle(c, 'handle-c');
  settle(set);

  assert.ok(set.remove('a'));
  assert.equal(set.count, 2);
  assert.equal(set.row('c'), 0);
  assert.equal(set.idAt(0), 'c');
  assert.deepEqual(set.metaAt(0), { id: 'c' });
  assert.equal(set.handleAt(0), 'handle-c');
  assert.equal(set.flags(0), ICON_SHOWN | ICON_ROTATES);
  assert.equal(set.width(0), 20);
  assert.equal(set.height(0), 24);
  assert.ok(Math.abs(set.scale(0) - 1.3) < 1e-6);
  assert.deepEqual([...set.colors.subarray(0, 4)], [255, 184, 0, 255]);
  const at = set.position(0, 0);
  assert.ok(
    Cesium.Cartesian3.distance(at, Cesium.Cartesian3.fromDegrees(3, 10, 1000)) <
      0.01,
  );
  assert.equal(set.course(0, 0), 120);
  assert.equal(
    set.dirty.segments.runs(set.count)[0][0],
    0,
    'the moved row uploads',
  );
  assert.equal(set.remove('a'), false);
});

test('removing the last row moves nothing', () => {
  const set = createIconSet();
  place(set, 'a', 1);
  place(set, 'b', 2);
  settle(set);
  set.remove('b');
  assert.equal(set.count, 1);
  assert.ok(set.dirty.segments.empty);
});

test('a released row hands its renderer handle back', () => {
  const set = createIconSet();
  const released = [];
  set.onRelease = (handle) => released.push(handle);
  set.setHandle(set.add('a'), 'ha');
  set.setHandle(set.add('b'), 'hb');
  set.remove('a');
  set.clear();
  assert.deepEqual(released, ['ha', 'hb']);
  assert.equal(set.count, 0);
  assert.equal(set.has('b'), false);
});

test('unchanged writes leave the columns clean', () => {
  const set = createIconSet();
  const row = set.add('a');
  set.setSize(row, 20, 20);
  set.setScale(row, 0.8);
  set.setShown(row, true);
  set.setColor(row, Cesium.Color.CYAN);
  set.setScaleByDistance(row, new Cesium.NearFarScalar(1000, 3, 8e6, 0.5));
  settle(set);
  set.setSize(row, 20, 20);
  set.setScale(row, 0.8);
  set.setShown(row, true);
  set.setColor(row, Cesium.Color.CYAN);
  set.setScaleByDistance(row, new Cesium.NearFarScalar(1000, 3, 8e6, 0.5));
  assert.ok(set.dirty.style.empty);
  assert.ok(set.dirty.colors.empty);
  set.setScale(row, 0.9);
  assert.deepEqual(set.dirty.style.runs(set.count), [[0, 0]]);
});

test('the set grows past its capacity and keeps every row', () => {
  const set = createIconSet({ capacity: 2 });
  for (let i = 0; i < 5; i++) place(set, `r${i}`, i, i * 10);
  assert.equal(set.count, 5);
  assert.ok(set.capacity >= 5);
  assert.equal(set.generation, 2);
  for (let i = 0; i < 5; i++)
    assert.equal(set.course(set.row(`r${i}`), 0), i * 10);
});

test('times are seconds since the epoch', () => {
  const epoch = Cesium.JulianDate.fromIso8601('2026-11-03T12:00:00Z');
  const set = createIconSet({ epoch });
  assert.equal(
    set.seconds(
      Cesium.JulianDate.addSeconds(epoch, 42.5, new Cesium.JulianDate()),
    ),
    42.5,
  );
});

test('dirty rows go out as coalesced runs, or whole when most rows changed', () => {
  const rows = new DirtyRows(1000);
  for (const row of [900, 3, 5, 40, 901, 3]) rows.mark(row);
  assert.deepEqual(rows.runs(1000), [
    [3, 5],
    [40, 40],
    [900, 901],
  ]);
  assert.deepEqual(rows.runs(1000, 64), [
    [3, 40],
    [900, 901],
  ]);
  assert.deepEqual(
    rows.runs(500),
    [
      [3, 5],
      [40, 40],
    ],
    'rows past the count are dropped',
  );
  rows.clear();
  assert.ok(rows.empty);
  for (let row = 0; row < 300; row++) rows.mark(row * 3);
  assert.deepEqual(rows.runs(1000), [[0, 999]]);
});

test('a new row has no image until one is set', () => {
  const set = createIconSet();
  const row = set.add('a');
  assert.equal(set.imageFar(row), -1);
  assert.equal(set.imageNear(row), -1);
  set.setImage(row, 3, 4);
  assert.equal(set.imageNear(row), 4);
});

test('a set of capacity zero still grows', () => {
  const set = createIconSet({ capacity: 0 });
  set.add('a');
  set.add('b');
  assert.equal(set.count, 2);
});

test('rebasing moves the epoch without moving any row', () => {
  const epoch = Cesium.JulianDate.fromIso8601('2026-11-03T12:00:00Z');
  const set = createIconSet({ epoch });
  const fix = Cesium.Cartesian3.fromDegrees(-97, 33, 10_000);
  const row = set.add('a');
  writeArcSegment(set.segments, row, {
    fix,
    t0: 5000,
    minDt: 0,
    maxDt: 300,
    speedMps: 240,
    trackDeg: 80,
    turnRateDps: 2,
  });
  writeCourseGlide(set.segments, row, 30, 5000, 20);
  set.segmentWritten(row, 5100);
  const tau = 5060;
  const before = set.position(row, tau);
  const courseBefore = set.course(row, tau);
  settle(set);

  const later = (s) =>
    Cesium.JulianDate.addSeconds(epoch, s, new Cesium.JulianDate());
  assert.equal(set.rebase(later(1000)), false, 'under half an hour: stays');
  assert.equal(set.rebase(later(4000)), true);
  assert.equal(set.seconds(later(4000)), 0);
  const after = set.position(row, tau - 4000);
  assert.ok(Cesium.Cartesian3.distance(before, after) < 0.01);
  assert.ok(Math.abs(set.course(row, tau - 4000) - courseBefore) < 1e-3);
  assert.equal(set.expires(row), 1100);
  assert.deepEqual(set.dirty.segments.runs(set.count), [[0, 0]]);
});

test('a cull-lift row is judged at no lower than the cull height above the ellipsoid', () => {
  const set = createIconSet();
  const row = set.add('a');
  const height = (p) => Cesium.Cartographic.fromCartesian(p).height;
  const at = (h) => Cesium.Cartesian3.fromDegrees(-84.43, 33.64, h);
  assert.ok(
    Math.abs(height(set.cullPoint(row, at(-31))) - -31) < 1e-6,
    'unflagged: as drawn',
  );
  set.setFlag(row, ICON_CULL_LIFT, true);
  for (const h of [-31, 0, 5]) {
    assert.ok(
      Math.abs(height(set.cullPoint(row, at(h))) - ICON_CULL_HEIGHT_M) < 0.01,
      `${h} m is judged at ${ICON_CULL_HEIGHT_M} m`,
    );
  }
  assert.ok(
    Math.abs(height(set.cullPoint(row, at(131))) - 131) < 1e-6,
    'a contact floored higher keeps its own height',
  );
});
