import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CONFIGURATION,
  buildCapabilitySummary,
  detectDefaultAzureCredential,
  formatSetupReport,
} from '../scripts/setup-doctor.mjs';

const names = CONFIGURATION.map(({ name }) => name);

test('setup doctor reports only current Azure and retained provider configuration', () => {
  assert.deepEqual(names.slice(0, 5), [
    'AZURE_CLIENT_ID',
    'AZURE_MAPS_CLIENT_ID',
    'FOUNDRY_ENDPOINT',
    'FOUNDRY_REALTIME_DEPLOYMENT',
    'FOUNDRY_HUD_DEPLOYMENT',
  ]);
  assert.equal(names.includes('AISSTREAM_API_KEY'), true);
  assert.equal(names.some((name) => /GOOGLE|CESIUM_ION|OPENAI_API_KEY/.test(name)), false);
});

test('DefaultAzureCredential detection recognizes Azure CLI and workload identity', () => {
  assert.deepEqual(
    detectDefaultAzureCredential({ environment: {}, azureCliLookup: () => true }),
    { configured: true, source: 'Azure CLI session' },
  );
  assert.deepEqual(
    detectDefaultAzureCredential({
      environment: {
        AZURE_CLIENT_ID: 'client',
        AZURE_TENANT_ID: 'tenant',
        AZURE_FEDERATED_TOKEN_FILE: 'token-file',
      },
      azureCliLookup: () => false,
    }),
    { configured: true, source: 'workload identity environment' },
  );
});

test('capability summary requires the complete Foundry and Azure Maps BFF configuration', () => {
  const configured = Object.fromEntries(names.map((name) => [name, { configured: true }]));
  const capabilities = buildCapabilitySummary(configured, {
    azureCredential: { configured: true, source: 'Azure CLI session' },
    environment: { PORT: '4173', BFF_PORT: '3000' },
  });
  assert.match(capabilities.bff, /BFF :3000; Vite :4173/);
  assert.match(capabilities.map, /Azure Maps.*same-origin BFF/);
  assert.match(capabilities.voice, /Foundry realtime and HUD deployments configured/);
});

test('formatted report names the managed-identity boundary and both local ports', () => {
  const credentials = Object.fromEntries(names.map((name) => [name, {
    configured: false,
    source: null,
  }]));
  const capabilities = buildCapabilitySummary(credentials, {
    azureCredential: { configured: false, source: null },
    environment: {},
  });
  const output = formatSetupReport({
    ready: true,
    node: { level: 'ok', version: '24.14.0', summary: 'supported' },
    npm: { available: true, version: '11.0.0' },
    dependenciesInstalled: true,
    credentials,
    capabilities,
  }, { readyMessage: 'Ready.' });
  assert.match(output, /Fastify BFF :3000; Vite :4173/);
  assert.match(output, /DefaultAzureCredential/);
  assert.match(output, /OpenStreetMap fallback/);
});
