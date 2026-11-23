import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(
  new URL('../app/startupChrome.js', import.meta.url),
  'utf8',
)
  .replace(/^import .*;\n/gm, '')
  .replace('export function', 'function');

function fixture({
  playOpening,
  hasShareState = false,
  shareLink,
  navigationGeneration,
} = {}) {
  const timers = new Map();
  const listeners = new Map();
  const events = [];
  let restored;
  let nextTimer = 0;
  const controller = new AbortController();
  const context = {
    console,
    setTimeout(fn, delay) {
      const id = ++nextTimer;
      timers.set(id, { fn, delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    initFirstRunExperience() {
      events.push('welcome');
      return { destroy: () => events.push('welcome:destroy') };
    },
    async initKeySetup() {
      return { destroy: () => events.push('settings:destroy') };
    },
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  const styleManager = {
    _navigationGeneration: navigationGeneration,
    hasShareState,
    viewer: 'viewer',
    shareLinkManager: shareLink,
    initialRestorePromise: new Promise((resolve) => {
      restored = resolve;
    }),
  };
  const stop = context.startApplicationChrome({
    initializeSettings: context.initKeySetup,
    loadingScreen: {
      classList: { add: (value) => events.push(value) },
      addEventListener: (type, listener) => listeners.set(type, listener),
      removeEventListener: (type) => listeners.delete(type),
    },
    playOpening,
    styleManager,
    dataManager: {},
    signal: controller.signal,
  });
  return {
    events,
    styleManager,
    listeners,
    stop,
    restored,
    controller,
    fire(delay) {
      for (const [id, task] of timers) {
        if (task.delay === delay) {
          timers.delete(id);
          task.fn();
        }
      }
    },
    timers,
  };
}
async function flush() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

test('welcome waits for restoration, minimum delay, and the cover transition', async () => {
  const f = fixture();
  f.fire(1000);
  await flush();
  assert.deepEqual(f.events, []);
  f.restored();
  await flush();
  assert.deepEqual(f.events, ['hidden']);
  f.listeners.get('transitionend')();
  f.fire(900);
  assert.deepEqual(f.events, ['hidden', 'welcome']);
  await f.stop();
  assert.deepEqual(f.events.slice(-2), ['welcome:destroy', 'settings:destroy']);
  assert.equal(f.timers.size, 0);
});

test('reduced motion uses the bounded fallback after the cover hides', async () => {
  const f = fixture();
  f.restored();
  f.fire(1000);
  await flush();
  f.fire(900);
  assert.deepEqual(f.events, ['hidden', 'welcome']);
  await f.stop();
});

test('shutdown while restore is pending never reveals late welcome UI', async () => {
  const f = fixture();
  f.controller.abort();
  await f.stop();
  f.restored();
  await flush();
  f.fire(1000);
  f.fire(900);
  assert.deepEqual(f.events, ['settings:destroy']);
  assert.equal(f.listeners.size, 0);
  assert.equal(f.timers.size, 0);
});

test('shutdown during the cover transition cancels the listener and fallback', async () => {
  const f = fixture();
  f.restored();
  f.fire(1000);
  await flush();
  const transition = f.listeners.get('transitionend');
  f.controller.abort();
  await f.stop();
  transition();
  f.fire(900);
  assert.deepEqual(f.events, ['hidden', 'settings:destroy']);
});

function openingStub(events) {
  let land;
  const calls = [];
  const play = (options) => {
    calls.push(options);
    events.push('opening');
    return {
      done: new Promise((resolve) => {
        land = resolve;
      }),
      cancel: () => events.push('opening:cancel'),
    };
  };
  return { play, calls, land: () => land() };
}

test('a bare address plays the opening, and welcome waits for its end', async () => {
  const events = [];
  const opening = openingStub(events);
  const f = fixture({ playOpening: opening.play });
  f.events.push = (value) => events.push(value);
  f.restored();
  f.fire(1000);
  await flush();
  assert.deepEqual(events, ['opening']);
  assert.equal(opening.calls[0].viewer, 'viewer');
  f.fire(900);
  assert.deepEqual(events, ['opening'], 'no fallback timer while it plays');
  f.listeners.get('transitionend')(); // the cover has faded
  opening.land();
  await flush();
  assert.deepEqual(events, ['opening', 'welcome']);
  await f.stop();
  assert.ok(events.includes('opening:cancel'));
});

test("the opening's frames stay out of the address until it ends", async () => {
  const events = [];
  const holds = [];
  const opening = openingStub(events);
  const f = fixture({
    playOpening: opening.play,
    shareLink: { holdWrites: (held, owner) => holds.push([held, owner]) },
  });
  f.restored();
  f.fire(1000);
  await flush();
  assert.deepEqual(holds, [[true, 'opening']]);
  opening.land();
  await flush();
  assert.deepEqual(holds, [
    [true, 'opening'],
    [false, 'opening'],
  ]);
  await f.stop();
});

test('an opening that does not play releases the address at once', async () => {
  const holds = [];
  const f = fixture({
    playOpening: () => null,
    shareLink: { holdWrites: (held, owner) => holds.push([held, owner]) },
  });
  f.restored();
  f.fire(1000);
  await flush();
  assert.deepEqual(holds, [
    [true, 'opening'],
    [false, 'opening'],
  ]);
  assert.ok(f.events.includes('hidden'));
  await f.stop();
});

const VIEW_ONLY = Object.freeze({
  status: 'settled',
  share: { camera: 'applied' },
  tracking: { status: 'skipped', reason: 'no-shared-target' },
  thing: false,
});

test('a link to only a view opens with the opening, ending at that view', async () => {
  const events = [];
  const opening = openingStub(events);
  const f = fixture({ playOpening: opening.play, hasShareState: true });
  f.restored(VIEW_ONLY);
  f.fire(1000);
  await flush();
  assert.equal(opening.calls.length, 1);
  await f.stop();
});

for (const [name, restored] of [
  ['a followed target', { ...VIEW_ONLY, tracking: { status: 'restored' } }],
  ['a shared thing', { ...VIEW_ONLY, thing: true }],
  [
    'a camera the person moved first',
    { ...VIEW_ONLY, share: { camera: 'superseded' } },
  ],
  ['a failed restore', { status: 'failed' }],
]) {
  test(`a link to ${name} opens without the opening`, async () => {
    for (const [result, plays] of [
      [restored, 0],
      [VIEW_ONLY, 1],
    ]) {
      const opening = openingStub([]);
      const f = fixture({ playOpening: opening.play, hasShareState: true });
      f.restored(result);
      f.fire(1000);
      await flush();
      assert.equal(opening.calls.length, plays);
      if (!plays) assert.deepEqual(f.events, ['hidden']);
      await f.stop();
    }
  });
}

test('a share restore whose navigation was superseded does not start the opening', async () => {
  const opening = openingStub([]);
  const f = fixture({
    playOpening: opening.play,
    hasShareState: true,
    navigationGeneration: 5,
  });
  f.restored({ ...VIEW_ONLY, navigationToken: 3 });
  f.fire(1000);
  await flush();
  assert.equal(opening.calls.length, 0);
  assert.deepEqual(f.events, ['hidden']);
  await f.stop();
});

test('a navigation before the opening starts keeps the camera from it', async () => {
  const opening = openingStub([]);
  const f = fixture({ playOpening: opening.play, navigationGeneration: 0 });
  f.styleManager._navigationGeneration = 1;
  f.restored();
  f.fire(1000);
  await flush();
  assert.equal(opening.calls.length, 0);
  assert.deepEqual(f.events, ['hidden']);
  await f.stop();
});

for (const [name, rejectedShareCode, plays] of [
  ['a rejected share code opens without the opening', 'checksum', 0],
  ['control: a bare address still plays it', null, 1],
]) {
  test(name, async () => {
    const opening = openingStub([]);
    const f = fixture({
      playOpening: opening.play,
      shareLink: { rejectedShareCode },
    });
    f.restored({ status: 'not-requested', share: null, layers: [] });
    f.fire(1000);
    await flush();
    assert.equal(opening.calls.length, plays);
    if (!plays) assert.deepEqual(f.events, ['hidden']);
    await f.stop();
  });
}

test('a skipped opening reveals welcome only once the cover has faded', async () => {
  const f = fixture({
    playOpening: () => ({ done: Promise.resolve(), cancel() {} }),
  });
  f.restored();
  f.fire(1000);
  await flush();
  assert.ok(!f.events.includes('welcome'));
  f.fire(900);
  assert.ok(f.events.includes('welcome'));
  await f.stop();
});
