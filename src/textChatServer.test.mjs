import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createGeminiChatHandler } from '../server/providers/gemini/chat.js';
import {
  chatSchema,
  createOpenAiChatHandler,
} from '../server/providers/openai/chat.js';
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
        ...(name === 'gemini' ? { candidates: [] } : { choices: [] }),
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
    if (name === 'gemini')
      echo.candidates[0].content.parts = [{ text: 'key fixture-only' }];
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
          : body.tools[0].functionDeclarations.map((tool) => tool.name);
      const prompt =
        name === 'openai'
          ? body.messages[0].content
          : body.systemInstruction.parts[0].text;
      assert.equal(offered.includes('osm_query'), overpass);
      assert.equal(prompt.includes('osm_query'), overpass);
      assert.ok(offered.includes('resolve_area'));
      // Chat Completions answers 400 invalid_function_parameters for a
      // pattern with Unicode property classes, as resolve_area's area ids
      // use; OpenAI chat leaves those patterns out.
      if (name === 'openai')
        assert.doesNotMatch(JSON.stringify(body.tools), /\\\\[pP]\{/);
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
  assert.equal(await allowed(providers.openai, 5), 2);
  assert.equal(await allowed(providers.gemini, 5), 3);
  process.env.GEV_RATELIMIT_OPENAI_CHAT_PER_MIN = '4';
  process.env.GEV_RATELIMIT_GEMINI_CHAT_PER_MIN = '0';
  assert.equal(await allowed(providers.openai, 6), 4);
  assert.equal(await allowed(providers.gemini, 6), 6);
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

test('OpenAI chat schemas drop only the patterns Chat Completions refuses', () => {
  assert.match(JSON.stringify(GEV_REALTIME_TOOLS), /\\\\[pP]\{/);
  assert.deepEqual(
    chatSchema({
      type: 'object',
      properties: {
        id: { type: 'string', pattern: '^ne:[\\p{L}]+$', maxLength: 80 },
        code: { type: 'string', pattern: '^[A-Z]{2}$' },
        list: { type: 'array', items: [{ pattern: '\\P{N}' }] },
      },
    }),
    {
      type: 'object',
      properties: {
        id: { type: 'string', maxLength: 80 },
        code: { type: 'string', pattern: '^[A-Z]{2}$' },
        list: { type: 'array', items: [{}] },
      },
    },
  );
});
