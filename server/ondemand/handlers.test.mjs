import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { __reloadConfigForTests } from './config.js';
import { __resetStoreForTests } from './sessions-store.js';
import { makeReq, makeRes, stubFetchSequence, jsonResponse, sseResponse } from './test-helpers.mjs';

import sessionsHandler from '../../api/ondemand/sessions.js';
import chatHandler from '../../api/ondemand/chat.js';
import mediaHandler from '../../api/ondemand/media.js';
import sttHandler from '../../api/ondemand/stt.js';
import ttsHandler from '../../api/ondemand/tts.js';
import workflowHandler from '../../api/ondemand/workflow.js';
import healthHandler from '../../api/ondemand/health.js';

const TEST_KEY = 'test-key-abcd1234';
const ENV_KEYS = [
  'ONDEMAND_API_KEY',
  'ONDEMAND_BASE_URL',
  'ONDEMAND_SPATIAL_AGENT_ID',
  'ONDEMAND_SPATIAL_FLOW_ID',
  'ONDEMAND_FULFILLMENT_ENDPOINT_ID',
  'ONDEMAND_REASONING_MODE',
];
let savedEnv;
let activeStub;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  __resetStoreForTests();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  __reloadConfigForTests();
  __resetStoreForTests();
  if (activeStub) {
    activeStub.restore();
    activeStub = undefined;
  }
});

function configureWithKey(extraEnv = {}) {
  process.env.ONDEMAND_API_KEY = TEST_KEY;
  for (const [k, v] of Object.entries(extraEnv)) process.env[k] = v;
  __reloadConfigForTests();
}

describe('api/ondemand/health.js', () => {
  test('reports every field "not configured" (200) when ONDEMAND_API_KEY is absent', async () => {
    __reloadConfigForTests(); // key already deleted by beforeEach
    const req = makeReq({ method: 'GET', url: '/api/ondemand/health' });
    const res = makeRes();
    await healthHandler(req, res);
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ondemand, 'not configured');
    assert.equal(body.chat, 'not configured');
    assert.equal(body.speech, 'not configured');
    assert.equal(body.media, 'not configured');
    assert.equal(body.workflow, 'not configured');
    assert.deepEqual(body.plugins, {});
    assert.equal(body.configured, false);
    assert.ok(typeof body.message === 'string' && body.message.length > 0);
    assert.ok(typeof body.checkedAt === 'string');
  });

  test('smoke: probes chat/media/workflow with apikey header and reports healthy', async () => {
    configureWithKey();
    activeStub = stubFetchSequence([
      jsonResponse(200, { message: 'ok', data: [] }),
      jsonResponse(200, { message: 'ok', data: [] }),
      jsonResponse(200, { message: 'ok', data: [] }),
    ]);
    const req = makeReq({ method: 'GET', url: '/api/ondemand/health' });
    const res = makeRes();
    await healthHandler(req, res);

    assert.equal(activeStub.calls.length, 3);
    assert.equal(activeStub.calls[0].url, 'https://api.on-demand.io/chat/v1/sessions?limit=1');
    assert.equal(activeStub.calls[1].url, 'https://api.on-demand.io/media/v1/public/file?page=1&limit=1');
    assert.equal(activeStub.calls[2].url, 'https://api.on-demand.io/automation/api/workflow/?limit=1');
    for (const call of activeStub.calls) {
      assert.equal(call.init.headers.apikey, TEST_KEY);
    }

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.chat, 'healthy');
    assert.equal(body.media, 'healthy');
    assert.equal(body.workflow, 'healthy');
    assert.equal(body.speech, 'degraded');
    assert.equal(body.ondemand, 'healthy');
    assert.equal(body.configured, true);
    assert.deepEqual(body.plugins, {});
    assert.equal(body.error, undefined);
  });
});

describe('api/ondemand/sessions.js', () => {
  test('smoke: POST create sends externalUserId + pluginIds to POST {chat}/sessions', async () => {
    configureWithKey();
    activeStub = stubFetchSequence([
      jsonResponse(200, { message: 'Chat session created successfully', data: { id: 'sess-abc', createdAt: '2026-01-01T00:00:00.000Z' } }),
    ]);
    const req = makeReq({ method: 'POST', url: '/api/ondemand/sessions', body: { userId: 'user-1' } });
    const res = makeRes();
    await sessionsHandler(req, res);

    assert.equal(activeStub.calls.length, 1);
    const call = activeStub.calls[0];
    assert.equal(call.url, 'https://api.on-demand.io/chat/v1/sessions');
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.headers.apikey, TEST_KEY);
    assert.deepEqual(JSON.parse(call.init.body), { externalUserId: 'user-1', pluginIds: [] });

    assert.equal(res.statusCode, 201);
    assert.deepEqual(res.json(), {
      sessionId: 'sess-abc',
      externalUserId: 'user-1',
      reused: false,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
  });

  test('GET returns 404 no_session when the store has nothing for userId', async () => {
    configureWithKey();
    const req = makeReq({ method: 'GET', url: '/api/ondemand/sessions?userId=nobody' });
    const res = makeRes();
    await sessionsHandler(req, res);
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error, 'no_session');
  });

  test('DELETE never calls upstream and returns the documented note', async () => {
    configureWithKey();
    activeStub = stubFetchSequence([]);
    const req = makeReq({ method: 'DELETE', url: '/api/ondemand/sessions?userId=user-1' });
    const res = makeRes();
    await sessionsHandler(req, res);
    assert.equal(activeStub.calls.length, 0);
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().deleted, true);
  });
});

describe('api/ondemand/chat.js — validation (no network)', () => {
  test('unknown top-level field -> 400 unknown_field', async () => {
    configureWithKey();
    activeStub = stubFetchSequence([
      () => {
        throw new Error('network should not be called');
      },
    ]);
    const req = makeReq({ method: 'POST', body: { userId: 'u', query: 'hi', foo: 'bar' } });
    const res = makeRes();
    await chatHandler(req, res);
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.json(), { error: 'unknown_field', field: 'foo' });
    assert.equal(activeStub.calls.length, 0);
  });

  test('modelConfigs.temperature out of [0,2] -> 400', async () => {
    configureWithKey();
    activeStub = stubFetchSequence([
      () => {
        throw new Error('network should not be called');
      },
    ]);
    const req = makeReq({
      method: 'POST',
      body: { userId: 'u', query: 'hi', endpointId: 'predefined-x', modelConfigs: { temperature: 5 } },
    });
    const res = makeRes();
    await chatHandler(req, res);
    assert.equal(res.statusCode, 400);
    const body = res.json();
    assert.equal(body.error, 'invalid_modelConfigs_field');
    assert.equal(body.field, 'temperature');
    assert.equal(activeStub.calls.length, 0);
  });

  test('no endpointId in body or env -> 400 endpointId_required', async () => {
    configureWithKey();
    activeStub = stubFetchSequence([
      () => {
        throw new Error('network should not be called');
      },
    ]);
    const req = makeReq({ method: 'POST', body: { userId: 'u', query: 'hi' } });
    const res = makeRes();
    await chatHandler(req, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, 'endpointId_required');
    assert.equal(activeStub.calls.length, 0);
  });

  test('responseMode webhook -> 501 not documented', async () => {
    configureWithKey();
    activeStub = stubFetchSequence([
      () => {
        throw new Error('network should not be called');
      },
    ]);
    const req = makeReq({
      method: 'POST',
      body: { userId: 'u', query: 'hi', endpointId: 'predefined-x', responseMode: 'webhook' },
    });
    const res = makeRes();
    await chatHandler(req, res);
    assert.equal(res.statusCode, 501);
    assert.equal(res.json().error, 'not documented');
  });
});

describe('api/ondemand/chat.js — smoke with stubbed fetch', () => {
  test('sync: auto-creates a session for userId then POSTs the query', async () => {
    configureWithKey();
    activeStub = stubFetchSequence([
      jsonResponse(200, { message: 'ok', data: { id: 'sess-xyz', createdAt: 't' } }),
      jsonResponse(200, {
        message: 'Chat query submitted successfully',
        data: { sessionId: 'sess-xyz', messageId: 'm1', answer: '42', status: 'completed' },
      }),
    ]);
    const req = makeReq({
      method: 'POST',
      body: { userId: 'user-2', query: 'What is the answer?', endpointId: 'predefined-claude-sonnet-5', responseMode: 'sync' },
    });
    const res = makeRes();
    await chatHandler(req, res);

    assert.equal(activeStub.calls.length, 2);
    assert.equal(activeStub.calls[0].url, 'https://api.on-demand.io/chat/v1/sessions');
    assert.equal(activeStub.calls[1].url, 'https://api.on-demand.io/chat/v1/sessions/sess-xyz/query');
    assert.equal(activeStub.calls[1].init.method, 'POST');
    assert.equal(activeStub.calls[1].init.headers.apikey, TEST_KEY);
    const sentBody = JSON.parse(activeStub.calls[1].init.body);
    assert.equal(sentBody.query, 'What is the answer?');
    assert.equal(sentBody.endpointId, 'predefined-claude-sonnet-5');
    assert.equal(sentBody.responseMode, 'sync');
    assert.ok(!('pluginIds' in sentBody), 'pluginIds should be omitted, not sent as undefined');
    assert.ok(!('reasoningMode' in sentBody), 'reasoningMode must never be sent on a sync query');

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().data.answer, '42');
  });

  test('stream: pipes the upstream SSE bytes verbatim, including [DONE]', async () => {
    configureWithKey();
    const frames = [
      'event:message\ndata:{"eventType":"fulfillment","answer":"Hi"}\n\n',
      'event:message\ndata:[DONE]\n\n',
    ];
    activeStub = stubFetchSequence([
      jsonResponse(200, { message: 'ok', data: { id: 'sess-stream', createdAt: 't' } }),
      sseResponse(200, frames),
    ]);
    const req = makeReq({
      method: 'POST',
      body: { userId: 'user-3', query: 'hi', endpointId: 'predefined-x', responseMode: 'stream' },
    });
    const res = makeRes();
    await chatHandler(req, res);

    assert.equal(activeStub.calls.length, 2);
    assert.equal(activeStub.calls[1].url, 'https://api.on-demand.io/chat/v1/sessions/sess-stream/query');
    const sentBody = JSON.parse(activeStub.calls[1].init.body);
    assert.equal(sentBody.responseMode, 'stream');

    assert.equal(res.getHeader('content-type'), 'text/event-stream; charset=utf-8');
    assert.equal(res.text(), frames.join(''));
    assert.equal(res.ended, true);
  });
});

describe('api/ondemand/media.js — smoke', () => {
  test('JSON url-create posts to POST {media} with the documented fields', async () => {
    configureWithKey();
    activeStub = stubFetchSequence([jsonResponse(200, { message: 'Media Created', data: { id: 'm1' } })]);
    const req = makeReq({
      method: 'POST',
      body: { url: 'https://example.com/a.pdf', plugins: ['plugin-1713954536'] },
    });
    const res = makeRes();
    await mediaHandler(req, res);

    assert.equal(activeStub.calls.length, 1);
    const call = activeStub.calls[0];
    assert.equal(call.url, 'https://api.on-demand.io/media/v1/public/file');
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.headers.apikey, TEST_KEY);
    const sentBody = JSON.parse(call.init.body);
    assert.equal(sentBody.url, 'https://example.com/a.pdf');
    assert.deepEqual(sentBody.plugins, ['plugin-1713954536']);
    assert.equal(sentBody.responseMode, 'sync');

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().data.id, 'm1');
  });
});

describe('api/ondemand/stt.js — smoke', () => {
  test('POSTs exactly {audioUrl} to /execute/speech_to_text', async () => {
    configureWithKey();
    activeStub = stubFetchSequence([jsonResponse(200, { message: 'ok', data: { text: 'hello world' } })]);
    const req = makeReq({ method: 'POST', body: { audioUrl: 'https://example.com/a.wav' } });
    const res = makeRes();
    await sttHandler(req, res);

    assert.equal(activeStub.calls.length, 1);
    const call = activeStub.calls[0];
    assert.equal(call.url, 'https://api.on-demand.io/services/v1/public/service/execute/speech_to_text');
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.headers.apikey, TEST_KEY);
    assert.deepEqual(JSON.parse(call.init.body), { audioUrl: 'https://example.com/a.wav' });

    assert.equal(res.json().data.text, 'hello world');
  });

  test('multipart upload attempt -> 501 not documented (no upload-bytes variant)', async () => {
    configureWithKey();
    activeStub = stubFetchSequence([
      () => {
        throw new Error('network should not be called');
      },
    ]);
    const req = makeReq({
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=x' },
      body: Buffer.from('irrelevant'),
    });
    const res = makeRes();
    await sttHandler(req, res);
    assert.equal(res.statusCode, 501);
    assert.equal(res.json().error, 'not documented');
    assert.equal(activeStub.calls.length, 0);
  });
});

describe('api/ondemand/tts.js — smoke (json format)', () => {
  test('?format=json returns the upstream envelope without fetching the audio bytes', async () => {
    configureWithKey();
    activeStub = stubFetchSequence([
      jsonResponse(200, { message: 'ok', data: { audioUrl: 'https://cdn.example.com/out.mp3' } }),
    ]);
    const req = makeReq({
      method: 'POST',
      url: '/api/ondemand/tts?format=json',
      body: { input: 'hi', voice: 'alloy', model: 'tts-1' },
    });
    const res = makeRes();
    await ttsHandler(req, res);

    assert.equal(activeStub.calls.length, 1, 'must not fetch the audio bytes when format=json');
    const call = activeStub.calls[0];
    assert.equal(call.url, 'https://api.on-demand.io/services/v1/public/service/execute/text_to_speech');
    assert.equal(call.init.headers.apikey, TEST_KEY);
    assert.deepEqual(JSON.parse(call.init.body), { input: 'hi', voice: 'alloy', model: 'tts-1' });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().data.audioUrl, 'https://cdn.example.com/out.mp3');
  });

  test('invalid voice -> 400 before any network call', async () => {
    configureWithKey();
    activeStub = stubFetchSequence([
      () => {
        throw new Error('network should not be called');
      },
    ]);
    const req = makeReq({ method: 'POST', body: { input: 'hi', voice: 'not-a-voice' } });
    const res = makeRes();
    await ttsHandler(req, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, 'invalid_voice');
    assert.equal(activeStub.calls.length, 0);
  });
});

describe('api/ondemand/workflow.js — smoke', () => {
  test('execute sends NO request body (contract §7.1)', async () => {
    configureWithKey();
    activeStub = stubFetchSequence([jsonResponse(200, { executionID: 'ex-1' })]);
    const req = makeReq({ method: 'POST', url: '/api/ondemand/workflow?action=execute', body: { workflowId: 'wf-1' } });
    const res = makeRes();
    await workflowHandler(req, res);

    assert.equal(activeStub.calls.length, 1);
    const call = activeStub.calls[0];
    assert.equal(call.url, 'https://api.on-demand.io/automation/api/workflow/wf-1/execute');
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.headers.apikey, TEST_KEY);
    assert.equal(call.init.body, undefined, 'execute must never send a request body');

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().executionID, 'ex-1');
  });

  test('execute with a client-supplied "input" field -> 501 not documented, no network', async () => {
    configureWithKey({ ONDEMAND_SPATIAL_FLOW_ID: 'wf-default' });
    activeStub = stubFetchSequence([
      () => {
        throw new Error('network should not be called');
      },
    ]);
    const req = makeReq({ method: 'POST', url: '/api/ondemand/workflow?action=execute', body: { input: 'nope' } });
    const res = makeRes();
    await workflowHandler(req, res);
    assert.equal(res.statusCode, 501);
    assert.equal(res.json().error, 'not documented');
    assert.equal(activeStub.calls.length, 0);
  });

  test('unknown action -> 400 listing supported actions', async () => {
    configureWithKey();
    const req = makeReq({ method: 'GET', url: '/api/ondemand/workflow?action=bogus' });
    const res = makeRes();
    await workflowHandler(req, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, 'unknown_action');
    assert.ok(Array.isArray(res.json().supported));
  });
});
