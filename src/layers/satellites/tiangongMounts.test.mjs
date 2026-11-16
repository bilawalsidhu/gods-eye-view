// src/layers/satellites/tiangongMounts.test.mjs — the Cockpit's views from
// Tiangong: offered in order from the modules the catalog lists and the
// docked vehicle, each riding its own entry, placed on the model's axes.
import assert from 'node:assert/strict';
import test from 'node:test';
import { TIANGONG_NORAD } from './policy.js';
import {
  TIANGONG_MENGTIAN_NORAD,
  TIANGONG_MOUNT_ORDER,
  TIANGONG_MOUNTS,
  TIANGONG_WENTIAN_NORAD,
  tiangongCockpitMount,
  tiangongMountLabel,
  tiangongMountViews,
} from './tiangongMounts.js';

const summary = (views) =>
  views.map(({ key, label, noradId }) => ({ key, label, noradId }));

test('the station offers its views in order, Tianhe first', () => {
  assert.deepEqual(
    [...TIANGONG_MOUNT_ORDER],
    ['tianhe', 'wentian', 'mengtian', 'docked'],
  );
  for (const key of TIANGONG_MOUNT_ORDER) assert.ok(TIANGONG_MOUNTS[key]);
  assert.equal(
    new Set([TIANGONG_NORAD, TIANGONG_WENTIAN_NORAD, TIANGONG_MENGTIAN_NORAD])
      .size,
    3,
  );
  const views = tiangongMountViews({
    tianheName: 'CSS (TIANHE)',
    wentianName: 'CSS (WENTIAN)',
    mengtianName: 'CSS (MENGTIAN)',
    dockedName: 'SHENZHOU-23 (SZ-23)',
    tianheNorad: TIANGONG_NORAD,
    wentianNorad: TIANGONG_WENTIAN_NORAD,
    mengtianNorad: TIANGONG_MENGTIAN_NORAD,
    dockedNorad: 69180,
  });
  assert.deepEqual(summary(views), [
    { key: 'tianhe', label: 'TIANHE', noradId: TIANGONG_NORAD },
    { key: 'wentian', label: 'WENTIAN', noradId: TIANGONG_WENTIAN_NORAD },
    { key: 'mengtian', label: 'MENGTIAN', noradId: TIANGONG_MENGTIAN_NORAD },
    { key: 'docked', label: 'SHENZHOU-23 (SZ-23)', noradId: 69180 },
  ]);
  // Every view rides a catalog entry: no cards.
  assert.ok(views.every((view) => view.card === null));
  // No vehicle docked: no view from one. The modules are part of the model,
  // so they are offered even when the catalog has no entry for them.
  assert.deepEqual(summary(tiangongMountViews()), [
    { key: 'tianhe', label: 'TIANHE', noradId: null },
    { key: 'wentian', label: 'WENTIAN', noradId: null },
    { key: 'mengtian', label: 'MENGTIAN', noradId: null },
  ]);
});

test('the view is named after the entry, without the catalog’s "CSS (…)"', () => {
  assert.equal(tiangongMountLabel('CSS (WENTIAN)'), 'WENTIAN');
  assert.equal(tiangongMountLabel('TIANZHOU-10'), 'TIANZHOU-10');
  assert.equal(tiangongMountLabel(null), '');
});

test('every mount is outside the hull, with a usable view frame', () => {
  for (const key of TIANGONG_MOUNT_ORDER) {
    const { eye, forward, up } = TIANGONG_MOUNTS[key];
    // Tianhe and the labs are 4.2 m across: no eye inside them (2.1 m of an
    // axis), and none far from the station (the labs reach ~20 m out).
    const offAxis = Math.hypot(eye[0], eye[1]);
    const offLab = Math.hypot(eye[1], eye[2] - 6.4);
    assert.ok(offAxis > 2.1 || offLab > 2.1, `${key} sits inside a module`);
    assert.ok(Math.hypot(...eye) < 40, `${key} is off the station`);
    assert.ok(Math.hypot(...forward) > 0.9, `${key} looks somewhere`);
    assert.ok(Math.hypot(...up) > 0.9, `${key} has an up`);
    assert.ok(forward[1] < 0, `${key} looks down at the Earth`);
  }
});

test('the spec’s mount gives the view asked for in the world, else the first', () => {
  const centre = { x: 6_780_000, y: 0, z: 0 };
  // The model's axes in the world: port = +y, zenith = +x (away from the
  // Earth), forward = +z.
  const axes = { x: [0, 0, 1], y: [0, 1, 0], z: [1, 0, 0] };
  const names = new Map([
    [TIANGONG_NORAD, 'CSS (TIANHE)'],
    [TIANGONG_WENTIAN_NORAD, 'CSS (WENTIAN)'],
    [69180, 'SHENZHOU-23 (SZ-23)'],
  ]);
  const input = {
    centre,
    axes,
    name: (id) => names.get(id) ?? null,
    entry: (id) => (names.has(id) ? id : null),
    dockedVehicle: 69180,
  };
  const first = tiangongCockpitMount({ ...input, key: null });
  assert.equal(first.key, 'tianhe');
  // The modules are 4.2 m across: no eye inside Tianhe (2.1 m of its axis).
  assert.ok(
    Math.hypot(TIANGONG_MOUNTS.tianhe.eye[0], TIANGONG_MOUNTS.tianhe.eye[1]) >
      2.1,
  );
  assert.equal(first.noradId, TIANGONG_NORAD);
  assert.deepEqual(
    first.views.map((view) => view.key),
    ['tianhe', 'wentian', 'mengtian', 'docked'],
  );
  // Tianhe's eye is 3 m above the hull (+x in the world), 3 m aft (−z).
  assert.ok(Math.abs(first.position.y) < 1e-9);
  assert.ok(Math.abs(first.position.x - (6_780_000 + 3.0)) < 1e-9);
  assert.ok(Math.abs(first.position.z + 3) < 1e-9);
  assert.ok(first.direction.z > 0.9, 'looks ahead along the station');
  assert.ok(first.direction.x < 0, 'and down');
  const docked = tiangongCockpitMount({ ...input, key: 'docked' });
  assert.equal(docked.key, 'docked');
  assert.equal(docked.noradId, 69180);
  assert.equal(docked.label, 'SHENZHOU-23 (SZ-23)');
  assert.ok(docked.direction.z < -0.8, 'looks behind the station');
  const unknown = tiangongCockpitMount({ ...input, key: 'cupola' });
  assert.equal(unknown.key, 'tianhe', 'a view not on offer gives the first');
  // The frame is unit and square.
  const d = docked.direction;
  const u = docked.up;
  assert.ok(Math.abs(Math.hypot(d.x, d.y, d.z) - 1) < 1e-9);
  assert.ok(Math.abs(Math.hypot(u.x, u.y, u.z) - 1) < 1e-9);
  assert.ok(Math.abs(d.x * u.x + d.y * u.y + d.z * u.z) < 1e-9);
});
