import test from 'node:test';
import assert from 'node:assert/strict';
import { nextCockpitNearContacts } from './cockpitAirLod.js';

test('Cockpit AIR LOD admits at ADD and retains through KEEP', () => {
  const previous = new Set(['retained', 'expired']);
  const next = nextCockpitNearContacts(previous, [
    ['new-near', 149_000 ** 2],
    ['new-outside-add', 151_000 ** 2],
    ['retained', 184_000 ** 2],
    ['expired', 186_000 ** 2],
  ], 150_000, 185_000);

  assert.deepEqual([...next].sort(), ['new-near', 'retained']);
});

test('Cockpit AIR LOD switches to the All range without a model-budget dependency', () => {
  const next = nextCockpitNearContacts(new Set(), [
    ['inside-all', 399_000 ** 2],
    ['outside-all', 401_000 ** 2],
  ], 400_000, 450_000);

  assert.deepEqual([...next], ['inside-all']);
});

test('Cockpit AIR LOD drops absent and invalid contacts', () => {
  const next = nextCockpitNearContacts(new Set(['gone']), [
    ['nan', Number.NaN],
    ['', 1],
  ], 150_000, 185_000);

  assert.equal(next.size, 0);
});

// --- Branch floor (cycle 4): malformed inputs resolve to a sane band --------

test('a non-Set retention memory behaves as no memory', () => {
  // Without a Set, nothing is "retained" — every contact is judged at ADD.
  const next = nextCockpitNearContacts(['retained'], [
    ['retained', 184_000 ** 2],
    ['fresh', 149_000 ** 2],
  ], 150_000, 185_000);
  assert.deepEqual([...next].sort(), ['fresh'], 'a retired retention store forgets, not flickers');
  assert.deepEqual([...nextCockpitNearContacts(undefined, [], 1, 1)], []);
});

test('a null distance iterable is an empty update, not a throw', () => {
  assert.deepEqual([...nextCockpitNearContacts(new Set(), null, 150_000, 185_000)], []);
});

test('malformed radii collapse: NaN and negative radii become 0, keep never under-cuts add', () => {
  // NaN add radius → 0: only a contact dead-on the camera (distanceSq 0)
  // still passes the inclusive edge — nobody at any real range enters.
  assert.deepEqual([...nextCockpitNearContacts(new Set(), [['x', 0], ['far', 1]], Number.NaN, 185_000)], ['x'],
    'a malformed ADD radius collapses the band to the camera point itself');
  assert.deepEqual([...nextCockpitNearContacts(new Set(), [['far', 1]], Number.NaN, 185_000)], []);
  // Negative radii clamp to 0; distanceSq 0 still passes `<= 0`.
  assert.deepEqual([...nextCockpitNearContacts(new Set(), [['y', 0]], -5, -7)], ['y']);
  // A keep radius below the add radius is raised to add — hysteresis cannot
  // shrink the band.
  const keepUnder = nextCockpitNearContacts(new Set(['r']), [['r', 150_000 ** 2]], 150_000, 1);
  assert.deepEqual([...keepUnder], ['r'], 'retained contact judged at add radius when keep < add');
  // A malformed keep radius falls back to the add band rather than dropping
  // every retained contact.
  assert.deepEqual(
    [...nextCockpitNearContacts(new Set(['r']), [['r', 150_000 ** 2]], 150_000, Number.NaN)],
    ['r'],
    'malformed KEEP → the retention band IS the add band',
  );
});

test('negative squared distances are dropped before any band comparison', () => {
  assert.deepEqual([...nextCockpitNearContacts(new Set(), [['neg', -1]], 150_000, 185_000)], [],
    'a negative squared distance is caller corruption, not proximity');
});

test('the exact band edge admits (inclusive <=)', () => {
  assert.deepEqual([...nextCockpitNearContacts(new Set(), [['edge', 150_000 ** 2]], 150_000, 185_000)], ['edge']);
});

