import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakeEngine } from '../../src/globe/testing/fakeEngine.js';
import { createSettledState } from '../../src/app/qaProbe.js';
import {
  waitForSettled,
  whenSettled,
  whenFramesDrawn,
  whenTilesLoaded,
  whenUiSettled,
  pollPage,
  until,
} from './ready.mjs';

function pageEngine(t) {
  const engine = createFakeEngine();
  const previous = globalThis.window;
  const launches = { qaDrawn: () => ({ paused: false, replay: null }) };
  const app = {
    engine,
    launches,
    dataManager: { layers: new Map([['rocket-launches', { module: launches }]]) },
    styleManager: {
      initialRestorePromise: Promise.resolve(),
      getCockpitState: () => ({ active: false }),
    },
  };
  globalThis.window = { __godsEyeView: app };
  t.after(() => {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
    engine.destroy();
  });
  return app;
}

test('cockpit, follow and replay readiness allow held inputs and moving poses after drawn frames', async (t) => {
  for (const owner of ['cockpit', 'follow', 'replay']) {
    await t.test(owner, async (t) => {
      const { engine, styleManager, launches } = pageEngine(t);
      engine.input.suspendCameraInputs();
      let drawn = 0;
      if (owner === 'cockpit')
        styleManager.getCockpitState = () => ({ active: true });
      else if (owner === 'replay')
        launches.qaDrawn = () => ({ paused: false, replay: { active: true } });
      else
        engine.camera.follow({
          position: () => ({ x: 6378137, y: drawn * 10, z: 0 }),
          viewFrom: { x: 0, y: -100, z: 100 },
        });
      t.mock.method(engine.render, 'request', () =>
        setImmediate(() => {
          engine.fake.setPose({ heading: ++drawn / 100 });
          engine.fake.frame();
        }),
      );
      const status = await waitForSettled(createSettledState, {
        frames: 3,
        timeoutMs: 1000,
      });
      assert.equal(status.settled, true);
      assert.equal(status.framesDrawn, 3);
      assert.equal(status.observed.inputsEnabled, false);
      assert.equal(status.observed.cockpitActive, owner === 'cockpit');
      assert.equal(status.observed.following, owner === 'follow');
      assert.equal(status.observed.replaying, owner === 'replay');
      assert.ok(status.observed.lastPoseDelta.orientation > 0);
      assert.equal(engine.frames.postRender.numberOfListeners, 0);
    });
  }
});

test('camera owners do not excuse restoration, flights, missing frames or destruction', async (t) => {
  for (const unmet of [
    'initialViewRestored',
    'noFlight',
    'frameDrawn',
    'engineStarted',
  ]) {
    await t.test(unmet, async (t) => {
      const { engine, styleManager } = pageEngine(t);
      styleManager.getCockpitState = () => ({ active: true });
      engine.input.suspendCameraInputs();
      if (unmet === 'initialViewRestored')
        styleManager.initialRestorePromise = new Promise(() => {});
      if (unmet === 'noFlight')
        engine.camera.flyTo({
          destination: { x: 7000000, y: 0, z: 0 },
          duration: 1,
        });
      t.mock.method(engine.render, 'request', () => {});
      const pending = waitForSettled(createSettledState, {
        frames: 3,
        timeoutMs: 10,
      });
      await Promise.resolve();
      if (unmet === 'engineStarted') {
        engine.destroy();
        t.mock.method(engine.camera, 'pose', () => {
          throw Error('released camera');
        });
      } else engine.fake.frames(unmet === 'frameDrawn' ? 2 : 4);
      await assert.rejects(pending, (error) => {
        assert.match(error.message, new RegExp(`Readiness timeout: ${unmet}`));
        assert.match(error.message, /"cockpitActive":true/);
        return true;
      });
      assert.equal(engine.frames.postRender.numberOfListeners, 0);
    });
  }
});

test('unowned input locks and moving cameras time out with observed state', async (t) => {
  for (const moving of [false, true]) {
    await t.test(moving ? 'moving' : 'locked', async (t) => {
      const { engine } = pageEngine(t);
      if (!moving) engine.input.suspendCameraInputs();
      t.mock.method(engine.render, 'request', () => {});
      const pending = waitForSettled(createSettledState, {
        frames: 3,
        timeoutMs: 10,
      });
      await Promise.resolve();
      for (let i = 0; i < 5; i++) {
        if (moving)
          engine.fake.setPose({ position: { x: 7000000 + i, y: 0, z: 0 } });
        engine.fake.frame();
      }
      await assert.rejects(pending, (error) => {
        assert.match(error.message, /cameraPoseStable/);
        if (!moving) assert.match(error.message, /cameraInputsEnabled/);
        const observed = JSON.parse(error.message.split('; observed: ')[1]);
        assert.deepEqual(observed, {
          inputsEnabled: moving,
          following: false,
          cockpitActive: false,
          replaying: false,
          lastPoseDelta: {
            positionM: moving ? 1 : 0,
            orientation: 0,
            projection: 0,
          },
        });
        return true;
      });
    });
  }
});

test('leaving a camera owner restores strict input and pose requirements', async (t) => {
  for (const owner of ['cockpit', 'follow']) {
    await t.test(owner, async (t) => {
      const { engine, styleManager } = pageEngine(t);
      engine.input.suspendCameraInputs();
      let active = owner === 'cockpit';
      styleManager.getCockpitState = () => ({ active });
      const follow =
        owner === 'follow'
          ? engine.camera.follow({
              position: () => ({ x: 6378137, y: 0, z: 0 }),
              viewFrom: { x: 0, y: -100, z: 100 },
            })
          : null;
      t.mock.method(engine.render, 'request', () => {});
      const pending = waitForSettled(createSettledState, {
        frames: 3,
        timeoutMs: 10,
      });
      await Promise.resolve();
      engine.fake.frames(2);
      active = false;
      follow?.stop();
      engine.fake.frames(4);
      await assert.rejects(pending, /cameraInputsEnabled, cameraPoseStable/);
    });
  }
});

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

test('camera readiness also waits for the startup cover to stop intercepting clicks', async (t) => {
  pageEngine(t);
  const previous = {
    document: globalThis.document,
    getComputedStyle: globalThis.getComputedStyle,
  };
  let visibility = 'visible';
  globalThis.document = { querySelector: () => ({}) };
  globalThis.getComputedStyle = () => ({ visibility });
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  });
  let disposed = false;
  await whenSettled({
    async waitForFunction(predicate) {
      assert.equal(predicate(), false, 'a started engine still has a cover');
      visibility = 'hidden';
      assert.equal(predicate(), true);
      return {
        dispose: async () => {
          disposed = true;
        },
      };
    },
    async evaluate() {
      assert.equal(disposed, true);
    },
  });
});

test('tile and UI polling request frames so a request-mode globe progresses', async (t) => {
  const { engine } = pageEngine(t);
  const previous = globalThis.document;
  globalThis.document = { getAnimations: () => [] };
  t.after(() => {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  });
  const reasons = [];
  t.mock.method(engine.render, 'request', (reason) => reasons.push(reason));
  const page = {
    async waitForFunction(predicate) {
      assert.equal(predicate(), true);
      return { dispose: async () => {} };
    },
  };
  await whenTilesLoaded(page);
  await whenUiSettled(page);
  assert.deepEqual(reasons, ['qa-tile-readiness', 'qa-ui-readiness']);
});
