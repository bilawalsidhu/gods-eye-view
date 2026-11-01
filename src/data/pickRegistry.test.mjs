/**
 * Pick-ownership contract tests (pre-ship audit H2).
 *
 * Locks the cross-layer pick coercion rules:
 *  - resolvePickId reduces every layer's pick shape (string icao/station ids,
 *    numeric NORAD ids, AIS vessel record objects, Cesium Entity objects) to
 *    ONE canonical String id.
 *  - isOwnedByOtherLayer consults sibling predicates only, never the asker's,
 *    and never throws on a broken predicate.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  registerPickOwner,
  unregisterPickOwner,
  isOwnedByOtherLayer,
  resolvePickId,
  pickContact,
} from './pickRegistry.js';

// ---------------------------------------------------------------------------
// resolvePickId — canonical String coercion for every layer's pick shape
// ---------------------------------------------------------------------------

test('resolvePickId: string pick id (flights/military/bikeshare/cctv billboards)', () => {
  assert.equal(resolvePickId({ id: 'aaa001' }), 'aaa001');
  assert.equal(resolvePickId({ id: undefined, primitive: { id: 'station:austin:1' } }), 'station:austin:1');
});

test('resolvePickId: numeric pick id (satellite NORAD numbers) → String', () => {
  assert.equal(resolvePickId({ id: 25544 }), '25544');
  assert.equal(resolvePickId({ id: undefined, primitive: { id: 43013 } }), '43013');
});

test('resolvePickId: AIS vessel record object → its mmsi', () => {
  const record = { mmsi: '367123450', name: 'EVER GIVEN', billboard: {} };
  assert.equal(resolvePickId({ id: record }), '367123450');
  assert.equal(resolvePickId({ primitive: { id: record } }), '367123450');
});

test('resolvePickId: Cesium-Entity-like object → its string id', () => {
  const entity = { id: 'cctv-atx-cam-3-center', properties: {} };
  assert.equal(resolvePickId({ id: entity }), 'cctv-atx-cam-3-center');
});

test('resolvePickId: unresolvable picks → null', () => {
  assert.equal(resolvePickId(null), null);
  assert.equal(resolvePickId(undefined), null);
  assert.equal(resolvePickId({}), null);
  assert.equal(resolvePickId({ id: {} }), null); // object with no mmsi/id
  assert.equal(resolvePickId({ primitive: {} }), null);
});

// ---------------------------------------------------------------------------
// isOwnedByOtherLayer — sibling-only scan over String-coerced ids
// ---------------------------------------------------------------------------

test('ownership: sibling layers recognize each other via String-coerced ids', () => {
  const points = new Map([[25544, {}], [43013, {}]]); // satellites: numeric keys
  const vessels = new Map([['367123450', {}]]);        // AIS: string mmsi keys
  registerPickOwner('satellites', (pickedId) => {
    const norad = Number(pickedId);
    return Number.isFinite(norad) && points.has(norad);
  });
  registerPickOwner('ais-live-vessels', (pickedId) => vessels.has(pickedId));
  try {
    // Flights asking about a satellite pick (raw numeric id → String upstream)
    assert.equal(isOwnedByOtherLayer('flights', resolvePickId({ id: 25544 })), true);
    // Flights asking about a vessel pick (record object → mmsi)
    assert.equal(isOwnedByOtherLayer('flights', resolvePickId({ id: { mmsi: '367123450' } })), true);
    // A layer never owns its own pick via the sibling scan
    assert.equal(isOwnedByOtherLayer('satellites', '25544'), false);
    // Unknown ids belong to nobody
    assert.equal(isOwnedByOtherLayer('flights', 'zzz999'), false);
    assert.equal(isOwnedByOtherLayer('flights', null), false);
  } finally {
    unregisterPickOwner('satellites');
    unregisterPickOwner('ais-live-vessels');
  }
});

test('ownership: a throwing predicate never breaks click handling', () => {
  registerPickOwner('broken', () => { throw new Error('boom'); });
  registerPickOwner('cctv', (pickedId) => pickedId === 'atx-cam-3');
  try {
    assert.equal(isOwnedByOtherLayer('flights', 'atx-cam-3'), true);
    assert.equal(isOwnedByOtherLayer('flights', 'nothing'), false);
  } finally {
    unregisterPickOwner('broken');
    unregisterPickOwner('cctv');
  }
});

test('ownership: unregister removes the predicate', () => {
  registerPickOwner('bikeshare', (pickedId) => pickedId === 'station:1');
  assert.equal(isOwnedByOtherLayer('flights', 'station:1'), true);
  unregisterPickOwner('bikeshare');
  assert.equal(isOwnedByOtherLayer('flights', 'station:1'), false);
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
  for (const first of [{ id: 'military' }, { id: { mmsi: '123456789' } }]) {
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
