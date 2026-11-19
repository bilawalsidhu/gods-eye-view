/**
 * Pick-ownership contract tests (pre-ship audit H2).
 *
 * Locks the cross-layer pick coercion rules:
 *  - resolvePickId reads a click's hit (the contract's `Hit`, or one with no
 *    set for something drawn outside the draw port) as ONE canonical String
 *    id: its item's id.
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
  clickCard,
  isUnderOtherCard,
  setClickCardHitTest,
} from './pickRegistry.js';

// ---------------------------------------------------------------------------
// resolvePickId — canonical String coercion for every layer's pick shape
// ---------------------------------------------------------------------------

const item = (set, id) => ({ set, id, surface: false });
const SURFACE = { set: '', id: '', surface: true };

test("resolvePickId: a draw-set item's hit → its item id", () => {
  assert.equal(resolvePickId(item('flights:1', 'aaa001')), 'aaa001');
  assert.equal(resolvePickId(item('satellites:1:dots', '25544')), '25544');
});

test('resolvePickId: something drawn outside the draw port → its own id', () => {
  assert.equal(resolvePickId(item('', 'transit:bus-1')), 'transit:bus-1');
  assert.equal(resolvePickId(item('', null)), null, 'it has none');
  assert.equal(resolvePickId(item('', '')), '', 'an empty id is still an id');
});

test('resolvePickId: the map and nothing → null', () => {
  assert.equal(resolvePickId(null), null);
  assert.equal(resolvePickId(undefined), null);
  assert.equal(resolvePickId(SURFACE), null);
  assert.equal(resolvePickId({ ...SURFACE, id: 'tile' }), null);
});

// ---------------------------------------------------------------------------
// isOwnedByOtherLayer — sibling-only scan over String-coerced ids
// ---------------------------------------------------------------------------

test('ownership: sibling layers recognize each other via String-coerced ids', () => {
  const points = new Map([[25544, {}], [43013, {}]]); // satellites: numeric keys
  const vessels = new Map([['367123450', {}]]);        // AIS: string id keys
  registerPickOwner('satellites', (pickedId) => {
    const norad = Number(pickedId);
    return Number.isFinite(norad) && points.has(norad);
  });
  registerPickOwner('ais-live-vessels', (pickedId) => vessels.has(pickedId));
  try {
    // Flights asking about a satellite pick (raw numeric id → String upstream)
    assert.equal(isOwnedByOtherLayer('flights', resolvePickId(item('sat:1', '25544'))), true);
    // Flights asking about a vessel pick (an icon row id: the vessel's id)
    assert.equal(isOwnedByOtherLayer('flights', resolvePickId(item('ais:1', '367123450'))), true);
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

/** A query port double: one pick, and a drill that records its asks. */
function query(picked, drillPick = () => assert.fail('must not drill')) {
  return {
    pick: () => picked,
    drillPick,
  };
}

test('touch contact pick expands only a surface miss, bounded to 8 hits in 14 CSS pixels', (t) => {
  primaryPointer(t, true);
  contactOwners(t);
  const position = { x: 30, y: 50 };
  const contact = item('flights:1', 'civil');
  let drills = 0;
  const port = query(SURFACE, (...args) => {
    drills++;
    assert.deepEqual(args, [30, 50, { width: 14, height: 14, limit: 8 }]);
    return [contact];
  });
  assert.equal(pickContact(port, position), contact);
  assert.equal(drills, 1);
});

test("touch contact pick uses the click's own pick and drill", (t) => {
  primaryPointer(t, true);
  contactOwners(t);
  const contact = item('flights:1', 'civil');
  const asked = [];
  const found = pickContact(query(null), { x: 1, y: 1 }, {
    picked: null,
    drill: (...args) => (asked.push(args), [contact]),
  });
  assert.equal(found, contact);
  assert.deepEqual(asked, [[8, 14, 14]]);
});

test('touch contact pick returns the first registered sibling, never a caller-specific preference', (t) => {
  primaryPointer(t, true);
  contactOwners(t);
  for (const first of [item('mil:1', 'military'), item('ais:1', '123456789')]) {
    const port = query(SURFACE, () => [first, item('flights:1', 'civil')]);
    assert.equal(pickContact(port, { x: 1, y: 1 }), first);
  }
});

test('touch contact pick does not drill through exact registered or unregistered interactive picks', (t) => {
  primaryPointer(t, true);
  contactOwners(t);
  for (const exact of [
    item('mil:1', 'military'),
    item('notes:1', 'custom-annotation'),
    item('', 'custom-gizmo'),
  ])
    assert.equal(pickContact(query(exact), { x: 1, y: 1 }), exact);
});

test('touch expansion stops at an unowned item and respects the drill bound', (t) => {
  primaryPointer(t, true);
  contactOwners(t);
  for (const hits of [
    [item('notes:1', 'custom-annotation'), item('flights:1', 'civil')],
    [...Array(8).fill(item('notes:1', 'x')), item('flights:1', 'civil')],
    [],
  ])
    assert.equal(pickContact(query(SURFACE, () => hits), { x: 1, y: 1 }), SURFACE);
});

test('fine primary pointers keep the exact mouse pick without a drill', (t) => {
  primaryPointer(t, false);
  contactOwners(t);
  assert.equal(pickContact(query(SURFACE), { x: 1, y: 1 }), SURFACE);
});

test('touch picking tolerates a failing drill and preserves empty sky', (t) => {
  primaryPointer(t, true);
  contactOwners(t);
  for (const drillPick of [
    () => {
      throw new Error('context lost');
    },
    () => [],
  ])
    assert.equal(pickContact(query(null, drillPick), { x: 1, y: 1 }), null);
});

test("the card on top is read once per click, and only another layer's card counts", () => {
  let top = { sourceId: 'quake-card', entryId: 'q1' };
  let reads = 0;
  setClickCardHitTest((x, y) => {
    reads++;
    assert.deepEqual([x, y], [4, 5]);
    return top;
  });
  try {
    const click = { screenPosition: { x: 4, y: 5 } };
    assert.equal(isUnderOtherCard(click, ['vessel-card']), true);
    assert.equal(isUnderOtherCard(click, ['quake-card']), false, 'own card');
    // A card published later in the same click does not change it.
    top = { sourceId: 'vessel-card', entryId: 'v1' };
    assert.equal(clickCard(click).sourceId, 'quake-card');
    assert.equal(reads, 1);
    assert.equal(isUnderOtherCard({ screenPosition: { x: 4, y: 5 } }), true);
    top = null;
    assert.equal(isUnderOtherCard({ screenPosition: { x: 4, y: 5 } }), false);
  } finally {
    setClickCardHitTest(null);
  }
  assert.equal(
    isUnderOtherCard({ screenPosition: { x: 4, y: 5 } }),
    false,
    'no host',
  );
  setClickCardHitTest(() => {
    throw new Error('broken');
  });
  try {
    assert.equal(clickCard({ screenPosition: { x: 1, y: 1 } }), null);
  } finally {
    setClickCardHitTest(null);
  }
});
