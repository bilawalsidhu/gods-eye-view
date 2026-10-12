import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createOpenAiReconstructionProvider,
  CAMERA_RECONSTRUCTION_MODEL,
} from './camera-reconstruction.js';
test('read-only access checks exact documented edit model without inference or exposing credential', async () => {
  const calls = [];
  const p = createOpenAiReconstructionProvider({
    resolveApiKey: () => 'fixture-key',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(
        JSON.stringify({ data: [{ id: CAMERA_RECONSTRUCTION_MODEL }] }),
      );
    },
  });
  assert.equal((await p.checkAccess()).listed, true);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.endsWith('/models'));
  await assert.rejects(p.generate({}), /approval/);
  assert.equal(calls.length, 1);
});
test('approved edit uses one PNG and explicit 1K medium settings; fixture only', async () => {
  const calls = [];
  const p = createOpenAiReconstructionProvider({
    approved: true,
    resolveApiKey: () => 'fixture-key',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(
        JSON.stringify(
          url.endsWith('/models')
            ? { data: [{ id: CAMERA_RECONSTRUCTION_MODEL }] }
            : { data: [{ b64_json: 'fixture' }] },
        ),
      );
    },
  });
  await p.generate({
    sourceImage: 'data:image/png;base64,Zml4dHVyZQ==',
    scope: 'region',
    note: 'Tentative instruction',
  });
  const edit = calls.find((c) => c.url.endsWith('/images/edits'));
  assert.equal(edit.options.body.get('model'), CAMERA_RECONSTRUCTION_MODEL);
  assert.equal(edit.options.body.get('n'), '1');
  assert.equal(edit.options.body.get('size'), '1024x1024');
  assert.equal(edit.options.body.get('quality'), 'medium');
  assert.equal(edit.options.body.get('output_format'), 'png');
  assert.ok(edit.options.body.get('image[]') instanceof Blob);
  assert.match(edit.options.body.get('prompt'), /Tentative instruction/);
  assert.ok(!edit.options.body.get('prompt').includes('fixture-key'));
});

test('concurrent access checks reserve one shared paid attempt and report token cost', async () => {
  let edits = 0;
  const provider = createOpenAiReconstructionProvider({
    approved: true,
    maxRequests: 1,
    resolveApiKey: () => 'fixture-key',
    fetchImpl: async (url) => {
      if (url.endsWith('/models')) {
        await new Promise((r) => setTimeout(r, 10));
        return new Response(
          JSON.stringify({ data: [{ id: CAMERA_RECONSTRUCTION_MODEL }] }),
        );
      }
      edits++;
      return new Response(
        JSON.stringify({
          data: [{ b64_json: 'fixture' }],
          usage: {
            input_tokens_details: { text_tokens: 100, image_tokens: 200 },
            output_tokens: 439,
          },
        }),
      );
    },
  });
  const input = {
    sourceImage: 'data:image/png;base64,Zml4dHVyZQ==',
    scope: 'whole',
    note: '',
  };
  const results = await Promise.allSettled([
    provider.generate(input),
    provider.generate(input),
  ]);
  assert.equal(edits, 1);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const success = results.find((r) => r.status === 'fulfilled').value;
  assert.equal(success.costUsd, 0.01527);
  assert.deepEqual(success.usage, {
    textTokens: 100,
    imageTokens: 200,
    outputTokens: 439,
  });
  assert.equal(provider.approved, false);
  assert.equal(provider.remainingRequests, 0);
});
