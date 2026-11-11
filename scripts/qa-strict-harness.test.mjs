import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import vm from 'node:vm';
import { closeBrowser, diagnoseExit, exitAfterFlush } from './qa/browser.mjs';
import { DAYTIME, daytimeNear, shiftTime } from './qa/time.mjs';
import {
  createStrict,
  installStrictNetwork,
  installContractMonitors,
  networkLedger,
  pickEngine,
} from './qa-strict-harness.mjs';

function fakeBrowser(t, close = async () => {}) {
  t.mock.method(process, 'kill', () => true);
  const stdout = { destroy: t.mock.fn() };
  const stderr = { destroy: t.mock.fn() };
  return {
    close,
    process: () => ({ pid: 12345, stdout, stderr }),
    stdout,
    stderr,
  };
}

test('closeBrowser kills the remaining group and drops both pipes after closing', async (t) => {
  const browser = fakeBrowser(t);
  const result = await closeBrowser(browser);
  assert.equal(result.closed, true);
  assert.equal(result.killed, true);
  assert.ok(result.ms >= 0);
  assert.deepEqual(
    process.kill.mock.calls.map((call) => call.arguments),
    [
      [-12345, 0],
      [-12345, 'SIGKILL'],
    ],
  );
  assert.equal(browser.stdout.destroy.mock.callCount(), 1);
  assert.equal(browser.stderr.destroy.mock.callCount(), 1);
});

test('closeBrowser bounds a stuck close and tolerates a late rejection', async (t) => {
  let reject;
  const browser = fakeBrowser(
    t,
    () =>
      new Promise((resolve, failure) => {
        reject = failure;
      }),
  );
  const result = await closeBrowser(browser, { deadlineMs: 10 });
  assert.equal(result.closed, false);
  assert.equal(result.killed, true);
  assert.ok(result.ms < 1000);
  reject(new Error('closed later'));
});

test('missing processes, dead groups and broken streams never prevent cleanup', async (t) => {
  const browser = fakeBrowser(t, () => {
    throw new Error('close failed');
  });
  t.mock.method(process, 'kill', () => {
    throw new Error('ESRCH');
  });
  browser.stdout.destroy = () => {
    throw new Error('pipe failed');
  };
  const result = await closeBrowser(browser);
  assert.equal(result.closed, false);
  assert.equal(result.killed, false);
  assert.equal(browser.stderr.destroy.mock.callCount(), 1);
  for (const process of [
    () => null,
    () => ({}),
    () => {
      throw new Error('no process');
    },
  ]) {
    const missing = await closeBrowser({ process, close: async () => {} });
    assert.equal(missing.closed, true);
    assert.equal(missing.killed, false);
  }
  assert.equal((await closeBrowser(undefined)).closed, false);
});

test('diagnostic shutdown preserves the process group and pipes', async (t) => {
  const old = process.env.QA_EXIT_DIAGNOSTICS;
  process.env.QA_EXIT_DIAGNOSTICS = '1';
  t.after(() => {
    if (old === undefined) delete process.env.QA_EXIT_DIAGNOSTICS;
    else process.env.QA_EXIT_DIAGNOSTICS = old;
  });
  const browser = fakeBrowser(t);
  const result = await closeBrowser(browser);
  assert.equal(result.closed, true);
  assert.equal(result.killed, false);
  assert.equal(process.kill.mock.callCount(), 0);
  assert.equal(browser.stdout.destroy.mock.callCount(), 0);
  assert.equal(browser.stderr.destroy.mock.callCount(), 0);
  let callback;
  const unref = t.mock.fn();
  t.mock.method(globalThis, 'setTimeout', (fn, delay) => {
    callback = fn;
    assert.equal(delay, 5000);
    return { unref };
  });
  t.mock.method(console, 'error', () => {});
  diagnoseExit([]);
  assert.equal(unref.mock.callCount(), 1);
  assert.equal(console.error.mock.callCount(), 0);
  callback();
  assert.equal(console.error.mock.calls[0].arguments[0], 'QA EXIT resources');
  assert.match(
    console.error.mock.calls[1].arguments[0],
    /pid ppid pgid elapsed command/,
  );
});

test('the page clock moves to the nearest 18:30 UTC, at most 12 hours away', () => {
  const at = (iso) => daytimeNear(Date.parse(iso));
  assert.equal(at('2026-11-10T10:00:00Z'), '2026-11-10T18:30:00.000Z');
  assert.equal(at('2026-11-10T03:00:00Z'), '2026-11-09T18:30:00.000Z');
  assert.equal(at('2026-12-31T23:00:00Z'), '2026-12-31T18:30:00.000Z');
  assert.equal(at('2027-01-01T07:00:00Z'), '2027-01-01T18:30:00.000Z');
  assert.ok(Math.abs(Date.parse(DAYTIME) - Date.now()) <= 12 * 3_600_000);
});

test('the shifted clock ticks, preserves explicit dates, and supports the real clock', () => {
  const context = vm.createContext({});
  vm.runInContext(
    `
    globalThis.tick = 1000;
    const NativeDate = Date;
    globalThis.Date = class extends NativeDate {
      static now() { return tick; }
    };
    globalThis.original = Date;
    (${shiftTime})(${JSON.stringify(DAYTIME)});
  `,
    context,
  );
  assert.equal(vm.runInContext('Date.now()', context), Date.parse(DAYTIME));
  assert.equal(vm.runInContext('new Date().toISOString()', context), DAYTIME);
  assert.equal(
    vm.runInContext('tick += 250; Date.now()', context),
    Date.parse(DAYTIME) + 250,
  );
  assert.equal(vm.runInContext('new Date(0).getTime()', context), 0);
  assert.equal(
    vm.runInContext('Date.UTC(2026, 0, 1)', context),
    Date.UTC(2026, 0, 1),
  );
  vm.runInContext(
    `globalThis.Date = original; (${shiftTime})('real');`,
    context,
  );
  assert.equal(vm.runInContext('Date === original', context), true);
});

test('diagnostics keeps natural exit and the requested failure code', async (t) => {
  const old = process.env.QA_EXIT_DIAGNOSTICS;
  const code = process.exitCode;
  process.env.QA_EXIT_DIAGNOSTICS = '1';
  t.after(() => {
    if (old === undefined) delete process.env.QA_EXIT_DIAGNOSTICS;
    else process.env.QA_EXIT_DIAGNOSTICS = old;
    process.exitCode = code;
  });
  t.mock.method(process, 'exit', () => {});
  await exitAfterFlush(1);
  assert.equal(process.exit.mock.callCount(), 0);
  assert.equal(process.exitCode, 1);
});

test('each attached page gets its clock script before it is resumed', async (t) => {
  // Network installation creates a tile-cache directory; this test makes no requests.
  t.mock.method(fs, 'mkdirSync', () => {});
  for (const time of [undefined, '2026-07-15T18:00:00Z', 'real']) {
    const sessions = new Map();
    const root = new EventEmitter();
    root.send = async () => {};
    root.connection = () => ({ session: (id) => sessions.get(id) });
    await installStrictNetwork(
      { target: () => ({ createCDPSession: async () => root }) },
      {
        origin: 'http://localhost:4242',
        ledger: networkLedger(),
        time,
      },
    );
    for (let id = 1; id <= 2; id++) {
      const session = new EventEmitter();
      const calls = [];
      const ready = Promise.withResolvers();
      session.send = async (method, params) => {
        calls.push({ method, params });
        if (method === 'Runtime.runIfWaitingForDebugger') ready.resolve();
      };
      sessions.set(id, session);
      root.emit('Target.attachedToTarget', {
        sessionId: id,
        targetInfo: { type: 'page' },
        waitingForDebugger: true,
      });
      await ready.promise;
      const script = calls.find(
        (call) => call.method === 'Page.addScriptToEvaluateOnNewDocument',
      );
      assert.ok(script);
      assert.equal(calls.at(-1).method, 'Runtime.runIfWaitingForDebugger');
      const context = vm.createContext({});
      vm.runInContext(
        'globalThis.window = globalThis; window.top = window; globalThis.original = Date;',
        context,
      );
      vm.runInContext(script.params.source, context);
      if (time === 'real')
        assert.equal(vm.runInContext('Date === original', context), true);
      else
        assert.ok(
          Math.abs(
            vm.runInContext('Date.now()', context) -
              Date.parse(time ?? DAYTIME),
          ) < 1000,
        );
      assert.equal(
        vm.runInContext(
          'Object.getOwnPropertyDescriptor(window, "Cesium").get instanceof Function',
          context,
        ),
        true,
      );
    }
  }
});

test('finish writes failing evidence for final validation and body failures', async (t) => {
  const dir = fs.mkdtempSync('tmp_acceptance_evidence_');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = `${dir}/evidence.json`;
  const old = process.env.QA_STRICT_EVIDENCE;
  process.env.QA_STRICT_EVIDENCE = file;
  t.after(() => {
    if (old === undefined) delete process.env.QA_STRICT_EVIDENCE;
    else process.env.QA_STRICT_EVIDENCE = old;
  });
  t.mock.method(console, 'log', () => {});
  const strict = createStrict({
    origin: 'http://localhost:4242',
    layers: ['test'],
  });
  await assert.rejects(strict.finish(), /layers without an assertion/);
  let manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(manifest.status, 'fail');
  assert.match(manifest.error, /layers without an assertion/);
  await createStrict({ origin: 'http://localhost:4242', layers: [] }).finish({
    failed: new Error('body failed'),
  });
  manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(manifest.status, 'fail');
  assert.match(manifest.error, /body failed/);
  assert.throws(
    () =>
      createStrict({
        origin: 'http://localhost:4242',
        layers: [],
        time: 'invalid',
      }),
    /valid page time/,
  );
});

test('strict.run flushes large output and exits despite active resources on success or failure', async () => {
  const harness = new URL('./qa-strict-harness.mjs', import.meta.url).href;
  for (const fail of [false, true]) {
    const source = `
      import { createStrict } from ${JSON.stringify(harness)};
      const strict = createStrict({ origin: 'http://localhost:4242', layers: [] });
      strict.launch = async () => ({ close: async () => console.log('CLOSED'), process: () => null });
      strict.finish = async () => console.log('STRICT');
      setInterval(() => {}, 1000);
      await strict.run({}, async () => {
        process.stdout.write('x'.repeat(300000) + 'OUT_END\\n');
        process.stderr.write('y'.repeat(300000) + 'ERR_END\\n');
        if (${fail}) throw new Error('body failed');
      });
    `;
    const result = await promisify(execFile)(
      process.execPath,
      ['--input-type=module', '-e', source],
      {
        timeout: 10000,
        maxBuffer: 2000000,
        env: { ...process.env, QA_EXIT_DIAGNOSTICS: '' },
      },
    ).catch((error) => error);
    assert.equal(result.code ?? 0, fail ? 1 : 0);
    assert.match(result.stdout, /OUT_END\nCLOSED\nSTRICT\n$/);
    assert.match(result.stderr, /ERR_END/);
    if (fail) assert.match(result.stderr, /Error: body failed/);
  }
});

// Production readiness runs the same state observer as the dev-only probe.
import { createFakeEngine } from '../src/globe/testing/fakeEngine.js';
import { createSettledState } from '../src/app/qaProbe.js';
import {
  clickUntilSelected,
  waitForSettled,
  whenPickable,
  whenSettled,
} from './qa/ready.mjs';
import { drawLedger, compareLedgers } from './qa/ledger.mjs';
import { createContractMonitor } from '../src/globe/testing/contractMonitor.js';
import { QA_HARNESS_METRICS } from './report-qa-harness.mjs';
import { waitForFirstFrame } from '../src/standalone/engineSwitch.js';

test('readiness counts drawn frames and resets on orientation, flight, and input changes', async () => {
  const engine = createFakeEngine();
  const restore = Promise.withResolvers();
  const state = createSettledState(engine, () => restore.promise);
  assert.deepEqual(state.settled().unmet, [
    'initialViewRestored',
    'frameDrawn',
    'cameraPoseStable',
  ]);
  engine.fake.frames(4);
  assert.deepEqual(state.settled().unmet, ['initialViewRestored']);
  restore.resolve();
  await restore.promise;
  assert.equal(state.settled().settled, true);
  engine.fake.setPose({ heading: 0.2 });
  assert.equal(state.settled().settled, false);
  engine.fake.frames(3);
  assert.equal(state.settled().settled, false);
  engine.fake.frame();
  assert.equal(state.settled().settled, true);
  const resume = engine.input.suspendCameraInputs();
  engine.fake.frame();
  assert.ok(state.settled().unmet.includes('cameraInputsEnabled'));
  resume();
  engine.camera.flyTo({ destination: { x: 7000000, y: 0, z: 0 }, duration: 1 });
  engine.fake.frames(4);
  assert.ok(state.settled().unmet.includes('noFlight'));
  engine.camera.cancelFlight();
  engine.fake.frames(4);
  assert.equal(state.settled().settled, true);
  state.destroy();
  assert.equal(engine.frames.postRender.numberOfListeners, 0);
});

test('readiness follows a replaced or rejected restore promise', async () => {
  const engine = createFakeEngine();
  let promise = Promise.resolve();
  const state = createSettledState(engine, () => promise);
  await promise;
  engine.fake.frames(4);
  assert.equal(state.settled().settled, true);
  promise = Promise.reject(new Error('restore failed'));
  state.settled();
  await promise.catch(() => {});
  assert.deepEqual(state.settled().unmet, ['initialViewRestored']);
  assert.match(state.settled().restoreError, /restore failed/);
  state.destroy();
});

test('readiness requests real frames and cleans up on success and timeout', async (t) => {
  const engine = createFakeEngine();
  globalThis.window = {
    __godsEyeView: {
      engine,
      styleManager: { initialRestorePromise: Promise.resolve() },
    },
  };
  t.after(() => {
    delete globalThis.window;
  });
  engine.render.request = () => setImmediate(() => engine.fake.frame());
  const result = await waitForSettled(createSettledState, {
    frames: 3,
    timeoutMs: 1000,
  });
  assert.equal(result.settled, true);
  assert.equal(result.framesDrawn, 4);
  assert.equal(engine.frames.postRender.numberOfListeners, 0);
  engine.render.request = () => {};
  await assert.rejects(
    waitForSettled(createSettledState, { frames: 3, timeoutMs: 10 }),
    /frameDrawn, cameraPoseStable/,
  );
  assert.equal(engine.frames.postRender.numberOfListeners, 0);
});

test('readiness reports missing startup conditions instead of a selector timeout', async () => {
  await assert.rejects(
    whenSettled(
      {
        waitForFunction() {
          throw new Error('selector');
        },
      },
      { timeoutMs: 1 },
    ),
    /engineStarted, initialViewRestored/,
  );
});

test('readiness reports destruction without reading a released camera', async () => {
  const engine = createFakeEngine();
  const state = createSettledState(engine, () => Promise.resolve());
  engine.destroy();
  engine.camera.pose = () => {
    throw new Error('camera released');
  };
  assert.ok(state.settled().unmet.includes('engineStarted'));
  state.destroy();
});

test('pick readiness waits beyond camera rest for the intended target and requests frames', async (t) => {
  const engine = createFakeEngine();
  const restore = Promise.resolve();
  const state = createSettledState(engine, () => restore);
  await restore;
  engine.fake.frames(4);
  assert.equal(state.settled().settled, true);
  state.destroy();
  const window = { __godsEyeView: { engine } };
  engine.host.canvas.getBoundingClientRect = () => ({ left: 40, top: 25 });
  const request = t.mock.method(engine.render, 'request');
  let picked;
  t.mock.method(engine.picker, 'pick', (position) => {
    assert.deepEqual({ ...position }, { x: 60, y: 55 });
    return picked;
  });
  const dispose = t.mock.fn();
  const position = { x: 100, y: 80 };
  const result = await whenPickable(
    {
      async waitForFunction(source, options) {
        assert.deepEqual(options, { polling: 50, timeout: 30000 });
        const poll = () => vm.runInNewContext(source, { window });
        assert.equal(poll(), false);
        engine.fake.frame();
        picked = { id: 'another-vessel' };
        assert.equal(poll(), false);
        engine.fake.frame();
        picked = { id: '123456789' };
        picked.object = picked;
        const value = poll();
        return { jsonValue: () => JSON.parse(JSON.stringify(value)), dispose };
      },
    },
    position,
    (picked) => picked?.id === '123456789',
  );
  assert.deepEqual(result, position);
  assert.equal(request.mock.callCount(), 3);
  assert.ok(
    request.mock.calls.every(
      ({ arguments: args }) => args[0] === 'qa-pick-readiness',
    ),
  );
  assert.equal(dispose.mock.callCount(), 1);
  assert.equal(engine.frames.postRender.numberOfListeners, 0);
});

test('pick readiness retries a page-side locator and keeps its target identity', async (t) => {
  const engine = createFakeEngine();
  engine.host.canvas.getBoundingClientRect = () => ({ left: 0, top: 0 });
  const window = { __godsEyeView: { engine }, target: null };
  const pick = t.mock.method(engine.picker, 'pick', () => ({ id: 'line' }));
  const dispose = t.mock.fn();
  const result = await whenPickable(
    {
      async waitForFunction(source) {
        const poll = () => vm.runInNewContext(source, { window });
        assert.equal(poll(), false);
        assert.equal(pick.mock.callCount(), 0);
        window.target = { x: 12, y: 34, id: 'line' };
        return { jsonValue: () => poll(), dispose };
      },
    },
    () => window.target,
    (picked, position) => picked?.id === position.id,
  );
  assert.deepEqual(result, window.target);
  assert.equal(dispose.mock.callCount(), 1);
});

test('pick readiness reports a bounded timeout for a missing target or unavailable engine', async (t) => {
  for (const kind of ['missing target', 'missing engine', 'destroyed engine']) {
    await t.test(kind, async (t) => {
      const engine = createFakeEngine();
      engine.host.canvas.getBoundingClientRect = () => ({ left: 0, top: 0 });
      if (kind === 'destroyed engine') engine.destroy();
      const window = {
        __godsEyeView: kind === 'missing engine' ? undefined : { engine },
      };
      const pick = t.mock.method(engine.picker, 'pick', () => undefined);
      const timeout = new Error('waiting failed');
      timeout.name = 'TimeoutError';
      await assert.rejects(
        whenPickable(
          {
            async waitForFunction(source, options) {
              assert.equal(options.timeout, 10);
              assert.equal(vm.runInNewContext(source, { window }), false);
              throw timeout;
            },
          },
          { x: 1, y: 2 },
          (picked) => picked?.id === 'vessel',
          { timeoutMs: 10 },
        ),
        (error) =>
          error.message === 'Readiness timeout: pickable target' &&
          error.cause === timeout,
      );
      assert.equal(pick.mock.callCount(), kind === 'missing target' ? 1 : 0);
      assert.equal(engine.frames.postRender.numberOfListeners, 0);
    });
  }
});

test('pick readiness preserves picker errors and releases handles after a failed read', async () => {
  const failure = new Error('pick failed');
  await assert.rejects(
    whenPickable(
      {
        waitForFunction: async () => {
          throw failure;
        },
      },
      { x: 1, y: 2 },
      () => true,
    ),
    (error) => error === failure,
  );
  let disposed = false;
  await assert.rejects(
    whenPickable(
      {
        waitForFunction: async () => ({
          jsonValue: async () => {
            throw failure;
          },
          dispose: () => {
            disposed = true;
          },
        }),
      },
      { x: 1, y: 2 },
      () => true,
    ),
    (error) => error === failure,
  );
  assert.equal(disposed, true);
});

test('selection readiness retries lost clicks and stops as soon as selection succeeds', async (t) => {
  for (const succeedsAt of [1, 2, 5]) {
    await t.test(`selection on click ${succeedsAt}`, async (t) => {
      let clicks = 0;
      let selected = null;
      const selection = () => selected?.mmsi === '123456789';
      const dispose = t.mock.fn();
      await clickUntilSelected(
        {
          async waitForFunction(predicate, options) {
            assert.equal(predicate, selection);
            assert.deepEqual(options, { timeout: 2000 });
            if (predicate()) return { dispose };
            const timeout = new Error('no selection');
            timeout.name = 'TimeoutError';
            throw timeout;
          },
        },
        async () => {
          clicks++;
          if (clicks === succeedsAt) selected = { mmsi: '123456789' };
        },
        selection,
      );
      assert.equal(clicks, succeedsAt);
      assert.equal(dispose.mock.callCount(), 1);
    });
  }
});

test('selection readiness fails after five unselected clicks', async () => {
  let clicks = 0;
  let waits = 0;
  const timeout = new Error('no selection');
  timeout.name = 'TimeoutError';
  await assert.rejects(
    clickUntilSelected(
      {
        async waitForFunction(predicate, options) {
          waits++;
          assert.equal(predicate(), false);
          assert.deepEqual(options, { timeout: 2000 });
          throw timeout;
        },
      },
      async () => clicks++,
      () => false,
    ),
    (error) =>
      error.message === 'Readiness timeout: selection after 5 clicks' &&
      error.cause === timeout,
  );
  assert.equal(clicks, 5);
  assert.equal(waits, 5);
});

test('selection readiness does not retry click or page errors', async (t) => {
  for (const failureAt of ['click', 'selection']) {
    await t.test(failureAt, async () => {
      let clicks = 0;
      const failure = new Error('page closed');
      await assert.rejects(
        clickUntilSelected(
          {
            async waitForFunction() {
              throw failure;
            },
          },
          async () => {
            clicks++;
            if (failureAt === 'click') throw failure;
          },
          () => false,
        ),
        (error) => error === failure,
      );
      assert.equal(clicks, 1);
    });
  }
});

test('draw ledgers normalize all five families and compare absences and visibility', async (t) => {
  const engine = createFakeEngine();
  // A mover set counts as shown once one of its drawn instances is.
  const points = engine.movers.createSet({
    id: 'point',
    kind: 'point',
    capacity: 1,
    point: { sizePx: 4, color: [1, 1, 1, 1] },
  });
  points.set(0, { position: { x: 1, y: 0, z: 0 } });
  points.setCount(1);
  points.commit();
  engine.lines.createLine({ id: 'line', color: [1, 1, 1, 1], widthPx: 1 });
  engine.ground.createSet({ id: 'ground', kind: 'disc' });
  engine.imagery.list = () => [{ id: 'tiles', kind: 'xyz', shown: true }];
  engine.meshes.list = () => [{ id: 'model', shown: true }];
  globalThis.window = { __godsEyeView: { engine } };
  t.after(() => {
    delete globalThis.window;
  });
  const before = await drawLedger({ evaluate: (fn) => fn() });
  assert.ok(before.every((row) => row.shown === true));
  assert.deepEqual(
    before.map((row) => row.family),
    ['ground', 'imagery', 'lines', 'meshes', 'movers'],
  );
  const after = before
    .filter((row) => row.id !== 'line')
    .map((row) => ({ ...row, shown: row.id !== 'point' }));
  after.push({ id: 'overlay', family: 'imagery' });
  const comparison = compareLedgers(before, after, [
    { id: 'overlay', reason: 'engine overlay' },
  ]);
  assert.deepEqual(comparison.onlyBefore, [{ id: 'line', family: 'lines' }]);
  assert.deepEqual(comparison.onlyAfter, []);
  assert.deepEqual(comparison.shown, [
    { id: 'point', family: 'movers', before: true, after: false },
  ]);
  assert.equal(comparison.allowed[0].reason, 'engine overlay');
  assert.deepEqual(
    compareLedgers(
      [{ id: 'same', family: 'movers' }],
      [{ id: 'same', family: 'movers', shown: true }],
    ).shown,
    [],
  );
});

test('the strict scenario set has no private launches, sleeps, or loading-screen readiness', () => {
  const runner = fs.readFileSync(
    new URL('./qa-all-layer-switches.mjs', import.meta.url),
    'utf8',
  );
  const runs = vm.runInNewContext(
    runner.match(/const runs = ([\s\S]*?);\n/)[1],
    { soakRuns: [], longRun: '' },
  );
  const files = [...new Set(runs.map(([, script]) => script))].map((name) => ({
    file: `qa-${name}.mjs`,
    text: fs.readFileSync(new URL(`./qa-${name}.mjs`, import.meta.url), 'utf8'),
  }));
  for (const metric of QA_HARNESS_METRICS.filter(({ id }) =>
    ['ownLaunch', 'fixedSleeps', 'loadingScreenReadiness'].includes(id),
  )) {
    assert.deepEqual(
      files.filter((file) => metric.measure([file])).map(({ file }) => file),
      [],
      metric.id,
    );
  }
});

test('the injected monitor follows debug-handle attachments and streams evidence before close', async () => {
  const rows = [];
  const first = createFakeEngine({ kind: 'navara' });
  const second = createFakeEngine({ kind: 'cesium' });
  const context = vm.createContext({
    document: {},
    MutationObserver: class {
      observe() {}
    },
    first,
    second,
    queueMicrotask,
    setTimeout,
    clearTimeout,
    report: (json) => rows.push(JSON.parse(json)),
  });
  vm.runInContext(
    `
    globalThis.window = globalThis;
    window.top = window;
    window.addEventListener = () => {};
    window.__gevStrictMonitor = report;
    (${installContractMonitors})(${createContractMonitor});
    const debug = { engine: first };
    window.__godsEyeView = debug;
    delete window.__godsEyeView;
    debug.engine = null;
    debug.engine = second;
    window.__godsEyeView = debug;
  `,
    context,
  );
  assert.deepEqual(
    rows.map(({ kind }) => kind),
    ['navara', 'cesium'],
  );
  first.destroy();
  first.fake.emit('camera.changed');
  second.input.suspendCameraInputs();
  await vm.runInContext('window.__qaFinishMonitors()', context);
  await vm.runInContext('window.__qaFinishMonitors()', context);
  assert.deepEqual(
    rows.filter(({ record }) => record).map(({ record }) => record.invariant),
    ['event-after-destroy', 'final-inputs-disabled'],
  );
  assert.equal(rows.filter(({ finished }) => finished).length, 2);
});

test('the first-frame outcome names the actual frame, visibility, or timeout path', async () => {
  for (const path of ['frame', 'hidden', 'timeout']) {
    const engine = createFakeEngine({ canvas: { dataset: {} } });
    let timer;
    const result = waitForFirstFrame(engine, {
      document: { hidden: path === 'hidden' },
      setTimer: (callback) => {
        timer = callback;
      },
      clearTimer() {},
    });
    if (path === 'frame') {
      engine.fake.frame();
      timer();
    }
    if (path === 'timeout') timer();
    assert.equal(await result, path === 'frame');
    assert.equal(engine.host.canvas.dataset.firstFrameOutcome, path);
  }
});

test('picker readiness also settles the surviving engine after a rollback', async (t) => {
  const engine = createFakeEngine({ kind: 'navara' });
  const element = {
    value: 'navara',
    tagName: 'SELECT',
    id: 'globe-engine',
    className: '',
    closest: () => element,
    getAttribute: () => 'true',
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 30 }),
    addEventListener() {},
  };
  globalThis.window = {
    __godsEyeView: {
      engine,
      styleManager: { initialRestorePromise: Promise.resolve() },
    },
  };
  globalThis.document = {
    activeElement: element,
    querySelector: (selector) =>
      selector === '#globe-engine' ? element : null,
    elementFromPoint: () => element,
  };
  globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
  };
  // The keyless check reads the page address for the tiles fixture.
  globalThis.location = new URL('http://localhost:4300/');
  t.after(() => {
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.MutationObserver;
    delete globalThis.location;
  });
  engine.render.request = () => setImmediate(() => engine.fake.frame());
  const page = {
    $: async () => null,
    $eval: async (selector, fn) => fn(element),
    $$eval: async (selector, fn) =>
      fn([{ value: 'cesium' }, { value: 'navara' }]),
    evaluate: async (fn) =>
      typeof fn === 'string' ? vm.runInThisContext(fn) : fn(),
    waitForSelector: async () => {},
    waitForFunction: async (fn, options, arg) => assert.ok(fn(arg)),
    mouse: { click: async () => {} },
    keyboard: {
      type: async () => {
        // A failed attempt leaves the original engine and picker value intact.
        Object.assign(window.__qaPick, {
          changed: true,
          busy: true,
          at: 1,
          idleAt: 2,
        });
      },
    },
  };
  const result = await pickEngine(page, 'cesium');
  assert.equal(result.idleAt, 2);
  assert.equal(engine.frames.postRender.numberOfListeners, 0);
});
