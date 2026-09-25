import test from 'node:test';
import assert from 'node:assert/strict';
import { createUpstreamGate } from '../../server/providers/xweather/gate.js';

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));
function held() {
  const started = [];
  const work = (signal) =>
    new Promise((resolve, reject) => {
      started.push({ resolve, signal });
      signal.addEventListener('abort', () => reject(signal.reason), {
        once: true,
      });
    });
  return { started, work };
}

test('one key runs its work once for every waiter', async () => {
  const run = createUpstreamGate();
  const { started, work } = held();
  const a = run('k', work, new AbortController().signal);
  const b = run('k', work, new AbortController().signal);
  await nextTurn();
  assert.equal(started.length, 1);
  started[0].resolve('value');
  assert.deepEqual(await Promise.all([a, b]), ['value', 'value']);
});

test('the work is aborted only when its last waiter leaves', async () => {
  const run = createUpstreamGate();
  const { started, work } = held();
  const first = new AbortController();
  const second = new AbortController();
  const a = run('k', work, first.signal);
  const b = run('k', work, second.signal);
  await nextTurn();
  first.abort();
  await nextTurn();
  assert.equal(started[0].signal.aborted, false);
  second.abort();
  assert.equal(started[0].signal.aborted, true);
  await assert.rejects(a, { code: 'xweather_request_cancelled' });
  await assert.rejects(b, { code: 'xweather_request_cancelled' });
  // A later caller starts afresh instead of joining the aborted work.
  const c = run('k', work, new AbortController().signal);
  await nextTurn();
  assert.equal(started.length, 2);
  started[1].resolve('again');
  assert.equal(await c, 'again');
});

test('concurrency and the queue bound are enforced before work starts', async () => {
  const run = createUpstreamGate({ concurrency: 2, queueLimit: 2 });
  const { started, work } = held();
  const signal = new AbortController().signal;
  const runs = ['a', 'b', 'c', 'd'].map((key) => run(key, work, signal));
  await nextTurn();
  assert.equal(started.length, 2);
  await assert.rejects(run('e', work, signal), {
    code: 'xweather_busy',
    status: 429,
  });
  started[0].resolve(1);
  await nextTurn();
  assert.equal(started.length, 3);
  for (let i = 1; i < 4; i++) {
    started[i]?.resolve(i + 1);
    await nextTurn();
  }
  assert.deepEqual(await Promise.all(runs), [1, 2, 3, 4]);
});

test('the deadline aborts the work and rejects as cancelled', async () => {
  const run = createUpstreamGate({ timeoutMs: 5 });
  const { started, work } = held();
  await assert.rejects(run('k', work, new AbortController().signal), {
    code: 'xweather_request_cancelled',
  });
  assert.equal(started[0].signal.aborted, true);
});
