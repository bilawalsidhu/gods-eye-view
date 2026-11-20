import assert from 'node:assert/strict';
import test from 'node:test';
import { createPhotoViewer } from './photoViewer.js';
import { nextViewKey, subscribePhotoViewers } from './photoViewers.js';

/**
 * A photo viewer whose presentations the test sends; `superseded` counts.
 * Unlike photoViewer.js it keeps presenting once superseded, so the order
 * is seen to come from the mount keys alone.
 */
function fakeViewer() {
  const listeners = new Set();
  let current = null;
  const viewer = {
    superseded: 0,
    view(mountKey) {
      return {
        mountKey,
        actions: { supersede: () => viewer.superseded++ },
      };
    },
    present(view) {
      current = view;
      for (const listener of [...listeners]) listener(view);
    },
    subscribeView(listener) {
      listeners.add(listener);
      listener(current);
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

test('a presentation without a mount key counts as mounted when it began presenting', async () => {
  const a = fakeViewer();
  const b = fakeViewer();
  const c = fakeViewer();
  const shown = [];
  const unsubscribe = subscribePhotoViewers([a, b, c], (view) =>
    shown.push(view),
  );
  a.present(a.view(nextViewKey()));
  const keyless = b.view(undefined);
  b.present(keyless);
  assert.equal(shown.at(-1), keyless, 'after the keyed one');
  // Of two without, the one that began presenting last.
  const newer = c.view(undefined);
  c.present(newer);
  assert.equal(shown.at(-1), newer);
  b.present({ ...keyless, kind: 'flat' });
  assert.equal(shown.at(-1), newer, 'presenting again is not a new mount');
  // A keyed mount made after them wins.
  const latest = a.view(nextViewKey());
  a.present(latest);
  assert.equal(shown.at(-1), latest);
  await Promise.resolve();
  assert.ok(b.superseded > 0 && c.superseded > 0, 'the keyless ones are told');
  unsubscribe();
});

test('a presentation that is not drawn is superseded even when the pick stays', async () => {
  const a = fakeViewer();
  const b = fakeViewer();
  const shown = [];
  const unsubscribe = subscribePhotoViewers([a, b], (view) => shown.push(view));
  const later = b.view(2);
  b.present(later);
  // An earlier mount presents once the later one is drawn.
  a.present(a.view(1));
  assert.deepEqual(shown, [null, later]);
  await Promise.resolve();
  assert.equal(a.superseded, 1);
  unsubscribe();
});

test('a photo viewer mounting while a keyless presentation shows is drawn, and the keyless one superseded', async () => {
  let superseded = 0;
  const keyless = {
    subscribeView(listener) {
      listener({ actions: { supersede: () => superseded++ } });
      return () => {};
    },
  };
  const viewer = createPhotoViewer({
    providerId: 'test',
    name: 'Test',
    sources: {},
    getPhoto: async () => null,
    step: async () => null,
    onStep() {},
  });
  const shown = [];
  const element = { clientWidth: 400, clientHeight: 250 };
  const unsubscribe = subscribePhotoViewers([keyless, viewer], (view) => {
    shown.push(view);
    if (!view?.mountKey) return;
    for (const name of ['root', 'picture', 'canvas', 'prev', 'next'])
      view.actions.attach(name, element);
  });
  const mounting = viewer.mount({});
  const outcome = await Promise.race([
    mounting.then(() => 'mounted'),
    new Promise((resolve) => setTimeout(() => resolve('pending'), 50)),
  ]);
  assert.equal(outcome, 'mounted');
  assert.ok(Number.isFinite(shown.at(-1)?.mountKey), 'the mount is drawn');
  assert.ok(superseded >= 1, 'the keyless one is told');
  viewer.unmount();
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

test('a keyless viewer on screen keeps its place when the picker is made again', async () => {
  const keyed = fakeViewer();
  const keyless = fakeViewer();
  keyed.present(keyed.view(nextViewKey()));
  const shown = [];
  let unsubscribe = subscribePhotoViewers([keyless, keyed], (view) =>
    shown.push(view),
  );
  const mounted = keyless.view(undefined);
  keyless.present(mounted);
  assert.equal(shown.at(-1), mounted);
  await Promise.resolve();
  unsubscribe();
  // A new picker, the keyless viewer first: it is still the later mount.
  const again = [];
  unsubscribe = subscribePhotoViewers([keyless, keyed], (view) =>
    again.push(view),
  );
  assert.equal(again.at(-1), mounted);
  await Promise.resolve();
  assert.equal(keyless.superseded, 0, 'never told it is not drawn');
  assert.ok(keyed.superseded > 0);
  unsubscribe();
});
