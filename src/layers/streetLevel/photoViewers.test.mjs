import assert from 'node:assert/strict';
import test from 'node:test';
import { subscribePhotoViewers } from './photoViewers.js';

/**
 * A photo viewer whose presentations the test sends; `superseded` counts.
 * Unlike photoViewer.js it keeps presenting once superseded, so the order
 * is seen to come from the mount keys alone.
 */
function fakeViewer() {
  const listeners = new Set();
  const viewer = {
    superseded: 0,
    view(mountKey) {
      return {
        mountKey,
        actions: { supersede: () => viewer.superseded++ },
      };
    },
    present(view) {
      for (const listener of [...listeners]) listener(view);
    },
    subscribeView(listener) {
      listeners.add(listener);
      listener(null);
      return () => listeners.delete(listener);
    },
  };
  return viewer;
}

test('the later mount is drawn, whatever order the viewers present in', async () => {
  const a = fakeViewer();
  const b = fakeViewer();
  const shown = [];
  const unsubscribe = subscribePhotoViewers([a, b], (view) => shown.push(view));
  assert.deepEqual(shown, [null], 'the current one first');
  const first = a.view(1);
  a.present(first);
  const later = b.view(2);
  b.present(later);
  assert.equal(shown.at(-1), later);
  // Once every subscriber has the later one.
  await Promise.resolve();
  assert.equal(a.superseded, 1, 'the earlier mount is told it is not drawn');
  // The earlier viewer presents again: it does not take the view back.
  a.present({ ...first, kind: 'flat' });
  assert.equal(shown.at(-1), later);
  assert.equal(shown.length, 3);
  b.present(null);
  assert.equal(shown.at(-1).mountKey, 1, 'the only one presenting');
  a.present(null);
  assert.equal(shown.at(-1), null);
  unsubscribe();
  a.present(first);
  assert.equal(shown.length, 5, 'unsubscribed');
});

/** A viewer that, superseded, unmounts as photoViewer.js does: it presents null. */
function unmountingViewer() {
  const viewer = fakeViewer();
  const view = viewer.view;
  viewer.view = (mountKey) => {
    const presented = view(mountKey);
    const supersede = presented.actions.supersede;
    presented.actions.supersede = () => {
      supersede();
      viewer.present(null);
    };
    return presented;
  };
  return viewer;
}

test('every subscriber sees the earlier mount, then the later one, with no gap', async () => {
  const a = unmountingViewer();
  const b = unmountingViewer();
  const first = [];
  const second = [];
  const unsubscribes = [
    subscribePhotoViewers([a, b], (view) => first.push(view)),
    subscribePhotoViewers([a, b], (view) => second.push(view)),
  ];
  const earlier = a.view(1);
  a.present(earlier);
  const later = b.view(2);
  b.present(later);
  await Promise.resolve();
  assert.equal(a.superseded, 1, 'superseded once, by both');
  assert.deepEqual(first, [null, earlier, later]);
  assert.deepEqual(second, [null, earlier, later], 'never null between');
  for (const unsubscribe of unsubscribes) unsubscribe();
});

test('a presentation without a mount key counts as the latest mount', () => {
  const a = fakeViewer();
  const b = fakeViewer();
  const c = fakeViewer();
  const shown = [];
  const unsubscribe = subscribePhotoViewers([a, b, c], (view) =>
    shown.push(view),
  );
  a.present(a.view(5));
  const keyless = { actions: {} };
  b.present(keyless);
  assert.equal(shown.at(-1), keyless, 'after the keyed one');
  // A keyed mount presenting later does not take it back.
  a.present(a.view(6));
  assert.equal(shown.at(-1), keyless);
  // Of two without, the one that began presenting last.
  const newer = { actions: {} };
  c.present(newer);
  assert.equal(shown.at(-1), newer);
  b.present({ ...keyless, kind: 'flat' });
  assert.equal(shown.at(-1), newer, 'presenting again is not a new mount');
  unsubscribe();
});

test('a presentation without actions or supersede is drawn and passed over without throwing', async () => {
  const a = fakeViewer();
  const b = fakeViewer();
  const shown = [];
  const unsubscribe = subscribePhotoViewers([a, b], (view) => shown.push(view));
  a.present({ mountKey: 1 });
  const later = { mountKey: 2, actions: {} };
  assert.doesNotThrow(() => b.present(later));
  await Promise.resolve();
  assert.equal(shown.at(-1), later);
  a.present({ mountKey: 3 });
  await Promise.resolve();
  assert.equal(shown.at(-1).mountKey, 3);
  unsubscribe();
});
