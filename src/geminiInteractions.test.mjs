import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GEMINI_INTERACTIONS_URL,
  createGeminiInteractionText,
  extractGeminiInteractionText,
  normalizeGeminiTextModel,
} from '../server/providers/gemini/interactions.js';

function recorder(reply) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return reply;
  };
  return { calls, fetchImpl };
}

const completed = (steps) =>
  Response.json({ id: 'int_1', status: 'completed', steps });

test('one stateless request: key in a header, never in the URL', async () => {
  const { calls, fetchImpl } = recorder(
    completed([
      { type: 'user_input', content: [{ type: 'text', text: '{"view":1}' }] },
      {
        type: 'model_output',
        content: [{ type: 'text', text: 'Calm skies over Austin' }],
      },
    ]),
  );
  const result = await createGeminiInteractionText({
    apiKey: 'fixture-gemini-secret',
    model: 'gemini-3.5-flash-lite',
    systemInstruction: 'Write a caption.',
    input: '{"view":1}',
    maxOutputTokens: 64,
    thinkingLevel: 'minimal',
    fetchImpl,
  });
  assert.deepEqual(result, {
    ok: true,
    status: 200,
    text: 'Calm skies over Austin',
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, GEMINI_INTERACTIONS_URL);
  assert.equal(
    GEMINI_INTERACTIONS_URL,
    'https://generativelanguage.googleapis.com/v1beta/interactions',
  );
  assert.doesNotMatch(calls[0].url, /fixture-gemini-secret|key=/);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.redirect, 'error');
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  assert.equal(
    calls[0].init.headers['x-goog-api-key'],
    'fixture-gemini-secret',
  );
  assert.deepEqual(calls[0].body, {
    model: 'gemini-3.5-flash-lite',
    system_instruction: 'Write a caption.',
    input: '{"view":1}',
    // The view context is not kept on Google's side for later retrieval.
    store: false,
    generation_config: {
      max_output_tokens: 64,
      thinking_level: 'minimal',
      thinking_summaries: 'none',
    },
  });
});

test('only model output is answer text: thoughts and the echoed input are not', () => {
  assert.equal(
    extractGeminiInteractionText({
      status: 'completed',
      steps: [
        { type: 'user_input', content: [{ type: 'text', text: 'the input' }] },
        { type: 'thought', summary: [{ type: 'text', text: 'considering' }] },
        // Not the documented shape, but text here must not leak either.
        { type: 'thought', content: [{ type: 'text', text: 'scratch' }] },
        {
          type: 'model_output',
          content: [
            { type: 'text', text: 'Storm cells' },
            { type: 'image', data: 'xx' },
            { type: 'text', text: 'north of the city' },
          ],
        },
      ],
    }),
    'Storm cells north of the city',
  );
  for (const data of [
    null,
    {},
    { steps: 'x' },
    { steps: [{ type: 'model_output' }] },
    { steps: [{ type: 'model_output', content: [{ type: 'text' }] }] },
  ])
    assert.equal(extractGeminiInteractionText(data), '', JSON.stringify(data));
});

test('an interaction that did not complete is not an answer, even with partial text', async () => {
  for (const status of ['incomplete', 'failed', 'in_progress', undefined]) {
    const { fetchImpl } = recorder(
      Response.json({
        status,
        steps: [
          { type: 'model_output', content: [{ type: 'text', text: 'Storm' }] },
        ],
      }),
    );
    const result = await createGeminiInteractionText({
      apiKey: 'k',
      model: 'gemini-3.5-flash-lite',
      systemInstruction: 's',
      input: 'u',
      fetchImpl,
    });
    assert.deepEqual(result, { ok: false, status: 502, text: '' }, status);
  }
});

test('an HTTP failure keeps the status and drops the provider text', async () => {
  const { fetchImpl } = recorder(
    Response.json(
      { error: { code: 429, message: 'Quota exceeded for project 12345' } },
      { status: 429 },
    ),
  );
  const result = await createGeminiInteractionText({
    apiKey: 'k',
    model: 'gemini-3.5-flash-lite',
    systemInstruction: 's',
    input: 'u',
    fetchImpl,
  });
  assert.deepEqual(result, { ok: false, status: 429, text: '' });
});

test('model ids: a models/ prefix is accepted, anything that could reshape the request is not', async () => {
  assert.equal(
    normalizeGeminiTextModel(' models/gemini-3.8-flash '),
    'gemini-3.8-flash',
  );
  assert.equal(
    normalizeGeminiTextModel('gemini-3.5-flash-lite'),
    'gemini-3.5-flash-lite',
  );
  for (const bad of [
    '',
    'gpt-5-nano',
    '../files',
    'gemini?alt=sse',
    'gemini x',
    'GEMINI-3',
    null,
  ])
    assert.equal(normalizeGeminiTextModel(bad), null, String(bad));

  const { calls, fetchImpl } = recorder(completed([]));
  await assert.rejects(
    createGeminiInteractionText({
      apiKey: 'k',
      model: 'gemini?alt=sse',
      systemInstruction: 's',
      input: 'u',
      fetchImpl,
    }),
    /Invalid Gemini model id/,
  );
  assert.equal(calls.length, 0, 'no request is sent for a refused model id');
});

test('without a thinking level the model keeps its own default', async () => {
  const { calls, fetchImpl } = recorder(completed([]));
  await createGeminiInteractionText({
    apiKey: 'k',
    model: 'gemini-3.8-flash',
    systemInstruction: 's',
    input: 'u',
    fetchImpl,
  });
  assert.deepEqual(calls[0].body.generation_config, { max_output_tokens: 100 });
});
