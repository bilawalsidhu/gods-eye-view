import test from 'node:test';
import assert from 'node:assert/strict';
import { createInatQueue } from './queue.js';

async function until(check) {
  for (let i = 0; i < 100; i += 1) {
    if (check()) return;
    await new Promise(setImmediate);
  }
  assert.fail('queue did not reach its expected state');
}

test('shared governor paces a four-call burst within the rolling minute ceiling', async () => {
  let at = 0;
  const waits = [];
  const queue = createInatQueue({
    now: () => at,
    wait: async (ms) => {
      waits.push(ms);
      at += ms;
    },
  });
  const dispatched = [];
  await Promise.all(
    Array.from({ length: 65 }, () => queue(() => dispatched.push(at))),
  );
  assert.equal(dispatched.length, 65);
  assert.deepEqual(dispatched.slice(0, 7), [0, 0, 0, 0, 1000, 2000, 3000]);
  assert.deepEqual(waits.slice(0, 3), [1000, 1000, 1000]);
  for (const time of dispatched)
    assert.ok(
      dispatched.filter((other) => other > time - 60_000 && other <= time)
        .length <= 60,
    );
  assert.equal(dispatched[60], 60_000);
});

test('an observation arriving during the pacing wait overtakes queued tiles', async () => {
  let at = 0;
  const waits = [];
  const queue = createInatQueue({
    burst: 1,
    now: () => at,
    wait: (ms) => new Promise((resolve) => waits.push({ ms, resolve })),
  });
  const dispatched = [];
  await queue(() => dispatched.push('first tile'));
  const tile = queue(() => dispatched.push('waiting tile'));
  await until(() => waits.length === 1);
  const observation = queue(() => dispatched.push('observation'), {
    priority: 0,
  });
  at += waits[0].ms;
  waits[0].resolve();
  await observation;
  assert.deepEqual(dispatched, ['first tile', 'observation']);
  await until(() => waits.length === 2);
  at += waits[1].ms;
  waits[1].resolve();
  await tile;
  assert.deepEqual(dispatched, ['first tile', 'observation', 'waiting tile']);
});

test('superseded tasks leave before dispatch, and a rejection cannot poison the tail', async () => {
  const queue = createInatQueue({ intervalMs: 0 });
  const dispatched = [];
  let release;
  const first = queue(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await until(() => release);
  const controller = new AbortController();
  const superseded = queue(() => assert.fail('superseded tile dispatched'), {
    signal: controller.signal,
  });
  const dropped = assert.rejects(superseded, { name: 'AbortError' });
  controller.abort();
  await dropped;
  const failed = queue(() => {
    dispatched.push('failed');
    throw new Error('synthetic');
  });
  const failure = assert.rejects(failed, /synthetic/);
  const succeeding = queue(() => dispatched.push('recovered'));
  release();
  await Promise.all([first, failure, succeeding]);
  assert.deepEqual(dispatched, ['failed', 'recovered']);
});

test('a slow call does not hold later calls; at most four run at once', async () => {
  const queue = createInatQueue({ intervalMs: 0, windowMs: 0 });
  const releases = [];
  const started = [];
  const slow = (id) => () =>
    new Promise((resolve) => {
      started.push(id);
      releases.push(() => resolve(id));
    });
  const jobs = [1, 2, 3, 4, 5].map((id) => queue(slow(id)));
  await until(() => started.length === 4);
  assert.deepEqual(started, [1, 2, 3, 4], 'four start without waiting');
  releases[1]();
  assert.equal(await jobs[1], 2, 'a later call finishes before the first');
  await until(() => started.length === 5);
  assert.deepEqual(started, [1, 2, 3, 4, 5], 'a freed slot starts the next');
  for (const release of releases) release();
  assert.deepEqual(await Promise.all(jobs), [1, 2, 3, 4, 5]);
});
