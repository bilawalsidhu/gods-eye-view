import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { config, isConfigured, baseUrls, requestTimeoutMs, __reloadConfigForTests } from './config.js';

const ENV_KEYS = [
  'ONDEMAND_API_KEY',
  'ONDEMAND_BASE_URL',
  'ONDEMAND_SPATIAL_AGENT_ID',
  'ONDEMAND_SPATIAL_FLOW_ID',
  'ONDEMAND_FULFILLMENT_ENDPOINT_ID',
  'ONDEMAND_REASONING_MODE',
  'ONDEMAND_REQUEST_TIMEOUT_MS',
];
let savedEnv;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  __reloadConfigForTests();
});

describe('server/ondemand/config.js', () => {
  test('isConfigured() is false with no ONDEMAND_API_KEY', () => {
    __reloadConfigForTests();
    assert.equal(isConfigured(), false);
  });

  test('isConfigured() is true once ONDEMAND_API_KEY is set', () => {
    process.env.ONDEMAND_API_KEY = 'secret-key-1234';
    __reloadConfigForTests();
    assert.equal(isConfigured(), true);
    assert.equal(config.apiKey, 'secret-key-1234');
  });

  test('baseUrls() derives the documented default base URL for all four families', () => {
    __reloadConfigForTests();
    const urls = baseUrls();
    assert.equal(urls.chat, 'https://api.on-demand.io/chat/v1');
    assert.equal(urls.media, 'https://api.on-demand.io/media/v1/public/file');
    assert.equal(urls.services, 'https://api.on-demand.io/services/v1/public/service');
    assert.equal(urls.automation, 'https://api.on-demand.io/automation/api');
  });

  test('baseUrls() strips exactly one trailing slash from a custom ONDEMAND_BASE_URL', () => {
    process.env.ONDEMAND_BASE_URL = 'https://gateway-dev.on-demand.io/';
    __reloadConfigForTests();
    const urls = baseUrls();
    assert.equal(urls.chat, 'https://gateway-dev.on-demand.io/chat/v1');
    assert.equal(urls.automation, 'https://gateway-dev.on-demand.io/automation/api');
  });

  test('baseUrls() leaves a custom ONDEMAND_BASE_URL without a trailing slash untouched', () => {
    process.env.ONDEMAND_BASE_URL = 'https://api-dev.on-demand.io';
    __reloadConfigForTests();
    assert.equal(baseUrls().media, 'https://api-dev.on-demand.io/media/v1/public/file');
  });

  test('requestTimeoutMs() defaults to 60000 and honours ONDEMAND_REQUEST_TIMEOUT_MS', () => {
    __reloadConfigForTests();
    assert.equal(requestTimeoutMs(), 60000);
    process.env.ONDEMAND_REQUEST_TIMEOUT_MS = '15000';
    __reloadConfigForTests();
    assert.equal(requestTimeoutMs(), 15000);
  });

  test('requestTimeoutMs() ignores a non-positive override', () => {
    process.env.ONDEMAND_REQUEST_TIMEOUT_MS = '-5';
    __reloadConfigForTests();
    assert.equal(requestTimeoutMs(), 60000);
  });

  test('optional ids default to empty string when unset', () => {
    __reloadConfigForTests();
    assert.equal(config.spatialAgentId, '');
    assert.equal(config.spatialFlowId, '');
    assert.equal(config.fulfillmentEndpointId, '');
    assert.equal(config.reasoningMode, '');
  });
});
