import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchBinary } from '../dist/http.js';

test('binary proxy cancels streamed responses above the byte limit', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2]));
      controller.enqueue(new Uint8Array([3, 4]));
      controller.close();
    },
  }), { headers: { 'content-type': 'image/png' } });
  try {
    await assert.rejects(
      fetchBinary('https://example.test/tile', {}, { timeoutMs: 1000, maxResponseBytes: 3 }),
      /exceeded the configured limit/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
