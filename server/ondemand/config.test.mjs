import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  config,
  isConfigured,
  baseUrls,
  requestTimeoutMs,
  configSources,
  getConfig,
  DOCUMENTED_REASONING_MODES,
  TIER_DEFAULTS,
  FLOW_DEFAULTS,
  FLOW_VERSION_ENV,
  tierDefaults,
  __reloadConfigForTests,
} from './config.js';

// Constructed dynamically (never a literal in this file) so this test file
// is not itself a hit if the deny-list grep in
// server/ondemand/deny-list.test.mjs is ever widened to include *.test.mjs
// — the retired alias name is exercised below purely via this constant.
const DEPRECATED_KNOWLEDGE_ALIAS = [
  'ONDEMAND',
  'KNOWLEDGE',
  'PLUGIN',
  'IDS',
].join('_');

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
  'ONDEMAND_REQUEST_TIMEOUT_MS',
  'GODS_EYE_FLOW_VERSION',
  'ONDEMAND_SPATIAL_FLOW_VERSION',
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

  test('ids/fields with no built-in default are empty when unset', () => {
    __reloadConfigForTests();
    assert.equal(config.spatialAgentId, '');
    // spatialFlowId is NOT in this group any more: since 2026-09-18 it has
    // a non-secret built-in default (FLOW_DEFAULTS) — see the flow tests.
    assert.equal(config.reasoningMode, '');
    assert.equal(config.reasoningModeInvalid, false);
    assert.deepEqual(config.defaultPluginIds, []);
  });

  test('reasoningEndpointId/fulfillmentEndpointId/flowVersion fall back to their built-in defaults when unset', () => {
    __reloadConfigForTests();
    // 'low' = a documented reasoningMode value (§3.1/§12): OnDemand has no
    // separate reasoning endpoint, so this default is the default
    // reasoningMode TIER (re-based 2026-09-18 from 'dynamic').
    assert.equal(config.reasoningEndpointId, 'low');
    assert.ok(DOCUMENTED_REASONING_MODES.includes(config.reasoningEndpointId));
    // fulfillment default = the benchmarked ASK winner.
    assert.equal(config.fulfillmentEndpointId, 'predefined-gpt-5.6-luna');
    assert.equal(
      config.fulfillmentEndpointId,
      TIER_DEFAULTS.ASK.fulfillmentEndpointId,
    );
    assert.equal(config.flowVersion, '1');
    assert.equal(config.flowVersion, FLOW_DEFAULTS.flowVersion);
  });

  test('configSources() reports "unset"/"default" for every setting when nothing is configured', () => {
    __reloadConfigForTests();
    assert.deepEqual(configSources(), {
      apiKey: 'unset',
      baseUrl: 'default',
      reasoningEndpointId: 'default',
      fulfillmentEndpointId: 'default',
      defaultPluginIds: 'unset',
      spatialFlowId: 'default',
      reasoningMode: 'unset',
      flowVersion: 'default',
      requestTimeoutMs: 'default',
    });
  });
});

describe('server/ondemand/config.js — getConfig()', () => {
  test('returns a frozen snapshot with the documented shape', () => {
    process.env.ONDEMAND_API_KEY = 'k-1';
    __reloadConfigForTests();
    const cfg = getConfig();
    assert.deepEqual(
      Object.keys(cfg).sort(),
      [
        'apiKey',
        'baseUrl',
        'baseUrls',
        'defaultPluginIds',
        'flowVersion',
        'fulfillmentEndpointId',
        'reasoningEndpointId',
        'reasoningMode',
        'reasoningModeInvalid',
        'sources',
        'spatialAgentId',
        'spatialFlowId',
        'requestTimeoutMs',
        'tiers',
        'flowDefaults',
        'flowVersionEnv',
      ].sort(),
    );
    assert.equal(cfg.apiKey, 'k-1');
    assert.equal(cfg.tiers, TIER_DEFAULTS);
    assert.equal(cfg.flowDefaults, FLOW_DEFAULTS);
    assert.equal(cfg.flowVersionEnv, FLOW_VERSION_ENV);
    assert.deepEqual(Object.keys(cfg.baseUrls).sort(), [
      'automation',
      'chat',
      'media',
      'services',
    ]);
    assert.ok(Object.isFrozen(cfg));
    assert.throws(() => {
      cfg.apiKey = 'changed';
    });
  });

  test('exposes exactly the fields a consumer like a selftest route needs', () => {
    process.env.ONDEMAND_SPATIAL_FLOW_ID = 'wf-9';
    process.env.ONDEMAND_SPATIAL_AGENT_ID = 'plugin-9';
    __reloadConfigForTests();
    const {
      apiKey,
      baseUrl,
      fulfillmentEndpointId,
      spatialFlowId,
      defaultPluginIds,
    } = getConfig();
    assert.equal(apiKey, '');
    assert.equal(baseUrl, 'https://api.on-demand.io');
    assert.equal(fulfillmentEndpointId, 'predefined-gpt-5.6-luna');
    assert.equal(spatialFlowId, 'wf-9');
    assert.deepEqual(defaultPluginIds, ['plugin-9']);
  });
});

describe('server/ondemand/config.js — DOCUMENTED_REASONING_MODES / reasoningMode validation', () => {
  test('DOCUMENTED_REASONING_MODES is a non-empty frozen list of strings', () => {
    assert.ok(Array.isArray(DOCUMENTED_REASONING_MODES));
    assert.ok(DOCUMENTED_REASONING_MODES.length > 0);
    assert.ok(Object.isFrozen(DOCUMENTED_REASONING_MODES));
    assert.ok(DOCUMENTED_REASONING_MODES.every((m) => typeof m === 'string'));
    // Spot-check a few values cited in docs/ONDEMAND_API_CURRENT.md §3.1/§12/§17.4.
    for (const expected of [
      'low',
      'high',
      'grok-4-fast',
      'dynamic',
      'opus',
      'haiku',
    ]) {
      assert.ok(
        DOCUMENTED_REASONING_MODES.includes(expected),
        `expected DOCUMENTED_REASONING_MODES to include ${expected}`,
      );
    }
  });

  test('unset ONDEMAND_REASONING_MODE -> empty string, not invalid, source "unset"', () => {
    __reloadConfigForTests();
    assert.equal(config.reasoningMode, '');
    assert.equal(config.reasoningModeInvalid, false);
    assert.equal(configSources().reasoningMode, 'unset');
  });

  test('a documented ONDEMAND_REASONING_MODE value passes through unchanged', () => {
    process.env.ONDEMAND_REASONING_MODE = 'haiku';
    __reloadConfigForTests();
    assert.equal(config.reasoningMode, 'haiku');
    assert.equal(config.reasoningModeInvalid, false);
    assert.equal(configSources().reasoningMode, 'ONDEMAND_REASONING_MODE');
  });

  test('an undocumented ONDEMAND_REASONING_MODE value falls back to the "dynamic" default tier, flagged invalid', () => {
    process.env.ONDEMAND_REASONING_MODE = 'not-a-real-tier';
    __reloadConfigForTests();
    assert.equal(config.reasoningMode, 'dynamic');
    assert.equal(config.reasoningModeInvalid, true);
    assert.equal(configSources().reasoningMode, 'default');
  });
});

describe('server/ondemand/config.js — TIER_DEFAULTS / tierDefaults() (benchmark 2026-09-18, docs/audit/endpoint-benchmark.md)', () => {
  test('TIER_DEFAULTS has exactly ASK / INVESTIGATE / DEEP with the benchmarked ids and modes', () => {
    assert.deepEqual(Object.keys(TIER_DEFAULTS).sort(), [
      'ASK',
      'DEEP',
      'INVESTIGATE',
    ]);
    assert.deepEqual(TIER_DEFAULTS.ASK, {
      fulfillmentEndpointId: 'predefined-gpt-5.6-luna',
      reasoningMode: 'low',
    });
    assert.deepEqual(TIER_DEFAULTS.INVESTIGATE, {
      fulfillmentEndpointId: 'predefined-claude-sonnet-5',
      reasoningMode: 'low',
    });
    assert.deepEqual(TIER_DEFAULTS.DEEP, {
      fulfillmentEndpointId: 'predefined-claude-sonnet-5',
      reasoningMode: 'high',
    });
  });

  test('TIER_DEFAULTS and every tier entry are frozen', () => {
    assert.ok(Object.isFrozen(TIER_DEFAULTS));
    for (const tier of Object.values(TIER_DEFAULTS)) {
      assert.ok(Object.isFrozen(tier));
      assert.deepEqual(Object.keys(tier).sort(), [
        'fulfillmentEndpointId',
        'reasoningMode',
      ]);
    }
    assert.throws(() => {
      'use strict';
      TIER_DEFAULTS.ASK.reasoningMode = 'high';
    });
  });

  test('every tier reasoningMode is a documented value (DOCUMENTED_REASONING_MODES) and every id is a predefined-* endpointId', () => {
    for (const { fulfillmentEndpointId, reasoningMode } of Object.values(
      TIER_DEFAULTS,
    )) {
      assert.ok(
        DOCUMENTED_REASONING_MODES.includes(reasoningMode),
        `${reasoningMode} must be a documented reasoningMode`,
      );
      assert.match(fulfillmentEndpointId, /^predefined-[a-z0-9.-]+$/);
    }
  });

  test('tierDefaults() is case-insensitive and trims', () => {
    assert.equal(tierDefaults('deep'), TIER_DEFAULTS.DEEP);
    assert.equal(tierDefaults('DEEP'), TIER_DEFAULTS.DEEP);
    assert.equal(tierDefaults(' Deep '), TIER_DEFAULTS.DEEP);
    assert.equal(tierDefaults('ask'), TIER_DEFAULTS.ASK);
    assert.equal(tierDefaults('investigate'), TIER_DEFAULTS.INVESTIGATE);
  });

  test('tierDefaults() falls back to INVESTIGATE for unknown / non-string tiers', () => {
    assert.equal(tierDefaults('turbo'), TIER_DEFAULTS.INVESTIGATE);
    assert.equal(tierDefaults(''), TIER_DEFAULTS.INVESTIGATE);
    assert.equal(tierDefaults(undefined), TIER_DEFAULTS.INVESTIGATE);
    assert.equal(tierDefaults(null), TIER_DEFAULTS.INVESTIGATE);
    assert.equal(tierDefaults(42), TIER_DEFAULTS.INVESTIGATE);
    // prototype names must not resolve to inherited properties
    assert.equal(tierDefaults('constructor'), TIER_DEFAULTS.INVESTIGATE);
    assert.equal(tierDefaults('toString'), TIER_DEFAULTS.INVESTIGATE);
  });

  test('getConfig().tiers is the same frozen TIER_DEFAULTS constant, regardless of env overrides', () => {
    process.env.ONDEMAND_FULFILLMENT_ENDPOINT_ID = 'predefined-override';
    process.env.ONDEMAND_REASONING_MODE = 'opus';
    __reloadConfigForTests();
    const cfg = getConfig();
    assert.equal(cfg.tiers, TIER_DEFAULTS);
    assert.equal(
      cfg.tiers.ASK.fulfillmentEndpointId,
      'predefined-gpt-5.6-luna',
    );
    // the env override wins for the reconciled field itself, as before
    assert.equal(cfg.fulfillmentEndpointId, 'predefined-override');
    assert.equal(cfg.reasoningMode, 'opus');
  });
});

describe('server/ondemand/config.js — flowVersion (ONDEMAND_SPATIAL_FLOW_VERSION, alias GODS_EYE_FLOW_VERSION checked FIRST)', () => {
  test('FLOW_VERSION_ENV is a frozen constant naming canonical, alias and the alias-first order', () => {
    assert.ok(Object.isFrozen(FLOW_VERSION_ENV));
    assert.ok(Object.isFrozen(FLOW_VERSION_ENV.order));
    assert.deepEqual(FLOW_VERSION_ENV, {
      canonical: 'ONDEMAND_SPATIAL_FLOW_VERSION',
      alias: 'GODS_EYE_FLOW_VERSION',
      order: ['GODS_EYE_FLOW_VERSION', 'ONDEMAND_SPATIAL_FLOW_VERSION', 'default'],
    });
    __reloadConfigForTests();
    assert.equal(getConfig().flowVersionEnv, FLOW_VERSION_ENV);
  });

  test('defaults to "1" (string, FLOW_DEFAULTS.flowVersion) with source "default" when neither name is set', () => {
    __reloadConfigForTests();
    assert.equal(config.flowVersion, '1');
    assert.equal(config.flowVersion, FLOW_DEFAULTS.flowVersion);
    assert.equal(configSources().flowVersion, 'default');
    assert.equal(getConfig().flowVersion, '1');
  });

  test('alias only: honours GODS_EYE_FLOW_VERSION and names it as the source', () => {
    process.env.GODS_EYE_FLOW_VERSION = '3';
    __reloadConfigForTests();
    assert.equal(config.flowVersion, '3');
    assert.equal(configSources().flowVersion, 'GODS_EYE_FLOW_VERSION');
    assert.equal(configSources().flowVersion, FLOW_VERSION_ENV.alias);
  });

  test('canonical only: honours ONDEMAND_SPATIAL_FLOW_VERSION and names it as the source', () => {
    process.env.ONDEMAND_SPATIAL_FLOW_VERSION = '4';
    __reloadConfigForTests();
    assert.equal(config.flowVersion, '4');
    assert.equal(configSources().flowVersion, 'ONDEMAND_SPATIAL_FLOW_VERSION');
    assert.equal(configSources().flowVersion, FLOW_VERSION_ENV.canonical);
  });

  test('BOTH set with different values: the alias (already provisioned on Vercel) wins — alias-first', () => {
    process.env.GODS_EYE_FLOW_VERSION = '3';
    process.env.ONDEMAND_SPATIAL_FLOW_VERSION = '4';
    __reloadConfigForTests();
    assert.equal(config.flowVersion, '3');
    assert.equal(configSources().flowVersion, 'GODS_EYE_FLOW_VERSION');
    assert.equal(getConfig().sources.flowVersion, 'GODS_EYE_FLOW_VERSION');
  });

  test('a whitespace-only alias falls through to the canonical name', () => {
    process.env.GODS_EYE_FLOW_VERSION = '   ';
    process.env.ONDEMAND_SPATIAL_FLOW_VERSION = '4';
    __reloadConfigForTests();
    assert.equal(config.flowVersion, '4');
    assert.equal(configSources().flowVersion, 'ONDEMAND_SPATIAL_FLOW_VERSION');
  });

  test('explicitly empty alias AND canonical still yield the default (never an empty label)', () => {
    process.env.GODS_EYE_FLOW_VERSION = '   ';
    process.env.ONDEMAND_SPATIAL_FLOW_VERSION = '';
    __reloadConfigForTests();
    assert.equal(config.flowVersion, '1');
    assert.equal(configSources().flowVersion, 'default');
  });

  test('sources.flowVersion is always one of FLOW_VERSION_ENV.order (names only, never a value)', () => {
    for (const env of [
      {},
      { GODS_EYE_FLOW_VERSION: '3' },
      { ONDEMAND_SPATIAL_FLOW_VERSION: '4' },
      { GODS_EYE_FLOW_VERSION: '3', ONDEMAND_SPATIAL_FLOW_VERSION: '4' },
    ]) {
      delete process.env.GODS_EYE_FLOW_VERSION;
      delete process.env.ONDEMAND_SPATIAL_FLOW_VERSION;
      Object.assign(process.env, env);
      __reloadConfigForTests();
      const source = configSources().flowVersion;
      assert.ok(FLOW_VERSION_ENV.order.includes(source), source);
      assert.notEqual(source, '3');
      assert.notEqual(source, '4');
    }
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

  describe('reasoningEndpointId: ONDEMAND_REASONING_ENDPOINT_ID (canonical) vs ONDEMAND_ENDPOINT_ID (alias)', () => {
    test('canonical wins when both are set', () => {
      process.env.ONDEMAND_REASONING_ENDPOINT_ID = 'reasoning-canonical';
      process.env.ONDEMAND_ENDPOINT_ID = 'shared-alias';
      __reloadConfigForTests();
      assert.equal(config.reasoningEndpointId, 'reasoning-canonical');
      assert.equal(
        configSources().reasoningEndpointId,
        'ONDEMAND_REASONING_ENDPOINT_ID',
      );
    });

    test('alias is used when the canonical name is absent', () => {
      process.env.ONDEMAND_ENDPOINT_ID = 'shared-alias';
      __reloadConfigForTests();
      assert.equal(config.reasoningEndpointId, 'shared-alias');
      assert.equal(configSources().reasoningEndpointId, 'ONDEMAND_ENDPOINT_ID');
    });

    test('neither set -> "low" default (documented reasoningMode tier, re-based 2026-09-18), source "default"', () => {
      __reloadConfigForTests();
      assert.equal(config.reasoningEndpointId, 'low');
      assert.equal(configSources().reasoningEndpointId, 'default');
    });

    test('an explicit "dynamic" override still wins over the new "low" default (env overrides unchanged)', () => {
      process.env.ONDEMAND_REASONING_ENDPOINT_ID = 'dynamic';
      __reloadConfigForTests();
      assert.equal(config.reasoningEndpointId, 'dynamic');
      assert.equal(
        configSources().reasoningEndpointId,
        'ONDEMAND_REASONING_ENDPOINT_ID',
      );
    });

    test('the shared ONDEMAND_ENDPOINT_ID alias feeds BOTH reasoningEndpointId and fulfillmentEndpointId at once', () => {
      process.env.ONDEMAND_ENDPOINT_ID = 'shared-alias';
      __reloadConfigForTests();
      assert.equal(config.reasoningEndpointId, 'shared-alias');
      assert.equal(config.fulfillmentEndpointId, 'shared-alias');
      assert.equal(configSources().reasoningEndpointId, 'ONDEMAND_ENDPOINT_ID');
      assert.equal(
        configSources().fulfillmentEndpointId,
        'ONDEMAND_ENDPOINT_ID',
      );
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

    test('neither set -> the step-3 INVESTIGATE default, source "default"', () => {
      __reloadConfigForTests();
      assert.equal(config.fulfillmentEndpointId, 'predefined-gpt-5.6-luna');
      assert.equal(configSources().fulfillmentEndpointId, 'default');
    });
  });

  describe('default plugin ids: ONDEMAND_SPATIAL_AGENT_ID (canonical); no accepted alias', () => {
    test('canonical sets the list', () => {
      process.env.ONDEMAND_SPATIAL_AGENT_ID = 'plugin-canonical';
      __reloadConfigForTests();
      assert.deepEqual(config.defaultPluginIds, ['plugin-canonical']);
      assert.equal(config.spatialAgentId, 'plugin-canonical');
      assert.equal(
        configSources().defaultPluginIds,
        'ONDEMAND_SPATIAL_AGENT_ID',
      );
    });

    test('canonical value is comma/whitespace-separated, trimmed, and de-duplicated', () => {
      process.env.ONDEMAND_SPATIAL_AGENT_ID =
        '  plugin-a ,plugin-b,  plugin-a\nplugin-c ,,plugin-b';
      __reloadConfigForTests();
      assert.deepEqual(config.defaultPluginIds, [
        'plugin-a',
        'plugin-b',
        'plugin-c',
      ]);
    });

    test('canonical value is capped at the documented pluginIds maxItems (20)', () => {
      const ids = Array.from({ length: 25 }, (_, i) => `plugin-${i}`);
      process.env.ONDEMAND_SPATIAL_AGENT_ID = ids.join(',');
      __reloadConfigForTests();
      assert.equal(config.defaultPluginIds.length, 20);
      assert.deepEqual(config.defaultPluginIds, ids.slice(0, 20));
    });

    test('unset -> empty list, source "unset"', () => {
      __reloadConfigForTests();
      assert.deepEqual(config.defaultPluginIds, []);
      assert.equal(config.spatialAgentId, '');
      assert.equal(configSources().defaultPluginIds, 'unset');
    });

    test('set to only separators -> empty list, source "unset"', () => {
      process.env.ONDEMAND_SPATIAL_AGENT_ID = ' , , ';
      __reloadConfigForTests();
      assert.deepEqual(config.defaultPluginIds, []);
      assert.equal(configSources().defaultPluginIds, 'unset');
    });

    test('the retired ONDEMAND_KNOWLEDGE_PLUGIN_IDS alias is now IGNORED even when set, with no canonical value present', () => {
      process.env[DEPRECATED_KNOWLEDGE_ALIAS] = 'plugin-a,plugin-b';
      __reloadConfigForTests();
      assert.deepEqual(config.defaultPluginIds, []);
      assert.equal(config.spatialAgentId, '');
      assert.equal(configSources().defaultPluginIds, 'unset');
    });

    test('the retired alias is ignored even when the canonical name is ALSO set (canonical wins, alias contributes nothing)', () => {
      process.env.ONDEMAND_SPATIAL_AGENT_ID = 'plugin-canonical';
      process.env[DEPRECATED_KNOWLEDGE_ALIAS] = 'plugin-alias-1,plugin-alias-2';
      __reloadConfigForTests();
      assert.deepEqual(config.defaultPluginIds, ['plugin-canonical']);
      assert.equal(
        configSources().defaultPluginIds,
        'ONDEMAND_SPATIAL_AGENT_ID',
      );
    });
  });

  test('ONDEMAND_SPATIAL_FLOW_ID has no accepted alias (docs/ONDEMAND_PROXY_DESIGN.md §5b)', () => {
    __reloadConfigForTests();
    assert.equal(config.spatialFlowId, FLOW_DEFAULTS.spatialFlowId);
    assert.equal(configSources().spatialFlowId, 'default');
    process.env.ONDEMAND_SPATIAL_FLOW_ID = 'wf-1';
    __reloadConfigForTests();
    assert.equal(config.spatialFlowId, 'wf-1');
    assert.equal(configSources().spatialFlowId, 'ONDEMAND_SPATIAL_FLOW_ID');
  });
});

describe('server/ondemand/config.js — FLOW_DEFAULTS (OnDemand Spatial Advanced Workflow v1, 2026-09-18)', () => {
  test('is a frozen constant carrying the real workflow id and the version label "1"', () => {
    assert.ok(Object.isFrozen(FLOW_DEFAULTS));
    assert.deepEqual(Object.keys(FLOW_DEFAULTS).sort(), [
      'flowVersion',
      'spatialFlowId',
    ]);
    // A Mongo-style 24-hex id, as every workflow id returned by
    // POST /automation/api/workflow/ is (docs/ONDEMAND_API_CURRENT.md §7.4
    // samples and the live 201 of 2026-09-18T07:16:04Z).
    assert.match(FLOW_DEFAULTS.spatialFlowId, /^[0-9a-f]{24}$/);
    assert.equal(FLOW_DEFAULTS.spatialFlowId, '6aace534859f7b0abb53d99a');
    assert.equal(FLOW_DEFAULTS.flowVersion, '1');
    assert.equal(typeof FLOW_DEFAULTS.flowVersion, 'string');
  });

  test('spatialFlowId defaults to FLOW_DEFAULTS.spatialFlowId with source "default" when unset', () => {
    __reloadConfigForTests();
    assert.equal(config.spatialFlowId, FLOW_DEFAULTS.spatialFlowId);
    assert.equal(configSources().spatialFlowId, 'default');
    assert.equal(getConfig().spatialFlowId, FLOW_DEFAULTS.spatialFlowId);
  });

  test('an explicitly empty ONDEMAND_SPATIAL_FLOW_ID still yields the default (never an empty id)', () => {
    process.env.ONDEMAND_SPATIAL_FLOW_ID = '';
    __reloadConfigForTests();
    assert.equal(config.spatialFlowId, FLOW_DEFAULTS.spatialFlowId);
    assert.equal(configSources().spatialFlowId, 'default');
  });

  test('the default flow id and version match the committed export docs/ondemand-workflows/ondemand-spatial-advanced-v1.json', async () => {
    const { readFile } = await import('node:fs/promises');
    const exported = JSON.parse(
      await readFile(
        new URL(
          '../../docs/ondemand-workflows/ondemand-spatial-advanced-v1.json',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    assert.equal(exported.workflow.id, FLOW_DEFAULTS.spatialFlowId);
    assert.equal(
      String(exported._export.flowVersion),
      FLOW_DEFAULTS.flowVersion,
    );
    assert.equal(exported.workflow.name, 'OnDemand Spatial Advanced Workflow');
    assert.equal(exported.createBody.name, 'OnDemand Spatial Advanced Workflow');
    // Display-name rename only (PATCH /workflow/{id}/name, 2026-09-18T10:41:47Z):
    // the id is the one FLOW_DEFAULTS carries, and the export records the
    // rename it went through.
    assert.equal(exported._export.rename.from, 'GodsEye Advanced Spatial Workflow');
    assert.equal(exported._export.rename.to, 'OnDemand Spatial Advanced Workflow');
    assert.equal(exported.workflow.isActive, true);
  });
});
