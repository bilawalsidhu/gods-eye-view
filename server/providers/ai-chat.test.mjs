import test from 'node:test';
import assert from 'node:assert/strict';
import { aiChatProxy, sanitizeMessages } from './ai-chat.js';

const ENV_NAMES = [
  'DEEPSEEK_API_KEY',
  'DEEPSEEK_COMMAND_MODEL',
  'MIMO_API_KEY',
  'MIMO_API_BASE',
  'MIMO_COMMAND_MODEL',
  'AI_CHAT_PROVIDER',
];

function withEnv(t, values) {
  const saved = Object.fromEntries(ENV_NAMES.map((n) => [n, process.env[n]]));
  for (const name of ENV_NAMES) delete process.env[name];
  Object.assign(process.env, values);
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

function routes() {
  const handlers = new Map();
  aiChatProxy().configureServer({
    middlewares: { use: (path, handler) => handlers.set(path, handler) },
  });
  return handlers;
}

function call(handler, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve) => {
    const chunks = body === undefined ? [] : [Buffer.from(body)];
    const req = {
      method,
      headers: { host: '127.0.0.1:5173', ...headers },
      socket: { remoteAddress: '127.0.0.1' },
      async *[Symbol.asyncIterator]() {
        yield* chunks;
      },
      on(event, fn) {
        if (event === 'data') chunks.forEach((c) => fn(c));
        if (event === 'end') fn();
        return this;
      },
    };
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(name, value) {
        this.headers[name.toLowerCase()] = value;
      },
      end(text) {
        resolve({ status: this.statusCode, json: JSON.parse(text || '{}') });
      },
    };
    handler(req, res);
  });
}

test('status lists only providers with a key and honours AI_CHAT_PROVIDER', async (t) => {
  withEnv(t, {
    DEEPSEEK_API_KEY: 'sk-test',
    MIMO_API_KEY: 'tp-test',
    MIMO_COMMAND_MODEL: 'mimo-v2.6-pro',
    AI_CHAT_PROVIDER: 'mimo',
  });
  const { status, json } = await call(routes().get('/api/ai/status'));
  assert.equal(status, 200);
  assert.equal(json.configured, true);
  assert.equal(json.defaultProvider, 'mimo');
  assert.deepEqual(
    json.providers.map((p) => [p.id, p.model]),
    [
      ['deepseek', 'deepseek-flash'],
      ['mimo', 'mimo-v2.6-pro'],
    ],
  );
});

test('status reports unconfigured without any key and ignores an unset preference', async (t) => {
  withEnv(t, { AI_CHAT_PROVIDER: 'mimo' });
  const { json } = await call(routes().get('/api/ai/status'));
  assert.equal(json.configured, false);
  assert.equal(json.defaultProvider, null);
  assert.deepEqual(json.providers, []);
});

test('chat refuses cross-site browser requests before reaching a provider', async (t) => {
  withEnv(t, { MIMO_API_KEY: 'tp-test' });
  const { status } = await call(routes().get('/api/ai/chat'), {
    method: 'POST',
    headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
    body: '{}',
  });
  assert.equal(status, 403);
});

test('chat forwards to the chosen provider base with its extra body', async (t) => {
  withEnv(t, {
    DEEPSEEK_API_KEY: 'sk-test',
    MIMO_API_KEY: 'tp-test',
    MIMO_API_BASE: 'https://token-plan-sgp.xiaomimimo.com/v1/',
  });
  const realFetch = globalThis.fetch;
  let seen;
  globalThis.fetch = async (url, init) => {
    seen = { url, init, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ choices: [] }), { status: 200 });
  };
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  const { status } = await call(routes().get('/api/ai/chat'), {
    method: 'POST',
    body: JSON.stringify({
      provider: 'mimo',
      messages: [{ role: 'assistant', content: 'hi', reasoning_content: 'x' }],
    }),
  });
  assert.equal(status, 200);
  assert.equal(
    seen.url,
    'https://token-plan-sgp.xiaomimimo.com/v1/chat/completions',
  );
  assert.equal(seen.init.headers.Authorization, 'Bearer tp-test');
  assert.equal(seen.body.model, 'mimo-v2.6-flash');
  assert.deepEqual(seen.body.thinking, { type: 'disabled' });
  assert.deepEqual(seen.body.messages, [{ role: 'assistant', content: 'hi' }]);
  assert.ok(seen.body.tools.length > 0);
});

test('chat rejects a provider that has no key', async (t) => {
  withEnv(t, { DEEPSEEK_API_KEY: 'sk-test' });
  const { status } = await call(routes().get('/api/ai/chat'), {
    method: 'POST',
    body: JSON.stringify({ provider: 'mimo', messages: [] }),
  });
  assert.equal(status, 400);
});

test('sanitizeMessages drops reasoning_content and keeps everything else', () => {
  assert.deepEqual(
    sanitizeMessages([
      {
        role: 'assistant',
        content: null,
        tool_calls: [],
        reasoning_content: 'r',
      },
      { role: 'tool', tool_call_id: 'a', content: '{}' },
    ]),
    [
      { role: 'assistant', content: null, tool_calls: [] },
      { role: 'tool', tool_call_id: 'a', content: '{}' },
    ],
  );
});

test('a provider error body is logged server-side, never relayed', async (t) => {
  withEnv(t, { DEEPSEEK_API_KEY: 'sk-test' });
  const realFetch = globalThis.fetch;
  const realWarn = console.warn;
  const warned = [];
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: { message: 'secret detail' } }), {
      status: 401,
    });
  console.warn = (...args) => warned.push(args.join(' '));
  t.after(() => {
    globalThis.fetch = realFetch;
    console.warn = realWarn;
  });
  const { status, json } = await call(routes().get('/api/ai/chat'), {
    method: 'POST',
    body: JSON.stringify({ messages: [] }),
  });
  assert.equal(status, 502);
  assert.equal(json.error, 'DeepSeek chat request failed (HTTP 401)');
  assert.doesNotMatch(JSON.stringify(json), /secret detail/);
  assert.match(warned.join('\n'), /secret detail/);
});
