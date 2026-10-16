import assert from 'node:assert/strict';
import test from 'node:test';

import { createSingleflight } from './singleflight.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('equivalent concurrent callers share one loader execution', async () => {
  const gate = deferred();
  const lane = createSingleflight();
  let loads = 0;

  const loader = async () => {
    loads += 1;
    return gate.promise;
  };
  const first = lane.run('terrain:fixture', loader);
  const second = lane.run('terrain:fixture', loader);

  await Promise.resolve();
  assert.equal(loads, 1);
  assert.equal(lane.getInFlightCount(), 1);

  gate.resolve({ value: 7 });
  assert.deepEqual(await first, { value: 7 });
  assert.deepEqual(await second, { value: 7 });
  assert.equal(lane.getInFlightCount(), 0);
});

test('one caller can abort without cancelling another waiter', async () => {
  const gate = deferred();
  const lane = createSingleflight();
  const caller = new AbortController();
  let sharedSignal;

  const loader = ({ signal }) => {
    sharedSignal = signal;
    return gate.promise;
  };
  const first = lane.run('shared', loader, { signal: caller.signal });
  const second = lane.run('shared', loader);

  await Promise.resolve();
  caller.abort();
  await assert.rejects(first, { name: 'AbortError' });
  assert.equal(sharedSignal.aborted, false);

  gate.resolve('ok');
  assert.equal(await second, 'ok');
});

test('the last cancelled waiter aborts the shared loader', async () => {
  const lane = createSingleflight();
  const caller = new AbortController();
  let sharedSignal;

  const pending = lane.run(
    'cancel',
    ({ signal }) => {
      sharedSignal = signal;
      return new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        });
      });
    },
    { signal: caller.signal },
  );

  await Promise.resolve();
  caller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(sharedSignal.aborted, true);
});

test('a settled key may load again', async () => {
  const lane = createSingleflight();
  let loads = 0;
  const loader = async () => ++loads;

  assert.equal(await lane.run('again', loader), 1);
  assert.equal(await lane.run('again', loader), 2);
});

test('the last abandoned waiter evicts keys even when a loader ignores abort', async () => {
  const lane = createSingleflight();
  for (let i = 0; i < 12; i += 1) {
    const caller = new AbortController();
    const pending = lane.run(
      'stalled-' + i,
      () => new Promise(() => {}),
      { signal: caller.signal },
    );
    await Promise.resolve();
    caller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(lane.getInFlightCount(), 0);
  }
});

test('late abandoned transport cannot evict a replacement under the same key', async () => {
  const lane = createSingleflight();
  const caller = new AbortController();
  const abandoned = deferred();
  const first = lane.run('reused-key', () => abandoned.promise, {
    signal: caller.signal,
  });
  await Promise.resolve();
  caller.abort();
  await assert.rejects(first, { name: 'AbortError' });
  assert.equal(lane.getInFlightCount(), 0);

  const replacement = deferred();
  const second = lane.run('reused-key', () => replacement.promise);
  await Promise.resolve();
  assert.equal(lane.getInFlightCount(), 1);

  abandoned.resolve('stale');
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(lane.getInFlightCount(), 1);

  replacement.resolve('current');
  assert.equal(await second, 'current');
  assert.equal(lane.getInFlightCount(), 0);
});

test('immediate cancellation prevents a not-yet-started loader from running', async () => {
  const lane = createSingleflight();
  const caller = new AbortController();
  let loaderCalls = 0;
  const pending = lane.run(
    'cancel-before-microtask',
    () => {
      loaderCalls += 1;
      return 'unexpected work';
    },
    { signal: caller.signal },
  );
  caller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  await Promise.resolve();
  assert.equal(loaderCalls, 0);
  assert.equal(lane.getInFlightCount(), 0);
});

test('immediate abort of one caller retains a loader needed by a surviving caller', async () => {
  const lane = createSingleflight();
  const caller = new AbortController();
  const gate = deferred();
  let loaderCalls = 0;
  const loader = () => {
    loaderCalls += 1;
    return gate.promise;
  };
  const discarded = lane.run('shared-before-microtask', loader, {
    signal: caller.signal,
  });
  const retained = lane.run('shared-before-microtask', loader);
  caller.abort();
  await assert.rejects(discarded, { name: 'AbortError' });
  assert.equal(loaderCalls, 1);
  assert.equal(lane.getInFlightCount(), 1);
  gate.resolve('retained');
  assert.equal(await retained, 'retained');
  assert.equal(lane.getInFlightCount(), 0);
});
