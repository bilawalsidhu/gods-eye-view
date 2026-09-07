import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../dist/config.js';

test('loads production-safe defaults', () => {
  const config = loadConfig({ NODE_ENV: 'production' });
  assert.equal(config.environment, 'production');
  assert.equal(config.host, '0.0.0.0');
  assert.equal(config.port, 3000);
  assert.equal(config.requestBodyLimitBytes, 1_048_576);
  assert.equal(config.azureMapsEndpoint, 'https://atlas.microsoft.com');
});

test('rejects invalid numeric values', () => {
  assert.throws(() => loadConfig({ PORT: '70000' }), /PORT must be an integer/);
  assert.throws(() => loadConfig({ BFF_PORT: '70000' }), /BFF_PORT must be an integer/);
});

test('BFF_PORT overrides the shared Vite PORT for local development', () => {
  const config = loadConfig({ BFF_PORT: '3000', PORT: '4173' });
  assert.equal(config.port, 3000);
});

test('requires complete Foundry configuration', () => {
  assert.throws(
    () => loadConfig({ FOUNDRY_ENDPOINT: 'https://example.services.ai.azure.com' }),
    /must be configured together/,
  );
});

test('requires HTTPS for remote upstreams', () => {
  assert.throws(
    () => loadConfig({ AISSTREAM_URL: 'ws://example.com' }),
    /must use HTTPS or WSS/,
  );
});
