import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createGeminiChatHandler } from '../server/providers/gemini/chat.js';
import { createOpenAiChatHandler } from '../server/providers/openai/chat.js';
import {
  realtimeDirectives,
  realtimeInstructions,
} from '../server/providers/openai/instructions.js';
import {
  TEXT_WORDING,
  textInstructions,
} from '../server/providers/common/textInstructions.js';

const tools = [
  {
    name: 'fly_to',
    description: 'Fly',
    parameters: {
      type: 'object',
      properties: { lat: { type: 'number', minimum: -90, maximum: 90 } },
      required: ['lat'],
      additionalProperties: false,
    },
  },
];
const providers = {
  gemini: {
    create: createGeminiChatHandler,
    input: { contents: [{ role: 'user', parts: [{ text: 'Hello' }] }] },
    reply: (bad = false) => ({
      candidates: [
        {
          content: {
            role: 'model',
            parts: [
              {
                thoughtSignature: 'opaque',
                functionCall: {
                  name: 'fly_to',
                  id: 'c',
                  args: { lat: bad ? 100 : 1 },
                },
              },
            ],
          },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: {
        promptTokenCount: 7,
        candidatesTokenCount: 2,
        totalTokenCount: 10,
        thoughtsTokenCount: 1,
      },
    }),
  },
  openai: {
    create: createOpenAiChatHandler,
    input: { messages: [{ role: 'user', content: 'Hello' }] },
    reply: (bad = false) => ({
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                type: 'function',
                id: 'c',
                function: {
                  name: 'fly_to',
                  arguments: bad ? '{' : '{"lat":1}',
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
    }),
  },
};
async function fixture(t, provider, fetchImpl) {
  const calls = [];
  const handler = provider.create({
    tools,
    resolveApiKey: () => 'fixture-only',
    resolveRateLimit: () => '0',
    resolveHost: () => '',
    resolveAllowedHosts: () => '',
    fetchImpl:
      fetchImpl ||
      (async (url, options) => {
        calls.push({ url, body: JSON.parse(options.body) });
        return Response.json(provider.reply(true));
      }),
  });
  const server = http.createServer((req, res) => void handler(req, res));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    calls,
    origin,
    send: (input) =>
      fetch(origin, {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify(input ?? provider.input),
      }),
  };
}
for (const [name, provider] of Object.entries(providers)) {
  test(`${name} text route validates calls, retains usage and only accepts paired history`, async (t) => {
    const f = await fixture(t, provider);
    const response = await f.send();
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.invalidCalls[0].index, 0);
    assert.equal(body.usage.totalTokens, 10);
    assert.equal(body.usage.outputTokens, 3);
    const nullCall = provider.reply();
    if (name === 'gemini')
      nullCall.candidates[0].content.parts[0].functionCall.args = null;
    else nullCall.choices[0].message.tool_calls[0].function.arguments = 'null';
    const nullFixture = await fixture(t, provider, async () =>
      Response.json(nullCall),
    );
    const nullBody = await (await nullFixture.send()).json();
    assert.equal(nullBody.invalidCalls.length, 1);
    assert.match(nullBody.invalidCalls[0].error, /must be an object/);

    const input =
      name === 'gemini'
        ? {
            contents: [
              ...provider.input.contents,
              body.content,
              {
                role: 'user',
                parts: [
                  {
                    functionResponse: {
                      name: 'fly_to',
                      id: 'c',
                      response: { ok: false, error: 'Invalid' },
                    },
                  },
                ],
              },
            ],
          }
        : {
            messages: [
              ...provider.input.messages,
              body.content,
              { role: 'tool', tool_call_id: 'c', content: '{"ok":false}' },
            ],
          };
    assert.equal((await f.send(input)).status, 200);
    const orphan =
      name === 'gemini'
        ? { contents: [...input.contents.slice(0, -1)] }
        : { messages: input.messages.slice(0, -1) };
    assert.equal((await f.send(orphan)).status, 400);
    assert.equal(
      (await f.send({ ...provider.input, model: 'caller-model' })).status,
      400,
    );
    if (name === 'openai') {
      assert.equal(
        f.calls[0].url,
        'https://api.openai.com/v1/chat/completions',
      );
      assert.equal(f.calls[0].body.stream, false);
      assert.equal(f.calls[0].body.n, 1);
      assert.equal(f.calls[0].body.model, 'gpt-4.1-mini');
      assert.equal(f.calls[0].body.messages[0].role, 'system');
      assert.equal(
        (await f.send({ messages: [{ role: 'system', content: 'override' }] }))
          .status,
        400,
      );
    }
  });
  test(`${name} client disconnect aborts upstream and cancels a late body`, async (t) => {
    let finish,
      signal,
      cancelled = 0,
      ready;
    const acquired = new Promise((resolve) => (ready = resolve));
    const f = await fixture(t, provider, (_url, options) => {
      signal = options.signal;
      ready();
      return new Promise((resolve) => (finish = resolve));
    });
    const request = http.request(f.origin, {
      method: 'POST',
      headers: { Origin: f.origin, 'Content-Type': 'application/json' },
    });
    request.on('error', () => {});
    request.end(JSON.stringify(provider.input));
    await acquired;
    const aborted = once(signal, 'abort');
    request.destroy();
    await aborted;
    assert.equal(signal.aborted, true);
    finish({
      body: {
        cancel: async () => {
          cancelled++;
        },
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(cancelled > 0);
  });
  test(`${name} invalid upstream content still returns reported usage`, async (t) => {
    const f = await fixture(t, provider, async () =>
      Response.json({
        ...provider.reply(),
        ...(name === 'gemini' ? { candidates: [] } : { choices: [] }),
      }),
    );
    const response = await f.send();
    assert.equal(response.status, 502);
    assert.equal((await response.json()).usage.totalTokens, 10);
  });
}

test('text adapts speech wording while retaining shared Radio and annotation policies', () => {
  const directives = realtimeDirectives();
  assert.equal(realtimeInstructions(), directives.join('\n'));
  const text = textInstructions();
  assert.match(text, /text-only chat/);
  assert.ok(!text.includes('mic session is active'));
  for (const line of directives.filter(
    (line) =>
      (line.includes('radio') && !line.startsWith('PREAMBLES:')) ||
      line.startsWith('annotate_map results:'),
  ))
    assert.ok(text.includes(line));
});

test('every spoken phrase chat rewrites still occurs in the voice directives', () => {
  const voice = realtimeDirectives().join('\n');
  const text = textInstructions();
  for (const [spoken, written] of TEXT_WORDING) {
    assert.ok(voice.includes(spoken), `voice directives lost "${spoken}"`);
    assert.ok(!text.includes(spoken), `chat still says "${spoken}"`);
    assert.ok(text.includes(written), `chat lacks "${written}"`);
  }
});

test('OpenAI empty tool arrays are removed before history is returned', async (t) => {
  const f = await fixture(t, providers.openai, async () =>
    Response.json({
      choices: [
        {
          message: { role: 'assistant', content: 'Hello', tool_calls: [] },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
  );
  const body = await (await f.send()).json();
  assert.equal(body.content.tool_calls, undefined);
});
