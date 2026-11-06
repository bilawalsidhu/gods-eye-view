import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createGeminiChatHandler } from '../server/providers/gemini/chat.js';
import { createOpenAiChatHandler } from '../server/providers/openai/chat.js';
import { createAnthropicChatHandler } from '../server/providers/anthropic/chat.js';
import { createVertexChatHandler } from '../server/providers/vertex/chat.js';
import { createBedrockChatHandler } from '../server/providers/bedrock/chat.js';
import { parseUsage } from '../server/providers/common/textTools.js';
import { GEV_REALTIME_TOOLS } from '../server/providers/openai/tools.js';
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
  anthropic: {
    create: createAnthropicChatHandler,
    input: { messages: [{ role: 'user', content: 'Hello' }] },
    reply: (bad = false) => ({
      id: 'm',
      type: 'message',
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'c',
          name: 'fly_to',
          input: { lat: bad ? 100 : 1 },
        },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 7, output_tokens: 3 },
    }),
  },
  bedrock: {
    create: createBedrockChatHandler,
    input: { messages: [{ role: 'user', content: [{ text: 'Hello' }] }] },
    reply: (bad = false) => ({
      output: {
        message: {
          role: 'assistant',
          content: [
            {
              toolUse: {
                toolUseId: 'c',
                name: 'fly_to',
                input: { lat: bad ? 100 : 1 },
              },
            },
          ],
        },
      },
      stopReason: 'tool_use',
      usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
    }),
  },
};
// Vertex AI Express Mode takes and answers the same contents as Gemini.
providers.vertex = {
  create: createVertexChatHandler,
  input: providers.gemini.input,
  reply: providers.gemini.reply,
};
async function fixture(t, provider, fetchImpl, overrides = {}) {
  const calls = [];
  const handler = provider.create({
    tools,
    resolveApiKey: () => 'fixture-only',
    resolveRateLimit: () => '0',
    resolveHost: () => '',
    resolveAllowedHosts: () => '',
    environment: {},
    fetchImpl:
      fetchImpl ||
      (async (url, options) => {
        calls.push({ url, body: JSON.parse(options.body), options });
        return Response.json(provider.reply(true));
      }),
    ...overrides,
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
    raw: (options, body) =>
      new Promise((resolve, reject) => {
        const request = http.request(origin, options, (response) => {
          let text = '';
          response.setEncoding('utf8');
          response.on('data', (chunk) => (text += chunk));
          response.on('end', () =>
            resolve({
              status: response.statusCode,
              headers: response.headers,
              body: text ? JSON.parse(text) : null,
            }),
          );
        });
        request.on('error', reject);
        if (body === undefined) request.end();
        else request.end(body);
      }),
    send: (input) =>
      fetch(origin, {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify(input ?? provider.input),
      }),
  };
}
for (const [name, provider] of Object.entries(providers)) {
  // Vertex AI sends and answers Gemini's contents.
  const geminiShape = name === 'gemini' || name === 'vertex';
  test(`${name} text route validates calls, retains usage and only accepts paired history`, async (t) => {
    const f = await fixture(t, provider);
    const response = await f.send();
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.invalidCalls[0].index, 0);
    assert.equal(body.usage.totalTokens, 10);
    assert.equal(body.usage.outputTokens, 3);
    const nullCall = provider.reply();
    if (geminiShape)
      nullCall.candidates[0].content.parts[0].functionCall.args = null;
    else if (name === 'anthropic') nullCall.content[0].input = null;
    else if (name === 'bedrock')
      nullCall.output.message.content[0].toolUse.input = null;
    else nullCall.choices[0].message.tool_calls[0].function.arguments = 'null';
    const nullFixture = await fixture(t, provider, async () =>
      Response.json(nullCall),
    );
    const nullBody = await (await nullFixture.send()).json();
    assert.equal(nullBody.invalidCalls.length, 1);
    assert.match(nullBody.invalidCalls[0].error, /must be an object/);

    const input = geminiShape
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
      : name === 'anthropic'
        ? {
            messages: [
              ...provider.input.messages,
              body.content,
              {
                role: 'user',
                content: [
                  {
                    type: 'tool_result',
                    tool_use_id: 'c',
                    content: '{"ok":false}',
                  },
                ],
              },
            ],
          }
        : name === 'bedrock'
          ? {
              messages: [
                ...provider.input.messages,
                body.content,
                {
                  role: 'user',
                  content: [
                    {
                      toolResult: {
                        toolUseId: 'c',
                        content: [{ json: { ok: false } }],
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
    const orphan = geminiShape
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
    if (geminiShape) {
      const [{ url, body: sent, options }] = f.calls;
      assert.equal(options.headers['x-goog-api-key'], 'fixture-only');
      assert.deepEqual(sent.contents, provider.input.contents);
      assert.equal(typeof sent.systemInstruction.parts[0].text, 'string');
      const { functionDeclarations } = sent.tools[0];
      if (name === 'vertex') {
        assert.equal(
          url,
          'https://aiplatform.googleapis.com/v1beta1/publishers/google/models/gemini-3-flash-preview:generateContent',
        );
        // Vertex takes its own Schema dialect, never parametersJsonSchema.
        assert.deepEqual(functionDeclarations, [
          {
            name: 'fly_to',
            description: 'Fly',
            parameters: {
              type: 'OBJECT',
              properties: {
                lat: { type: 'NUMBER', minimum: -90, maximum: 90 },
              },
              required: ['lat'],
            },
          },
        ]);
        assert.ok(!JSON.stringify(sent.tools).includes('additionalProperties'));
        // The default is a Gemini 3 model, which takes thinkingLevel.
        assert.deepEqual(sent.generationConfig, {
          responseModalities: ['TEXT'],
          maxOutputTokens: 4096,
          thinkingConfig: { thinkingLevel: 'LOW' },
        });
      } else {
        assert.equal(
          url,
          'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent',
        );
        assert.deepEqual(functionDeclarations, [
          {
            name: 'fly_to',
            description: 'Fly',
            parametersJsonSchema: tools[0].parameters,
          },
        ]);
        assert.deepEqual(sent.generationConfig, {
          responseModalities: ['TEXT'],
          maxOutputTokens: 4096,
          thinkingConfig: { thinkingLevel: 'LOW' },
        });
      }
    }
    if (name === 'anthropic') {
      const [{ url, body: sent, options }] = f.calls;
      assert.equal(url, 'https://api.anthropic.com/v1/messages');
      assert.equal(options.headers['x-api-key'], 'fixture-only');
      assert.equal(options.headers['anthropic-version'], '2023-06-01');
      assert.equal(sent.model, 'claude-haiku-5-5');
      assert.equal(sent.max_tokens, 4096);
      assert.deepEqual(sent.thinking, { type: 'disabled' });
      assert.equal(typeof sent.system, 'string');
      assert.deepEqual(sent.messages, provider.input.messages);
      assert.deepEqual(sent.tools, [
        {
          name: 'fly_to',
          description: 'Fly',
          input_schema: tools[0].parameters,
        },
      ]);
      assert.equal(
        (await f.send({ messages: [{ role: 'system', content: 'override' }] }))
          .status,
        400,
      );
    }
    if (name === 'bedrock') {
      const [{ url, body: sent, options }] = f.calls;
      assert.equal(
        url,
        'https://bedrock-runtime.us-east-1.amazonaws.com/model/global.anthropic.claude-haiku-5-5/converse',
      );
      assert.equal(options.headers.Authorization, 'Bearer fixture-only');
      assert.equal(options.headers['Content-Type'], 'application/json');
      // Only the Converse fields this route owns; the model is in the URL.
      assert.deepEqual(Object.keys(sent).sort(), [
        'inferenceConfig',
        'messages',
        'system',
        'toolConfig',
      ]);
      assert.equal(sent.system.length, 1);
      assert.equal(typeof sent.system[0].text, 'string');
      assert.deepEqual(sent.messages, provider.input.messages);
      assert.deepEqual(sent.toolConfig, {
        tools: [
          {
            toolSpec: {
              name: 'fly_to',
              description: 'Fly',
              inputSchema: { json: tools[0].parameters },
            },
          },
        ],
      });
      assert.deepEqual(sent.inferenceConfig, { maxTokens: 4096 });
      assert.equal(
        (await f.send({ messages: [{ role: 'system', content: 'override' }] }))
          .status,
        400,
      );
    }
  });
  test(
    `${name} client disconnect aborts upstream and cancels a late body`,
    {
      timeout: 5000,
    },
    async (t) => {
      let finish,
        signal,
        cancelled = 0,
        ready;
      const acquired = new Promise((resolve) => (ready = resolve));
      // A deadline this far out cannot be what aborts the upstream call.
      const f = await fixture(
        t,
        provider,
        (_url, options) => {
          signal = options.signal;
          ready();
          return new Promise((resolve) => (finish = resolve));
        },
        { timeoutMs: 1e9 },
      );
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
    },
  );
  test(`${name} invalid upstream content still returns reported usage`, async (t) => {
    const f = await fixture(t, provider, async () =>
      Response.json({
        ...provider.reply(),
        ...(geminiShape
          ? { candidates: [] }
          : name === 'anthropic'
            ? { content: [] }
            : name === 'bedrock'
              ? { output: { message: { role: 'assistant', content: [] } } }
              : { choices: [] }),
      }),
    );
    const response = await f.send();
    assert.equal(response.status, 502);
    assert.equal((await response.json()).usage.totalTokens, 10);
  });
  test(`${name} route refuses bad methods, media types and bodies before upstream`, async (t) => {
    const f = await fixture(t, provider, undefined, { timeoutMs: 2000 });
    const json = { Origin: f.origin, 'Content-Type': 'application/json' };
    const get = await f.raw({ method: 'GET', headers: { Origin: f.origin } });
    assert.equal(get.status, 405);
    assert.equal(get.headers.allow, 'POST');
    const text = await f.raw(
      {
        method: 'POST',
        headers: { Origin: f.origin, 'Content-Type': 'text/plain' },
      },
      JSON.stringify(provider.input),
    );
    assert.equal(text.status, 415);
    // The declared length alone refuses; the short body never completes it.
    const declared = await f.raw(
      { method: 'POST', headers: { ...json, 'Content-Length': 600 * 1024 } },
      '{}',
    );
    assert.equal(declared.status, 413);
    const streamed = await f.raw(
      { method: 'POST', headers: { ...json, 'Transfer-Encoding': 'chunked' } },
      JSON.stringify({ ...provider.input, padding: 'x'.repeat(600 * 1024) }),
    );
    assert.equal(streamed.status, 413);
    assert.equal(f.calls.length, 0);
  });
  test(`${name} route names a missing key without calling upstream`, async (t) => {
    const f = await fixture(t, provider, undefined, {
      resolveApiKey: () => ' ',
    });
    const response = await f.send();
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: 'Add an API key in Provider Settings',
      code: 'API_KEY_MISSING',
    });
    assert.equal(f.calls.length, 0);
  });
  test(
    `${name} upstream deadline answers 504 and aborts the call`,
    {
      timeout: 5000,
    },
    async (t) => {
      let signal;
      const f = await fixture(
        t,
        provider,
        (_url, options) => {
          signal = options.signal;
          return new Promise(() => {});
        },
        { timeoutMs: 50 },
      );
      const response = await f.send();
      assert.equal(response.status, 504);
      assert.equal(signal.aborted, true);
    },
  );
  test(`${name} route refuses redirects and unexpected destinations`, async (t) => {
    const f = await fixture(t, provider);
    assert.equal((await f.send()).status, 200);
    assert.equal(f.calls[0].options.redirect, 'error');
    const moved = await fixture(t, provider, async () => {
      const response = Response.json(provider.reply());
      Object.defineProperty(response, 'url', {
        value: 'https://example.test/',
      });
      return response;
    });
    assert.equal((await moved.send()).status, 502);
    const redirected = await fixture(t, provider, async () => {
      const response = Response.json(provider.reply());
      Object.defineProperty(response, 'redirected', { value: true });
      return response;
    });
    assert.equal((await redirected.send()).status, 502);
  });
  test(`${name} route caps the upstream response and never echoes the key`, async (t) => {
    const large = await fixture(t, provider, async () =>
      Response.json({ ...provider.reply(), padding: 'x'.repeat(600 * 1024) }),
    );
    assert.equal((await large.send()).status, 502);
    const echo = provider.reply();
    if (geminiShape)
      echo.candidates[0].content.parts = [{ text: 'key fixture-only' }];
    else if (name === 'anthropic')
      echo.content = [{ type: 'text', text: 'key fixture-only' }];
    else if (name === 'bedrock')
      echo.output.message.content = [{ text: 'key fixture-only' }];
    else
      echo.choices[0].message = {
        role: 'assistant',
        content: 'key fixture-only',
      };
    const echoed = await fixture(t, provider, async () => Response.json(echo));
    const response = await echoed.send();
    assert.equal(response.status, 502);
    assert.ok(!(await response.text()).includes('fixture-only'));
  });
  test(`${name} upstream 429 and 503 keep their status and a sane Retry-After`, async (t) => {
    for (const [status, retryAfter, expected] of [
      [429, '7', '7'],
      [503, '7200', '3600'],
      [429, 'Wed, 21 Oct 2015 07:28:00 GMT', undefined],
      [500, '7', undefined],
    ]) {
      const f = await fixture(t, provider, async () =>
        Response.json({}, { status, headers: { 'Retry-After': retryAfter } }),
      );
      const response = await f.send();
      assert.equal(response.status, status === 500 ? 502 : status);
      assert.equal(response.headers.get('retry-after') ?? undefined, expected);
      assert.deepEqual(await response.json(), {
        error: 'Could not connect. Try again.',
        ...(status === 429 ? { code: 'RATE_LIMITED' } : {}),
      });
    }
  });
  test(`${name} rejected key cools down until it changes or the window ends`, async (t) => {
    for (const status of [401, 403]) {
      let clock = 1_000_000;
      let key = 'fixture-only';
      let upstream = 0;
      const f = await fixture(
        t,
        provider,
        async () => {
          upstream++;
          return Response.json({}, { status });
        },
        { now: () => clock, resolveApiKey: () => key },
      );
      assert.equal((await f.send()).status, 502);
      const cooling = await f.send();
      assert.equal(cooling.status, 502);
      assert.equal(cooling.headers.get('retry-after'), '60');
      assert.equal(upstream, 1, 'a rejected key must not reach upstream again');
      key = 'replacement-key';
      assert.equal((await f.send()).status, 502);
      assert.equal(upstream, 2, 'a new key is tried at once');
      clock += 59_000;
      assert.equal((await f.send()).status, 502);
      assert.equal(upstream, 2);
      clock += 1_000;
      assert.equal((await f.send()).status, 502);
      assert.equal(upstream, 3, 'the cooldown ends after a minute');
    }
  });
  test(`${name} an invalid-key 400 cools down like 401, and every refusal names the key`, async (t) => {
    let upstream = 0;
    let body = {
      error: {
        code: 400,
        status: 'INVALID_ARGUMENT',
        details: [{ reason: 'API_KEY_INVALID' }],
      },
    };
    const f = await fixture(t, provider, async () => {
      upstream++;
      return Response.json(body, { status: 400 });
    });
    const first = await f.send();
    assert.equal(first.status, 502);
    assert.equal((await first.json()).code, 'API_KEY_REJECTED');
    const cooling = await f.send();
    assert.equal((await cooling.json()).code, 'API_KEY_REJECTED');
    assert.equal(upstream, 1, 'the rejected key is not sent again');
    // Any other 400 is a plain failure and does not cool the key down.
    body = { error: { code: 400, status: 'INVALID_ARGUMENT' } };
    const plain = await fixture(t, provider, async () => {
      upstream++;
      return Response.json(body, { status: 400 });
    });
    const other = await plain.send();
    assert.equal(other.status, 502);
    assert.equal((await other.json()).code, undefined);
    await plain.send();
    assert.equal(upstream, 3);
  });
  test(`${name} a 403 or an out-of-credit 429 cools down with its own code`, async (t) => {
    for (const [status, body, code] of [
      [
        403,
        { error: { code: 'unsupported_country_region_territory' } },
        'ACCESS_DENIED',
      ],
      [429, { error: { code: 'insufficient_quota' } }, 'QUOTA_EXCEEDED'],
    ]) {
      let upstream = 0;
      const f = await fixture(t, provider, async () => {
        upstream++;
        return Response.json(body, { status });
      });
      const first = await f.send();
      assert.equal(first.status, 502);
      assert.equal((await first.json()).code, code);
      const cooling = await f.send();
      assert.equal((await cooling.json()).code, code);
      assert.equal(upstream, 1, `${code} is not retried at once`);
    }
  });
  test(`${name} only an exact invalid-key reason marks a 400 as a rejected key`, async (t) => {
    let upstream = 0;
    const f = await fixture(t, provider, async () => {
      upstream++;
      return Response.json(
        { error: { code: 400, message: 'Field API_KEY_INVALID is unknown' } },
        { status: 400 },
      );
    });
    const reply = await f.send();
    assert.equal(reply.status, 502);
    assert.equal((await reply.json()).code, undefined);
    await f.send();
    assert.equal(upstream, 2);
  });
  test(`${name} refusal bodies are read within 16 KB and released when unread`, async (t) => {
    // An oversized error body is not parsed, so its reason does not count.
    const padded = await fixture(t, provider, async () =>
      Response.json(
        {
          error: {
            message: 'x'.repeat(20 * 1024),
            details: [{ reason: 'API_KEY_INVALID' }],
          },
        },
        { status: 400 },
      ),
    );
    const reply = await padded.send();
    assert.equal(reply.status, 502);
    assert.equal((await reply.json()).code, undefined);
    // A 401 body is never read, and is cancelled rather than left open.
    let cancelled = false;
    const unread = await fixture(
      t,
      provider,
      async () =>
        new Response(
          new ReadableStream({
            pull: () => {},
            cancel: () => {
              cancelled = true;
            },
          }),
          { status: 401 },
        ),
    );
    assert.equal((await (await unread.send()).json()).code, 'API_KEY_REJECTED');
    assert.equal(cancelled, true);
  });
  test(`${name} offers osm_query, and names it, only with Overpass, as voice does`, async (t) => {
    for (const overpass of [false, true]) {
      const f = await fixture(t, provider, undefined, {
        tools: GEV_REALTIME_TOOLS,
        overpassConfigured: () => overpass,
      });
      assert.equal((await f.send()).status, 200);
      const { body } = f.calls[0];
      const offered =
        name === 'openai'
          ? body.tools.map((tool) => tool.function.name)
          : name === 'anthropic'
            ? body.tools.map((tool) => tool.name)
            : name === 'bedrock'
              ? body.toolConfig.tools.map((tool) => tool.toolSpec.name)
              : body.tools[0].functionDeclarations.map((tool) => tool.name);
      const prompt =
        name === 'openai'
          ? body.messages[0].content
          : name === 'anthropic'
            ? body.system
            : name === 'bedrock'
              ? body.system[0].text
              : body.systemInstruction.parts[0].text;
      assert.equal(offered.includes('osm_query'), overpass);
      assert.equal(prompt.includes('osm_query'), overpass);
      assert.ok(offered.includes('resolve_area'));
    }
  });
  test(`${name} throttled replies say they are rate limited`, async (t) => {
    const local = await fixture(t, provider, undefined, {
      resolveRateLimit: () => '1',
    });
    await local.send();
    const limited = await local.send();
    assert.equal(limited.status, 429);
    assert.equal((await limited.json()).code, 'RATE_LIMITED');
    const upstream = await fixture(t, provider, async () =>
      Response.json({}, { status: 429, headers: { 'Retry-After': '7' } }),
    );
    const busy = await upstream.send();
    assert.equal(busy.status, 429);
    assert.equal(busy.headers.get('retry-after'), '7');
    assert.equal((await busy.json()).code, 'RATE_LIMITED');
  });
  test(`${name} chat throttle follows the provider throttle unless set`, async (t) => {
    const burst = async (overrides, count) => {
      const f = await fixture(t, provider, undefined, overrides);
      const statuses = [];
      for (let i = 0; i < count; i++) statuses.push((await f.send()).status);
      return { statuses, calls: f.calls.length, last: f };
    };
    const unset = await burst(
      {
        resolveRateLimit: () => undefined,
        resolveProviderRateLimit: () => undefined,
      },
      31,
    );
    assert.equal(
      unset.calls,
      30,
      'the default cap is the provider default, 30',
    );
    assert.equal(unset.statuses.at(-1), 429);
    const follows = await burst(
      { resolveRateLimit: () => '', resolveProviderRateLimit: () => '2' },
      3,
    );
    assert.deepEqual(follows.statuses, [200, 200, 429]);
    const own = await burst(
      { resolveRateLimit: () => '3', resolveProviderRateLimit: () => '2' },
      4,
    );
    assert.deepEqual(own.statuses, [200, 200, 200, 429]);
    const off = await burst(
      { resolveRateLimit: () => '0', resolveProviderRateLimit: () => '2' },
      4,
    );
    assert.deepEqual(off.statuses, [200, 200, 200, 200]);
    const capped = await fixture(t, provider, undefined, {
      resolveRateLimit: () => '1',
    });
    assert.equal((await capped.send()).status, 200);
    const refused = await capped.send();
    assert.equal(refused.status, 429);
    assert.equal(refused.headers.get('retry-after'), '60');
    assert.deepEqual(await refused.json(), {
      error: 'Could not connect. Try again.',
      code: 'RATE_LIMITED',
    });
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

test('chat throttles read their own variables and fall back per provider', async (t) => {
  const names = [
    'GEV_RATELIMIT_OPENAI_CHAT_PER_MIN',
    'GEV_RATELIMIT_OPENAI_PER_MIN',
    'GEV_RATELIMIT_GEMINI_CHAT_PER_MIN',
    'GEV_RATELIMIT_GEMINI_PER_MIN',
    'GEV_RATELIMIT_ANTHROPIC_CHAT_PER_MIN',
    'GEV_RATELIMIT_ANTHROPIC_PER_MIN',
    'GEV_RATELIMIT_VERTEX_CHAT_PER_MIN',
    'GEV_RATELIMIT_VERTEX_PER_MIN',
    'GEV_RATELIMIT_BEDROCK_CHAT_PER_MIN',
    'GEV_RATELIMIT_BEDROCK_PER_MIN',
  ];
  const saved = Object.fromEntries(names.map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  });
  const allowed = async (provider, count) => {
    const f = await fixture(t, provider, undefined, {
      resolveRateLimit: undefined,
    });
    let ok = 0;
    for (let i = 0; i < count; i++) if ((await f.send()).status === 200) ok++;
    return ok;
  };
  for (const key of names) delete process.env[key];
  process.env.GEV_RATELIMIT_OPENAI_PER_MIN = '2';
  process.env.GEV_RATELIMIT_GEMINI_PER_MIN = '3';
  process.env.GEV_RATELIMIT_ANTHROPIC_PER_MIN = '1';
  process.env.GEV_RATELIMIT_VERTEX_PER_MIN = '4';
  process.env.GEV_RATELIMIT_BEDROCK_PER_MIN = '3';
  assert.equal(await allowed(providers.openai, 5), 2);
  assert.equal(await allowed(providers.gemini, 5), 3);
  assert.equal(await allowed(providers.anthropic, 5), 1);
  assert.equal(await allowed(providers.vertex, 6), 4);
  assert.equal(await allowed(providers.bedrock, 5), 3);
  process.env.GEV_RATELIMIT_OPENAI_CHAT_PER_MIN = '4';
  process.env.GEV_RATELIMIT_GEMINI_CHAT_PER_MIN = '0';
  process.env.GEV_RATELIMIT_ANTHROPIC_CHAT_PER_MIN = '2';
  process.env.GEV_RATELIMIT_VERTEX_CHAT_PER_MIN = '5';
  process.env.GEV_RATELIMIT_BEDROCK_CHAT_PER_MIN = '1';
  assert.equal(await allowed(providers.openai, 6), 4);
  assert.equal(await allowed(providers.gemini, 6), 6);
  assert.equal(await allowed(providers.anthropic, 6), 2);
  assert.equal(await allowed(providers.vertex, 7), 5);
  assert.equal(await allowed(providers.bedrock, 4), 1);
});

test('the ChatGPT OAuth lock refuses OpenAI chat but not Gemini chat', async (t) => {
  for (const [value, code] of [
    ['true', 'CODEX_OAUTH_REQUIRED'],
    ['maybe', 'CODEX_OAUTH_REQUIRED'],
    ['false', undefined],
  ]) {
    const environment = { GEV_PREFER_CODEX_OAUTH: value };
    const openai = await fixture(t, providers.openai, undefined, {
      environment,
    });
    const response = await openai.send();
    const body = await response.json();
    assert.equal(response.status, code ? 503 : 200);
    assert.equal(body.code, code);
    if (code) {
      assert.equal(typeof body.error, 'string');
      assert.equal(openai.calls.length, 0, 'the API key must not be billed');
    }
    const gemini = await fixture(t, providers.gemini, undefined, {
      environment,
    });
    assert.equal((await gemini.send()).status, 200);
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

test('Anthropic overload 529 answers 503 and passes on Retry-After', async (t) => {
  const f = await fixture(t, providers.anthropic, async () =>
    Response.json(
      { type: 'error', error: { type: 'overloaded_error', message: 'Busy' } },
      { status: 529, headers: { 'Retry-After': '9' } },
    ),
  );
  const response = await f.send();
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('retry-after'), '9');
  assert.deepEqual(await response.json(), {
    error: 'Could not connect. Try again.',
  });
});

test('Anthropic history must alternate and answer each tool_use batch in order', async (t) => {
  const f = await fixture(t, providers.anthropic);
  const user = (text) => ({ role: 'user', content: text });
  const calls = {
    role: 'assistant',
    content: [
      { type: 'text', text: 'Flying' },
      { type: 'tool_use', id: 'a', name: 'fly_to', input: { lat: 1 } },
      { type: 'tool_use', id: 'b', name: 'fly_to', input: { lat: 2 } },
    ],
  };
  const results = (...ids) => ({
    role: 'user',
    content: ids.map((id) => ({
      type: 'tool_result',
      tool_use_id: id,
      content: '{"ok":true}',
    })),
  });
  const done = { role: 'assistant', content: [{ type: 'text', text: 'Done' }] };
  const send = async (messages) => (await f.send({ messages })).status;
  assert.equal(
    await send([user('Go'), calls, results('a', 'b'), done, user('Next')]),
    200,
  );
  assert.equal(await send([user('Go'), calls, results('a', 'b')]), 200);
  // Results out of order, missing, or mixed with text.
  assert.equal(await send([user('Go'), calls, results('b', 'a')]), 400);
  assert.equal(await send([user('Go'), calls, results('a')]), 400);
  const mixed = results('a', 'b');
  mixed.content.push({ type: 'text', text: 'And more' });
  assert.equal(await send([user('Go'), calls, mixed]), 400);
  // A result with no call before it, and a call left unanswered.
  assert.equal(await send([results('a')]), 400);
  assert.equal(await send([user('Go'), done, results('a')]), 400);
  assert.equal(await send([user('Go'), calls]), 400);
  assert.equal(await send([user('Go'), calls, user('Never mind')]), 400);
  // Roles alternate from the user and the history ends with the user.
  assert.equal(await send([user('Go'), user('Again')]), 400);
  assert.equal(await send([done, user('Go')]), 400);
  assert.equal(await send([user('Go'), done]), 400);
  // Only known blocks and keys cross the route.
  assert.equal(
    await send([
      {
        role: 'user',
        content: [{ type: 'image', source: { type: 'url', url: 'x' } }],
      },
    ]),
    400,
  );
  assert.equal(
    await send([
      { role: 'user', content: [{ type: 'text', text: 'Hi', cache: 1 }] },
    ]),
    400,
  );
  assert.equal(
    await send([{ role: 'user', content: 'Hi', name: 'override' }]),
    400,
  );
  assert.equal(await send([user('')]), 400);
  assert.equal(f.calls.length, 2);
});

test('Anthropic replies keep only the blocks history can send back', async (t) => {
  const reply = (content) => async () =>
    Response.json({
      ...providers.anthropic.reply(),
      content,
      stop_reason: 'end_turn',
    });
  const f = await fixture(
    t,
    providers.anthropic,
    reply([{ type: 'text', text: 'Hi', citations: null }]),
  );
  const body = await (await f.send()).json();
  assert.deepEqual(body.content, {
    role: 'assistant',
    content: [{ type: 'text', text: 'Hi' }],
  });
  assert.equal(body.finishReason, 'end_turn');
  const thinking = await fixture(
    t,
    providers.anthropic,
    reply([{ type: 'thinking', thinking: '', signature: 's' }]),
  );
  assert.equal((await thinking.send()).status, 502);
});

test('parseUsage adds Anthropic cache tokens to input and needs both counts', () => {
  assert.deepEqual(
    parseUsage('anthropic', { usage: { input_tokens: 7, output_tokens: 3 } }),
    {
      inputTokens: 7,
      outputTokens: 3,
      totalTokens: 10,
      reasoningTokens: 0,
      cachedInputTokens: 0,
    },
  );
  assert.deepEqual(
    parseUsage('anthropic', {
      usage: {
        input_tokens: 7,
        output_tokens: 3,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 20,
      },
    }),
    {
      inputTokens: 127,
      outputTokens: 3,
      totalTokens: 130,
      reasoningTokens: 0,
      cachedInputTokens: 100,
    },
  );
  assert.equal(parseUsage('anthropic', { usage: { input_tokens: 7 } }), null);
  assert.equal(
    parseUsage('anthropic', { usage: { input_tokens: -1, output_tokens: 3 } }),
    null,
  );
  assert.equal(parseUsage('anthropic', {}), null);
});

// The fields Vertex AI's Schema accepts; any other key is a 400 upstream.
const VERTEX_SCHEMA_KEYS = new Set([
  'type',
  'format',
  'title',
  'description',
  'nullable',
  'default',
  'items',
  'minItems',
  'maxItems',
  'enum',
  'properties',
  'propertyOrdering',
  'required',
  'minProperties',
  'maxProperties',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'pattern',
  'example',
  'anyOf',
]);

test('Vertex sends converted tool schemas while Gemini keeps parametersJsonSchema', async (t) => {
  const offered = { tools: GEV_REALTIME_TOOLS, overpassConfigured: () => true };
  const vertex = await fixture(t, providers.vertex, undefined, offered);
  const gemini = await fixture(t, providers.gemini, undefined, offered);
  assert.equal((await vertex.send()).status, 200);
  assert.equal((await gemini.send()).status, 200);
  const declared = (f) => f.calls[0].body.tools[0].functionDeclarations;
  assert.equal(declared(vertex).length, GEV_REALTIME_TOOLS.length);
  const walk = (schema, path) => {
    for (const key of Object.keys(schema))
      assert.ok(VERTEX_SCHEMA_KEYS.has(key), `${path} sends ${key}`);
    assert.equal(schema.type, schema.type?.toUpperCase(), path);
    for (const [name, child] of Object.entries(schema.properties ?? {}))
      walk(child, `${path}.${name}`);
    if (schema.items) walk(schema.items, `${path}[]`);
    for (const [index, child] of (schema.anyOf ?? []).entries())
      walk(child, `${path}|${index}`);
  };
  let withoutArguments = 0;
  for (const [index, declaration] of declared(vertex).entries()) {
    const source = GEV_REALTIME_TOOLS[index];
    assert.equal(declaration.name, source.name);
    assert.equal(declaration.parametersJsonSchema, undefined);
    // A tool without arguments declares no parameters at all.
    if (!Object.keys(source.parameters.properties).length) {
      assert.deepEqual(Object.keys(declaration), ['name', 'description']);
      withoutArguments++;
      continue;
    }
    assert.deepEqual(Object.keys(declaration), [
      'name',
      'description',
      'parameters',
    ]);
    assert.equal(declaration.parameters.type, 'OBJECT');
    walk(declaration.parameters, declaration.name);
    assert.deepEqual(
      declaration.parameters.required,
      source.parameters.required,
    );
  }
  assert.ok(withoutArguments > 0, 'the catalog has a tool without arguments');
  for (const [index, declaration] of declared(gemini).entries()) {
    assert.equal(declaration.parameters, undefined);
    assert.deepEqual(
      declaration.parametersJsonSchema,
      GEV_REALTIME_TOOLS[index].parameters,
    );
  }
});

test('Vertex sends thinkingLevel to Gemini 3, none to Gemini 2.5, and refuses Live models', async (t) => {
  const three = await fixture(t, providers.vertex, undefined, {
    resolveChatModel: () => 'gemini-3-flash-preview',
  });
  assert.equal((await three.send()).status, 200);
  assert.equal(
    three.calls[0].url,
    'https://aiplatform.googleapis.com/v1beta1/publishers/google/models/gemini-3-flash-preview:generateContent',
  );
  assert.deepEqual(three.calls[0].body.generationConfig.thinkingConfig, {
    thinkingLevel: 'LOW',
  });
  // Gemini 2.5 refuses thinkingLevel, so it is left out.
  const two = await fixture(t, providers.vertex, undefined, {
    resolveChatModel: () => 'gemini-2.5-flash-lite',
  });
  assert.equal((await two.send()).status, 200);
  assert.equal(two.calls[0].body.generationConfig.thinkingConfig, undefined);
  for (const model of ['gemini-3.8-live', 'gemini-2.5-flash-preview-tts']) {
    const live = await fixture(t, providers.vertex, undefined, {
      resolveChatModel: () => model,
    });
    assert.equal((await live.send()).status, 503);
    assert.equal(live.calls.length, 0);
  }
});

test('parseUsage reads Vertex usageMetadata exactly as Gemini', () => {
  for (const usageMetadata of [
    {
      promptTokenCount: 7,
      candidatesTokenCount: 2,
      totalTokenCount: 10,
      thoughtsTokenCount: 1,
      cachedContentTokenCount: 4,
    },
    { promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 },
  ]) {
    const vertex = parseUsage('vertex', { usageMetadata });
    assert.deepEqual(vertex, parseUsage('gemini', { usageMetadata }));
    assert.equal(vertex.outputTokens, 3);
    assert.equal(vertex.totalTokens, 10);
  }
  assert.equal(parseUsage('vertex', { usage: { prompt_tokens: 1 } }), null);
});

test('Bedrock URL-encodes an ARN model id and takes the Region from BEDROCK_REGION', async (t) => {
  const arn =
    'arn:aws:bedrock:eu-west-1:123456789012:inference-profile/eu.anthropic.claude-haiku-5-5';
  const f = await fixture(t, providers.bedrock, undefined, {
    resolveChatModel: () => arn,
    resolveRegion: () => 'eu-west-1',
  });
  assert.equal((await f.send()).status, 200);
  assert.equal(
    f.calls[0].url,
    `https://bedrock-runtime.eu-west-1.amazonaws.com/model/${encodeURIComponent(arn)}/converse`,
  );
  assert.ok(!f.calls[0].url.slice(8).includes(':'));
  assert.equal(f.calls[0].body.model, undefined);
});

test('Bedrock refuses an invalid BEDROCK_REGION or model before upstream', async (t) => {
  for (const overrides of [
    { resolveRegion: () => 'us-east-1.evil.test' },
    { resolveRegion: () => 'US-EAST-1' },
    { resolveRegion: () => '' },
    { resolveChatModel: () => '../converse' },
    { resolveChatModel: () => 'model id' },
    { resolveChatModel: () => 'x'.repeat(2049) },
  ]) {
    const f = await fixture(t, providers.bedrock, undefined, overrides);
    assert.equal((await f.send()).status, 503);
    assert.equal(f.calls.length, 0);
  }
  const gov = await fixture(t, providers.bedrock, undefined, {
    resolveRegion: () => 'us-gov-west-1',
  });
  assert.equal((await gov.send()).status, 200);
  assert.match(gov.calls[0].url, /^https:\/\/bedrock-runtime\.us-gov-west-1\./);
});

test('Bedrock history must alternate and answer each toolUse batch in order', async (t) => {
  const f = await fixture(t, providers.bedrock);
  const user = (text) => ({ role: 'user', content: [{ text }] });
  const use = (toolUseId, lat) => ({
    toolUse: { toolUseId, name: 'fly_to', input: { lat } },
  });
  const calls = {
    role: 'assistant',
    content: [{ text: 'Flying' }, use('a', 1), use('b', 2)],
  };
  const results = (...ids) => ({
    role: 'user',
    content: ids.map((toolUseId) => ({
      toolResult: { toolUseId, content: [{ json: { ok: true } }] },
    })),
  });
  const done = { role: 'assistant', content: [{ text: 'Done' }] };
  const send = async (messages) => (await f.send({ messages })).status;
  assert.equal(
    await send([user('Go'), calls, results('a', 'b'), done, user('Next')]),
    200,
  );
  assert.equal(await send([user('Go'), calls, results('a', 'b')]), 200);
  // Results out of order, missing, or mixed with text.
  assert.equal(await send([user('Go'), calls, results('b', 'a')]), 400);
  assert.equal(await send([user('Go'), calls, results('a')]), 400);
  const mixed = results('a', 'b');
  mixed.content.push({ text: 'And more' });
  assert.equal(await send([user('Go'), calls, mixed]), 400);
  // A result with no call before it, and a call left unanswered.
  assert.equal(await send([results('a')]), 400);
  assert.equal(await send([user('Go'), done, results('a')]), 400);
  assert.equal(await send([user('Go'), calls]), 400);
  assert.equal(await send([user('Go'), calls, user('Never mind')]), 400);
  // Roles alternate from the user and the history ends with the user.
  assert.equal(await send([user('Go'), user('Again')]), 400);
  assert.equal(await send([done, user('Go')]), 400);
  assert.equal(await send([user('Go'), done]), 400);
  // Only one member per block, and only text, tool and reasoning blocks.
  assert.equal(
    await send([{ role: 'user', content: [{ text: 'Hi', cachePoint: {} }] }]),
    400,
  );
  for (const block of [
    { image: { format: 'png', source: { bytes: 'AA==' } } },
    { document: { name: 'd', format: 'txt', source: { bytes: 'AA==' } } },
    { cachePoint: { type: 'default' } },
    { guardContent: { text: { text: 'Hi' } } },
    {},
  ])
    assert.equal(await send([{ role: 'user', content: [block] }]), 400);
  // Tool results carry one JSON object, with no status or text wrapping.
  for (const toolResult of [
    { toolUseId: 'a', content: [{ text: '{"ok":true}' }] },
    { toolUseId: 'a', content: [{ json: { ok: true } }], status: 'success' },
    { toolUseId: 'a', content: [{ json: { ok: true }, text: 'x' }] },
    { toolUseId: 'a', content: [] },
  ]) {
    const answer = results('a', 'b');
    answer.content[0] = { toolResult };
    assert.equal(await send([user('Go'), calls, answer]), 400);
  }
  // Ids and names follow Converse's own patterns.
  for (const [toolUseId, name] of [
    ['a b', 'fly_to'],
    ['x'.repeat(65), 'fly_to'],
    ['a', 'fly to'],
    ['a', 'x'.repeat(65)],
  ])
    assert.equal(
      await send([
        user('Go'),
        {
          role: 'assistant',
          content: [{ toolUse: { toolUseId, name, input: {} } }],
        },
        results(toolUseId),
      ]),
      400,
    );
  assert.equal(
    await send([{ role: 'user', content: 'Hi' }]),
    400,
    'Converse content is always an array of blocks',
  );
  assert.equal(
    await send([{ role: 'user', content: [{ text: 'Hi' }], name: 'x' }]),
    400,
  );
  assert.equal(await send([user('')]), 400);
  assert.equal(f.calls.length, 2);
});

test('Bedrock keeps reasoning blocks opaquely and refuses other reply blocks', async (t) => {
  const upstream = [];
  const reply =
    (content, stopReason = 'end_turn') =>
    async (url, options) => {
      upstream.push(JSON.parse(options.body));
      return Response.json({
        ...providers.bedrock.reply(),
        output: { message: { role: 'assistant', content } },
        stopReason,
      });
    };
  const thought = {
    reasoningContent: { reasoningText: { text: 'Think', signature: 'sig' } },
  };
  const redacted = { reasoningContent: { redactedContent: 'b3BhcXVl' } };
  const f = await fixture(
    t,
    providers.bedrock,
    reply([thought, redacted, { text: '' }, { text: 'Hi' }]),
  );
  const body = await (await f.send()).json();
  assert.deepEqual(body.content, {
    role: 'assistant',
    content: [thought, redacted, { text: 'Hi' }],
  });
  assert.equal(body.finishReason, 'end_turn');
  // Fields outside the accepted members are left out of history.
  const extra = await fixture(
    t,
    providers.bedrock,
    reply([
      {
        reasoningContent: {
          reasoningText: { text: 'Think', signature: 'sig', extra: 1 },
        },
      },
      { toolUse: { toolUseId: 'c', name: 'fly_to', input: {}, extra: 1 } },
    ]),
  );
  assert.deepEqual((await (await extra.send()).json()).content.content, [
    thought,
    { toolUse: { toolUseId: 'c', name: 'fly_to', input: {} } },
  ]);
  for (const content of [
    [{ image: { format: 'png', source: { bytes: 'AA==' } } }, { text: 'Hi' }],
    [{ text: 'Hi', citationsContent: {} }],
    [{ citationsContent: { content: [{ text: 'Hi' }], citations: [] } }],
    [{ reasoningContent: { reasoningText: { text: 'x'.repeat(64001) } } }],
    [
      {
        reasoningContent: {
          reasoningText: { text: 'a' },
          redactedContent: 'b',
        },
      },
    ],
    [{ text: '' }],
  ]) {
    const refused = await fixture(t, providers.bedrock, reply(content));
    assert.equal((await refused.send()).status, 502, JSON.stringify(content));
  }

  // The reply's reasoning goes back unchanged within the turn that made it.
  const round = await fixture(
    t,
    providers.bedrock,
    reply(
      [
        thought,
        { toolUse: { toolUseId: 'c', name: 'fly_to', input: { lat: 1 } } },
      ],
      'tool_use',
    ),
  );
  const calls = (await (await round.send()).json()).content;
  assert.deepEqual(calls.content[0], thought);
  const results = {
    role: 'user',
    content: [
      { toolResult: { toolUseId: 'c', content: [{ json: { ok: true } }] } },
    ],
  };
  const sameTurn = [...providers.bedrock.input.messages, calls, results];
  assert.equal((await round.send({ messages: sameTurn })).status, 200);
  assert.deepEqual(upstream.at(-1).messages, sameTurn);
  // An earlier turn's reasoning is left out: the chat shortens earlier turns,
  // and a block whose prefix changed is refused upstream.
  const done = { role: 'assistant', content: [thought, { text: 'Done' }] };
  const later = [
    ...sameTurn,
    done,
    { role: 'user', content: [{ text: 'Next' }] },
  ];
  assert.equal((await round.send({ messages: later })).status, 200);
  const sent = upstream.at(-1).messages;
  assert.deepEqual(sent[1].content, [calls.content[1]]);
  assert.deepEqual(sent[3].content, [{ text: 'Done' }]);
  assert.deepEqual(sent.at(-1), later.at(-1));
  // Reasoning is the assistant's own; a user message cannot carry it.
  assert.equal(
    (
      await round.send({
        messages: [{ role: 'user', content: [{ text: 'Hi' }, thought] }],
      })
    ).status,
    400,
  );
});

test('parseUsage derives Bedrock input from its total and keeps cache reads', () => {
  assert.deepEqual(
    parseUsage('bedrock', {
      usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
    }),
    {
      inputTokens: 7,
      outputTokens: 3,
      totalTokens: 10,
      reasoningTokens: 0,
      cachedInputTokens: 0,
    },
  );
  assert.deepEqual(
    parseUsage('bedrock', {
      usage: {
        inputTokens: 7,
        outputTokens: 3,
        totalTokens: 130,
        cacheReadInputTokens: 100,
        cacheWriteInputTokens: 20,
      },
    }),
    {
      inputTokens: 127,
      outputTokens: 3,
      totalTokens: 130,
      reasoningTokens: 0,
      cachedInputTokens: 100,
    },
  );
  assert.equal(
    parseUsage('bedrock', { usage: { inputTokens: 7, outputTokens: 3 } }),
    null,
  );
  assert.equal(
    parseUsage('bedrock', { usage: { outputTokens: 11, totalTokens: 10 } }),
    null,
  );
  assert.equal(
    parseUsage('bedrock', { usage: { outputTokens: -1, totalTokens: 10 } }),
    null,
  );
  assert.equal(parseUsage('bedrock', {}), null);
  // The other providers read their own shapes, unchanged.
  assert.equal(
    parseUsage('anthropic', {
      usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
    }),
    null,
  );
});

test('every GEV tool name fits a Converse toolSpec name', () => {
  assert.ok(GEV_REALTIME_TOOLS.length > 0);
  for (const tool of GEV_REALTIME_TOOLS)
    assert.match(tool.name, /^[a-zA-Z0-9_-]{1,64}$/);
});
