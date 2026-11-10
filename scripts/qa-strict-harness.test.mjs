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
  networkLedger,
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
