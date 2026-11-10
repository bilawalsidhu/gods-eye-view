import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakeEngine } from '../../src/globe/testing/fakeEngine.js';
import {
  whenFramesDrawn,
  whenTilesLoaded,
  whenUiSettled,
  pollPage,
  until,
} from './ready.mjs';

test('frame readiness advances a request-mode engine and removes its listener', async (t) => {
  const engine = createFakeEngine();
  const previous = globalThis.window;
  globalThis.window = { __godsEyeView: { engine } };
  t.after(() => {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
    engine.destroy();
  });
  let frames = 0;
  t.mock.method(engine.render, 'request', () =>
    queueMicrotask(() => {
      frames++;
      engine.fake.frame();
    }),
  );
  const page = { evaluate: (fn, value) => fn(value) };
  await whenFramesDrawn(page, { frames: 3, timeoutMs: 1000 });
  assert.equal(frames, 3);
  engine.fake.frame();
  await Promise.resolve();
  assert.equal(frames, 3, 'completion does not leave a render pump');
  t.mock.method(engine.render, 'request', () => {});
  await assert.rejects(
    whenFramesDrawn(page, { timeoutMs: 5 }),
    /Readiness timeout: drawn frames/,
  );
});

test('page readiness disposes polling handles and only treats timeouts as absence', async () => {
  let disposed = 0;
  const page = {
    waitForFunction: async () => ({
      dispose: async () => {
        disposed++;
      },
    }),
  };
  await whenTilesLoaded(page);
  await whenUiSettled(page);
  assert.equal(await pollPage(page, () => true, { timeoutMs: 10 }), true);
  assert.equal(disposed, 3);
  page.waitForFunction = async () => {
    throw Object.assign(new Error('late'), { name: 'TimeoutError' });
  };
  assert.equal(await pollPage(page, () => false, { timeoutMs: 10 }), false);
  page.waitForFunction = async () => {
    throw new Error('page closed');
  };
  await assert.rejects(
    pollPage(page, () => true, { timeoutMs: 10 }),
    /page closed/,
  );
});

test('scenario polling waits for evidence and identifies an unmet condition', async () => {
  let calls = 0;
  assert.equal(
    await until(() => ++calls === 3 && 'ready', { intervalMs: 1 }),
    'ready',
  );
  await assert.rejects(
    until(() => false, {
      timeoutMs: 5,
      intervalMs: 1,
      label: 'fixture response',
    }),
    /Readiness timeout: fixture response/,
  );
  await assert.rejects(
    until(() => {
      throw new Error('broken predicate');
    }),
    /broken predicate/,
  );
});
