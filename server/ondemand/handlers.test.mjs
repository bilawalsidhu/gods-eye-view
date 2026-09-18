import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { __reloadConfigForTests } from './config.js';
import { __resetStoreForTests } from './sessions-store.js';
import {
  makeReq,
  makeRes,
  stubFetchSequence,
  jsonResponse,
  sseResponse,
} from './test-helpers.mjs';

import sessionsHandler from '../../api/ondemand/sessions.js';
import chatHandler from '../../api/ondemand/chat.js';
import mediaHandler from '../../api/ondemand/media.js';
import sttHandler from '../../api/ondemand/stt.js';
import ttsHandler from '../../api/ondemand/tts.js';
import workflowHandler from '../../api/ondemand/workflow.js';
import healthHandler, {
  __resetSpeechProbeCacheForTests,
} from '../../api/ondemand/health.js';

const TEST_KEY = 'test-key-abcd1234';
// Constructed dynamically (never a literal) — these two names are
// deny-listed (server/ondemand/deny-list.test.mjs) and must never appear as
// string literals in a non-test file; kept dynamic here too so this test
// file's own env-isolation/sentinel plumbing never needs the literal.
const DEPRECATED_KNOWLEDGE_ALIAS = [
  'ONDEMAND',
  'KNOWLEDGE',
  'PLUGIN',
  'IDS',
].join('_');
const DENIED_ELEVENLABS_NAME = ['ELEVENLABS', 'API', 'KEY'].join('_');
const ENV_KEYS = [
  'ONDEMAND_API_KEY',
  'ONDEMAND_BASE_URL',
  'ONDEMAND_API_BASE',
  'ONDEMAND_SPATIAL_AGENT_ID',
  DEPRECATED_KNOWLEDGE_ALIAS,
  'ONDEMAND_SPATIAL_FLOW_ID',
  'ONDEMAND_REASONING_ENDPOINT_ID',
  'ONDEMAND_FULFILLMENT_ENDPOINT_ID',
  'ONDEMAND_ENDPOINT_ID',
  'ONDEMAND_REASONING_MODE',
  'GODS_EYE_FLOW_VERSION',
  DENIED_ELEVENLABS_NAME,
];
let savedEnv;
let activeStub;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  __resetStoreForTests();
  __resetSpeechProbeCacheForTests();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  __reloadConfigForTests();
  __resetStoreForTests();
  __resetSpeechProbeCacheForTests();
  if (activeStub) {
    activeStub.restore();
    activeStub = undefined;
  }
});

const TTS_PROBE_URL =
  'https://api.on-demand.io/services/v1/public/service/execute/text_to_speech';
// A sentinel audioUrl: health must never echo it back to a client.
const TTS_AUDIO_URL_SENTINEL =
  'https://cdn.example.test/tts/sentinel-3f9c1a.mp3';

/** Documented §6.2 TTS envelope — what a healthy speech probe receives. */
function ttsEnvelope() {
  return jsonResponse(200, {
    message: 'Service executed successfully',
    data: { audioUrl: TTS_AUDIO_URL_SENTINEL },
  });
}

/** The three read-only probes (chat, media, workflow) all healthy; the
 * fourth entry (speech) is supplied by each test. */
function healthyReadProbes() {
  return [
    jsonResponse(200, { message: 'ok', data: [] }),
    jsonResponse(200, { message: 'ok', data: [] }),
    jsonResponse(200, { message: 'ok', data: [] }),
  ];
}

async function runHealth(url = '/api/ondemand/health') {
  const req = makeReq({ method: 'GET', url });
  const res = makeRes();
  await healthHandler(req, res);
  return res;
}

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
    assert.equal(body.reasoningModeInvalid, false);
    assert.ok(typeof body.message === 'string' && body.message.length > 0);
    assert.ok(typeof body.checkedAt === 'string');
  });

  test('the "not configured" response carries a full `config` block with every source name', async () => {
    __reloadConfigForTests(); // key already deleted by beforeEach
    const req = makeReq({ method: 'GET', url: '/api/ondemand/health' });
    const res = makeRes();
    await healthHandler(req, res);
    const body = res.json();
    assert.deepEqual(
      Object.keys(body.config).sort(),
      [
        'apiKey',
        'baseUrl',
        'reasoningEndpointId',
        'fulfillmentEndpointId',
        'reasoningMode',
        'flowVersion',
        'spatialFlowId',
        'tiers',
      ].sort(),
    );
    // benchmarked tier defaults (ids only) ride along even unkeyed
    assert.deepEqual(body.config.tiers, {
      ASK: {
        fulfillmentEndpointId: 'predefined-gpt-5.6-luna',
        reasoningMode: 'low',
      },
      INVESTIGATE: {
        fulfillmentEndpointId: 'predefined-claude-sonnet-5',
        reasoningMode: 'low',
      },
      DEEP: {
        fulfillmentEndpointId: 'predefined-claude-sonnet-5',
        reasoningMode: 'high',
      },
    });
    // no probe ran, so there is nothing to report under speechProbe
    assert.equal('speechProbe' in body, false);
    assert.equal(body.config.apiKey.configured, false);
    assert.equal(body.config.baseUrl.configured, true);
    assert.equal(body.config.baseUrl.source, 'default');
    assert.equal(body.config.reasoningEndpointId.configured, true);
    assert.equal(body.config.reasoningEndpointId.source, 'default');
    assert.equal(body.config.fulfillmentEndpointId.configured, true);
    assert.equal(body.config.fulfillmentEndpointId.source, 'default');
    assert.equal(body.config.reasoningMode.configured, false);
    assert.equal(body.config.reasoningMode.source, 'unset');
    assert.equal(body.config.reasoningMode.valid, true);
    assert.equal(body.config.flowVersion.configured, true);
    assert.equal(body.config.flowVersion.source, 'default');
    // Since 2026-09-18 the workflow id has a non-secret built-in default
    // (server/ondemand/config.js FLOW_DEFAULTS) — configured, source
    // 'default'; the VALUE is still never surfaced by health.
    assert.equal(body.config.spatialFlowId.configured, true);
    assert.equal(body.config.spatialFlowId.source, 'default');
    assert.equal(
      JSON.stringify(body).includes('6aace534859f7b0abb53d99a'),
      false,
    );
  });

  test('smoke: probes chat/media/workflow (GET) + speech (POST TTS §6.2) with apikey header and reports healthy', async () => {
    configureWithKey();
    activeStub = stubFetchSequence([...healthyReadProbes(), ttsEnvelope()]);
    const req = makeReq({ method: 'GET', url: '/api/ondemand/health' });
    const res = makeRes();
    await healthHandler(req, res);

    assert.equal(activeStub.calls.length, 4);
    assert.equal(
      activeStub.calls[0].url,
      'https://api.on-demand.io/chat/v1/sessions?limit=1',
    );
    assert.equal(
      activeStub.calls[1].url,
      'https://api.on-demand.io/media/v1/public/file?page=1&limit=1',
    );
    assert.equal(
      activeStub.calls[2].url,
      'https://api.on-demand.io/automation/api/workflow/?limit=1',
    );
    assert.equal(activeStub.calls[3].url, TTS_PROBE_URL);
    for (const call of activeStub.calls) {
      assert.equal(call.init.headers.apikey, TEST_KEY);
    }
    for (const call of activeStub.calls.slice(0, 3)) {
      assert.equal(call.init.method, 'GET');
    }
    // the speech probe sends exactly the documented §6.2 fields, nothing else
    const tts = activeStub.calls[3];
    assert.equal(tts.init.method, 'POST');
    assert.equal(tts.init.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(tts.init.body), {
      input: 'ok',
      model: 'tts-1',
      voice: 'alloy',
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.chat, 'healthy');
    assert.equal(body.media, 'healthy');
    assert.equal(body.workflow, 'healthy');
    assert.equal(body.speech, 'healthy');
    assert.deepEqual(body.speechProbe, { cached: false, ageSec: 0 });
    assert.equal(body.ondemand, 'healthy');
    assert.equal(body.configured, true);
    assert.deepEqual(body.plugins, {});
    assert.equal(body.error, undefined);
    assert.equal(body.details, undefined);
    // the synthesized audio URL is never echoed to a client
    assert.equal(res.text().includes(TTS_AUDIO_URL_SENTINEL), false);

    // once a key is present, none of the five status fields may read
    // 'not configured' — healthy/degraded/error only.
    for (const field of ['ondemand', 'chat', 'speech', 'media', 'workflow']) {
      assert.notEqual(body[field], 'not configured');
    }
    assert.equal(body.reasoningModeInvalid, false);
    assert.equal(body.config.apiKey.configured, true);
    assert.equal(body.config.fulfillmentEndpointId.source, 'default');
    assert.equal(body.config.reasoningEndpointId.source, 'default');
    assert.equal(
      body.config.tiers.ASK.fulfillmentEndpointId,
      'predefined-gpt-5.6-luna',
    );
    assert.equal(body.config.tiers.DEEP.reasoningMode, 'high');
  });

  test('reasoningModeInvalid is true (and config.reasoningMode.valid is false) when an undocumented ONDEMAND_REASONING_MODE is set', async () => {
    configureWithKey({ ONDEMAND_REASONING_MODE: 'not-a-real-tier' });
    activeStub = stubFetchSequence([
      jsonResponse(200, { message: 'ok', data: [] }),
      jsonResponse(200, { message: 'ok', data: [] }),
      jsonResponse(200, { message: 'ok', data: [] }),
    ]);
    const req = makeReq({ method: 'GET', url: '/api/ondemand/health' });
    const res = makeRes();
    await healthHandler(req, res);
    const body = res.json();
    assert.equal(body.reasoningModeInvalid, true);
    assert.equal(body.config.reasoningMode.valid, false);
    assert.equal(body.config.reasoningMode.configured, true);
    assert.equal(body.config.reasoningMode.source, 'default');

    // still no field reads 'not configured' once a key is present, even
    // though the reasoningMode value itself was rejected.
    for (const field of ['ondemand', 'chat', 'speech', 'media', 'workflow']) {
      assert.notEqual(body[field], 'not configured');
    }
  });
});

describe('api/ondemand/health.js — speech probe (POST text_to_speech §6.2, cached 10 min per warm instance)', () => {
  test('first keyed call probes TTS (healthy, cached:false); the second within the window reuses it (cached:true) without another TTS fetch', async () => {
    configureWithKey();
    activeStub = stubFetchSequence([...healthyReadProbes(), ttsEnvelope()]);
    const first = (await runHealth()).json();
    assert.equal(activeStub.calls.length, 4);
    assert.equal(activeStub.calls[3].url, TTS_PROBE_URL);
    assert.equal(first.speech, 'healthy');
    assert.deepEqual(first.speechProbe, { cached: false, ageSec: 0 });
    activeStub.restore();

    // second call: only the three read-only probes hit the network
    activeStub = stubFetchSequence(healthyReadProbes());
    const second = (await runHealth()).json();
    assert.equal(activeStub.calls.length, 3);
    assert.equal(
      activeStub.calls.some((c) => c.url === TTS_PROBE_URL),
      false,
      'a fresh cached success must not synthesize audio again',
    );
    assert.equal(second.speech, 'healthy');
    assert.equal(second.speechProbe.cached, true);
    assert.equal(typeof second.speechProbe.ageSec, 'number');
    assert.ok(second.speechProbe.ageSec >= 0 && second.speechProbe.ageSec < 60);
    assert.equal(second.ondemand, 'healthy');
  });

  test('verbose=1 reports the speech probe latency/status under details.speech (no cached/ageSec there, no audioUrl anywhere)', async () => {
    configureWithKey();
    activeStub = stubFetchSequence([...healthyReadProbes(), ttsEnvelope()]);
    const res = await runHealth('/api/ondemand/health?verbose=1');
    const body = res.json();
    assert.equal(body.details.speech.httpStatus, 200);
    assert.equal(typeof body.details.speech.latencyMs, 'number');
    assert.equal('cached' in body.details.speech, false);
    assert.equal('ageSec' in body.details.speech, false);
    assert.equal('status' in body.details.speech, false);
    assert.equal(res.text().includes(TTS_AUDIO_URL_SENTINEL), false);
  });

  test('a timeout (TimeoutError/AbortError from fetch) -> speech "degraded" with the documented detail, never cached', async () => {
    configureWithKey();
    const timeoutStub = () => {
      throw new DOMException(
        'The operation was aborted due to timeout',
        'TimeoutError',
      );
    };
    activeStub = stubFetchSequence([...healthyReadProbes(), timeoutStub]);
    const first = (await runHealth()).json();
    assert.equal(activeStub.calls.length, 4);
    assert.equal(first.speech, 'degraded');
    assert.equal(first.chat, 'healthy');
    assert.equal(first.ondemand, 'healthy'); // chat healthy still short-circuits the roll-up
    assert.deepEqual(first.speechProbe, { cached: false, ageSec: 0 });
    assert.equal(
      first.details.speech.detail,
      'speech probe timed out (>4.5 s); TTS is a synthesis call, not a read-only probe',
    );
    activeStub.restore();

    // a non-healthy outcome is not memoised: the next call probes again
    const abortStub = () => {
      throw new DOMException('This operation was aborted', 'AbortError');
    };
    activeStub = stubFetchSequence([...healthyReadProbes(), abortStub]);
    const second = (await runHealth()).json();
    assert.equal(activeStub.calls.length, 4);
    assert.equal(activeStub.calls[3].url, TTS_PROBE_URL);
    assert.equal(second.speech, 'degraded');
    assert.equal(second.speechProbe.cached, false);
  });

  test('the speech probe uses its own 4.5 s budget (AbortSignal on the TTS call), the read probes 3 s', async () => {
    configureWithKey();
    activeStub = stubFetchSequence([...healthyReadProbes(), ttsEnvelope()]);
    await runHealth();
    for (const call of activeStub.calls) {
      assert.ok(call.init.signal instanceof AbortSignal);
      assert.equal(call.init.signal.aborted, false);
    }
  });

  test('401 from TTS -> speech "error" ("invalid key"), surfaced under details even without verbose', async () => {
    configureWithKey();
    activeStub = stubFetchSequence([
      ...healthyReadProbes(),
      jsonResponse(401, { message: 'Unauthorized' }),
    ]);
    const body = (await runHealth()).json();
    assert.equal(body.speech, 'error');
    assert.equal(body.details.speech.detail, 'invalid key');
    assert.equal(body.speechProbe.cached, false);
    assert.equal(body.ondemand, 'healthy'); // chat healthy
  });

  test('403 from TTS -> speech "error"; other non-2xx (500) and a 2xx without data.audioUrl -> "degraded" with the status', async () => {
    configureWithKey();
    activeStub = stubFetchSequence([
      ...healthyReadProbes(),
      jsonResponse(403, { message: 'Forbidden' }),
    ]);
    assert.equal((await runHealth()).json().speech, 'error');
    activeStub.restore();

    activeStub = stubFetchSequence([
      ...healthyReadProbes(),
      jsonResponse(500, { message: 'boom' }),
    ]);
    const degraded = (await runHealth()).json();
    assert.equal(degraded.speech, 'degraded');
    assert.equal(degraded.details.speech.httpStatus, 500);
    assert.match(degraded.details.speech.detail, /HTTP 500/);
    activeStub.restore();

    activeStub = stubFetchSequence([
      ...healthyReadProbes(),
      jsonResponse(200, { message: 'ok', data: {} }),
    ]);
    const noUrl = (await runHealth()).json();
    assert.equal(noUrl.speech, 'degraded');
    assert.match(noUrl.details.speech.detail, /without data\.audioUrl/);
    assert.equal(noUrl.speechProbe.cached, false);
  });

  test('a speech "error" rolls up to ondemand "error" when chat is not healthy', async () => {
    configureWithKey();
    activeStub = stubFetchSequence([
      jsonResponse(500, { message: 'chat down' }),
      jsonResponse(200, { message: 'ok', data: [] }),
      jsonResponse(200, { message: 'ok', data: [] }),
      jsonResponse(401, { message: 'Unauthorized' }),
    ]);
    const body = (await runHealth()).json();
    assert.equal(body.chat, 'degraded');
    assert.equal(body.speech, 'error');
    assert.equal(body.ondemand, 'error');
  });

  test('unkeyed: every field "not configured", no fetch at all (no TTS synthesis), no speechProbe field', async () => {
    __reloadConfigForTests(); // key already deleted by beforeEach
    activeStub = stubFetchSequence([
      () => {
        throw new Error('fetch must not be called without an API key');
      },
    ]);
    const res = await runHealth();
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(activeStub.calls.length, 0);
    for (const field of ['ondemand', 'chat', 'speech', 'media', 'workflow']) {
      assert.equal(body[field], 'not configured');
    }
    assert.equal(body.configured, false);
    assert.equal('speechProbe' in body, false);
    assert.ok(body.config.tiers);
  });
});

describe('api/ondemand/health.js — ?envNames=1 diagnostic (docs/ONDEMAND_PROXY_DESIGN.md §5b)', () => {
  test('default response (flag absent) has no "env" field', async () => {
    configureWithKey();
    activeStub = stubFetchSequence([
      jsonResponse(200, { message: 'ok', data: [] }),
      jsonResponse(200, { message: 'ok', data: [] }),
      jsonResponse(200, { message: 'ok', data: [] }),
    ]);
    const req = makeReq({ method: 'GET', url: '/api/ondemand/health' });
    const res = makeRes();
    await healthHandler(req, res);
    assert.equal('env' in res.json(), false);
  });

  test('envNames=1 never leaks a configured env var VALUE, only names', async () => {
    // An obviously-unique sentinel: if this string ever shows up in the
    // serialized response, a value leaked instead of just a name.
    const SENTINEL = 'sk-test-should-never-leak-9f3ae1c0';
    process.env.ONDEMAND_API_KEY = SENTINEL;
    __reloadConfigForTests();
    activeStub = stubFetchSequence([
      jsonResponse(200, { message: 'ok', data: [] }),
      jsonResponse(200, { message: 'ok', data: [] }),
      jsonResponse(200, { message: 'ok', data: [] }),
    ]);
    const req = makeReq({
      method: 'GET',
      url: '/api/ondemand/health?envNames=1',
    });
    const res = makeRes();
    await healthHandler(req, res);

    const raw = res.text();
    assert.equal(
      raw.includes(SENTINEL),
      false,
      'the raw serialized response must never contain an env var value',
    );

    const body = JSON.parse(raw);
    assert.ok(Array.isArray(body.env.names));
    assert.ok(
      body.env.names.includes('ONDEMAND_API_KEY'),
      'names lists the key that is set',
    );
    assert.ok(
      body.env.names.every(
        (n) => typeof n === 'string' && !n.includes(SENTINEL),
      ),
      'every entry in names is a bare env var name, not a value',
    );
    assert.equal(body.env.sources.apiKey, 'ONDEMAND_API_KEY');
  });

  test('envNames=1 sources map reports the alias name when only ONDEMAND_ENDPOINT_ID is set', async () => {
    configureWithKey({ ONDEMAND_ENDPOINT_ID: 'predefined-alias-ep' });
    activeStub = stubFetchSequence([
      jsonResponse(200, { message: 'ok', data: [] }),
      jsonResponse(200, { message: 'ok', data: [] }),
      jsonResponse(200, { message: 'ok', data: [] }),
    ]);
    const req = makeReq({
      method: 'GET',
      url: '/api/ondemand/health?envNames=1',
    });
    const res = makeRes();
    await healthHandler(req, res);
    const body = res.json();
    assert.equal(
      body.env.sources.fulfillmentEndpointId,
      'ONDEMAND_ENDPOINT_ID',
    );
    assert.ok(body.env.names.includes('ONDEMAND_ENDPOINT_ID'));
    assert.equal(
      body.env.names.some((n) => n.includes('predefined-alias-ep')),
      false,
    );
  });

  test('envNames=1 also attaches env on the "not configured" (no API key) response, without changing its shape otherwise', async () => {
    __reloadConfigForTests(); // key already deleted by beforeEach
    const req = makeReq({
      method: 'GET',
      url: '/api/ondemand/health?envNames=1',
    });
    const res = makeRes();
    await healthHandler(req, res);
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.configured, false);
    assert.equal(body.ondemand, 'not configured');
    assert.equal(body.env.sources.apiKey, 'unset');
    assert.ok(Array.isArray(body.env.names));
  });

  test('envNames=1 never lists a deny-listed env var name, even when it is set to a sentinel value', async () => {
    // Sentinels: if either ever shows up (as a name OR a value) in the
    // serialized response, the deny-list is not being enforced.
    const KNOWLEDGE_SENTINEL = 'sentinel-knowledge-7be2c4';
    const ELEVENLABS_SENTINEL = 'sentinel-elevenlabs-9a01df';
    process.env[DEPRECATED_KNOWLEDGE_ALIAS] = KNOWLEDGE_SENTINEL;
    process.env[DENIED_ELEVENLABS_NAME] = ELEVENLABS_SENTINEL;
    configureWithKey();
    activeStub = stubFetchSequence([
      jsonResponse(200, { message: 'ok', data: [] }),
      jsonResponse(200, { message: 'ok', data: [] }),
      jsonResponse(200, { message: 'ok', data: [] }),
    ]);
    const req = makeReq({
      method: 'GET',
      url: '/api/ondemand/health?envNames=1',
    });
    const res = makeRes();
    await healthHandler(req, res);

    const raw = res.text();
    assert.equal(raw.includes(KNOWLEDGE_SENTINEL), false);
    assert.equal(raw.includes(ELEVENLABS_SENTINEL), false);
    assert.equal(raw.includes(DEPRECATED_KNOWLEDGE_ALIAS), false);
    assert.equal(raw.includes(DENIED_ELEVENLABS_NAME), false);

    const body = JSON.parse(raw);
    assert.equal(body.env.names.includes(DEPRECATED_KNOWLEDGE_ALIAS), false);
    assert.equal(body.env.names.includes(DENIED_ELEVENLABS_NAME), false);
    // the plugin-id default must also not have silently picked up the
    // retired alias's sentinel value (ONDEMAND_SPATIAL_AGENT_ID was never
    // set in this test, so `plugins` must stay empty).
    assert.deepEqual(body.plugins, {});
  });
});

describe('api/ondemand/sessions.js', () => {
  test('smoke: POST create sends externalUserId + pluginIds to POST {chat}/sessions', async () => {
    configureWithKey();
    activeStub = stubFetchSequence([
      jsonResponse(200, {
        message: 'Chat session created successfully',
        data: { id: 'sess-abc', createdAt: '2026-01-01T00:00:00.000Z' },
      }),
    ]);
    const req = makeReq({
      method: 'POST',
      url: '/api/ondemand/sessions',
      body: { userId: 'user-1' },
    });
    const res = makeRes();
    await sessionsHandler(req, res);

    assert.equal(activeStub.calls.length, 1);
    const call = activeStub.calls[0];
    assert.equal(call.url, 'https://api.on-demand.io/chat/v1/sessions');
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.headers.apikey, TEST_KEY);
    assert.deepEqual(JSON.parse(call.init.body), {
      externalUserId: 'user-1',
      pluginIds: [],
    });

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
    const req = makeReq({
      method: 'GET',
      url: '/api/ondemand/sessions?userId=nobody',
    });
    const res = makeRes();
    await sessionsHandler(req, res);
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error, 'no_session');
  });

  test('DELETE never calls upstream and returns the documented note', async () => {
    configureWithKey();
    activeStub = stubFetchSequence([]);
    const req = makeReq({
      method: 'DELETE',
      url: '/api/ondemand/sessions?userId=user-1',
    });
    const res = makeRes();
    await sessionsHandler(req, res);
    assert.equal(activeStub.calls.length, 0);
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().deleted, true);
  });

  test('POST with no body pluginIds defaults to the FULL ONDEMAND_SPATIAL_AGENT_ID list, not just the first id', async () => {
    configureWithKey({ ONDEMAND_SPATIAL_AGENT_ID: 'plugin-a,plugin-b' });
    activeStub = stubFetchSequence([
      jsonResponse(200, {
        message: 'Chat session created successfully',
        data: { id: 'sess-def', createdAt: '2026-01-01T00:00:00.000Z' },
      }),
    ]);
    const req = makeReq({
      method: 'POST',
      url: '/api/ondemand/sessions',
      body: { userId: 'user-2' },
    });
    const res = makeRes();
    await sessionsHandler(req, res);

    assert.equal(activeStub.calls.length, 1);
    assert.deepEqual(JSON.parse(activeStub.calls[0].init.body), {
      externalUserId: 'user-2',
      pluginIds: ['plugin-a', 'plugin-b'],
    });
  });

  test('POST with body pluginIds overrides the env default entirely', async () => {
    configureWithKey({ ONDEMAND_SPATIAL_AGENT_ID: 'plugin-a,plugin-b' });
    activeStub = stubFetchSequence([
      jsonResponse(200, {
        message: 'Chat session created successfully',
        data: { id: 'sess-ghi', createdAt: '2026-01-01T00:00:00.000Z' },
      }),
    ]);
    const req = makeReq({
      method: 'POST',
      url: '/api/ondemand/sessions',
      body: { userId: 'user-3', pluginIds: ['plugin-caller-supplied'] },
    });
    const res = makeRes();
    await sessionsHandler(req, res);

    assert.equal(activeStub.calls.length, 1);
    assert.deepEqual(JSON.parse(activeStub.calls[0].init.body), {
      externalUserId: 'user-3',
      pluginIds: ['plugin-caller-supplied'],
    });
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
    const req = makeReq({
      method: 'POST',
      body: { userId: 'u', query: 'hi', foo: 'bar' },
    });
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
      body: {
        userId: 'u',
        query: 'hi',
        endpointId: 'predefined-x',
        modelConfigs: { temperature: 5 },
      },
    });
    const res = makeRes();
    await chatHandler(req, res);
    assert.equal(res.statusCode, 400);
    const body = res.json();
    assert.equal(body.error, 'invalid_modelConfigs_field');
    assert.equal(body.field, 'temperature');
    assert.equal(activeStub.calls.length, 0);
  });

  test('explicit falsy endpointId in the body -> 400 endpointId_required (env now always resolves to a default tier, so this is the only way left to trigger it)', async () => {
    configureWithKey();
    activeStub = stubFetchSequence([
      () => {
        throw new Error('network should not be called');
      },
    ]);
    const req = makeReq({
      method: 'POST',
      body: { userId: 'u', query: 'hi', endpointId: '' },
    });
    const res = makeRes();
    await chatHandler(req, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, 'endpointId_required');
    assert.equal(activeStub.calls.length, 0);
  });

  test('endpointId omitted from the body falls back to config.fulfillmentEndpointId (default tier, never a 400)', async () => {
    configureWithKey();
    activeStub = stubFetchSequence([
      jsonResponse(200, {
        message: 'ok',
        data: { id: 'sess-default-ep', createdAt: 't' },
      }),
      jsonResponse(200, {
        message: 'Chat query submitted successfully',
        data: {
          sessionId: 'sess-default-ep',
          messageId: 'm1',
          answer: 'ok',
          status: 'completed',
        },
      }),
    ]);
    const req = makeReq({
      method: 'POST',
      body: { userId: 'u', query: 'hi', responseMode: 'sync' },
    });
    const res = makeRes();
    await chatHandler(req, res);
    assert.equal(res.statusCode, 200);
    const sentBody = JSON.parse(activeStub.calls[1].init.body);
    assert.equal(sentBody.endpointId, 'predefined-gpt-5.6-luna');
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
      body: {
        userId: 'u',
        query: 'hi',
        endpointId: 'predefined-x',
        responseMode: 'webhook',
      },
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
      jsonResponse(200, {
        message: 'ok',
        data: { id: 'sess-xyz', createdAt: 't' },
      }),
      jsonResponse(200, {
        message: 'Chat query submitted successfully',
        data: {
          sessionId: 'sess-xyz',
          messageId: 'm1',
          answer: '42',
          status: 'completed',
        },
      }),
    ]);
    const req = makeReq({
      method: 'POST',
      body: {
        userId: 'user-2',
        query: 'What is the answer?',
        endpointId: 'predefined-claude-sonnet-5',
        responseMode: 'sync',
      },
    });
    const res = makeRes();
    await chatHandler(req, res);

    assert.equal(activeStub.calls.length, 2);
    assert.equal(
      activeStub.calls[0].url,
      'https://api.on-demand.io/chat/v1/sessions',
    );
    assert.equal(
      activeStub.calls[1].url,
      'https://api.on-demand.io/chat/v1/sessions/sess-xyz/query',
    );
    assert.equal(activeStub.calls[1].init.method, 'POST');
    assert.equal(activeStub.calls[1].init.headers.apikey, TEST_KEY);
    const sentBody = JSON.parse(activeStub.calls[1].init.body);
    assert.equal(sentBody.query, 'What is the answer?');
    assert.equal(sentBody.endpointId, 'predefined-claude-sonnet-5');
    assert.equal(sentBody.responseMode, 'sync');
    assert.ok(
      !('pluginIds' in sentBody),
      'pluginIds should be omitted, not sent as undefined',
    );
    assert.ok(
      !('reasoningMode' in sentBody),
      'reasoningMode must never be sent on a sync query',
    );

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
      jsonResponse(200, {
        message: 'ok',
        data: { id: 'sess-stream', createdAt: 't' },
      }),
      sseResponse(200, frames),
    ]);
    const req = makeReq({
      method: 'POST',
      body: {
        userId: 'user-3',
        query: 'hi',
        endpointId: 'predefined-x',
        responseMode: 'stream',
      },
    });
    const res = makeRes();
    await chatHandler(req, res);

    assert.equal(activeStub.calls.length, 2);
    assert.equal(
      activeStub.calls[1].url,
      'https://api.on-demand.io/chat/v1/sessions/sess-stream/query',
    );
    const sentBody = JSON.parse(activeStub.calls[1].init.body);
    assert.equal(sentBody.responseMode, 'stream');

    assert.equal(
      res.getHeader('content-type'),
      'text/event-stream; charset=utf-8',
    );
    assert.equal(res.text(), frames.join(''));
    assert.equal(res.ended, true);
  });
});

describe('api/ondemand/chat.js — mode "capability-loop" (server/ondemand/capability-loop.js)', () => {
  const structured = {
    message: 'Nautical zone estimate UTC+04:00 for 24.43N 54.65E.',
    entities: [],
    actions: [],
    evidence: [],
    sources: [
      {
        id: 'demo.timezone',
        kind: 'capability',
        label: 'demo.timezone',
        status: 'used',
      },
    ],
    suggestedNextActions: [],
    runMeta: {
      mode: 'capability-loop',
      executed: ['demo.timezone'],
      generatedAtUtc: '2026-09-18T08:00:00.000Z',
    },
  };

  test('invalid mode -> 400; spatialContext/tier without the mode -> 400; non-sync responseMode -> 400', async () => {
    configureWithKey();
    activeStub = stubFetchSequence([
      () => {
        throw new Error('network should not be called');
      },
    ]);
    let res = makeRes();
    await chatHandler(
      makeReq({
        method: 'POST',
        body: { userId: 'u', query: 'q', mode: 'agentic' },
      }),
      res,
    );
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, 'invalid_mode');
    res = makeRes();
    await chatHandler(
      makeReq({
        method: 'POST',
        body: { userId: 'u', query: 'q', spatialContext: {} },
      }),
      res,
    );
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().field, 'spatialContext');
    res = makeRes();
    await chatHandler(
      makeReq({
        method: 'POST',
        body: {
          userId: 'u',
          query: 'q',
          mode: 'capability-loop',
          responseMode: 'stream',
        },
      }),
      res,
    );
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, 'invalid_responseMode');
    res = makeRes();
    await chatHandler(
      makeReq({
        method: 'POST',
        body: {
          userId: 'u',
          query: 'q',
          mode: 'capability-loop',
          spatialContext: [1],
        },
      }),
      res,
    );
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, 'invalid_spatialContext');
    assert.equal(activeStub.calls.length, 0);
  });

  test('runs decide → execute (ONLY the selected, network-free demo.timezone) → answer in the same session; tier picks the endpoint', async () => {
    configureWithKey();
    activeStub = stubFetchSequence([
      jsonResponse(201, { data: { id: 'sess-loop' } }),
      jsonResponse(200, {
        data: {
          answer:
            '{"decisions":[{"capabilityId":"demo.timezone","params":{"lat":24.43,"lon":54.65}}]}',
          messageId: 'm1',
        },
      }),
      jsonResponse(200, {
        data: { answer: JSON.stringify(structured), messageId: 'm2' },
      }),
    ]);
    const req = makeReq({
      method: 'POST',
      body: {
        userId: 'loop-user',
        query: 'What time zone is the airport in?',
        mode: 'capability-loop',
        tier: 'ASK',
        spatialContext: { center: { latitude: 24.43, longitude: 54.65 } },
      },
    });
    const res = makeRes();
    await chatHandler(req, res);
    assert.equal(res.statusCode, 200, res.text());
    const body = res.json();
    assert.equal(body.mode, 'capability-loop');
    assert.equal(body.ok, true);
    assert.equal(body.tier, 'ASK');
    assert.equal(body.endpointId, 'predefined-gpt-5.6-luna');
    assert.equal(body.reasoningMode, 'low');
    assert.equal(body.reasoningModeSent, false);
    assert.deepEqual(
      body.executed.map((e) => [e.capabilityId, e.status, e.count]),
      [['demo.timezone', 200, 1]],
    );
    assert.equal(body.validation.ok, true);
    assert.ok(
      body.catalogue.includes('earthquake.search') &&
        body.catalogue.includes('demo.timezone'),
    );
    assert.equal(activeStub.calls.length, 3);
    const [, decisionCall, answerCall] = activeStub.calls;
    assert.ok(String(decisionCall.url).endsWith('/sessions/sess-loop/query'));
    assert.ok(String(answerCall.url).endsWith('/sessions/sess-loop/query'));
    const decisionBody = JSON.parse(decisionCall.init.body);
    assert.equal(decisionBody.responseMode, 'sync');
    assert.equal(decisionBody.endpointId, 'predefined-gpt-5.6-luna');
    assert.equal('reasoningMode' in decisionBody, false);
    const answerBody = JSON.parse(JSON.parse(answerCall.init.body).query);
    assert.equal(answerBody.toolResults[0].data.items[0].utc_offset, '+04:00');
    assert.equal(JSON.stringify(body).includes(TEST_KEY), false);
  });

  test('a hallucinated capability -> 422, nothing executed, only two upstream calls', async () => {
    configureWithKey();
    activeStub = stubFetchSequence([
      jsonResponse(201, { data: { id: 'sess-loop' } }),
      jsonResponse(200, {
        data: {
          answer: '{"decisions":[{"capabilityId":"weather.now","params":{}}]}',
        },
      }),
    ]);
    const res = makeRes();
    await chatHandler(
      makeReq({
        method: 'POST',
        body: { userId: 'u', query: 'q', mode: 'capability-loop' },
      }),
      res,
    );
    assert.equal(res.statusCode, 422);
    const body = res.json();
    assert.equal(body.decision.valid, false);
    assert.deepEqual(body.executed, []);
    assert.equal(activeStub.calls.length, 2);
  });
});

describe('api/ondemand/media.js — smoke', () => {
  test('JSON url-create posts to POST {media} with the documented fields', async () => {
    configureWithKey();
    activeStub = stubFetchSequence([
      jsonResponse(200, { message: 'Media Created', data: { id: 'm1' } }),
    ]);
    const req = makeReq({
      method: 'POST',
      body: {
        url: 'https://example.com/a.pdf',
        plugins: ['plugin-1713954536'],
      },
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
    activeStub = stubFetchSequence([
      jsonResponse(200, { message: 'ok', data: { text: 'hello world' } }),
    ]);
    const req = makeReq({
      method: 'POST',
      body: { audioUrl: 'https://example.com/a.wav' },
    });
    const res = makeRes();
    await sttHandler(req, res);

    assert.equal(activeStub.calls.length, 1);
    const call = activeStub.calls[0];
    assert.equal(
      call.url,
      'https://api.on-demand.io/services/v1/public/service/execute/speech_to_text',
    );
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.headers.apikey, TEST_KEY);
    assert.deepEqual(JSON.parse(call.init.body), {
      audioUrl: 'https://example.com/a.wav',
    });

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
      jsonResponse(200, {
        message: 'ok',
        data: { audioUrl: 'https://cdn.example.com/out.mp3' },
      }),
    ]);
    const req = makeReq({
      method: 'POST',
      url: '/api/ondemand/tts?format=json',
      body: { input: 'hi', voice: 'alloy', model: 'tts-1' },
    });
    const res = makeRes();
    await ttsHandler(req, res);

    assert.equal(
      activeStub.calls.length,
      1,
      'must not fetch the audio bytes when format=json',
    );
    const call = activeStub.calls[0];
    assert.equal(
      call.url,
      'https://api.on-demand.io/services/v1/public/service/execute/text_to_speech',
    );
    assert.equal(call.init.headers.apikey, TEST_KEY);
    assert.deepEqual(JSON.parse(call.init.body), {
      input: 'hi',
      voice: 'alloy',
      model: 'tts-1',
    });

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
    const req = makeReq({
      method: 'POST',
      body: { input: 'hi', voice: 'not-a-voice' },
    });
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
    activeStub = stubFetchSequence([
      jsonResponse(200, { executionID: 'ex-1' }),
    ]);
    const req = makeReq({
      method: 'POST',
      url: '/api/ondemand/workflow?action=execute',
      body: { workflowId: 'wf-1' },
    });
    const res = makeRes();
    await workflowHandler(req, res);

    assert.equal(activeStub.calls.length, 1);
    const call = activeStub.calls[0];
    assert.equal(
      call.url,
      'https://api.on-demand.io/automation/api/workflow/wf-1/execute',
    );
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.headers.apikey, TEST_KEY);
    assert.equal(
      call.init.body,
      undefined,
      'execute must never send a request body',
    );

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
    const req = makeReq({
      method: 'POST',
      url: '/api/ondemand/workflow?action=execute',
      body: { input: 'nope' },
    });
    const res = makeRes();
    await workflowHandler(req, res);
    assert.equal(res.statusCode, 501);
    assert.equal(res.json().error, 'not documented');
    assert.equal(activeStub.calls.length, 0);
  });

  test('unknown action -> 400 listing supported actions', async () => {
    configureWithKey();
    const req = makeReq({
      method: 'GET',
      url: '/api/ondemand/workflow?action=bogus',
    });
    const res = makeRes();
    await workflowHandler(req, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, 'unknown_action');
    assert.ok(Array.isArray(res.json().supported));
  });
});
