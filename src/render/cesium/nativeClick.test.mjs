/**
 * The raw forms of the shared pick-id and contact rules, over Cesium's own picks
 * (`nativePickId`, `nativePickContact`), and a click's own Cesium picks.
 *
 *  - nativePickId reduces every Cesium pick shape (string ids, numeric NORAD
 *    ids, Cesium Entity objects, draw-set pick ids) to ONE canonical String id.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  registerPickOwner,
  unregisterPickOwner,
  isOwnedByOtherLayer,
} from '../../data/pickRegistry.js';
import {
  createNativeClick,
  nativePickContact as pickContact,
  nativePickId as resolvePickId,
} from './nativeClick.js';
import { nativeClickOf } from '../rendererOf.js';
import { rememberPick } from './pickMemo.js';

// ---------------------------------------------------------------------------
// resolvePickId — canonical String coercion for every layer's pick shape
// ---------------------------------------------------------------------------

test('resolvePickId: string pick id (flights/military/bikeshare/cctv billboards)', () => {
  assert.equal(resolvePickId({ id: 'aaa001' }), 'aaa001');
  assert.equal(
    resolvePickId({ id: undefined, primitive: { id: 'station:austin:1' } }),
    'station:austin:1',
  );
});

test('resolvePickId: numeric pick id (satellite NORAD numbers) → String', () => {
  assert.equal(resolvePickId({ id: 25544 }), '25544');
  assert.equal(
    resolvePickId({ id: undefined, primitive: { id: 43013 } }),
    '43013',
  );
});

test('resolvePickId: Cesium-Entity-like object → its string id', () => {
  const entity = { id: 'cctv-atx-cam-3-center', properties: {} };
  assert.equal(resolvePickId({ id: entity }), 'cctv-atx-cam-3-center');
});

test('resolvePickId: a draw-set pick id → its item id', () => {
  assert.equal(
    resolvePickId({ id: { set: 'quakes:1', id: 'quake:a' } }),
    'quake:a',
  );
});

test('resolvePickId: unresolvable picks → null', () => {
  assert.equal(resolvePickId(null), null);
  assert.equal(resolvePickId(undefined), null);
  assert.equal(resolvePickId({}), null);
  assert.equal(resolvePickId({ id: {} }), null); // object with no id
  assert.equal(resolvePickId({ primitive: {} }), null);
});

function primaryPointer(t, coarse) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'matchMedia');
  Object.defineProperty(globalThis, 'matchMedia', {
    configurable: true,
    value: (query) => ({ matches: query === '(pointer: coarse)' && coarse }),
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'matchMedia', previous);
    else delete globalThis.matchMedia;
  });
}

function contactOwners(t) {
  registerPickOwner('flights', (id) => id === 'civil');
  registerPickOwner('military', (id) => id === 'military');
  registerPickOwner('ais-live-vessels', (id) => id === '123456789');
  t.after(() => {
    for (const id of ['flights', 'military', 'ais-live-vessels'])
      unregisterPickOwner(id);
  });
}

const mapTile = { primitive: { isCesium3DTileset: true } };

test('touch contact pick expands only a surface miss, bounded to 8 hits in 14 CSS pixels', (t) => {
  primaryPointer(t, true);
  contactOwners(t);
  const position = { x: 30, y: 50 };
  const contact = { primitive: { id: 'civil' } };
  let drills = 0;
  const scene = {
    pick(point) {
      assert.equal(point, position);
      return mapTile;
    },
    drillPick(...args) {
      drills++;
      assert.deepEqual(args, [position, 8, 14, 14]);
      return [mapTile, contact];
    },
  };
  assert.equal(pickContact(scene, position), contact);
  assert.equal(drills, 1);
});

test('touch contact pick returns the first registered sibling, never a caller-specific preference', (t) => {
  primaryPointer(t, true);
  contactOwners(t);
  for (const first of [{ id: 'military' }, { id: '123456789' }]) {
    const scene = {
      pick: () => mapTile,
      drillPick: () => [mapTile, first, { id: 'civil' }],
    };
    assert.equal(pickContact(scene, { x: 1, y: 1 }), first);
  }
});

test('touch contact pick does not drill through exact registered or unregistered interactive picks', (t) => {
  primaryPointer(t, true);
  contactOwners(t);
  for (const exact of [
    { id: 'military' },
    { id: 'custom-annotation' },
    { primitive: { id: 'custom-gizmo' } },
    { primitive: { id: 'civil', isCesium3DTileset: true } },
  ]) {
    const scene = {
      pick: () => exact,
      drillPick: () => assert.fail('must keep exact interactive hit'),
    };
    assert.equal(pickContact(scene, { x: 1, y: 1 }), exact);
  }
});

test('touch expansion stops at a non-surface object and respects the drill bound', (t) => {
  primaryPointer(t, true);
  contactOwners(t);
  for (const hits of [
    [mapTile, { id: 'custom-annotation' }, { id: 'civil' }],
    [...Array(8).fill(mapTile), { id: 'civil' }],
    [mapTile],
  ]) {
    assert.equal(
      pickContact(
        { pick: () => mapTile, drillPick: () => hits },
        { x: 1, y: 1 },
      ),
      mapTile,
    );
  }
});

test('fine primary pointers keep the existing exact mouse pick without a drill', (t) => {
  primaryPointer(t, false);
  contactOwners(t);
  const scene = {
    pick: () => mapTile,
    drillPick: () => assert.fail('mouse must not expand'),
  };
  assert.equal(pickContact(scene, { x: 1, y: 1 }), mapTile);
});

test('touch picking tolerates unavailable or failing drill support and preserves empty sky', (t) => {
  primaryPointer(t, true);
  contactOwners(t);
  for (const drillPick of [
    undefined,
    () => {
      throw new Error('context lost');
    },
    () => [],
  ]) {
    assert.equal(
      pickContact({ pick: () => undefined, drillPick }, { x: 1, y: 1 }),
      undefined,
    );
  }
});

// ---------------------------------------------------------------------------
// A click's own Cesium picks
// ---------------------------------------------------------------------------

function countingScene(picked) {
  const calls = { pick: [], drillPick: [] };
  return {
    calls,
    pick(...args) {
      calls.pick.push(args);
      return typeof picked === 'function' ? picked(...args) : picked;
    },
    drillPick(...args) {
      calls.drillPick.push(args);
      return [];
    },
  };
}

test('a click picks once, at the pick-buffer position, and names what the draw port does not draw', () => {
  const scene = countingScene({ id: 'transit:bus-1' });
  const click = createNativeClick(scene, { x: 12, y: 34 });
  assert.equal(click.native.pick.id, 'transit:bus-1');
  assert.equal(click.native.pick, click.native.pick, 'memoized');
  assert.deepEqual(click.foreign(), { id: 'transit:bus-1' });
  assert.equal(scene.calls.pick.length, 1);
  assert.deepEqual(
    [scene.calls.pick[0][0].x, scene.calls.pick[0][0].y],
    [12, 34],
  );
});

test('the map and nothing are not foreign; a draw-set item is its hit', () => {
  assert.deepEqual(
    createNativeClick(
      countingScene({ id: { set: 'quakes:1', id: 'quake:a' } }),
      {
        x: 0,
        y: 0,
      },
    ).foreign(),
    { set: 'quakes:1', id: 'quake:a', surface: false },
    'one the renderer pick did not name: drawn by a superseded draw port',
  );
  for (const picked of [
    undefined,
    { primitive: { isCesium3DTileset: true } },
    { content: {} },
  ])
    assert.equal(
      createNativeClick(countingScene(picked), { x: 0, y: 0 }).foreign(),
      null,
    );
  assert.deepEqual(
    createNativeClick(countingScene({ primitive: {} }), {
      x: 0,
      y: 0,
    }).foreign(),
    { id: null },
    'an id-less primitive is something, with no id',
  );
});

test("a click's own pick reuses the query port's pass of the same pixel in the same task", async () => {
  const picked = { id: 'transit:bus-1' };
  const scene = countingScene(picked);
  rememberPick(scene, 5, 6, 3, 3, picked);
  assert.equal(createNativeClick(scene, { x: 5, y: 6 }).native.pick, picked);
  assert.equal(scene.calls.pick.length, 0);
  // Another pixel or window picks again.
  createNativeClick(scene, { x: 5, y: 7 }).native.pick;
  createNativeClick(scene, { x: 5, y: 6 }).native.pickWindow(9, 9);
  assert.equal(scene.calls.pick.length, 2);
  // So does a later task: the scene may have drawn since.
  await Promise.resolve();
  createNativeClick(scene, { x: 5, y: 6 }).native.pick;
  assert.equal(scene.calls.pick.length, 3);
});

test("the query port's passes of several windows in one task are all reused", () => {
  const picked = { id: 'transit:bus-1' };
  const wide = { id: 'transit:bus-2' };
  const scene = countingScene(picked);
  rememberPick(scene, 5, 6, 3, 3, picked);
  rememberPick(scene, 5, 6, 9, 9, wide);
  const { native } = createNativeClick(scene, { x: 5, y: 6 });
  assert.equal(native.pickWindow(9, 9), wide);
  assert.equal(native.pick, picked);
  assert.equal(scene.calls.pick.length, 0);
});

test("a drill's hits: draw-set items, the map, and the rest with no set", () => {
  const scene = countingScene(undefined);
  scene.drillPick = () => [
    { id: { set: 'quakes:1', id: 'quake:a' } },
    { primitive: { isCesium3DTileset: true } },
    { primitive: { id: 'bus-1' } },
    { primitive: {} },
  ];
  assert.deepEqual(
    createNativeClick(scene, { x: 0, y: 0 })
      .drillHits(8, 14, 14)
      .map(({ set, id, surface }) => ({ set, id, surface })),
    [
      { set: 'quakes:1', id: 'quake:a', surface: false },
      { set: '', id: '', surface: true },
      { set: '', id: 'bus-1', surface: false },
      { set: '', id: null, surface: false },
    ],
  );
});

test('drills of different depths on one click share a pass', () => {
  const hits = Array.from({ length: 20 }, (_, i) => ({ id: `hit-${i}` }));
  const scene = countingScene(undefined);
  scene.drillPick = (...args) => {
    scene.calls.drillPick.push(args);
    return hits.slice(0, args[1]);
  };
  const { native } = createNativeClick(scene, { x: 0, y: 0 });
  assert.deepEqual(
    [native.drill(12).length, native.drill(8).length, native.drill(16).length],
    [12, 8, 16],
  );
  assert.equal(scene.calls.drillPick.length, 1);
});

test('the adapter provides native clicks for a Cesium-shaped viewer only', () => {
  const scene = countingScene({ id: 'x' });
  assert.equal(nativeClickOf({ scene }, { x: 1, y: 1 }).native.pick.id, 'x');
  assert.equal(nativeClickOf({ scene: {} }, { x: 1, y: 1 }), null);
  assert.equal(nativeClickOf(null, { x: 1, y: 1 }), null);
  assert.equal(
    nativeClickOf({ scene, isDestroyed: () => true }, { x: 1, y: 1 }),
    null,
  );
});
