import test from 'node:test';
import assert from 'node:assert/strict';
import {
  harness,
  deferred,
  tick,
} from '../testSupport/geminiNativeHarness.mjs';

function unreadResponse(bytes = null) {
  const state = { reads: 0, cancelled: 0 };
  const response = new Response(
    new ReadableStream(
      {
        pull(controller) {
          state.reads++;
          if (bytes) controller.enqueue(bytes);
        },
        cancel() {
          state.cancelled++;
        },
      },
      { highWaterMark: 0 },
    ),
  );
  return { response, state };
}

test('already aborted token request does not acquire or read a response', async (t) => {
  let fetches = 0;
  const h = harness({
    fetchImpl: () => {
      fetches++;
      throw Error('must not fetch');
    },
  });
  t.after(() => h.c.stop());
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(h.c.requestToken(abort.signal), { name: 'AbortError' });
  assert.equal(fetches, 0);
});

for (const phase of [
  'before response',
  'between resolution and continuation',
]) {
  test(`aborted token acquisition closes the unread body ${phase}`, async (t) => {
    const gate = deferred();
    const h = harness({ fetchImpl: () => gate.promise });
    t.after(() => h.c.stop());
    const abort = new AbortController();
    const { response, state } = unreadResponse();
    const result = assert.rejects(h.c.requestToken(abort.signal), {
      name: 'AbortError',
    });
    if (phase === 'before response') abort.abort();
    gate.resolve(response);
    if (phase !== 'before response') queueMicrotask(() => abort.abort());
    await result;
    await tick();
    assert.deepEqual(state, { reads: 0, cancelled: 1 });
  });
}

test('token body cap cancels a native response stream', async (t) => {
  const { response, state } = unreadResponse(new Uint8Array(256 * 1024 + 1));
  const h = harness({ fetchImpl: async () => response });
  t.after(() => h.c.stop());
  await assert.rejects(
    h.c.requestToken(new AbortController().signal),
    /too large|exceed|limit/i,
  );
  assert.equal(state.cancelled, 1);
  assert.equal(state.reads, 1);
});

test('token body read ends promptly on caller abort and releases the reader', async (t) => {
  const { response, state } = unreadResponse();
  const h = harness({ fetchImpl: async () => response });
  t.after(() => h.c.stop());
  const abort = new AbortController();
  const result = assert.rejects(h.c.requestToken(abort.signal), {
    name: 'AbortError',
  });
  await tick();
  assert.equal(state.reads, 1);
  abort.abort();
  await result;
  assert.equal(state.cancelled, 1);
  assert.equal(response.body.locked, false);
});

test('permission grant resolved just before Stop releases its tracks and preserves a fresh start', async (t) => {
  const gate = deferred();
  const h = harness({ getUserMedia: () => gate.promise });
  t.after(() => h.c.stop());
  const stream = h.makeStream();
  const start = h.c.start();
  gate.resolve(stream);
  queueMicrotask(() => h.c.stop());
  await start;
  await tick();
  assert.equal(h.tracks[0].readyState, 'ended');
  assert.equal(h.requests.length, 0);
  assert.equal(h.sockets.length, 0);
  assert.equal(h.captures[0].closed, true);
  h.c.getUserMedia = async () => h.makeStream();
  await h.c.start();
  assert.equal(h.c.status, 'listening');
  assert.equal(h.tracks[1].readyState, 'live');
  assert.equal(h.captures[1].closed, false);
});

test('late audio initialization cannot connect a retired microphone or close successor audio', async (t) => {
  const gate = deferred();
  const h = harness();
  t.after(() => h.c.stop());
  const createAudio = h.c.createAudio;
  let first = true;
  h.c.createAudio = (options) => {
    const audio = createAudio(options);
    if (first) {
      first = false;
      audio.initialize = () => gate.promise;
      audio.connectMicrophone = () =>
        assert.fail('retired initialization must not connect');
    }
    return audio;
  };
  const oldStart = h.c.start();
  await tick();
  h.c.stop();
  await h.c.start();
  gate.resolve();
  await oldStart;
  await tick();
  assert.equal(h.c.status, 'listening');
  assert.equal(h.captures[0].closed, true);
  assert.equal(h.captures[1].closed, false);
  assert.equal(h.tracks[0].readyState, 'ended');
  assert.equal(h.tracks[1].readyState, 'live');
});
