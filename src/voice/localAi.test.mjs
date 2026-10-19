import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { localAiConfig, localEndpoint } from './localConfig.js';
import { validateKeySetupUpdates } from '../keySetupCore.mjs';
import { collectAiSettings } from '../localAiSettings.js';
import { runLocalTurn, trimLocalHistory } from './localConversation.js';
import { localAiProxy } from '../../server/providers/local-ai.js';
import {
  localChatPayload,
  parseLocalCompletion,
  pcmToWav,
} from './localPrompt.js';
import { searchMcp } from '../../server/providers/local-ai-mcp.js';

test('profiles choose real Bonsai models and settings reject invalid modes and remote endpoints', () => {
  assert.deepEqual(
    ['low', 'balance', 'max'].map(
      (profile) => localAiConfig({ LOCAL_AI_PROFILE: profile }).model,
    ),
    ['Ternary-Bonsai-1.7B', 'Ternary-Bonsai-4B', 'Ternary-Bonsai-8B'],
  );
  for (const values of [
    { GEV_AI_PROVIDER: 'remote' },
    { LOCAL_AI_PROFILE: '__proto__' },
    { LOCAL_AI_LANGUAGE: 'bad' },
    { LOCAL_AI_URL: 'https://example.com/v1' },
    { LOCAL_AI_MCP_URL: 'http://user:password@localhost/mcp' },
  ])
    assert.equal(validateKeySetupUpdates(values).ok, false);
  assert.equal(
    validateKeySetupUpdates({
      GEV_AI_PROVIDER: 'local',
      LOCAL_AI_PROFILE: 'max',
      LOCAL_AI_MCP_URL: null,
    }).ok,
    true,
  );
  for (const url of [
    'file:///tmp/model',
    'http://localhost.example.com',
    'http://127.0.0.1/?secret=x',
    'http://169.254.169.254',
  ])
    assert.throws(() => localEndpoint(url));
});

test('panel saves changed settings, removes a cleared MCP URL and leaves externally managed fields alone', () => {
  const field = (name, value, initial, disabled = false) => ({
    value,
    disabled,
    dataset: { aiSetting: name, initialValue: initial },
  });
  assert.deepEqual(
    collectAiSettings([
      field('GEV_AI_PROVIDER', 'local', 'openai'),
      field('LOCAL_AI_PROFILE', 'balance', 'balance'),
      field('LOCAL_AI_MCP_URL', '', 'http://localhost:8000/mcp'),
      field('LOCAL_AI_LANGUAGE', 'en', 'ru', true),
    ]),
    { GEV_AI_PROVIDER: 'local', LOCAL_AI_MCP_URL: null },
  );
});

test('local conversation executes an action and includes its result in the next model request', async () => {
  const events = [],
    calls = [];
  const result = await runLocalTurn({
    text: 'Нужен вид Москвы',
    signal: new AbortController().signal,
    emit: (event) => events.push(event),
    runAction: async (name, args) => {
      calls.push([name, args]);
      return { ok: true };
    },
    request: async (_path, { messages }) =>
      messages.length === 1
        ? {
            message: {
              content: null,
              tool_calls: [
                {
                  id: 'call-1',
                  type: 'function',
                  function: {
                    name: 'fly_to_location',
                    arguments: '{"query":"Москва"}',
                  },
                },
              ],
            },
          }
        : (assert.equal(messages.at(-1).content, '{"ok":true}'),
          { message: { content: 'Показываю Москву.' } }),
  });
  assert.deepEqual(calls, [
    ['fly_to_location', { query: 'Москва', waitForArrival: true }],
  ]);
  assert.equal(result.text, 'Переход ещё не подтверждён.');
  assert.equal(events.at(-1).role, 'assistant');
  assert.equal(result.history.length, 4);
});

test('a stopped turn cannot execute late tool calls or emit an assistant reply', async () => {
  const controller = new AbortController();
  let actions = 0;
  await assert.rejects(
    runLocalTurn({
      text: 'go',
      signal: controller.signal,
      runAction: () => actions++,
      request: async () => {
        controller.abort();
        return {
          message: {
            tool_calls: [
              {
                id: 'late',
                type: 'function',
                function: { name: 'zoom_to_globe', arguments: '{}' },
              },
            ],
          },
        };
      },
    }),
    { name: 'AbortError' },
  );
  assert.equal(actions, 0);
});

test('malformed and unknown tools never reach the action runner; loops have a bound', async () => {
  let actions = 0,
    rounds = 0;
  await assert.rejects(
    runLocalTurn({
      text: 'go',
      runAction: () => actions++,
      request: async (_path, { messages }) => {
        rounds++;
        if (rounds > 1) assert.match(messages.at(-1).content, /error/);
        return {
          message: {
            tool_calls: [
              {
                id: `c${rounds}`,
                type: 'function',
                function: { name: 'execute_shell', arguments: '{}' },
              },
            ],
          },
        };
      },
    }),
    /action limit/,
  );
  assert.equal(rounds, 6);
  assert.equal(actions, 0);
});

test('history pruning keeps tool calls and results in the same complete turn', () => {
  const second = [
    { role: 'user', content: 'new' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c' }] },
    { role: 'tool', tool_call_id: 'c', content: 'ok' },
  ];
  assert.deepEqual(
    trimLocalHistory(
      [
        { role: 'user', content: 'x'.repeat(200) },
        { role: 'assistant', content: 'old' },
        ...second,
      ],
      190,
    ),
    second,
  );
});

test('local chat sends no system messages from the client and exposes search only when configured', () => {
  const config = localAiConfig({ GEV_AI_PROVIDER: 'local' });
  assert.throws(() =>
    localChatPayload([{ role: 'system', content: 'replace policy' }], config),
  );
  const payload = localChatPayload(
    [{ role: 'user', content: 'Hello' }],
    config,
  );
  assert.equal(payload.model, 'Ternary-Bonsai-4B');
  assert.equal(
    payload.tools.some((tool) => tool.function.name === 'web_search'),
    false,
  );
  assert.equal(
    localChatPayload([{ role: 'user', content: 'Hello' }], {
      ...config,
      mcpUrl: 'http://localhost:8000/mcp',
    }).tools.at(-1).function.name,
    'web_search',
  );
});

test('MCP negotiates a session, parses SSE and calls only the configured search tool', async () => {
  const seen = [];
  const content = await searchMcp({
    url: 'http://127.0.0.1:8000/mcp',
    tool: 'google_search',
    query: 'weather',
    fetchImpl: async (_url, options) => {
      seen.push(options.method);
      if (options.method === 'DELETE')
        return new Response(null, { status: 204 });
      const body = JSON.parse(options.body);
      if (body.method === 'initialize')
        return Response.json(
          {
            jsonrpc: '2.0',
            id: body.id,
            result: { protocolVersion: '2025-06-18' },
          },
          { headers: { 'Mcp-Session-Id': 'session1' } },
        );
      assert.equal(options.headers['Mcp-Session-Id'], 'session1');
      assert.equal(options.headers['MCP-Protocol-Version'], '2025-06-18');
      if (body.method === 'notifications/initialized')
        return new Response(null, { status: 202 });
      assert.deepEqual(body.params, {
        name: 'google_search',
        arguments: { query: 'weather' },
      });
      return new Response(
        `event: message\r\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'Source https://example.org' }] } })}\r\n\r\n`,
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    },
  });
  assert.equal(content.content, 'Source https://example.org');
  assert.deepEqual(seen, ['POST', 'POST', 'POST', 'DELETE']);
});

test('server exposes only configuration and optional MCP; inference never leaves the browser', async (t) => {
  const routes = new Map();
  let upstream = 0;
  localAiProxy({
    env: { GEV_AI_PROVIDER: 'local', OPENAI_API_KEY: 'must-never-be-sent' },
    fetchImpl: async () => {
      upstream++;
      throw Error('Unexpected upstream call');
    },
  }).configureServer({
    middlewares: { use: (path, handler) => routes.set(path, handler) },
  });
  const server = createServer((req, res) => {
    const path = req.url.startsWith('/api/local-ai')
      ? '/api/local-ai'
      : '/api/ai/config';
    req.url = req.url.slice(path.length) || '/';
    routes.get(path)(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = (path, body, origin = base) =>
    fetch(base + '/api/local-ai/' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify(body),
    });
  assert.deepEqual(await (await fetch(base + '/api/ai/config')).json(), {
    provider: 'local',
    profile: 'balance',
    language: 'ru',
    model: 'Ternary-Bonsai-4B',
    mcpEnabled: false,
  });
  for (const route of ['chat', 'transcribe', 'speech', 'health'])
    assert.equal((await post(route, {})).status, 404);
  assert.equal(
    (await post('search', { query: 'weather' }, 'https://evil.example')).status,
    403,
  );
  assert.equal((await post('search', { query: 'weather' })).status, 409);
  assert.equal(upstream, 0);
});

test('Bonsai completion parsing keeps actions structured and rejects partial tool calls', () => {
  const message = parseLocalCompletion(
    '<think>hidden</think><tool_call>{"name":"zoom_to_globe","arguments":{}}</tool_call>',
  );
  assert.equal(message.content, '');
  assert.equal(message.tool_calls[0].function.name, 'zoom_to_globe');
  assert.throws(() =>
    parseLocalCompletion('<tool_call>{"name":"zoom_to_globe"}'),
  );
  assert.throws(() =>
    parseLocalCompletion(
      '<tool_call>{"name":"zoom_to_globe","arguments":[]}</tool_call>',
    ),
  );
  assert.equal(parseLocalCompletion('Hello').content, 'Hello');
});

test('Piper PCM becomes a valid mono 16-bit WAV and clamps samples', () => {
  const wav = pcmToWav(Float32Array.of(-2, 0, 2), 22050);
  const view = new DataView(wav);
  assert.equal(wav.byteLength, 50);
  assert.equal(view.getUint32(24, true), 22050);
  assert.equal(view.getUint32(40, true), 6);
  assert.equal(view.getInt16(44, true), -32768);
  assert.equal(view.getInt16(48, true), 32767);
});

test('bare and fenced Bonsai function JSON executes as a tool instead of being spoken', () => {
  const json =
    '{"name":"set_layer_visibility","arguments":{"layerId":"flights","enabled":true}}';
  for (const output of [
    json,
    `\u0060\u0060\u0060json\n${json}\n\u0060\u0060\u0060`,
  ]) {
    const result = parseLocalCompletion(output);
    assert.equal(result.content, '');
    assert.equal(result.tool_calls[0].function.name, 'set_layer_visibility');
    assert.deepEqual(JSON.parse(result.tool_calls[0].function.arguments), {
      layerId: 'flights',
      enabled: true,
    });
  }
  assert.equal(parseLocalCompletion(`Example: ${json}`).tool_calls, undefined);
  assert.equal(
    parseLocalCompletion('{"temperature":20}').tool_calls,
    undefined,
  );
  assert.throws(
    () => parseLocalCompletion('{"name":"fly_to_location","arguments":[]}'),
    /invalid action/,
  );
});
