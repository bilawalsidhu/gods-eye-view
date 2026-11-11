// The debug handle is one object for the page; it is on window only while a
// globe is attached, as when every engine built its own application, so
// scripts reading `__godsEyeView?.engine.kind` never see a null engine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApplicationTools } from './tools.js';
import { createSceneHost } from './sceneHost.js';
import { createFakeEngine } from '../globe/testing/fakeEngine.js';

test('the debug handle leaves window between engines and comes back the same', async (t) => {
  const saved = {
    window: globalThis.window,
    document: globalThis.document,
    localStorage: globalThis.localStorage,
  };
  globalThis.window = {};
  globalThis.localStorage = {
    getItem: () => null,
    setItem() {},
    removeItem() {},
  };
  globalThis.document = {
    hidden: false,
    getElementById: () => null,
    querySelector: () => null,
    body: {
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      appendChild() {},
    },
    addEventListener() {},
    removeEventListener() {},
  };
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete globalThis[name];
      else globalThis[name] = value;
    }
  });
  const sceneHost = createSceneHost();
  const navara = (kind) => ({
    kind,
    viewer: null,
    engine: createFakeEngine({ kind, canvas: new EventTarget() }),
    tileset: null,
    mapStackController: { kind: 'maps' },
    operations: { surface: {} },
  });
  let current = navara('navara');
  await sceneHost.attach(current);
  const scene = {
    operations: { surface: {} },
    sceneHost,
    current: () => current,
  };
  const cleanups = [];
  await createApplicationTools({
    scene,
    voice: {
      createControl: () => ({ update() {}, on: () => () => {}, remove() {} }),
      createCard: () => null,
      createSession: () => ({
        async start() {},
        stop() {},
        sendText() {},
        sendMapEvent() {},
      }),
    },
    controls: { styleManager: {}, weatherEffects: null },
    data: {
      dataManager: { layers: new Map(), getAll: () => [] },
      presentation: { flushVisible() {} },
    },
    signal: new AbortController().signal,
    defer: (dispose) => cleanups.push(dispose),
  });
  const handle = window.__godsEyeView;
  assert.equal(handle.engine, current.engine);
  await sceneHost.detach({ handoff: true });
  assert.equal(window.__godsEyeView, undefined);
  assert.equal(handle.engine, null);
  current = navara('navara');
  await sceneHost.attach(current);
  assert.equal(window.__godsEyeView, handle);
  assert.equal(handle.engine, current.engine);
  while (cleanups.length) await cleanups.pop()();
  assert.equal(window.__godsEyeView, undefined);
});
