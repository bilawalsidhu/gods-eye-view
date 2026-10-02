import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { resampleTo16k } from './localAudio.js';
import { LITERT_VERSION, createWorkerClient } from './workerClient.js';

class FakeWorker extends EventTarget {
  constructor() {
    super();
    this.sent = [];
    this.terminated = false;
  }
  postMessage(message) {
    this.sent.push(message);
  }
  reply(data) {
    this.dispatchEvent(Object.assign(new Event('message'), { data }));
  }
  crash(message) {
    this.dispatchEvent(Object.assign(new Event('error'), { message }));
  }
  terminate() {
    this.terminated = true;
  }
}

test('the LiteRT runtime version matches the installed package', () => {
  const installed = JSON.parse(
    readFileSync(
      new URL(
        '../../../node_modules/@litert-lm/core/package.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  assert.equal(LITERT_VERSION, installed.version);
});

test('worker requests resolve on their own reply and report progress', async () => {
  const worker = new FakeWorker();
  const client = createWorkerClient(worker);
  const progress = [];
  const first = client.request(
    { type: 'load' },
    {
      onProgress: (event) => progress.push(event.loaded),
      done: (data) => data.type === 'loaded',
    },
  );
  const second = client.request({ type: 'other' });
  const [a, b] = worker.sent;
  worker.reply({ type: 'progress', id: a.id, loaded: 5 });
  worker.reply({ type: 'ok', id: b.id });
  worker.reply({ type: 'loaded', id: a.id, ms: 1 });
  assert.deepEqual(await second, { type: 'ok', id: b.id });
  assert.deepEqual(await first, { type: 'loaded', id: a.id, ms: 1 });
  assert.deepEqual(progress, [5]);
  const failing = client.request({ type: 'x' });
  worker.reply({ type: 'error', id: worker.sent[2].id, message: 'nope' });
  await assert.rejects(failing, /nope/);
});

test('a worker failure rejects pending requests and open streams', async () => {
  const worker = new FakeWorker();
  const client = createWorkerClient(worker);
  const pending = client.request({ type: 'load' });
  let streamError = null;
  client.onFailure((error) => {
    streamError = error;
  });
  worker.crash('boom');
  await assert.rejects(pending, /boom/);
  assert.match(streamError.message, /boom/);
  await assert.rejects(client.request({ type: 'again' }), /boom/);
  let late = null;
  client.onFailure((error) => {
    late = error;
  });
  assert.match(late.message, /boom/);
});

test('terminating a worker settles its streams as aborted', async () => {
  const worker = new FakeWorker();
  const client = createWorkerClient(worker);
  const pending = client.request({ type: 'turn' });
  let reason = null;
  client.onFailure((error) => {
    reason = error;
  });
  client.terminate();
  assert.equal(worker.terminated, true);
  await assert.rejects(pending, (error) => error.name === 'AbortError');
  assert.equal(reason.name, 'AbortError');
  client.post({ type: 'ignored' });
  assert.equal(worker.sent.length, 1);
});

test('microphone audio is resampled to 16 kHz by averaging', () => {
  const samples = Float32Array.from({ length: 48 }, (_, index) => index % 3);
  const out = resampleTo16k(samples, 48000);
  assert.equal(out.length, 16);
  assert.ok(out.every((value) => Math.abs(value - 1) < 1e-6));
  assert.equal(resampleTo16k(samples, 16000), samples);
});
