import assert from 'node:assert/strict';
import test from 'node:test';
import { createLimiter } from './limiter.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A task that runs until `finish()`. */
function held(log, name) {
  let finish;
  const done = new Promise((resolve) => (finish = resolve));
  return {
    task: () => {
      log.push(name);
      return done.then(() => name);
    },
    finish: () => finish(),
  };
}

test('at most `limit` tasks run; queued ones start first in, first out', async () => {
  const log = [];
  const gate = createLimiter(2);
  const tasks = ['a', 'b', 'c', 'd'].map((name) => held(log, name));
  const results = tasks.map(({ task }) => gate.run(task));
  await tick();
  assert.deepEqual(log, ['a', 'b']);
  assert.equal(gate.pending, 4);
  tasks[0].finish();
  await tick();
  assert.deepEqual(log, ['a', 'b', 'c']);
  for (const { finish } of tasks) finish();
  assert.deepEqual(await Promise.all(results), ['a', 'b', 'c', 'd']);
  assert.equal(gate.pending, 0);
});

test('lifo starts the newest queued task next', async () => {
  const log = [];
  const gate = createLimiter(1, { lifo: true });
  const tasks = ['a', 'b', 'c'].map((name) => held(log, name));
  const results = tasks.map(({ task }) => gate.run(task));
  await tick();
  tasks[0].finish();
  await tick();
  assert.deepEqual(log, ['a', 'c']);
  tasks[2].finish();
  tasks[1].finish();
  await Promise.all(results);
});

test('a queued task whose signal aborts never runs, leaves the queue and rejects with the reason', async () => {
  const log = [];
  const gate = createLimiter(1);
  const first = held(log, 'a');
  const running = gate.run(first.task);
  const controller = new AbortController();
  const queued = gate.run(held(log, 'b').task, { signal: controller.signal });
  await tick();
  assert.equal(gate.pending, 2);
  controller.abort(new Error('overtaken'));
  await assert.rejects(queued, /overtaken/);
  assert.equal(gate.pending, 1, 'out of the queue');
  first.finish();
  await running;
  await tick();
  assert.deepEqual(log, ['a'], 'b never ran');
});

test('a task already aborted when its turn comes is skipped', async () => {
  const log = [];
  const gate = createLimiter(1);
  const first = held(log, 'a');
  const running = gate.run(first.task);
  const signal = {
    aborted: false,
    reason: new Error('gone'),
    addEventListener() {},
  };
  const queued = gate.run(held(log, 'b').task, { signal });
  signal.aborted = true;
  first.finish();
  await running;
  await assert.rejects(queued, /gone/);
  assert.deepEqual(log, ['a']);
});
