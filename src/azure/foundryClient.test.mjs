import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FOUNDRY_BFF_CONTRACTS,
  FoundryHudSummaryClient,
  buildFoundryRealtimeSdpEndpoint,
  buildFoundryRealtimeSdpRequest,
  getFoundryRealtimeClientSecret,
} from './foundryClient.js';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('realtime client secret is obtained only from the same-origin BFF', async () => {
  let request;
  const secret = await getFoundryRealtimeClientSecret({
    deployment: 'realtime-deployment',
    voice: 'alloy',
    fetchImpl: async (url, init) => {
      request = { url, init };
      return jsonResponse({
        clientSecret: {
          value: 'ephemeral-client-secret',
          expiresAt: '2030-01-01T00:00:00Z',
        },
        endpoint: 'https://example-resource.openai.azure.com/',
        deployment: 'realtime-deployment',
        model: 'realtime-deployment',
      });
    },
  });

  assert.equal(request.url, FOUNDRY_BFF_CONTRACTS.realtimeClientSecret.path);
  assert.equal(request.init.method, 'POST');
  assert.equal(request.init.cache, 'no-store');
  assert.equal(request.init.headers.has('Authorization'), false);
  assert.deepEqual(JSON.parse(request.init.body), {
    deployment: 'realtime-deployment',
    voice: 'alloy',
  });
  assert.equal(secret.value, 'ephemeral-client-secret');
  assert.equal(secret.endpoint, 'https://example-resource.openai.azure.com/');
  assert.equal(secret.model, 'realtime-deployment');
});

test('SDP request targets Azure GA realtime calls and uses only ephemeral bearer auth', () => {
  const request = buildFoundryRealtimeSdpRequest({
    endpoint: 'https://example-resource.openai.azure.com',
    clientSecret: { value: 'temporary-secret' },
    sdp: 'v=0\r\n...',
  });

  assert.equal(request.url, 'https://example-resource.openai.azure.com/openai/v1/realtime/calls');
  assert.equal(request.init.method, 'POST');
  assert.equal(request.init.headers.Authorization, 'Bearer temporary-secret');
  assert.equal(request.init.headers['Content-Type'], 'application/sdp');
  assert.equal(request.init.body, 'v=0\r\n...');
  assert.equal(request.url.includes('temporary-secret'), false);
});

test('SDP endpoint supports explicitly configured preview query parameters', () => {
  const url = new URL(buildFoundryRealtimeSdpEndpoint(
    'https://foundry.example.test/custom-base/',
    { apiVersion: '2025-04-01-preview', deployment: 'realtime' },
  ));
  assert.equal(url.pathname, '/custom-base/openai/v1/realtime/calls');
  assert.equal(url.searchParams.get('api-version'), '2025-04-01-preview');
  assert.equal(url.searchParams.get('deployment'), 'realtime');
});

test('HUD summary client posts typed context and accepts unconfigured capability', async () => {
  let body;
  const client = new FoundryHudSummaryClient({
    fetchImpl: async (_url, init) => {
      body = JSON.parse(init.body);
      return jsonResponse({
        configured: false,
        summary: null,
        code: 'FOUNDRY_NOT_CONFIGURED',
        error: null,
      });
    },
  });

  const result = await client.summarize({
    prompt: 'Summarize the tracked aircraft',
    context: { count: 4 },
    maxCharacters: 280,
  });
  assert.deepEqual(body, {
    prompt: 'Summarize the tracked aircraft',
    context: { count: 4 },
    maxCharacters: 280,
  });
  assert.equal(result.configured, false);
  assert.equal(result.summary, null);
});

test('Foundry helpers reject cross-origin secret BFF paths and non-HTTPS service endpoints', async () => {
  await assert.rejects(
    getFoundryRealtimeClientSecret({
      endpoint: 'https://attacker.test/token',
      fetchImpl: async () => jsonResponse({}),
    }),
    /same-origin/,
  );
  assert.throws(
    () => buildFoundryRealtimeSdpEndpoint('http://example-resource.openai.azure.com'),
    /HTTPS/,
  );
});
