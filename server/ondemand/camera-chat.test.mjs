/**
 * Camera-chat server side: profile defaults (server/ondemand/camera-chat-config.js),
 * the chat proxy's `profile: 'camera'` / `attachment` handling, the
 * cursor-paginated messages proxy on sessions.js, the Media API raw upload
 * forward on media.js, the health `cameraChat` block, and keyless 503s.
 * docs/ONDEMAND_CAMERA_CHAT_ADDENDUM_2026-09-21.md
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeReq, makeRes, stubFetchSequence, jsonResponse } from './test-helpers.mjs';
import { __reloadConfigForTests } from './config.js';
import {
  __reloadCameraChatConfigForTests,
  cameraChatConfig,
  cameraChatPublicConfig,
  applyCameraProfile,
  parsePluginIds,
  CAMERA_CHAT_DEFAULTS,
  CAMERA_CHAT_ENV,
} from './camera-chat-config.js';
import { __resetStoreForTests } from './sessions-store.js';
import chatHandler from '../../api/ondemand/chat.js';
import sessionsHandler from '../../api/ondemand/sessions.js';
import mediaHandler from '../../api/ondemand/media.js';
import healthHandler from '../../api/ondemand/health.js';

const TEST_KEY = 'test-key-camera-chat';
const ENV_NAMES = [...Object.values(CAMERA_CHAT_ENV), 'ONDEMAND_API_KEY', 'ONDEMAND_FULFILLMENT_ENDPOINT_ID'];
let saved;
let activeStub = null;

beforeEach(() => {
  saved = Object.fromEntries(ENV_NAMES.map((n) => [n, process.env[n]]));
  for (const n of ENV_NAMES) delete process.env[n];
  __reloadConfigForTests();
  __reloadCameraChatConfigForTests();
  __resetStoreForTests();
});
afterEach(() => {
  activeStub?.restore();
  activeStub = null;
  for (const n of ENV_NAMES) {
    if (saved[n] === undefined) delete process.env[n];
    else process.env[n] = saved[n];
  }
  __reloadConfigForTests();
  __reloadCameraChatConfigForTests();
});

function keyed(extra = {}) {
  process.env.ONDEMAND_API_KEY = TEST_KEY;
  for (const [k, v] of Object.entries(extra)) process.env[k] = v;
  __reloadConfigForTests();
  __reloadCameraChatConfigForTests();
}

function sseResponse() {
  return new Response('event:message\ndata:{"eventType":"fulfillment","answer":"ok"}\n\nevent:message\ndata:[DONE]\n\n', {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

describe('camera-chat-config — defaults and env overrides (non-secret)', () => {
  test('defaults: cerebras text endpoint, Internet Agent pluginIds, reasoningMode low, image plugin, history 20', () => {
    const cfg = cameraChatConfig();
    assert.equal(cfg.endpointId, 'predefined-cerebras-qwen-3.8-27b');
    assert.equal(cfg.visionEndpointId, 'predefined-cerebras-qwen-3.8-27b', 'no vision endpoint documented → same as text');
    assert.equal(cfg.visionEndpointSource, 'text-endpoint');
    assert.deepEqual([...cfg.pluginIds], ['agent-1713924030']);
    assert.equal(cfg.reasoningMode, 'low');
    assert.equal(cfg.imagePluginId, 'plugin-1713958591');
    assert.equal(cfg.historyLimit, 20);
    assert.deepEqual(cfg.sources, { endpointId: 'default', visionEndpointId: 'default', pluginIds: 'default', reasoningMode: 'default', imagePluginId: 'default', historyLimit: 'default' });
    assert.deepEqual(CAMERA_CHAT_DEFAULTS.pluginIds, ['agent-1713924030']);
  });

  test('env overrides are honoured; an undocumented reasoning mode falls back to low and is flagged', () => {
    process.env[CAMERA_CHAT_ENV.endpointId] = 'predefined-qwen-3.8-max';
    process.env[CAMERA_CHAT_ENV.visionEndpointId] = 'predefined-gemini-3.7-flash';
    process.env[CAMERA_CHAT_ENV.pluginIds] = 'agent-1713924030, plugin-1775547203,,bad id!';
    process.env[CAMERA_CHAT_ENV.reasoningMode] = 'turbo-max';
    process.env[CAMERA_CHAT_ENV.historyLimit] = '50';
    __reloadCameraChatConfigForTests();
    const cfg = cameraChatConfig();
    assert.equal(cfg.endpointId, 'predefined-qwen-3.8-max');
    assert.equal(cfg.visionEndpointId, 'predefined-gemini-3.7-flash');
    assert.equal(cfg.visionEndpointSource, 'env');
    assert.deepEqual([...cfg.pluginIds], ['agent-1713924030', 'plugin-1775547203']);
    assert.equal(cfg.reasoningMode, 'low');
    assert.equal(cfg.reasoningModeInvalid, true);
    assert.equal(cfg.historyLimit, 50);
    process.env[CAMERA_CHAT_ENV.pluginIds] = '';
    process.env[CAMERA_CHAT_ENV.reasoningMode] = 'high';
    process.env[CAMERA_CHAT_ENV.historyLimit] = '500';
    __reloadCameraChatConfigForTests();
    assert.deepEqual([...cameraChatConfig().pluginIds], [], 'empty string disables the web agent');
    assert.equal(cameraChatConfig().reasoningMode, 'high');
    assert.equal(cameraChatConfig().historyLimit, 20, 'out-of-range limit → default');
    assert.deepEqual(parsePluginIds('a,b,a'), ['a', 'b']);
  });

  test('applyCameraProfile fills only what the body omitted; explicit values win; reasoningMode only in stream mode', () => {
    const streamed = applyCameraProfile({ responseMode: 'stream' });
    assert.deepEqual(streamed, { endpointId: 'predefined-cerebras-qwen-3.8-27b', pluginIds: ['agent-1713924030'], reasoningMode: 'low', applied: ['endpointId', 'pluginIds', 'reasoningMode'] });
    const withImage = applyCameraProfile({ responseMode: 'stream' }, { hasAttachment: true });
    assert.deepEqual(withImage.applied, ['visionEndpointId', 'pluginIds', 'reasoningMode']);
    const sync = applyCameraProfile({ responseMode: 'sync', pluginIds: [] });
    assert.deepEqual(sync, { endpointId: 'predefined-cerebras-qwen-3.8-27b', pluginIds: [], reasoningMode: undefined, applied: ['endpointId'] });
    const explicit = applyCameraProfile({ responseMode: 'stream', endpointId: 'predefined-claude-sonnet-5', reasoningMode: 'high' });
    assert.equal(explicit.endpointId, 'predefined-claude-sonnet-5');
    assert.equal(explicit.reasoningMode, 'high');
    assert.deepEqual(explicit.applied, ['pluginIds']);
  });

  test('the public block carries ids/mode names/env NAMES only — never the key', () => {
    keyed();
    const pub = cameraChatPublicConfig();
    assert.equal(JSON.stringify(pub).includes(TEST_KEY), false);
    assert.equal(pub.env.pluginIds, 'ONDEMAND_CAMERA_CHAT_PLUGIN_IDS');
    assert.deepEqual(pub.pluginIds, ['agent-1713924030']);
  });
});

describe('api/ondemand/chat.js — profile camera', () => {
  test('stream turn with profile camera gets endpointId + pluginIds + reasoningMode from the server config; profile/attachment never leave the proxy', async () => {
    keyed();
    activeStub = stubFetchSequence([sseResponse()]);
    const req = makeReq({ method: 'POST', url: '/api/ondemand/chat', body: { sessionId: 'sess-cam', query: 'How many lanes?', responseMode: 'stream', profile: 'camera', modelConfigs: { fulfillmentPrompt: 'ctx' } } });
    const res = makeRes();
    await chatHandler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(activeStub.calls.length, 1);
    const call = activeStub.calls[0];
    assert.equal(call.url, 'https://api.on-demand.io/chat/v1/sessions/sess-cam/query');
    const body = JSON.parse(call.init.body);
    assert.deepEqual(body, { query: 'How many lanes?', endpointId: 'predefined-cerebras-qwen-3.8-27b', responseMode: 'stream', pluginIds: ['agent-1713924030'], modelConfigs: { fulfillmentPrompt: 'ctx' }, reasoningMode: 'low' });
    assert.equal('profile' in body, false);
    assert.equal('attachment' in body, false);
    assert.equal(res.getHeader('X-OnDemand-Profile'), 'camera');
    assert.equal(res.getHeader('X-OnDemand-Profile-Applied'), 'endpointId,pluginIds,reasoningMode');
    assert.equal(JSON.stringify(call.init.headers).includes(TEST_KEY), true, 'apikey header carries the SERVER key');
    assert.equal(res.text().includes(TEST_KEY), false);
  });

  test('an attachment selects the vision endpoint (env) and is validated; the sync prime turn sends no reasoningMode', async () => {
    keyed({ [CAMERA_CHAT_ENV.visionEndpointId]: 'predefined-gemini-3.7-flash' });
    activeStub = stubFetchSequence([sseResponse(), jsonResponse(200, { data: { answer: 'READY' } })]);
    const req = makeReq({ method: 'POST', url: '/api/ondemand/chat', body: { sessionId: 'sess-cam', query: 'What is in the crosswalk?', responseMode: 'stream', profile: 'camera', attachment: { mediaId: 'media-777' } } });
    const res = makeRes();
    await chatHandler(req, res);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(activeStub.calls[0].init.body);
    assert.equal(body.endpointId, 'predefined-gemini-3.7-flash');
    assert.equal(res.getHeader('X-OnDemand-Profile-Applied'), 'visionEndpointId,pluginIds,reasoningMode');

    const prime = makeReq({ method: 'POST', url: '/api/ondemand/chat', body: { sessionId: 'sess-cam', query: 'You are…', responseMode: 'sync', fulfillmentOnly: true, profile: 'camera' } });
    const primeRes = makeRes();
    await chatHandler(prime, primeRes);
    assert.equal(primeRes.statusCode, 200);
    const primeBody = JSON.parse(activeStub.calls[1].init.body);
    assert.equal(primeBody.endpointId, 'predefined-cerebras-qwen-3.8-27b');
    assert.equal(primeBody.reasoningMode, undefined);
    assert.deepEqual(primeBody.pluginIds, ['agent-1713924030']);

    for (const bad of [{ profile: 'drone' }, { profile: 'camera', attachment: '' }, { profile: 'camera', attachment: { mediaId: 42 } }]) {
      const r = makeRes();
      await chatHandler(makeReq({ method: 'POST', url: '/api/ondemand/chat', body: { sessionId: 's', query: 'q', responseMode: 'stream', ...bad } }), r);
      assert.equal(r.statusCode, 400, JSON.stringify(bad));
      assert.match(r.json().error, /invalid_(profile|attachment)/);
    }
  });

  test('without a profile nothing changes: no pluginIds/reasoningMode injected, default fulfillment endpoint', async () => {
    keyed();
    activeStub = stubFetchSequence([sseResponse()]);
    const res = makeRes();
    await chatHandler(makeReq({ method: 'POST', url: '/api/ondemand/chat', body: { sessionId: 's', query: 'q', responseMode: 'stream' } }), res);
    const body = JSON.parse(activeStub.calls[0].init.body);
    assert.deepEqual(body, { query: 'q', endpointId: 'predefined-gpt-5.6-luna', responseMode: 'stream' });
    assert.equal(res.getHeader('X-OnDemand-Profile'), undefined);
  });

  test('keyless: chat, sessions (history) and media all answer 503 not_configured — never a silent failure, never an upstream call', async () => {
    __reloadConfigForTests();
    activeStub = stubFetchSequence([]);
    const cases = [
      [chatHandler, makeReq({ method: 'POST', url: '/api/ondemand/chat', body: { sessionId: 's', query: 'q', profile: 'camera' } })],
      [sessionsHandler, makeReq({ method: 'GET', url: '/api/ondemand/sessions?sessionId=sess-cam&limit=20' })],
      [mediaHandler, makeReq({ method: 'POST', url: '/api/ondemand/media', headers: { 'content-type': 'multipart/form-data; boundary=x' }, body: '' })],
    ];
    for (const [handler, req] of cases) {
      const res = makeRes();
      await handler(req, res);
      assert.equal(res.statusCode, 503);
      assert.equal(res.json().error, 'not_configured');
    }
    assert.equal(activeStub.calls.length, 0);
    const healthRes = makeRes();
    await healthHandler(makeReq({ method: 'GET', url: '/api/ondemand/health' }), healthRes);
    const health = healthRes.json();
    assert.equal(health.configured, false);
    assert.equal(health.cameraChat.imagePluginId, 'plugin-1713958591', 'keyless health still publishes the camera-chat defaults');
    assert.deepEqual(health.cameraChat.pluginIds, ['agent-1713924030']);
  });
});

describe('api/ondemand/sessions.js — cursor-paginated message history', () => {
  test('GET ?sessionId forwards cursor/limit/sort to GET {chat}/sessions/{id}/messages and returns the payload verbatim', async () => {
    keyed();
    const page = { message: 'ok', data: [{ id: 'm1', type: 'text', query: 'q', answer: 'a', createdAt: '2026-09-21T09:00:00Z' }], pagination: { next: 'abc', limit: 20 } };
    activeStub = stubFetchSequence([jsonResponse(200, page)]);
    const res = makeRes();
    await sessionsHandler(makeReq({ method: 'GET', url: '/api/ondemand/sessions?sessionId=sess-cam&limit=20&sort=desc&cursor=c1' }), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), page);
    const url = new URL(activeStub.calls[0].url);
    assert.equal(url.origin + url.pathname, 'https://api.on-demand.io/chat/v1/sessions/sess-cam/messages');
    assert.equal(url.searchParams.get('limit'), '20');
    assert.equal(url.searchParams.get('sort'), 'desc');
    assert.equal(url.searchParams.get('cursor'), 'c1');
    assert.equal(activeStub.calls[0].init.method, 'GET');
    assert.equal(activeStub.calls[0].init.headers.apikey, TEST_KEY);
  });

  test('first page sends no cursor; invalid limit/sort/sessionId are 400; upstream 404 is shaped, not swallowed', async () => {
    keyed();
    activeStub = stubFetchSequence([jsonResponse(200, { data: [], pagination: { next: '', limit: 10 } }), jsonResponse(404, { message: 'session not found' })]);
    const first = makeRes();
    await sessionsHandler(makeReq({ method: 'GET', url: '/api/ondemand/sessions?sessionId=sess-cam' }), first);
    assert.equal(first.statusCode, 200);
    assert.equal(new URL(activeStub.calls[0].url).searchParams.has('cursor'), false);
    for (const q of ['sessionId=sess-cam&limit=0', 'sessionId=sess-cam&limit=51', 'sessionId=sess-cam&sort=newest', 'sessionId=bad%20id']) {
      const res = makeRes();
      await sessionsHandler(makeReq({ method: 'GET', url: `/api/ondemand/sessions?${q}` }), res);
      assert.equal(res.statusCode, 400, q);
    }
    assert.equal(activeStub.calls.length, 1, 'rejected requests never reach upstream');
    const gone = makeRes();
    await sessionsHandler(makeReq({ method: 'GET', url: '/api/ondemand/sessions?sessionId=sess-gone' }), gone);
    assert.equal(gone.statusCode, 404);
  });

  test('the legacy ?userId lookup still works alongside the history route', async () => {
    keyed();
    const res = makeRes();
    await sessionsHandler(makeReq({ method: 'GET', url: '/api/ondemand/sessions?userId=nobody' }), res);
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error, 'no_session');
  });
});

describe('api/ondemand/media.js — frame upload (multipart raw, §5.2)', () => {
  test('a multipart body is forwarded verbatim to {media}/raw with the boundary intact and the server key; data.id comes back', async () => {
    keyed();
    activeStub = stubFetchSequence([jsonResponse(200, { message: 'Media Created', data: { id: 'media-777', source: 'image', actionStatus: 'completed' } })]);
    const boundary = 'gevframe';
    const raw = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="plugins"\r\n\r\nplugin-1713958591\r\n--${boundary}--\r\n`);
    const req = makeReq({ method: 'POST', url: '/api/ondemand/media', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, body: raw });
    const res = makeRes();
    await mediaHandler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().data.id, 'media-777');
    const call = activeStub.calls[0];
    assert.equal(call.url, 'https://api.on-demand.io/media/v1/public/file/raw');
    assert.equal(call.init.headers['Content-Type'], `multipart/form-data; boundary=${boundary}`);
    assert.equal(call.init.headers.apikey, TEST_KEY);
    assert.equal(Buffer.from(call.init.body).toString('utf8'), raw.toString('utf8'));
  });
});
