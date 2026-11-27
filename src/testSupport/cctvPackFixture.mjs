// Shared checks for the keyless CCTV city packs' catalog loaders.
import assert from 'node:assert/strict';

/**
 * A response whose body is a live stream, plus a flag that flips when the
 * stream is cancelled. A rejection path that returns without cancelling holds
 * the transport open, so the flag is what the refusal tests actually assert.
 */
export const streamingResponse = (init = {}, firstChunk = '{') => {
  const state = { cancelled: false };
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(firstChunk));
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { response: new Response(body, init), state };
};

/**
 * A failed upstream yields an empty pack and releases its response: a 503 can
 * still arrive with a streaming body, and returning without cancelling it would
 * hold the connection until the socket times out. A network error is empty too.
 */
export async function expectUpstreamFailureEmpty(t, load) {
  t.mock.method(console, 'warn', () => {});
  const failed = streamingResponse({ status: 503 });
  t.mock.method(globalThis, 'fetch', async () => failed.response);
  assert.deepEqual(await load(), []);
  assert.equal(failed.state.cancelled, true, 'the failed body is cancelled');

  t.mock.restoreAll();
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('network down');
  });
  assert.deepEqual(await load(), []);
}

/**
 * The catalog fetch never follows a redirect (the host cannot be steered) and
 * releases the redirect's body; a body over `maxBytes` is refused rather than
 * buffered, whether it declares its length or only grows past the cap.
 */
export async function expectFetchRefusals(
  t,
  {
    load,
    url,
    maxBytes,
    contentType,
    body,
    oversized = 'x'.repeat(maxBytes + 1024),
    firstChunk,
  },
) {
  const typed = contentType ? { 'Content-Type': contentType } : {};
  t.mock.method(console, 'warn', () => {});
  const seen = [];
  const redirected = streamingResponse(
    { status: 302, headers: { location: 'https://evil.example/catalog' } },
    firstChunk,
  );
  t.mock.method(globalThis, 'fetch', async (requested, init) => {
    seen.push([String(requested), init.redirect]);
    return redirected.response;
  });
  assert.deepEqual(await load(), []);
  assert.deepEqual(seen, [[url, 'manual']]);
  assert.equal(
    redirected.state.cancelled,
    true,
    'the redirect body is cancelled',
  );

  t.mock.restoreAll();
  t.mock.method(console, 'warn', () => {});
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(body, {
        headers: { ...typed, 'content-length': String(maxBytes + 1) },
      }),
  );
  assert.deepEqual(await load(), []);

  t.mock.restoreAll();
  t.mock.method(console, 'warn', () => {});
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(oversized));
            controller.close();
          },
        }),
        { headers: typed },
      ),
  );
  assert.deepEqual(await load(), []);
}
