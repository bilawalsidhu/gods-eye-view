import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserLocalRuntime } from './browserLocalRuntime.js';

function fixture(
  t,
  options = {},
  selection = { profile: 'balance', language: 'ru' },
) {
  const created = [],
    checks = [];
  const runtime = createBrowserLocalRuntime(selection, {
    checkCache: async () => checks.push('cache'),
    checkGpu: async () => checks.push('gpu'),
    createWorker: (kind) => {
      const worker = {
        kind,
        messages: [],
        terminated: false,
        postMessage(message) {
          this.messages.push(message);
        },
        terminate() {
          this.terminated = true;
        },
        reply(value = { result: { ok: true } }) {
          this.onmessage({ data: { id: this.messages.at(-1).id, ...value } });
        },
      };
      created.push(worker);
      return worker;
    },
    ...options,
  });
  t.after(() => runtime.stop());
  return { runtime, created, checks };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('voice startup loads only recognition; speech and chat have separate lazy reusable workers', async (t) => {
  const { runtime, created, checks } = fixture(t);
  const preparing = runtime.prepare();
  await tick();
  assert.deepEqual(
    created.map((w) => w.kind),
    ['recognition'],
  );
  assert.deepEqual(checks, ['cache']);
  created[0].reply();
  await preparing;
  const speech = runtime.speech('hello');
  created[1].reply();
  await speech;
  const chat = runtime.chat([{ role: 'user', content: 'Hello' }]);
  await tick();
  created[2].reply();
  await chat;
  const repeated = runtime.chat([{ role: 'user', content: 'Again' }]);
  created[2].reply();
  await repeated;
  assert.equal(created.length, 3);
  assert.deepEqual(checks, ['cache', 'gpu']);
  runtime.stop();
  assert.ok(created.every((w) => w.terminated));
  assert.deepEqual(runtime.diagnostics(), { loadedWorkers: [], pending: 0 });
});

test('OOM releases the failed heap, preserves other models and allows a clean retry', async (t) => {
  const { runtime, created } = fixture(t);
  const speech = runtime.speech('hello');
  created[0].reply();
  await speech;
  const chat = runtime.chat([]);
  await tick();
  const rejected = assert.rejects(chat, /out of memory.*released/iu);
  created[1].reply({ error: 'Aborted(OOM)' });
  await rejected;
  assert.equal(created[1].terminated, true);
  assert.equal(created[0].terminated, false);
  assert.deepEqual(runtime.diagnostics().loadedWorkers, ['speech']);
  const retry = runtime.chat([]);
  await tick();
  created[2].reply();
  await retry;
});

test('abort rejects pending inference, terminates its worker and ignores late messages', async (t) => {
  const { runtime, created } = fixture(t);
  const controller = new AbortController();
  const speech = runtime.speech('hello', controller.signal);
  const rejected = assert.rejects(speech, { name: 'AbortError' });
  controller.abort();
  await rejected;
  created[0].reply();
  assert.equal(created[0].terminated, true);
  assert.equal(runtime.diagnostics().pending, 0);
});

test('stop during asynchronous GPU/cache checks cannot resurrect a worker', async (t) => {
  for (const stage of ['cache', 'gpu']) {
    let proceed;
    const { runtime, created } = fixture(t, {
      [stage === 'cache' ? 'checkCache' : 'checkGpu']: () =>
        new Promise((resolve) => {
          proceed = resolve;
        }),
    });
    const pending = stage === 'cache' ? runtime.prepare() : runtime.chat([]);
    const rejected = assert.rejects(pending, { name: 'AbortError' });
    runtime.stop();
    proceed();
    await rejected;
    assert.equal(created.length, 0);
  }
});

test('overlapping work is rejected and idle chat memory is released', async (t) => {
  const { runtime, created } = fixture(t, { chatIdleMs: 15 });
  const pending = runtime.chat([]);
  await tick();
  await assert.rejects(runtime.chat([]), /busy/);
  assert.equal(created[0].terminated, false);
  created[0].reply();
  await pending;
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(created[0].terminated, true);
  assert.deepEqual(runtime.diagnostics().loadedWorkers, []);
});

test('max releases other model heaps before changing inference stages', async (t) => {
  const { runtime, created } = fixture(
    t,
    {},
    { profile: 'max', language: 'ru' },
  );
  const prepare = runtime.prepare();
  await tick();
  created[0].reply();
  await prepare;
  const chat = runtime.chat([]);
  await tick();
  assert.equal(created[0].terminated, true);
  created[1].reply();
  await chat;
  const voice = runtime.speech('hello');
  assert.equal(created[1].terminated, true);
  created[2].reply();
  await voice;
  const recognition = runtime.transcribe(new Float32Array(16000));
  assert.equal(created[2].terminated, true);
  created[3].reply();
  await recognition;
  assert.deepEqual(runtime.diagnostics().loadedWorkers, ['recognition']);
});

test('speech OOM retries once with a fresh heap after freeing idle models', async (t) => {
  const { runtime, created } = fixture(t);
  const chat = runtime.chat([]);
  await tick();
  created[0].reply();
  await chat;
  const voice = runtime.speech('hello');
  created[1].reply({ error: 'Aborted(OOM)' });
  await tick();
  assert.ok(created[0].terminated && created[1].terminated);
  assert.equal(created.length, 3);
  created[2].reply();
  await voice;
  const failed = runtime.speech('again');
  created[2].reply({ error: 'Aborted(OOM)' });
  await tick();
  const rejected = assert.rejects(failed, /out of memory/iu);
  created[3].reply({ error: 'Aborted(OOM)' });
  await rejected;
  assert.equal(created.length, 4);
});

test('stop between speech failure and its retry cannot resurrect inference', async (t) => {
  const { runtime, created } = fixture(t);
  const speech = runtime.speech('hello');
  const rejected = assert.rejects(speech, { name: 'AbortError' });
  created[0].reply({ error: 'Aborted(OOM)' });
  runtime.stop();
  await rejected;
  assert.equal(created.length, 1);
});
