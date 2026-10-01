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
