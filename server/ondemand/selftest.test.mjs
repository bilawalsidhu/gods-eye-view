import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createSelftestHandler } from '../../api/ondemand/selftest.js';
import { makeReq, makeRes } from './test-helpers.mjs';

const TOKEN_ENV = 'ONDEMAND_SELFTEST_TOKEN';
let savedToken;

beforeEach(() => {
  savedToken = process.env[TOKEN_ENV];
});

afterEach(() => {
  if (savedToken === undefined) delete process.env[TOKEN_ENV];
  else process.env[TOKEN_ENV] = savedToken;
});

function baseConfig(overrides = {}) {
  return {
    apiKey: 'SENTINEL-KEY-123',
    baseUrl: 'https://api.on-demand.io',
    fulfillmentEndpointId: 'predefined-claude-sonnet-5',
    spatialFlowId: '',
    defaultPluginIds: [],
    ...overrides,
  };
}

function happyReport() {
  return {
    generatedAtUtc: '2026-09-18T00:00:00.000Z',
    mode: 'direct',
    externalUserId: 'godseye-selftest-2026-09-18',
    sessionId: 'sess1',
    steps: [
      {
        step: 1,
        name: 'session create + reuse',
        ok: true,
        skipped: false,
        skipReason: null,
        latencyMs: 12,
        utc: '2026-09-18T00:00:00.000Z',
        httpStatus: 201,
        detail: 'sessionId=sess1',
      },
    ],
    summary: {
      passed: 1,
      failed: 0,
      skipped: 0,
      totalMs: 12,
      minMs: 12,
      maxMs: 12,
      meanMs: 12,
    },
  };
}

describe('api/ondemand/selftest.js', () => {
  test('missing x-selftest-token header -> 404', async () => {
    process.env[TOKEN_ENV] = 'right-token';
    const handler = createSelftestHandler({
      getConfig: () => baseConfig(),
      now: () => 0,
      runSteps: async () => happyReport(),
    });
    const req = makeReq({ method: 'GET', url: '/api/ondemand/selftest' });
    const res = makeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.json(), { error: 'not_found' });
  });

  test('wrong token -> 404', async () => {
    process.env[TOKEN_ENV] = 'right-token';
    const handler = createSelftestHandler({
      getConfig: () => baseConfig(),
      now: () => 0,
      runSteps: async () => happyReport(),
    });
    const req = makeReq({
      method: 'GET',
      headers: { 'x-selftest-token': 'wrong-token' },
    });
    const res = makeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.json(), { error: 'not_found' });
  });

  test('ONDEMAND_SELFTEST_TOKEN unset on the deployment -> 404 even with a header', async () => {
    delete process.env[TOKEN_ENV];
    const handler = createSelftestHandler({
      getConfig: () => baseConfig(),
      now: () => 0,
      runSteps: async () => happyReport(),
    });
    const req = makeReq({
      method: 'GET',
      headers: { 'x-selftest-token': 'anything' },
    });
    const res = makeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.json(), { error: 'not_found' });
  });

  test('valid token -> 200 with the documented shape; sessionIdHash is 64 hex, raw id absent', async () => {
    process.env[TOKEN_ENV] = 'right-token';
    const handler = createSelftestHandler({
      getConfig: () => baseConfig(),
      now: () => 1000,
      runSteps: async () => happyReport(),
    });
    const req = makeReq({
      method: 'GET',
      headers: { 'x-selftest-token': 'right-token' },
    });
    const res = makeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, true);
    assert.equal(body.configured, true);
    assert.equal(body.mode, 'direct');
    assert.equal(body.fulfillmentEndpointId, 'predefined-claude-sonnet-5');
    assert.match(body.sessionIdHash, /^[0-9a-f]{64}$/);
    assert.equal(Array.isArray(body.steps), true);
    assert.equal(body.steps[0].status, 'PASS');
    assert.ok(!JSON.stringify(body).includes('sess1'));
    assert.equal(res.getHeader('cache-control'), 'no-store');
  });

  test('an immediate second valid call is rate limited -> 429 with Retry-After', async () => {
    process.env[TOKEN_ENV] = 'right-token';
    const handler = createSelftestHandler({
      getConfig: () => baseConfig(),
      now: () => 1000,
      runSteps: async () => happyReport(),
    });
    const makeAuthedReq = () =>
      makeReq({
        method: 'GET',
        headers: { 'x-selftest-token': 'right-token' },
      });

    const res1 = makeRes();
    await handler(makeAuthedReq(), res1);
    assert.equal(res1.statusCode, 200);

    const res2 = makeRes();
    await handler(makeAuthedReq(), res2);
    assert.equal(res2.statusCode, 429);
    assert.equal(res2.json().error, 'rate_limited');
    assert.equal(typeof res2.json().retryAfterSec, 'number');
    assert.ok(res2.getHeader('retry-after'));
  });

  test('POST is rejected -> 405 with Allow: GET', async () => {
    process.env[TOKEN_ENV] = 'right-token';
    const handler = createSelftestHandler({
      getConfig: () => baseConfig(),
      now: () => 0,
      runSteps: async () => happyReport(),
    });
    const req = makeReq({
      method: 'POST',
      headers: { 'x-selftest-token': 'right-token' },
    });
    const res = makeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 405);
    assert.equal(res.getHeader('allow'), 'GET');
  });

  test('apiKey unset -> 200 configured:false and the runner is never called', async () => {
    process.env[TOKEN_ENV] = 'right-token';
    let called = false;
    const handler = createSelftestHandler({
      getConfig: () => baseConfig({ apiKey: '' }),
      now: () => 0,
      runSteps: async () => {
        called = true;
        return happyReport();
      },
    });
    const req = makeReq({
      method: 'GET',
      headers: { 'x-selftest-token': 'right-token' },
    });
    const res = makeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.configured, false);
    assert.equal(body.ok, false);
    assert.deepEqual(body.steps, []);
    assert.equal(called, false);
  });

  test('a step error string containing the api key is redacted from the response', async () => {
    process.env[TOKEN_ENV] = 'right-token';
    const report = happyReport();
    report.summary = { ...report.summary, passed: 0, failed: 1 };
    report.steps = [
      {
        step: 2,
        name: 'sync prompt',
        ok: false,
        skipped: false,
        skipReason: null,
        latencyMs: 5,
        utc: '2026-09-18T00:00:00.000Z',
        httpStatus: 401,
        error: 'HTTP 401 (application/json): invalid apikey SENTINEL-KEY-123',
      },
    ];
    const handler = createSelftestHandler({
      getConfig: () => baseConfig({ apiKey: 'SENTINEL-KEY-123' }),
      now: () => 0,
      runSteps: async () => report,
    });
    const req = makeReq({
      method: 'GET',
      headers: { 'x-selftest-token': 'right-token' },
    });
    const res = makeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 200);
    assert.ok(!res.text().includes('SENTINEL-KEY-123'));
    assert.ok(res.json().steps[0].error.includes('***'));
  });
});
