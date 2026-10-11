import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { completeLocalModel } from '../server/providers/local-model.js';
import {
  cancelResponseBodyBounded,
  readResponseTextCapped,
  readResponseBytesCapped,
} from './sources/httpBody.js';

const environment = {
  GEV_LLM_PROVIDER: 'bifrost',
  GEV_LLM_BASE_URL: 'http://127.0.0.1:49379/v1',
  GEV_LLM_MODEL: 'local/cancellation-fixture',
  GEV_LLM_API_KEY: 'synthetic-key',
};
const messages = [{ role: 'user', content: 'Synthetic cleanup fixture' }];
const result = () =>
  Response.json({
    choices: [{ finish_reason: 'stop', message: { content: 'done' } }],
  });
function deferred() {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

for (const mode of [
  'non-2xx',
  'oversized Content-Length',
  'oversized streamed body',
  'caller abort during body read',
  'HUD preemption during body read',
]) {
  test(`scheduler waits for held cancellation: ${mode}`, async (t) => {
    const cleanup = deferred();
    const cancellationStarted = deferred();
    t.after(() => cleanup.resolve());
    let calls = 0;
    let cancelCalls = 0;
    let settled = false;
    const controller = new AbortController();
    const fetchImpl = async () => {
      if (++calls > 1) return result();
      return new Response(
        new ReadableStream({
          start(stream) {
            if (mode === 'oversized streamed body')
              stream.enqueue(new Uint8Array(1024 * 1024 + 1));
          },
          cancel() {
            cancelCalls++;
            cancellationStarted.resolve();
            return cleanup.promise;
          },
        }),
        {
          status: mode === 'non-2xx' ? 503 : 200,
          headers:
            mode === 'oversized Content-Length'
              ? { 'content-length': String(1024 * 1024 + 1) }
              : {},
        },
      );
    };
    const options = { environment, fetchImpl, timeoutMs: 5000 };
    const first = completeLocalModel(
      { messages, signal: controller.signal },
      {
        ...options,
        priority:
          mode === 'HUD preemption during body read'
            ? 'background'
            : 'foreground',
      },
    );
    const firstError = assert.rejects(first, {
      status:
        mode === 'caller abort during body read'
          ? 504
          : mode === 'HUD preemption during body read'
            ? 503
            : 502,
    });
    void firstError.then(() => {
      settled = true;
    });
    await nextTurn();
    const second = completeLocalModel({ messages }, options);
    if (mode === 'caller abort during body read') controller.abort();
    await cancellationStarted.promise;
    await nextTurn();
    assert.equal(calls, 1, 'queued request must wait for transport cleanup');
    assert.equal(settled, false, 'first operation still owns cleanup');
    assert.equal(cancelCalls, 1);
    cleanup.resolve();
    await firstError;
    assert.equal((await second).content, 'done');
    assert.equal(calls, 2);
    assert.equal(cancelCalls, 1, 'abort and catch must share cancellation');
  });
}

for (const [name, read] of [
  ['text', readResponseTextCapped],
  ['bytes', readResponseBytesCapped],
]) {
  test(`${name} reader awaits its single cancellation promise on abort`, async (t) => {
    const cleanup = deferred();
    t.after(() => cleanup.resolve());
    const controller = new AbortController();
    let calls = 0;
    let settled = false;
    const response = new Response(
      new ReadableStream({
        cancel() {
          calls++;
          return cleanup.promise;
        },
      }),
    );
    const failure = assert.rejects(read(response, 128, controller.signal), {
      name: 'AbortError',
    });
    void failure.then(() => {
      settled = true;
    });
    controller.abort();
    await nextTurn();
    assert.equal(calls, 1);
    assert.equal(settled, false);
    cleanup.resolve();
    await failure;
    assert.equal(response.body.locked, false);
    assert.equal(calls, 1);
  });

  test(`${name} reader cancels an unread body when already aborted`, async () => {
    let calls = 0;
    const response = new Response(
      new ReadableStream({
        cancel() {
          calls++;
        },
      }),
    );
    await assert.rejects(read(response, 128, AbortSignal.abort()), {
      name: 'AbortError',
    });
    assert.equal(calls, 1);
  });
}

test('cleanup rejects within its bound when a nonconforming stream never settles', async () => {
  const response = new Response(
    new ReadableStream({
      cancel: () => new Promise(() => {}),
    }),
  );
  await assert.rejects(cancelResponseBodyBounded(response, { timeoutMs: 20 }), {
    code: 'RESPONSE_CLEANUP_TIMEOUT',
  });
});

test('scheduler fails the operation and recovers after the cleanup bound expires', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    if (++calls > 1) return result();
    return new Response(
      new ReadableStream({ cancel: () => new Promise(() => {}) }),
      { status: 503 },
    );
  };
  const options = { environment, fetchImpl, timeoutMs: 5000 };
  const firstError = assert.rejects(completeLocalModel({ messages }, options), {
    status: 502,
  });
  await nextTurn();
  const second = completeLocalModel({ messages }, options);
  await nextTurn();
  assert.equal(calls, 1);
  await firstError;
  assert.equal((await second).content, 'done');
  assert.equal(calls, 2);
});
