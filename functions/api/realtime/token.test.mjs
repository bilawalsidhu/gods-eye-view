import test from 'node:test';
import assert from 'node:assert/strict';

import { VOICE_MODELS } from '../../../src/voice/voiceCost.js';
import { onRequest } from './token.js';

const ctx = (request, env = {}) => ({ request, env });

const url = (query = '') => `https://example.com/api/realtime/token${query}`;

test('unsupported methods get the dev 405 shape — including GET', async () => {
  for (const method of ['GET', 'DELETE']) {
    const res = await onRequest(ctx(new Request(url(), { method })));
    assert.equal(res.status, 405, method);
    assert.deepEqual(await res.json(), { error: 'Method not allowed' });
  }
});

test('a cross-site Origin header is rejected before anything billable happens', async () => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (...args) => { calls.push(args); throw new Error('no'); };
  try {
    const res = await onRequest(ctx(new Request(url(), {
      method: 'POST',
      headers: { Origin: 'https://evil.example' },
    }), { OPENAI_API_KEY: 'k' }));
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: 'cross-origin token requests are rejected' });
    assert.equal(calls.length, 0, 'the drive-by mint never reaches OpenAI');
  } finally {
    globalThis.fetch = original;
  }
});

test('a same-origin POST carries Origin and is allowed through', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('{"value":"tok"}', { status: 200 });
  try {
    const res = await onRequest(ctx(new Request(url(), {
      method: 'POST',
      headers: { Origin: 'https://example.com' },
    }), { OPENAI_API_KEY: 'k' }));
    assert.equal(res.status, 200);
  } finally {
    globalThis.fetch = original;
  }
});

test('a missing key degrades with the dev 503 shape instead of calling OpenAI', async () => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (...args) => { calls.push(args); throw new Error('no'); };
  try {
    const res = await onRequest(ctx(new Request(url(), { method: 'POST' })));
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: 'OPENAI_API_KEY is not set' });
    assert.equal(calls.length, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test('a standard-tier session is minted on the shared module shape', async () => {
  let captured;
  const original = globalThis.fetch;
  globalThis.fetch = async (fetchUrl, init) => {
    captured = { fetchUrl, init };
    return new Response(JSON.stringify({ value: 'eccnec' }), { status: 201 });
  };
  try {
    const res = await onRequest(ctx(new Request(url(), { method: 'POST' }), {
      OPENAI_API_KEY: 'k',
      OPENAI_REALTIME_VOICE: 'alloy',
      OPENAI_REALTIME_CONTEXT_TOKENS: '5000',
    }));

    assert.equal(res.status, 201);
    assert.equal(await res.text(), JSON.stringify({ value: 'eccnec' }), 'upstream body passes through untouched');
    assert.equal(res.headers.get('X-GEV-Voice-Tier'), 'standard');
    assert.equal(res.headers.get('X-GEV-Voice-Model'), VOICE_MODELS.standard.id);
    assert.equal(res.headers.get('X-GEV-Voice-Tier-Fallback'), null);

    assert.equal(captured.fetchUrl, 'https://api.openai.com/v1/realtime/client_secrets');
    assert.equal(captured.init.headers.Authorization, 'Bearer k');
    const session = JSON.parse(captured.init.body).session;
    assert.equal(session.type, 'realtime');
    assert.equal(session.model, VOICE_MODELS.standard.id);
    assert.equal(session.audio.output.voice, 'alloy', 'the voice env override is authoritative');
    assert.equal(session.truncation.token_limits.post_instructions, 5000);
    assert.equal(session.tools.length, 28, 'the frozen schema rides the session');
    assert.ok(session.instructions.length > 1000, 'the full system prompt rides the session');
  } finally {
    globalThis.fetch = original;
  }
});

test('?tier=mini mints the mini model and honors its env override', async () => {
  const seen = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (_u, init) => {
    seen.push(JSON.parse(init.body).session.model);
    return new Response('{}', { status: 200 });
  };
  try {
    const plain = await onRequest(ctx(new Request(url('?tier=mini'), { method: 'POST' }), { OPENAI_API_KEY: 'k' }));
    assert.equal(plain.headers.get('X-GEV-Voice-Model'), VOICE_MODELS.mini.id);

    await onRequest(ctx(new Request(url('?tier=mini'), { method: 'POST' }), {
      OPENAI_API_KEY: 'k',
      OPENAI_REALTIME_MODEL_MINI: 'my-mini-model',
    }));
    assert.deepEqual(seen, [VOICE_MODELS.mini.id, 'my-mini-model']);
  } finally {
    globalThis.fetch = original;
  }
});

test('a hostile tier degrades to standard and is flagged, never forwarded', async () => {
  let seen;
  const original = globalThis.fetch;
  globalThis.fetch = async (_u, init) => {
    seen = JSON.parse(init.body).session.model;
    return new Response('{}', { status: 200 });
  };
  try {
    const res = await onRequest(ctx(new Request(url('?tier=%22%3E%3Cscript%3E'), { method: 'POST' }), { OPENAI_API_KEY: 'k' }));
    assert.equal(res.headers.get('X-GEV-Voice-Tier'), 'standard');
    assert.equal(res.headers.get('X-GEV-Voice-Tier-Fallback'), '1');
    assert.equal(seen, VOICE_MODELS.standard.id);
  } finally {
    globalThis.fetch = original;
  }
});

test('a transport failure becomes the dev 502 shape', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('connect ECONNREFUSED'); };
  try {
    const res = await onRequest(ctx(new Request(url(), { method: 'POST' }), { OPENAI_API_KEY: 'k' }));
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), { error: 'connect ECONNREFUSED' });
  } finally {
    globalThis.fetch = original;
  }
});

test('the opt-in per-IP throttle answers 429 before minting', async () => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async () => { calls.push(1); return new Response('{}', { status: 200 }); };
  try {
    const env = { OPENAI_API_KEY: 'k', GEV_RATELIMIT_OPENAI_PER_MIN: '1' };
    const headers = { 'CF-Connecting-IP': '10.0.0.9' };
    const make = () => onRequest(ctx(new Request(url(), { method: 'POST', headers }), env));

    assert.equal((await make()).status, 200);
    const second = await make();
    assert.equal(second.status, 429);
    assert.equal(second.headers.get('Retry-After'), '5');
    assert.equal(calls.length, 1, 'a throttled request never reaches OpenAI');
  } finally {
    globalThis.fetch = original;
  }
});
