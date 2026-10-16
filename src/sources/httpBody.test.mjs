import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readResponseBytesCapped } from './httpBody.js';

/**
 * A Response that streams `chunk` forever until the reader cancels it. The
 * zero high-water mark keeps the stream from pulling eagerly at construction,
 * so `pulls()` counts only what a reader actually asked for.
 */
function endlessResponse(chunk, onCancel, headers = {}) {
  let pulls = 0;
  const stream = new ReadableStream(
    {
      pull(controller) {
        pulls += 1;
        controller.enqueue(chunk);
      },
      cancel: onCancel,
    },
    { highWaterMark: 0 },
  );
  return { response: new Response(stream, { headers }), pulls: () => pulls };
}

function chunkedResponse(chunks, headers = {}) {
  const stream = new ReadableStream(
    {
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  return new Response(stream, { headers });
}

const bytes = (n, fill) => new Uint8Array(n).fill(fill);

test('returns the exact bytes of a body that fits, untouched by text decoding', async () => {
  // 0xFF and 0xFE are invalid UTF-8 lead bytes; a text path would mangle them.
  const payload = Uint8Array.from([0xff, 0xfe, 0x00, 0x7f, 0x80, 0x01]);
  const buf = await readResponseBytesCapped(chunkedResponse([payload]), 1024);
  assert.ok(buf instanceof Uint8Array);
  assert.deepEqual([...buf], [...payload]);
});

test('joins chunks in order and reports the total length', async () => {
  const buf = await readResponseBytesCapped(
    chunkedResponse([bytes(3, 1), bytes(2, 2), bytes(1, 3)]),
    1024,
  );
  assert.deepEqual([...buf], [1, 1, 1, 2, 2, 3]);
});

test('refuses on a declared Content-Length without pulling the body', async () => {
  let cancelled = false;
  const { response, pulls } = endlessResponse(
    bytes(512, 0),
    () => {
      cancelled = true;
    },
    { 'content-length': '4096' },
  );
  await assert.rejects(readResponseBytesCapped(response, 1024), {
    code: 'RESPONSE_TOO_LARGE',
  });
  assert.equal(pulls(), 0);
  assert.ok(cancelled);
});

test('refuses a chunked body the moment it passes the cap and stops pulling', async () => {
  let cancelled = false;
  const { response, pulls } = endlessResponse(bytes(512, 0), () => {
    cancelled = true;
  });
  await assert.rejects(readResponseBytesCapped(response, 1024), {
    code: 'RESPONSE_TOO_LARGE',
  });
  // Three 512-byte chunks is the first total over 1024; an uncapped read of
  // this never-ending stream would not terminate at all.
  assert.ok(pulls() <= 3, `pulled ${pulls()} chunks`);
  assert.ok(cancelled);
});

test('accepts a body exactly at the cap', async () => {
  const buf = await readResponseBytesCapped(
    chunkedResponse([bytes(512, 7), bytes(512, 7)]),
    1024,
  );
  assert.equal(buf.byteLength, 1024);
});

test('cancels a body still streaming when the signal aborts, and never returns a partial one', async () => {
  const controller = new AbortController();
  let cancelled = false;
  let pulls = 0;
  const stream = new ReadableStream(
    {
      pull(ctrl) {
        pulls += 1;
        ctrl.enqueue(bytes(64, 0));
        if (pulls === 2) controller.abort();
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  await assert.rejects(
    readResponseBytesCapped(new Response(stream), 1 << 20, controller.signal),
  );
  assert.ok(cancelled);
  assert.ok(pulls <= 3, `pulled ${pulls} chunks after abort`);
});

test('refuses immediately when the signal is already aborted', async () => {
  const controller = new AbortController();
  controller.abort();
  const { response, pulls } = endlessResponse(bytes(8, 0), () => {});
  await assert.rejects(
    readResponseBytesCapped(response, 1024, controller.signal),
  );
  assert.equal(pulls(), 0);
});

test('falls back to arrayBuffer() for a body with no stream reader', async () => {
  const response = new Response(bytes(16, 9));
  const buf = await readResponseBytesCapped(response, 1024);
  assert.equal(buf.byteLength, 16);
  assert.equal(buf[0], 9);
});
