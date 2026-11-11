import test from 'node:test';
import assert from 'node:assert/strict';
import { createSceneHost } from './sceneHost.js';
import { resolveEngineKind, ENGINE_STORAGE_KEY } from './engineChoice.js';

test('a history visit without ?engine= keeps the engine the page started with', async () => {
  // Tab A: no ?engine= in its address, started Navara from the stored choice.
  const store = new Map([[ENGINE_STORAGE_KEY, 'navara']]);
  const storage = { getItem: (key) => store.get(key) ?? null };
  const search = '?view=1'; // no engine parameter
  const initial = resolveEngineKind({ search, storage });
  const requested = () => resolveEngineKind({ search, fallback: initial });
  assert.equal(initial, 'navara');
  const entered = [];
  const switcher = createSceneHost().createSwitcher({
    kind: initial,
    requested,
    signal: new AbortController().signal,
    leave: async () => {},
    enter: async (kind) => entered.push(kind),
    address: { select: () => null, commit() {}, restore() {} },
    settle: async () => {},
  });
  // Tab B picks Cesium and remembers it in the shared storage.
  store.set(ENGINE_STORAGE_KEY, 'cesium');
  // Tab A: a popstate (a pasted share link that changes only the hash).
  await switcher.reconcile();
  assert.deepEqual(entered, [], `tab A switched to ${entered.join(',')}`);
  assert.equal(switcher.state().engine, 'navara');
});
