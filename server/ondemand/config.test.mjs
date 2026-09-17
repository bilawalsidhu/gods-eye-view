import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  config,
  isConfigured,
  baseUrls,
  requestTimeoutMs,
  configSources,
  __reloadConfigForTests,
} from './config.js';

const ENV_KEYS = [
  'ONDEMAND_API_KEY',
  'ONDEMAND_BASE_URL',
  'ONDEMAND_API_BASE',
  'ONDEMAND_SPATIAL_AGENT_ID',
  'ONDEMAND_KNOWLEDGE_PLUGIN_IDS',
  'ONDEMAND_SPATIAL_FLOW_ID',
  'ONDEMAND_FULFILLMENT_ENDPOINT_ID',
  'ONDEMAND_ENDPOINT_ID',
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
    assert.equal(
      urls.services,
      'https://api.on-demand.io/services/v1/public/service',
    );
    assert.equal(urls.automation, 'https://api.on-demand.io/automation/api');
  });

  test('baseUrls() strips exactly one trailing slash from a custom ONDEMAND_BASE_URL', () => {
    process.env.ONDEMAND_BASE_URL = 'https://gateway-dev.on-demand.io/';
    __reloadConfigForTests();
    const urls = baseUrls();
    assert.equal(urls.chat, 'https://gateway-dev.on-demand.io/chat/v1');
    assert.equal(
      urls.automation,
      'https://gateway-dev.on-demand.io/automation/api',
    );
  });

  test('baseUrls() leaves a custom ONDEMAND_BASE_URL without a trailing slash untouched', () => {
    process.env.ONDEMAND_BASE_URL = 'https://api-dev.on-demand.io';
    __reloadConfigForTests();
    assert.equal(
      baseUrls().media,
      'https://api-dev.on-demand.io/media/v1/public/file',
    );
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
    assert.deepEqual(config.defaultPluginIds, []);
  });

  test('configSources() reports "unset"/"default" for every setting when nothing is configured', () => {
    __reloadConfigForTests();
    assert.deepEqual(configSources(), {
      apiKey: 'unset',
      baseUrl: 'default',
      defaultPluginIds: 'unset',
      spatialFlowId: 'unset',
      fulfillmentEndpointId: 'unset',
      reasoningMode: 'unset',
      requestTimeoutMs: 'default',
    });
  });
});

describe('server/ondemand/config.js — accepted env-var aliases (docs/ONDEMAND_PROXY_DESIGN.md §5b)', () => {
  describe('baseUrl: ONDEMAND_BASE_URL (canonical) vs ONDEMAND_API_BASE (alias)', () => {
    test('canonical wins when both are set', () => {
      process.env.ONDEMAND_BASE_URL = 'https://canonical.on-demand.io';
      process.env.ONDEMAND_API_BASE = 'https://alias.on-demand.io';
      __reloadConfigForTests();
      assert.equal(config.baseUrl, 'https://canonical.on-demand.io');
      assert.equal(config.baseUrlSource, 'ONDEMAND_BASE_URL');
      assert.equal(configSources().baseUrl, 'ONDEMAND_BASE_URL');
    });

    test('alias is used when the canonical name is absent', () => {
      process.env.ONDEMAND_API_BASE = 'https://alias.on-demand.io';
      __reloadConfigForTests();
      assert.equal(config.baseUrl, 'https://alias.on-demand.io');
      assert.equal(config.baseUrlSource, 'ONDEMAND_API_BASE');
      assert.equal(configSources().baseUrl, 'ONDEMAND_API_BASE');
      assert.equal(baseUrls().chat, 'https://alias.on-demand.io/chat/v1');
    });

    test('alias with a trailing slash is normalized the same as the canonical name', () => {
      process.env.ONDEMAND_API_BASE = 'https://alias.on-demand.io/';
      __reloadConfigForTests();
      assert.equal(config.baseUrl, 'https://alias.on-demand.io');
      assert.equal(
        baseUrls().automation,
        'https://alias.on-demand.io/automation/api',
      );
    });

    test('alias carrying a full "/chat/v1" endpoint URL is stripped back to the bare host', () => {
      process.env.ONDEMAND_API_BASE = 'https://alias.on-demand.io/chat/v1';
      __reloadConfigForTests();
      assert.equal(config.baseUrl, 'https://alias.on-demand.io');
      assert.equal(baseUrls().chat, 'https://alias.on-demand.io/chat/v1');
      assert.equal(
        baseUrls().media,
        'https://alias.on-demand.io/media/v1/public/file',
      );
    });

    test('alias carrying a full "/chat/v1/" endpoint URL (trailing slash too) is also stripped', () => {
      process.env.ONDEMAND_API_BASE = '  https://alias.on-demand.io/chat/v1/  ';
      __reloadConfigForTests();
      assert.equal(config.baseUrl, 'https://alias.on-demand.io');
    });

    test('empty-string ONDEMAND_BASE_URL is treated as unset, falling through to the alias', () => {
      process.env.ONDEMAND_BASE_URL = '';
      process.env.ONDEMAND_API_BASE = 'https://alias.on-demand.io';
      __reloadConfigForTests();
      assert.equal(config.baseUrl, 'https://alias.on-demand.io');
      assert.equal(config.baseUrlSource, 'ONDEMAND_API_BASE');
    });

    test('neither set -> default host, source "default"', () => {
      __reloadConfigForTests();
      assert.equal(config.baseUrl, 'https://api.on-demand.io');
      assert.equal(config.baseUrlSource, 'default');
    });
  });

  describe('fulfillmentEndpointId: ONDEMAND_FULFILLMENT_ENDPOINT_ID (canonical) vs ONDEMAND_ENDPOINT_ID (alias)', () => {
    test('canonical wins when both are set', () => {
      process.env.ONDEMAND_FULFILLMENT_ENDPOINT_ID = 'predefined-canonical';
      process.env.ONDEMAND_ENDPOINT_ID = 'predefined-alias';
      __reloadConfigForTests();
      assert.equal(config.fulfillmentEndpointId, 'predefined-canonical');
      assert.equal(
        configSources().fulfillmentEndpointId,
        'ONDEMAND_FULFILLMENT_ENDPOINT_ID',
      );
    });

    test('alias is used when the canonical name is absent', () => {
      process.env.ONDEMAND_ENDPOINT_ID = 'predefined-alias';
      __reloadConfigForTests();
      assert.equal(config.fulfillmentEndpointId, 'predefined-alias');
      assert.equal(
        configSources().fulfillmentEndpointId,
        'ONDEMAND_ENDPOINT_ID',
      );
    });

    test('neither set -> empty string, source "unset"', () => {
      __reloadConfigForTests();
      assert.equal(config.fulfillmentEndpointId, '');
      assert.equal(configSources().fulfillmentEndpointId, 'unset');
    });
  });

  describe('default plugin ids: ONDEMAND_SPATIAL_AGENT_ID (canonical) vs ONDEMAND_KNOWLEDGE_PLUGIN_IDS (alias)', () => {
    test('canonical wins when both are set', () => {
      process.env.ONDEMAND_SPATIAL_AGENT_ID = 'plugin-canonical';
      process.env.ONDEMAND_KNOWLEDGE_PLUGIN_IDS =
        'plugin-alias-1,plugin-alias-2';
      __reloadConfigForTests();
      assert.deepEqual(config.defaultPluginIds, ['plugin-canonical']);
      assert.equal(config.spatialAgentId, 'plugin-canonical');
      assert.equal(
        configSources().defaultPluginIds,
        'ONDEMAND_SPATIAL_AGENT_ID',
      );
    });

    test('alias is used when the canonical name is absent, and is comma-split', () => {
      process.env.ONDEMAND_KNOWLEDGE_PLUGIN_IDS = 'plugin-a,plugin-b';
      __reloadConfigForTests();
      assert.deepEqual(config.defaultPluginIds, ['plugin-a', 'plugin-b']);
      assert.equal(
        config.spatialAgentId,
        'plugin-a',
        'spatialAgentId keeps the first id for existing consumers',
      );
      assert.equal(
        configSources().defaultPluginIds,
        'ONDEMAND_KNOWLEDGE_PLUGIN_IDS',
      );
    });

    test('alias list is comma/whitespace-separated, trimmed, and de-duplicated', () => {
      process.env.ONDEMAND_KNOWLEDGE_PLUGIN_IDS =
        '  plugin-a ,plugin-b,  plugin-a\nplugin-c ,,plugin-b';
      __reloadConfigForTests();
      assert.deepEqual(config.defaultPluginIds, [
        'plugin-a',
        'plugin-b',
        'plugin-c',
      ]);
    });

    test('alias list is capped at the documented pluginIds maxItems (20)', () => {
      const ids = Array.from({ length: 25 }, (_, i) => `plugin-${i}`);
      process.env.ONDEMAND_KNOWLEDGE_PLUGIN_IDS = ids.join(',');
      __reloadConfigForTests();
      assert.equal(config.defaultPluginIds.length, 20);
      assert.deepEqual(config.defaultPluginIds, ids.slice(0, 20));
    });

    test('neither set -> empty list, source "unset"', () => {
      __reloadConfigForTests();
      assert.deepEqual(config.defaultPluginIds, []);
      assert.equal(config.spatialAgentId, '');
      assert.equal(configSources().defaultPluginIds, 'unset');
    });

    test('alias set to only separators -> empty list, source "unset" (not the alias name)', () => {
      process.env.ONDEMAND_KNOWLEDGE_PLUGIN_IDS = ' , , ';
      __reloadConfigForTests();
      assert.deepEqual(config.defaultPluginIds, []);
      assert.equal(configSources().defaultPluginIds, 'unset');
    });
  });

  test('ONDEMAND_SPATIAL_FLOW_ID has no accepted alias (docs/ONDEMAND_PROXY_DESIGN.md §5b)', () => {
    __reloadConfigForTests();
    assert.equal(config.spatialFlowId, '');
    assert.equal(configSources().spatialFlowId, 'unset');
    process.env.ONDEMAND_SPATIAL_FLOW_ID = 'wf-1';
    __reloadConfigForTests();
    assert.equal(config.spatialFlowId, 'wf-1');
    assert.equal(configSources().spatialFlowId, 'ONDEMAND_SPATIAL_FLOW_ID');
  });
});
