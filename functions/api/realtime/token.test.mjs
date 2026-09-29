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

test('a transport failure becomes the fixed dev 502 shape', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('connect ECONNREFUSED 10.0.0.1:443'); };
  try {
    const res = await onRequest(ctx(new Request(url(), { method: 'POST' }), { OPENAI_API_KEY: 'k' }));
    assert.equal(res.status, 502);
    const payload = await res.json();
    assert.deepEqual(payload, { error: 'Failed to create Realtime token' });
    assert.ok(!JSON.stringify(payload).includes('ECONNREFUSED'), 'network errno text is not relayed');
  } finally {
    globalThis.fetch = original;
  }
});

test('a non-ok upstream mint is gated: fixed error body, upstream body never relayed', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({ error: { message: 'quota exceeded for org acme-corp' } }),
    { status: 429, headers: { 'Content-Type': 'application/json' } },
  );
  try {
    const res = await onRequest(ctx(new Request(url('?tier=mini'), { method: 'POST' }), {
      OPENAI_API_KEY: 'k',
    }));
    assert.equal(res.status, 429);
    const payload = await res.json();
    assert.deepEqual(payload, { error: 'Failed to create Realtime token' });
    assert.ok(!JSON.stringify(payload).includes('quota'), 'upstream quota wording is not relayed');
    assert.ok(!JSON.stringify(payload).includes('acme-corp'), 'org identifiers are not relayed');
    // The tier headers stay authoritative even on the failure path (the
    // client logs which tier the mint attempt was for).
    assert.equal(res.headers.get('X-GEV-Voice-Tier'), 'mini');
    assert.equal(res.headers.get('X-GEV-Voice-Model'), VOICE_MODELS.mini.id);
    assert.match(res.headers.get('Content-Type'), /application\/json/);
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

test('throttling is default-ON on Pages: the 31st mint in a minute is refused', async () => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async () => { calls.push(1); return new Response('{}', { status: 200 }); };
  try {
    // Dedicated edge IP so the test does not share window state with the
    // limiter-less tests above (which run as non-browser `unknown` clients).
    const headers = { 'CF-Connecting-IP': '10.0.0.31' };
    const make = () => onRequest(ctx(new Request(url(), { method: 'POST', headers }), { OPENAI_API_KEY: 'k' }));

    for (let i = 0; i < 30; i += 1) {
      assert.equal((await make()).status, 200, `mint ${i} rides the default 30/min window`);
    }
    const blocked = await make();
    assert.equal(blocked.status, 429, 'no GEV_RATELIMIT_* env still throttles on Pages');
    assert.equal(calls.length, 30, 'the blocked mint never reached OpenAI');
  } finally {
    globalThis.fetch = original;
  }
});

test('GEV_RATELIMIT_OPENAI_PER_MIN=0 disables the default-on throttle', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', { status: 200 });
  try {
    const env = { OPENAI_API_KEY: 'k', GEV_RATELIMIT_OPENAI_PER_MIN: '0' };
    const headers = { 'CF-Connecting-IP': '10.0.0.31' }; // already exhausted above
    for (let i = 0; i < 32; i += 1) {
      const res = await onRequest(ctx(new Request(url(), { method: 'POST', headers }), env));
      assert.equal(res.status, 200, `escape-hatch mint ${i} is unlimited`);
    }
  } finally {
    globalThis.fetch = original;
  }
});
