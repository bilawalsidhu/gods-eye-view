import test from 'node:test';
import assert from 'node:assert/strict';
import {
  installLocalVoiceMiddleware,
  resolveLocalVoiceProvider,
  sanitizeHistory,
  toAnthropicMessages,
  toAnthropicTools,
  toOllamaMessages,
  toOllamaTools,
} from '../../server/localVoice.js';

const TOOLS = [
  { type: 'function', name: 'fly_to_location', description: 'Fly', parameters: { type: 'object', properties: { query: { type: 'string' } } } },
  { type: 'function', name: 'zoom_to_globe', description: 'Globe' },
];

test('provider resolution: auto prefers Anthropic, then Ollama, else unconfigured', () => {
  assert.equal(resolveLocalVoiceProvider({}).configured, false);
  assert.equal(resolveLocalVoiceProvider({ OLLAMA_URL: 'http://x:11434/' }).provider, 'ollama');
  assert.equal(resolveLocalVoiceProvider({ OLLAMA_URL: 'http://x:11434/' }).url, 'http://x:11434');
  assert.equal(resolveLocalVoiceProvider({ OLLAMA_URL: 'http://x', ANTHROPIC_API_KEY: 'k' }).provider, 'anthropic');
  assert.equal(resolveLocalVoiceProvider({ LOCAL_VOICE_PROVIDER: 'ollama', ANTHROPIC_API_KEY: 'k' }).provider, 'ollama');
  assert.equal(resolveLocalVoiceProvider({ LOCAL_VOICE_PROVIDER: 'anthropic' }).configured, false);
  assert.equal(resolveLocalVoiceProvider({ OLLAMA_URL: 'http://x', OLLAMA_MODEL: 'qwen3', LOCAL_VOICE_LANG: 'es-ES' }).model, 'qwen3');
  assert.equal(resolveLocalVoiceProvider({ OLLAMA_URL: 'http://x', LOCAL_VOICE_LANG: 'es-ES' }).lang, 'es-ES');
});

test('tool schemas convert without touching the Realtime definitions', () => {
  const ollama = toOllamaTools(TOOLS);
  assert.equal(ollama[0].type, 'function');
  assert.equal(ollama[0].function.name, 'fly_to_location');
  assert.deepEqual(ollama[0].function.parameters, TOOLS[0].parameters);
  assert.deepEqual(ollama[1].function.parameters, { type: 'object', properties: {} });
  const anthropic = toAnthropicTools(TOOLS);
  assert.deepEqual(anthropic[0], { name: 'fly_to_location', description: 'Fly', input_schema: TOOLS[0].parameters });
  assert.equal(TOOLS[0].function, undefined, 'source tool objects must not be mutated');
});

test('history sanitizer normalizes roles, tool calls, and caps length', () => {
  const clean = sanitizeHistory([
    null,
    { role: 'user', content: 'hola' },
    { role: 'assistant', content: '', toolCalls: [{ name: 'zoom_to_globe' }, { id: 'c2', name: 'fly_to_location', args: { query: 'Lisbon' } }, { bogus: true }] },
    { role: 'tool', id: 'c2', name: 'fly_to_location', content: '{"ok":true}' },
    { role: 'system', content: 'ignored role becomes user' },
  ]);
  assert.equal(clean.length, 4);
  assert.deepEqual(clean[1].toolCalls, [
    { id: 'call_0', name: 'zoom_to_globe', args: {} },
    { id: 'c2', name: 'fly_to_location', args: { query: 'Lisbon' } },
  ]);
  assert.equal(clean[3].role, 'user');
  const long = sanitizeHistory(Array.from({ length: 60 }, (_, i) => ({ role: 'user', content: String(i) })));
  assert.equal(long.length, 24);
  assert.equal(long[0].content, '36');
});

test('Anthropic messages group tool results after the assistant tool_use turn and start with user', () => {
  const history = sanitizeHistory([
    { role: 'user', content: 'take me to Lisbon' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'fly_to_location', args: { query: 'Lisbon' } }, { id: 'c2', name: 'zoom_to_globe', args: {} }] },
    { role: 'tool', id: 'c1', name: 'fly_to_location', content: '{"ok":true}' },
    { role: 'tool', id: 'c2', name: 'zoom_to_globe', content: '{"ok":true}' },
  ]);
  const messages = toAnthropicMessages(history);
  assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.equal(messages[1].content.filter((b) => b.type === 'tool_use').length, 2);
  assert.deepEqual(messages[2].content.map((b) => b.tool_use_id), ['c1', 'c2']);
  const ollama = toOllamaMessages('SYS', history);
  assert.equal(ollama[0].role, 'system');
  assert.equal(ollama[2].tool_calls.length, 2);
  assert.equal(ollama[3].role, 'tool');
});

function fakeApp() {
  const routes = new Map();
  return { use: (path, handler) => routes.set(path, handler), routes };
}

function fakeReq(method, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  return { method, url: '/', [Symbol.asyncIterator]: async function* () { for (const c of chunks) yield c; } };
}

function fakeRes() {
  const res = { statusCode: 200, headers: {}, body: '' };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.end = (payload) => { res.body = payload; res.done = true; };
  return res;
}

test('status endpoint reports the resolved provider; turn refuses GET and unconfigured servers', async () => {
  const app = fakeApp();
  installLocalVoiceMiddleware(app, { tools: TOOLS, instructions: 'SYS', env: {} });
  const status = fakeRes();
  app.routes.get('/api/local-voice/status')(fakeReq('GET'), status);
  assert.deepEqual(JSON.parse(status.body), { configured: false, provider: null, model: null, lang: null });
  const get = fakeRes();
  await app.routes.get('/api/local-voice/turn')(fakeReq('GET'), get);
  assert.equal(get.statusCode, 405);
  const post = fakeRes();
  await app.routes.get('/api/local-voice/turn')(fakeReq('POST', { messages: [{ role: 'user', content: 'hi' }] }), post);
  assert.equal(post.statusCode, 503);
});

test('turn endpoint normalizes Ollama tool calls and Anthropic tool_use blocks', async () => {
  const originalFetch = globalThis.fetch;
  const seen = [];
  try {
    globalThis.fetch = async (url, init) => {
      seen.push({ url: String(url), body: JSON.parse(init.body) });
      if (String(url).includes('/api/chat')) {
        return new Response(JSON.stringify({ model: 'qwen3', message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'fly_to_location', arguments: { query: 'Lisbon' } } }] } }), { status: 200 });
      }
      return new Response(JSON.stringify({ model: 'claude', content: [{ type: 'text', text: 'Flying to Lisbon.' }, { type: 'tool_use', id: 'toolu_1', name: 'fly_to_location', input: { query: 'Lisbon' } }] }), { status: 200 });
    };
    const app = fakeApp();
    installLocalVoiceMiddleware(app, { tools: TOOLS, instructions: 'SYS', env: { OLLAMA_URL: 'http://ollama:11434', OLLAMA_MODEL: 'qwen3' } });
    const res = fakeRes();
    await app.routes.get('/api/local-voice/turn')(fakeReq('POST', { messages: [{ role: 'user', content: 'take me to Lisbon' }] }), res);
    const turn = JSON.parse(res.body);
    assert.equal(res.statusCode, 200);
    assert.equal(turn.provider, 'ollama');
    assert.equal(turn.toolCalls[0].name, 'fly_to_location');
    assert.deepEqual(turn.toolCalls[0].args, { query: 'Lisbon' });
    assert.equal(seen[0].body.tools[0].function.name, 'fly_to_location');
    assert.equal(seen[0].body.messages[0].role, 'system');
    assert.match(seen[0].body.messages[0].content, /^SYS\n/);

    const app2 = fakeApp();
    installLocalVoiceMiddleware(app2, { tools: TOOLS, instructions: 'SYS', env: { ANTHROPIC_API_KEY: 'k' } });
    const res2 = fakeRes();
    await app2.routes.get('/api/local-voice/turn')(fakeReq('POST', { messages: [{ role: 'user', content: 'take me to Lisbon' }] }), res2);
    const turn2 = JSON.parse(res2.body);
    assert.equal(turn2.provider, 'anthropic');
    assert.equal(turn2.text, 'Flying to Lisbon.');
    assert.deepEqual(turn2.toolCalls, [{ id: 'toolu_1', name: 'fly_to_location', args: { query: 'Lisbon' } }]);
    assert.equal(seen[1].body.tools[0].input_schema.type, 'object');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
