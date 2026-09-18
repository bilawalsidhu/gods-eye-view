import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import {
  createHudSummaryHandler,
  extractCodexStreamText,
} from './hud-summary.js';

function mockReq(body = '{}') {
  const req = Readable.from([Buffer.from(body)]);
  req.method = 'POST';
  req.url = '/api/openai/hud-summary';
  req.headers = {};
  req.socket = { remoteAddress: '127.0.0.1' };
  return req;
}

function mockRes() {
  const headers = new Map();
  return {
    statusCode: 200,
    headers,
    setHeader(name, value) {
      headers.set(String(name).toLowerCase(), String(value));
    },
    end(body = '') {
      this.body = String(body);
    },
  };
}

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
  };
}

test('extractCodexStreamText prefers the completed response object', () => {
  const sse = [
    'data: {"type":"response.output_text.done","text":"fallback words here now"}',
    '',
    'data: {"type":"response.completed","response":{"output_text":"Austin Congress Ave flights enabled"}}',
    '',
  ].join('\n');
  assert.equal(
    extractCodexStreamText(sse),
    'Austin Congress Ave flights enabled',
  );
});

test('extractCodexStreamText falls back to output_text.done events', () => {
  const sse = [
    'data: not-json',
    'data: {"type":"response.output_text.done","text":"Port Long Beach"}',
    'data: {"type":"response.output_text.done","text":"vessels live"}',
  ].join('\n');
  assert.equal(extractCodexStreamText(sse), 'Port Long Beach vessels live');
});

test('key lane keeps the platform Responses API shape', async () => {
  let seenUrl;
  let seenBody;
  const handler = createHudSummaryHandler({
    resolveCredential: () => ({ token: 'sk-fixture', source: 'env' }),
    fetchImpl: async (url, init) => {
      seenUrl = url;
      seenBody = JSON.parse(init.body);
      return jsonResponse(200, {
        output_text: 'Austin downtown flights cctv active',
      });
    },
  });
  const res = mockRes();
  await handler(mockReq('{"place":"Austin"}'), res);
  assert.equal(res.statusCode, 200);
  assert.equal(seenUrl, 'https://api.openai.com/v1/responses');
  assert.equal(seenBody.model, 'gpt-5-nano');
  assert.equal(seenBody.max_output_tokens, 100);
  assert.equal(
    JSON.parse(res.body).summary,
    'Austin downtown flights cctv active',
  );
  assert.equal(res.headers.get('x-gev-hud-auth'), 'env');
});

test('codex lane uses the strict ChatGPT backend wire shape', async () => {
  let seenUrl;
  let seenHeaders;
  let seenBody;
  const sse =
    'data: {"type":"response.completed","response":{"output_text":"Tokyo Shibuya radio layer live"}}\n';
  const handler = createHudSummaryHandler({
    resolveCredential: () => ({
      token: 'codex-access-fixture',
      source: 'codex-oauth',
      chatgptAccountId: 'acct-fixture',
    }),
    fetchImpl: async (url, init) => {
      seenUrl = url;
      seenHeaders = init.headers;
      seenBody = JSON.parse(init.body);
      return { ok: true, status: 200, text: async () => sse };
    },
  });
  const res = mockRes();
  await handler(mockReq('{"place":"Tokyo"}'), res);
  assert.equal(res.statusCode, 200);
  assert.equal(seenUrl, 'https://chatgpt.com/backend-api/codex/responses');
  assert.equal(seenHeaders.Authorization, 'Bearer codex-access-fixture');
  assert.equal(seenHeaders['ChatGPT-Account-Id'], 'acct-fixture');
  assert.equal(seenBody.store, false);
  assert.equal(seenBody.stream, true);
  assert.equal(seenBody.model, 'gpt-5.6-luna');
  assert.equal(seenBody.max_output_tokens, undefined);
  assert.ok(Array.isArray(seenBody.input));
  assert.equal(seenBody.input[0].content[0].type, 'input_text');
  assert.equal(JSON.parse(res.body).summary, 'Tokyo Shibuya radio layer live');
  assert.equal(res.headers.get('x-gev-hud-auth'), 'codex-oauth');
});

test('codex lane surfaces an upstream usage limit without inventing a summary', async () => {
  const handler = createHudSummaryHandler({
    resolveCredential: () => ({
      token: 'codex-access-fixture',
      source: 'codex-oauth',
      chatgptAccountId: 'acct-fixture',
    }),
    fetchImpl: async () =>
      jsonResponse(429, {
        error: {
          type: 'usage_limit_reached',
          message: 'The usage limit has been reached',
        },
      }),
  });
  const res = mockRes();
  await handler(mockReq(), res);
  assert.equal(res.statusCode, 429);
  assert.deepEqual(JSON.parse(res.body), {
    summary: null,
    error: 'The usage limit has been reached',
  });
});

test('no credential at all keeps the free unconfigured fallback', async () => {
  let fetchCalled = false;
  const handler = createHudSummaryHandler({
    resolveCredential: () => {
      throw new Error('no lanes');
    },
    fetchImpl: async () => {
      fetchCalled = true;
      return jsonResponse(200, {});
    },
  });
  const res = mockRes();
  await handler(mockReq(), res);
  assert.equal(res.statusCode, 200);
  assert.equal(fetchCalled, false);
  assert.equal(JSON.parse(res.body).configured, false);
});

test('codex model override comes from the environment', async () => {
  let seenBody;
  const sse =
    'data: {"type":"response.completed","response":{"output_text":"One two three four five"}}\n';
  const handler = createHudSummaryHandler({
    env: { OPENAI_HUD_SUMMARY_CODEX_MODEL: 'gpt-5.5' },
    resolveCredential: () => ({
      token: 'codex-access-fixture',
      source: 'codex-oauth',
      chatgptAccountId: 'acct-fixture',
    }),
    fetchImpl: async (url, init) => {
      seenBody = JSON.parse(init.body);
      return { ok: true, status: 200, text: async () => sse };
    },
  });
  const res = mockRes();
  await handler(mockReq(), res);
  assert.equal(seenBody.model, 'gpt-5.5');
});
