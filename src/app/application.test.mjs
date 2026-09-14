import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createApplication } from './application.js';

const phases = ['Scene', 'Controls', 'Data', 'Tools'];
function fixture(overrides = {}) {
  const events = [];
  const constructors = Object.fromEntries(
    phases.map((phase) => [
      `create${phase}`,
      ({ defer }) => {
        events.push(`start:${phase}`);
        defer(() => events.push(`stop:${phase}`));
        return { name: phase };
      },
    ]),
  );
  return { events, app: createApplication({ ...constructors, ...overrides }) };
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('importing and constructing the package is inactive without browser globals', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    globalThis.fetch = () => { throw new Error('unexpected request'); };
    globalThis.setTimeout = () => { throw new Error('unexpected timer'); };
    const { createApplication } = await import('gods-eye-view/application');
    const fail = () => { throw new Error('unexpected construction'); };
    const app = createApplication({ createScene: fail, createControls: fail, createData: fail, createTools: fail });
    if (app.getState().status !== 'created') process.exit(1);
  `,
    ],
    { cwd: new URL('../../', import.meta.url), encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
});

test('constructors are validated before allocating anything', () => {
  assert.throws(() => createApplication({}), /Missing scene constructor/);
});

test('startup shares one promise and teardown keeps data alive for controls', async () => {
  const { app, events } = fixture({
    createTools({ scene, controls, data, defer }) {
      assert.equal(scene.name, 'Scene');
      assert.equal(controls.name, 'Controls');
      assert.equal(data.name, 'Data');
      defer(() => events.push('stop:Tools'));
      return { name: 'Tools' };
    },
  });
  const states = [];
  app.subscribe((state) => states.push(`${state.status}:${state.phase}`));
  const started = app.start();
  assert.equal(started, app.start());
  const components = await started;
  assert.ok(Object.isFrozen(components));
  assert.equal(components.tools.name, 'Tools');
  assert.equal(app.getState().status, 'ready');
  const stopped = app.destroy();
  assert.equal(stopped, app.destroy());
  await stopped;
  assert.deepEqual(events.slice(-4), [
    'stop:Tools',
    'stop:Controls',
    'stop:Data',
    'stop:Scene',
  ]);
  assert.deepEqual(app.getComponents(), {});
  assert.equal(states.at(-1), 'destroyed:null');
  await assert.rejects(app.start(), /destroyed/);
});

for (const phase of phases) {
  test(`failure during ${phase} releases partially acquired resources`, async () => {
    const { app, events } = fixture({
      [`create${phase}`]({ defer }) {
        defer(() => events.push('partial:released'));
        throw new Error('broken constructor');
      },
    });
    await assert.rejects(app.start(), /broken constructor/);
    assert.equal(
      events.filter((value) => value === 'partial:released').length,
      1,
    );
    assert.equal(app.getState().status, 'failed');
    assert.deepEqual(app.getComponents(), {});
    await app.destroy();
    assert.equal(
      events.filter((value) => value === 'partial:released').length,
      1,
    );
  });
}

test('destroy before startup prevents every constructor', async () => {
  const { app, events } = fixture();
  const started = app.start();
  const failed = assert.rejects(started, { name: 'AbortError' });
  await app.destroy();
  await failed;
  assert.deepEqual(events, []);
});

test('destroy aborts an in-flight constructor and cleans late acquisitions before resolving', async () => {
  const gate = deferred();
  const entered = deferred();
  let observedSignal;
  const { app, events } = fixture({
    async createScene({ signal, defer }) {
      observedSignal = signal;
      entered.resolve();
      await gate.promise;
      defer(() => events.push('late:released'));
      return {};
    },
  });
  const started = app.start();
  const failed = assert.rejects(started, { name: 'AbortError' });
  await entered.promise;
  let settled = false;
  const stopped = app.destroy().then(() => {
    settled = true;
  });
  assert.equal(observedSignal.aborted, true);
  await Promise.resolve();
  assert.equal(settled, false);
  gate.resolve();
  await stopped;
  await failed;
  assert.deepEqual(events, ['late:released']);
});

test('cleanup errors are reported after all remaining resources are attempted', async () => {
  const { app, events } = fixture({
    createTools({ defer }) {
      defer(() => events.push('tools:earlier'));
      defer(() => {
        throw new Error('dispose failed');
      });
      return {};
    },
  });
  await app.start();
  await assert.rejects(app.destroy(), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors[0].message, 'dispose failed');
    return true;
  });
  assert.deepEqual(events.slice(-4), [
    'tools:earlier',
    'stop:Controls',
    'stop:Data',
    'stop:Scene',
  ]);
  assert.equal(app.getState().status, 'failed');
});

test('subscribers can destroy during startup without allowing the next constructor', async () => {
  const { app, events } = fixture();
  app.subscribe((state) => {
    if (state.phase === 'controls') void app.destroy();
  });
  await assert.rejects(app.start(), { name: 'AbortError' });
  await app.destroy();
  assert.deepEqual(events, ['start:Scene', 'stop:Scene']);
});

test('destroy during ready notification rejects startup and tears everything down', async () => {
  const { app } = fixture();
  app.subscribe((state) => {
    if (state.status === 'ready') void app.destroy();
  });
  await assert.rejects(app.start(), { name: 'AbortError' });
  await app.destroy();
  assert.equal(app.getState().status, 'destroyed');
});

test('cleanup registration closes when a constructor settles', async () => {
  let register;
  const { app } = fixture({
    createScene({ defer }) {
      register = defer;
      return {};
    },
  });
  await app.start();
  assert.throws(() => register(() => {}), /during component construction/);
  await app.destroy();
});

test('different application instances do not share lifecycle state', async () => {
  const first = fixture();
  const second = fixture();
  await Promise.all([first.app.start(), second.app.start()]);
  await first.app.destroy();
  assert.equal(second.app.getState().status, 'ready');
  assert.equal(second.events.length, 4);
  await second.app.destroy();
});

test('the separate viewer export imports without constructing a browser viewer', async () => {
  const { createApplicationViewer } =
    await import('gods-eye-view/application/viewer');
  assert.equal(typeof createApplicationViewer, 'function');
  assert.throws(() => createApplicationViewer({}), /containers are required/);
});
