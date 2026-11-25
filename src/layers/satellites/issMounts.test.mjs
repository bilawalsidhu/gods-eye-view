import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ISS_MOUNTS,
  ISS_MOUNT_CARDS,
  ISS_MOUNT_ORDER,
  ISS_NAUKA_NORAD,
  ISS_POISK_NORAD,
  issMountLabel,
  issMountView,
  issMountViews,
  issMountWorld,
  issNextMountView,
  issPreviousMountView,
} from './issMounts.js';
import { ISS_MODEL_NATIVE_SPAN, ISS_NORAD } from './policy.js';

const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const length = (a) => Math.hypot(a.x, a.y, a.z);

/** Key, label and entry of each view: what the Cockpit steps through. */
const summary = (views) =>
  views.map(({ key, label, noradId }) => ({ key, label, noradId }));

test('the station offers its views in order, Nauka first', () => {
  assert.deepEqual(
    [...ISS_MOUNT_ORDER],
    ['nauka', 'zarya', 'poisk', 'cupola', 'kibo', 'docked'],
  );
  for (const key of ISS_MOUNT_ORDER) assert.ok(ISS_MOUNTS[key]);
  assert.equal(new Set([ISS_NORAD, ISS_NAUKA_NORAD, ISS_POISK_NORAD]).size, 3);
  // Each view names the entry it belongs to, for the Cockpit to ride. The
  // Cupola and Kibo have no entries of their own: they ride the ISS's.
  const views = issMountViews({
    naukaName: 'ISS (NAUKA)',
    zaryaName: 'ISS (ZARYA)',
    poiskName: 'POISK',
    dockedName: 'PROGRESS-MS 34',
    naukaNorad: ISS_NAUKA_NORAD,
    zaryaNorad: ISS_NORAD,
    poiskNorad: ISS_POISK_NORAD,
    dockedNorad: 68837,
  });
  assert.deepEqual(summary(views), [
    { key: 'nauka', label: 'NAUKA', noradId: ISS_NAUKA_NORAD },
    { key: 'zarya', label: 'ZARYA', noradId: ISS_NORAD },
    { key: 'poisk', label: 'POISK', noradId: ISS_POISK_NORAD },
    { key: 'cupola', label: 'CUPOLA', noradId: ISS_NORAD },
    { key: 'kibo', label: 'KIBO', noradId: ISS_NORAD },
    { key: 'docked', label: 'PROGRESS-MS 34', noradId: 68837 },
  ]);
  // Only the modules without an entry carry cards of their own.
  assert.deepEqual(
    views.filter((view) => view.card).map((view) => view.key),
    ['cupola', 'kibo'],
  );
  // No vehicle docked: no view from one. The modules are part of the model,
  // so they are offered even when the catalog has no entry for them; such a
  // view has no entry to ride.
  assert.deepEqual(summary(issMountViews({ zaryaName: 'ISS (ZARYA)' })), [
    { key: 'nauka', label: 'NAUKA', noradId: null },
    { key: 'zarya', label: 'ZARYA', noradId: null },
    { key: 'poisk', label: 'POISK', noradId: null },
    { key: 'cupola', label: 'CUPOLA', noradId: null },
    { key: 'kibo', label: 'KIBO', noradId: null },
  ]);
  assert.deepEqual(
    issMountViews().map(({ key }) => key),
    ['nauka', 'zarya', 'poisk', 'cupola', 'kibo'],
  );
});

test('the Cupola’s card names it and gives its facts, marked for translation', () => {
  const card = ISS_MOUNT_CARDS.cupola;
  assert.equal(card.name, 'CUPOLA');
  assert.equal(card.classLabel, 'OBSERVATION MODULE · ISS');
  assert.equal(card.operator, 'European Space Agency (ESA)');
  assert.deepEqual(
    [...card.facts],
    [
      '7 WINDOWS',
      'LAUNCHED 8 FEB 2010 · STS-130',
      'TRANQUILITY · EARTH-FACING PORT',
    ],
  );
});

test('Kibo’s card names it and gives its facts, marked for translation', () => {
  const card = ISS_MOUNT_CARDS.kibo;
  assert.equal(card.name, 'KIBO');
  assert.equal(card.classLabel, 'LABORATORY MODULE · ISS');
  assert.equal(card.operator, 'Japan Aerospace Exploration Agency (JAXA)');
  assert.deepEqual(
    [...card.facts],
    ['2 WINDOWS', 'LAUNCHED 31 MAY 2008 · STS-124', 'HARMONY · PORT SIDE'],
  );
});

test('the view shown is the one asked for, else the first; the next wraps round', () => {
  const views = issMountViews({ dockedName: 'SOYUZ-MS 28' });
  assert.equal(issMountView(views, null).key, 'nauka');
  assert.equal(issMountView(views, undefined).key, 'nauka');
  assert.equal(issMountView(views, 'zarya').key, 'zarya');
  assert.equal(issMountView(views, 'docked').label, 'SOYUZ-MS 28');
  // A view no longer on offer (the vehicle undocked) falls back to the first.
  assert.equal(issMountView(issMountViews(), 'docked').key, 'nauka');

  assert.equal(issNextMountView(views, 'nauka').key, 'zarya');
  assert.equal(issNextMountView(views, 'zarya').key, 'poisk');
  assert.equal(issNextMountView(views, 'poisk').key, 'cupola');
  assert.equal(issNextMountView(views, 'cupola').key, 'kibo');
  assert.equal(issNextMountView(views, 'kibo').key, 'docked');
  assert.equal(issNextMountView(views, 'docked').key, 'nauka');
  assert.equal(issNextMountView(views, 'unknown').key, 'nauka');
  assert.equal(issNextMountView(views.slice(0, 1), 'nauka'), null);
  assert.equal(issNextMountView(null, 'nauka'), null);

  assert.equal(issPreviousMountView(views, 'nauka').key, 'docked');
  assert.equal(issPreviousMountView(views, 'docked').key, 'kibo');
  assert.equal(issPreviousMountView(views, 'zarya').key, 'nauka');
  assert.equal(issPreviousMountView(views, 'unknown').key, 'docked');
  assert.equal(issPreviousMountView(views.slice(0, 1), 'nauka'), null);
  assert.equal(issPreviousMountView(null, 'nauka'), null);
});

test('the view is named after the entry, without the catalog’s "ISS (…)"', () => {
  assert.equal(issMountLabel('ISS (ZARYA)'), 'ZARYA');
  assert.equal(issMountLabel(' ISS (NAUKA) '), 'NAUKA');
  assert.equal(issMountLabel('PROGRESS-MS 34'), 'PROGRESS-MS 34');
  assert.equal(issMountLabel(null), '');
});

test('every mount is on or beside the model, with a usable view frame', () => {
  for (const [key, { eye, forward, up }] of Object.entries(ISS_MOUNTS)) {
    // Within the station's own size of its centre: on it or just off its end.
    assert.ok(Math.hypot(...eye) < ISS_MODEL_NATIVE_SPAN / 2, key);
    assert.ok(Math.hypot(...forward) > 0.5, key);
    // Up is not along the view, so the frame can be squared.
    const cos =
      (forward[0] * up[0] + forward[1] * up[1] + forward[2] * up[2]) /
      (Math.hypot(...forward) * Math.hypot(...up));
    assert.ok(Math.abs(cos) < 0.9, key);
  }
});

test('a mount goes to the world on the axes the model is placed with', () => {
  // Flight axes: x along-track, y the orbit normal, z zenith.
  const axes = { x: [0, 1, 0], y: [0, 0, 1], z: [1, 0, 0] };
  const centre = { x: 6_800_000, y: 0, z: 0 };
  // Model axes are [port, zenith, forward]: forward is along-track, zenith
  // is away from the Earth, port is the orbit normal.
  const world = issMountWorld(
    { eye: [3, 5, -7], forward: [0, 0, 1], up: [0, 1, 0] },
    centre,
    axes,
  );
  assert.deepEqual(world.position, { x: 6_800_005, y: -7, z: 3 });
  assert.deepEqual(world.direction, { x: 0, y: 1, z: 0 });
  assert.deepEqual(world.up, { x: 1, y: 0, z: 0 });
  // right = direction × up.
  assert.deepEqual(world.right, { x: 0, y: 0, z: -1 });
});

test('the view frame is unit and square whatever the mount says', () => {
  const axes = { x: [0, 1, 0], y: [0, 0, 1], z: [1, 0, 0] };
  const centre = { x: 1, y: 2, z: 3 };
  for (const mount of [
    ...Object.values(ISS_MOUNTS),
    // Lengths off, and an up that leans into the view.
    { eye: [0, 0, 0], forward: [0, -3, 4], up: [0, 2, 1] },
  ]) {
    const { direction, up, right } = issMountWorld(mount, centre, axes);
    for (const v of [direction, up, right])
      assert.ok(Math.abs(length(v) - 1) < 1e-12);
    assert.ok(Math.abs(dot(direction, up)) < 1e-12);
    assert.ok(Math.abs(dot(direction, right)) < 1e-12);
    assert.ok(Math.abs(dot(up, right)) < 1e-12);
  }
  // The eye is the mount's distance from the centre.
  const { position } = issMountWorld(ISS_MOUNTS.docked, centre, axes);
  const offset = Math.hypot(position.x - 1, position.y - 2, position.z - 3);
  assert.ok(Math.abs(offset - Math.hypot(...ISS_MOUNTS.docked.eye)) < 1e-9);
});
