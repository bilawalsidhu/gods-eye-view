/**
 * The raw form of the shared pick-id rule, over Cesium's own picks
 * (`nativePickId`), and a click's own Cesium picks.
 *
 *  - nativePickId reduces every Cesium pick shape (string ids, numeric NORAD
 *    ids, Cesium Entity objects, draw-set pick ids) to ONE canonical String id.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createNativeClick,
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
