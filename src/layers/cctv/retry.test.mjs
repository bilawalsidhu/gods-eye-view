import test from 'node:test';
import assert from 'node:assert/strict';
import { createCameraRetry } from './retry.js';

function fixture(t, options = {}) {
  const a = { camera: { id: 'a' }, projection: { playback: {} } };
  let active = a,
    enabled = true,
    clock = 10000,
    complete;
  const events = [];
  let release = new Promise((resolve) => (complete = resolve));
  a.projection.playback.release = () => release;
  const controller = createCameraRetry({
    getActive: () => active,
    isEnabled: () => enabled,
    ownsRecord: (record) => record === a,
    now: () => clock,
    timeoutMs: options.timeoutMs || 1000,
    destroy: (runtime) => {
      events.push('destroy');
      return runtime?.playback?.release();
    },
    create: (record) => {
      events.push('create');
      assert.equal(record.releaseBlocked, false);
      record.projection = {};
    },
    notify: () => events.push('notify'),
  });
  t.after(controller.cancel);
  return {
    a,
    controller,
    events,
    complete: (value) => complete(value),
    switch: () => {
      controller.cancel();
      active = { camera: { id: 'b' } };
    },
    close: () => {
      controller.cancel();
      active = null;
    },
    disable: () => {
      controller.cancel();
      enabled = false;
    },
    advance: () => (clock += 5000),
    nextRelease: (value) => (release = Promise.resolve(value)),
    reselect: () => {
      enabled = true;
      active = a;
    },
  };
}
test('retry during startup destroys first and waits for lease release; repeated presses and cooldown do no work', async (t) => {
  const f = fixture(t);
  const attempt = f.controller.retry();
  assert.equal(f.a.projection, null);
  assert.equal(f.a.releaseBlocked, true);
  assert.equal(f.a.retry.status, 'loading');
  assert.deepEqual(f.events, ['destroy', 'notify']);
  assert.equal(await f.controller.retry(), false);
  f.complete(true);
  assert.equal(await attempt, true);
  assert.equal(f.a.retry.status, 'loading');
  f.controller.settle(f.a, 'ready', 'Live connected');
  assert.equal(await f.controller.retry(), false);
  assert.equal(f.events.filter((e) => e === 'create').length, 1);
  f.advance();
  const next = f.controller.retry();
  await next;
  f.controller.settle(f.a, 'ready', 'Live connected');
  assert.equal(f.a.retry.attempt > 1, true);
});
test('a canceled retry whose release fails remains honestly unavailable and recovers after reselect and explicit Refresh', async (t) => {
  for (const action of ['switch', 'close', 'disable']) {
    const f = fixture(t);
    const attempt = f.controller.retry();
    f[action]();
    f.complete(false);
    assert.equal(await attempt, false);
    assert.equal(f.a.connection.status, 'error');
    assert.equal(f.a.retry.status, 'error');
    assert.equal(f.a.releaseBlocked, true);
    assert.equal(f.events.includes('create'), false);
    f.reselect();
    f.advance();
    f.nextRelease(true);
    assert.equal(await f.controller.retry(), true);
    f.controller.settle(f.a, 'ready', 'Live connected');
    assert.equal(f.a.connection.status, 'ready');
    assert.equal(f.a.releaseBlocked, false);
  }
});
test('switch, Close and disable during release never recreate or notify a stale selected camera', async (t) => {
  for (const action of ['switch', 'close', 'disable']) {
    const f = fixture(t);
    const attempt = f.controller.retry();
    f[action]();
    f.complete(true);
    assert.equal(await attempt, false);
    assert.equal(f.events.includes('create'), false);
    assert.equal(f.a.retry.status, 'cancelled');
    assert.equal(f.a.releaseBlocked, false);
  }
});
test('failed DELETE prevents a new session, keeps cleanup retryable, and reports honest feedback', async (t) => {
  const f = fixture(t);
  const attempt = f.controller.retry();
  f.complete(false);
  assert.equal(await attempt, false);
  assert.equal(f.events.includes('create'), false);
  assert.equal(f.a.releaseBlocked, true);
  assert.equal(f.a.connection.status, 'error');
  f.advance();
  f.nextRelease(true);
  assert.equal(await f.controller.retry(), true);
  assert.equal(f.a.releaseBlocked, false);
  assert.equal(f.a.releasePrevious, null);
  f.controller.settle(f.a, 'ready', 'Live connected');
});
test('hung frame acquisition times out, destroys runtime and blocks render-loop auto resurrection', async (t) => {
  const f = fixture(t, { timeoutMs: 15 });
  const attempt = f.controller.retry();
  f.complete(true);
  await attempt;
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(f.a.retry.status, 'error');
  assert.equal(f.a.connection.status, 'error');
  assert.equal(f.a.projection, null);
  assert.equal(f.a.releaseBlocked, true);
  assert.equal(f.events.filter((e) => e === 'destroy').length, 2);
});
test('successful acquisition clears the manual deadline and later Close cancels without another runtime', async (t) => {
  const f = fixture(t, { timeoutMs: 15 });
  const attempt = f.controller.retry();
  f.complete(true);
  await attempt;
  f.controller.settle(f.a, 'ready', 'Live connected');
  f.close();
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(f.a.retry.status, 'ready');
  assert.equal(f.events.filter((e) => e === 'destroy').length, 1);
});
