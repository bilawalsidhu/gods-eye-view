import assert from 'node:assert/strict';
import test from 'node:test';
import { FoundryRestAdapter } from '../dist/adapters/foundry.js';
import { loadConfig } from '../dist/config.js';

const config = loadConfig({
  NODE_ENV: 'test',
  FOUNDRY_ENDPOINT: 'https://example.openai.azure.com',
  FOUNDRY_REALTIME_DEPLOYMENT: 'realtime-deployment',
  FOUNDRY_HUD_DEPLOYMENT: 'hud-deployment',
});
test('Foundry realtime uses the GA client_secrets endpoint and returns only ephemeral material', async () => {
  const originalFetch = globalThis.fetch;
  let captured;
  let requestedScope;
  const credential = {
    getToken: async (scope) => {
      requestedScope = scope;
      return { token: 'managed-identity-token', expiresOnTimestamp: Date.now() + 60_000 };
    },
  };
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), init };
    return Response.json({ value: 'ephemeral-session-secret', expires_at: 123456 });
  };
  try {
    const adapter = new FoundryRestAdapter(config, credential);
    const secret = await adapter.createRealtimeClientSecret(
      { voice: 'marin' },
      { correlationId: 'cid' },
    );
    assert.equal(new URL(captured.url).pathname, '/openai/v1/realtime/client_secrets');
    assert.equal(requestedScope, 'https://ai.azure.com/.default');
    assert.equal(captured.init.headers.authorization, 'Bearer managed-identity-token');
    assert.equal(JSON.parse(captured.init.body).session.model, 'realtime-deployment');
    assert.equal(secret.value, 'ephemeral-session-secret');
    assert.doesNotMatch(JSON.stringify(secret), /managed-identity-token/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Foundry HUD uses the v1 Responses endpoint and configured text deployment', async () => {
  const originalFetch = globalThis.fetch;
  let captured;
  let requestedScope;
  const credential = {
    getToken: async (scope) => {
      requestedScope = scope;
      return { token: 'managed-identity-token', expiresOnTimestamp: Date.now() + 60_000 };
    },
  };
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), init };
    return Response.json({ output_text: 'One two three four five' });
  };
  try {
    const adapter = new FoundryRestAdapter(config, credential);
    const summary = await adapter.createHudSummary(
      { prompt: 'Summarize', context: { place: 'Oslo' } },
      { correlationId: 'cid' },
    );
    assert.equal(new URL(captured.url).pathname, '/openai/v1/responses');
    assert.equal(requestedScope, 'https://ai.azure.com/.default');
    const body = JSON.parse(captured.init.body);
    assert.equal(body.model, 'hud-deployment');
    assert.match(body.instructions, /exactly five words/i);
    assert.equal(summary, 'One two three four five');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
