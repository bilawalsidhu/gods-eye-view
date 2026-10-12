import test from 'node:test';
import assert from 'node:assert/strict';
import { cameraImageCapability } from './cameraImageAi.js';

test('image capability exposes exact Sol model and high effort; explicit Send preserves original', async () => {
  const originalFetch = globalThis.fetch,
    calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response(
      JSON.stringify(
        options.method === 'POST'
          ? { answer: 'Fixture answer' }
          : {
              available: true,
              model: 'gpt-6.1-sol',
              reasoning: 'high',
              warning: 'API charges apply',
            },
      ),
    );
  };
  try {
    const controller = new AbortController();
    const capability = await cameraImageCapability(controller.signal);
    assert.equal(capability.model, 'gpt-6.1-sol');
    assert.equal(capability.reasoning, 'high');
    assert.equal(calls.length, 1, 'capability does not send an image');
    const image = 'data:image/png;base64,fixture';
    assert.equal(
      await capability.ask({
        original: { toDataURL: () => image },
        question: 'Visible details?',
        marks: [],
        signal: controller.signal,
      }),
      'Fixture answer',
    );
    const payload = JSON.parse(calls[1].options.body);
    assert.equal(payload.model, 'gpt-6.1-sol');
    assert.equal(payload.image, image);
    assert.equal(payload.confirmOriginal, true);
    assert.equal(calls[1].options.signal, controller.signal);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
