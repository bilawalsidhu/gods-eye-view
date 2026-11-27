import assert from 'node:assert/strict';
import test from 'node:test';
import { fromDegrees } from '../../geo/ellipsoid.js';
import { createIconBook } from './iconBook.js';
import { iconCourse, iconPosition } from './iconMotion.js';

const A = fromDegrees(4.1, 51.95, 10);
const B = { x: A.x + 1000, y: A.y, z: A.z };
const T0 = Date.UTC(2026, 10, 7);
const mover = (extra = {}) => ({
  id: 'a',
  pos: A,
  image: 'a.png',
  size: [16, 16],
  motion: { kind: 'lerp', from: A, to: B, t0: T0, t1: T0 + 10_000 },
  courseGlide: { fromCourseDeg: 0, t0: T0, rateDps: 10 },
  ...extra,
});

/** A draw set that records what it is sent. */
function recordingSet() {
  const calls = [];
  return {
    calls,
    id: 'set:1',
    show: true,
    upsert: (items) => calls.push(['upsert', items.map((i) => i.id)]),
    remove: (ids) => calls.push(['remove', ids]),
    dispose: () => calls.push(['dispose']),
  };
}

test('the book draws what it is given and reads it back as drawn', () => {
  const set = recordingSet();
  const book = createIconBook(set);
  const item = mover();
  book.put(item);
  assert.deepEqual(set.calls, [['upsert', ['a']]]);
  assert.equal(book.setId, 'set:1');
  assert.equal(book.item('a'), item);
  assert.deepEqual(
    book.position('a', T0 + 5000),
    iconPosition(item, T0 + 5000),
  );
  assert.equal(book.course('a', T0 + 3000), iconCourse(item, T0 + 3000));
  assert.equal(book.position('nobody', T0), null);
  assert.equal(book.course('nobody', T0), null);
  book.remove('a');
  book.remove('a');
  assert.deepEqual(set.calls.at(-1), ['remove', ['a']]);
  assert.equal(set.calls.length, 2, 'removed once');
  book.dispose();
  assert.deepEqual(set.calls.at(-1), ['dispose']);
});

test('an item put with an expiry comes due when its motion runs out', () => {
  const book = createIconBook();
  book.put(mover(), { expiresAt: T0 + 10_000 });
  book.put(mover({ id: 'b' }));
  assert.deepEqual(book.due(T0 + 9999), []);
  assert.deepEqual(book.due(T0 + 10_000), ['a']);
  assert.equal(book.expiresAt('a'), T0 + 10_000);
  assert.equal(book.expiresAt('b'), undefined, 'never due');
  // A focus change keeps the expiry; replanning sets a new one.
  book.setFocus('a', 0.5);
  assert.equal(book.expiresAt('a'), T0 + 10_000);
  book.put(mover(), { expiresAt: T0 + 20_000 });
  assert.deepEqual(book.due(T0 + 10_000), []);
  book.put(mover({ alpha: 0.5 }));
  assert.equal(book.expiresAt('a'), T0 + 20_000, 'a restyle keeps it');
  book.put(mover(), { expiresAt: Infinity });
  assert.deepEqual(book.due(Number.MAX_VALUE), [], 'planned, never due');
  book.put(mover(), { expiresAt: null });
  assert.equal(book.expiresAt('a'), undefined, 'null drops it');
  assert.throws(() => book.put(mover(), { expiresAt: NaN }), TypeError);
  assert.throws(() => book.put(mover(), { expiresAt: '5' }), TypeError);
  book.put(mover(), { expiresAt: T0 });
  book.remove('a');
  assert.deepEqual(book.due(Infinity), [], 'gone with its item');
});

test('without the renderer’s motion capabilities, icons read where they are drawn', () => {
  const still = createIconBook(null, { capabilities: new Set() });
  still.put(mover({ course: 45 }));
  assert.deepEqual(still.position('a', T0 + 5000), A);
  assert.equal(still.course('a', T0 + 5000), 45);
  const noGlide = createIconBook(null, {
    capabilities: new Set(['motionSegments']),
  });
  noGlide.put(mover({ motion: { kind: 'hold', courseDeg: 90 } }));
  assert.equal(noGlide.course('a', T0 + 1000), 90, 'on course at once');
  // Glides but does not move: the glide eases onto the item's own course.
  const noMotion = createIconBook(null, {
    capabilities: new Set(['courseGlide']),
  });
  noMotion.put(mover({ course: 60 }));
  assert.deepEqual(noMotion.position('a', T0 + 5000), A);
  assert.equal(noMotion.course('a', T0 + 3000), 30, 'gliding onto 60');
  assert.equal(noMotion.course('a', T0 + 9000), 60);
});

test('focus is read and written per icon', () => {
  const book = createIconBook();
  book.put(mover());
  assert.equal(book.focus('a'), 1);
  book.setFocus('a', 0.25);
  assert.equal(book.focus('a'), 0.25);
  assert.equal(book.item('a').focus, 0.25);
  book.setFocus('nobody', 0.5);
  assert.equal(book.has('nobody'), false);
  assert.equal(book.expiresAt('a'), undefined, 'focus leaves it unplanned');
});

test('the book shows and hides its draw set, and keeps the order icons came in', () => {
  const set = recordingSet();
  const book = createIconBook(set);
  book.show = false;
  assert.equal(set.show, false);
  assert.equal(book.show, false);
  const alone = createIconBook();
  alone.show = false;
  assert.equal(alone.show, true, 'nothing to hide');
  book.put(mover({ id: 'x' }));
  book.put(mover({ id: 'y' }));
  book.put(mover({ id: 'x', alpha: 0.2 }));
  assert.deepEqual(book.ids(), ['x', 'y']);
  assert.equal(book.size, 2);
});

test('a position is written into a given vector, and the kept id list lasts until ids come or go', () => {
  const book = createIconBook();
  book.put(mover());
  book.put(mover({ id: 'b', motion: undefined }));
  const out = { x: 0, y: 0, z: 0 };
  const t = T0 + 4_000;
  assert.equal(book.position('a', t, out), out);
  assert.deepEqual({ ...out }, iconPosition(mover(), t));
  assert.deepEqual(book.position('a', t), iconPosition(mover(), t));
  assert.equal(book.position('missing', t, out), null);

  // Without motion segments the icon reads where its item puts it.
  const still = createIconBook(null, { capabilities: new Set() });
  still.put(mover());
  assert.deepEqual(
    { ...still.position('a', t, out) },
    { x: A.x, y: A.y, z: A.z },
  );

  const list = book.idList();
  assert.deepEqual(list, ['a', 'b']);
  assert.equal(book.idList(), list, 'kept while no id comes or goes');
  book.put(mover({ motion: undefined })); // a restyle: same ids
  book.putMany([mover({ id: 'b' })]);
  assert.equal(book.idList(), list);
  book.put(mover({ id: 'c' }));
  const grown = book.idList();
  assert.notEqual(grown, list);
  assert.deepEqual(grown, ['a', 'b', 'c']);
  book.putMany([mover({ id: 'd' })]);
  assert.deepEqual(book.idList(), ['a', 'b', 'c', 'd']);
  const before = book.idList();
  book.remove('b');
  assert.notEqual(book.idList(), before);
  assert.deepEqual(book.idList(), ['a', 'c', 'd']);
  // ids() still hands each caller a copy of its own.
  assert.notEqual(book.ids(), book.ids());
});
