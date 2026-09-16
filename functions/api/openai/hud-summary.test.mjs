import test from 'node:test';
import assert from 'node:assert/strict';

import { onRequest } from './hud-summary.js';

/** A Pages-style context over a Request. */
const ctx = (request, env = {}) => ({ request, env });

const post = (body, env = {}) => ctx(new Request('https://example.com/api/openai/hud-summary', {
  method: 'POST',
  body: typeof body === 'string' ? body : JSON.stringify(body),
}), env);

test('non-POST methods get the dev 405 shape', async () => {
  const res = await onRequest(ctx(new Request('https://x/api/openai/hud-summary')));
  assert.equal(res.status, 405);
  assert.deepEqual(await res.json(), { error: 'Method not allowed' });
});

test('a missing key degrades with the keyless 200 shape instead of calling OpenAI', async () => {
  const res = await onRequest(post({ place: 'Austin' }, {}));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    error: 'OPENAI_API_KEY is not set',
    unavailable: true,
  });
});

test('invalid JSON bodies are rejected before any upstream call', async () => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (...args) => { calls.push(args); throw new Error('must not be called'); };
  try {
    const res = await onRequest(post('{nope', { OPENAI_API_KEY: 'k' }));
    assert.equal(res.status, 400);
    assert.ok((await res.json()).error);
    assert.equal(calls.length, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test('a good context returns a five-word summary built from the shared prompts', async () => {
  let captured;
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    captured = { url, init };
    return new Response(JSON.stringify({
      output_text: '  Downtown    Austin, traffic —  dense flights! ',
    }), { status: 200 });
  };
  try {
    const res = await onRequest(post(
      { place: 'Austin', layers: ['flights'] },
      { OPENAI_API_KEY: 'k', OPENAI_HUD_SUMMARY_MODEL: 'my-model' },
    ));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual(await res.json(), { summary: 'Downtown Austin traffic dense flights', error: null });

    assert.equal(captured.url, 'https://api.openai.com/v1/responses');
    const sent = JSON.parse(captured.init.body);
    assert.equal(sent.model, 'my-model', 'the env override is authoritative');
    assert.equal(sent.reasoning.effort, 'minimal');
    assert.equal(sent.max_output_tokens, 100);
    assert.match(sent.instructions, /Output exactly five words/);
    assert.equal(sent.input, JSON.stringify({ place: 'Austin', layers: ['flights'] }));
    assert.equal(captured.init.headers.Authorization, 'Bearer k');
  } finally {
    globalThis.fetch = original;
  }
});

test('the default HUD model rides the shared registry default', async () => {
  let sent;
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    sent = JSON.parse(init.body);
    return new Response(JSON.stringify({ output_text: 'a b c d e f' }), { status: 200 });
  };
  try {
    const res = await onRequest(post({}, { OPENAI_API_KEY: 'k' }));
    assert.equal(res.status, 200);
    assert.match(sent.model, /^gpt-/, 'the shared default is an OpenAI model id');
    assert.equal((await res.json()).summary.split(' ').length, 5, 'exactly five words survive');
  } finally {
    globalThis.fetch = original;
  }
});

test('an upstream error passes its status and message through', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({ error: { message: 'quota exhausted' } }),
    { status: 429 },
  );
  try {
    const res = await onRequest(post({}, { OPENAI_API_KEY: 'k' }));
    assert.equal(res.status, 429);
    assert.deepEqual(await res.json(), { summary: null, error: 'quota exhausted' });
  } finally {
    globalThis.fetch = original;
  }
});

test('a transport failure becomes the dev 502 shape', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('dns fail'); };
  try {
    const res = await onRequest(post({}, { OPENAI_API_KEY: 'k' }));
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), { error: 'dns fail' });
  } finally {
    globalThis.fetch = original;
  }
});

test('the opt-in per-IP throttle answers 429 with Retry-After', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ output_text: 'a b c d e' }), { status: 200 });
  try {
    const env = { OPENAI_API_KEY: 'k', GEV_RATELIMIT_OPENAI_PER_MIN: '1' };
    const headers = { 'CF-Connecting-IP': '10.0.0.1' };
    const make = () => onRequest(ctx(new Request('https://x/api/openai/hud-summary', {
      method: 'POST', headers, body: '{}',
    }), env));

    assert.equal((await make()).status, 200);
    const second = await make();
    assert.equal(second.status, 429);
    assert.equal(second.headers.get('Retry-After'), '5');
    assert.deepEqual(await second.json(), { error: 'Rate limit exceeded' });
  } finally {
    globalThis.fetch = original;
  }
});

test('a cross-origin POST is rejected before spending OpenAI quota', async () => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (...args) => { calls.push(args); throw new Error('no'); };
  try {
    const res = await onRequest(ctx(new Request('https://example.com/api/openai/hud-summary', {
      method: 'POST',
      headers: { Origin: 'https://evil.example' },
      body: '{}',
    }), { OPENAI_API_KEY: 'k' }));
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: 'cross-origin requests are rejected' });
    assert.equal(calls.length, 0, 'the drive-by summary never reaches OpenAI');
  } finally {
    globalThis.fetch = original;
  }
});

test('throttling is default-ON on Pages: the 31st summary in a minute is refused', async () => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async () => { calls.push(1); return new Response(JSON.stringify({ output_text: 'a b c d e' }), { status: 200 }); };
  try {
    // Dedicated edge IP so this test does not share window state with the
    // other tests (which run as non-browser `unknown` clients).
    const headers = { 'CF-Connecting-IP': '10.0.1.31' };
    const make = () => onRequest(ctx(new Request('https://x/api/openai/hud-summary', {
      method: 'POST', headers, body: '{}',
    }), { OPENAI_API_KEY: 'k' }));

    for (let i = 0; i < 30; i += 1) {
      assert.equal((await make()).status, 200, `summary ${i} rides the default 30/min window`);
    }
    const blocked = await make();
    assert.equal(blocked.status, 429, 'no GEV_RATELIMIT_* env still throttles on Pages');
    assert.equal(calls.length, 30, 'the blocked summary never reached OpenAI');
  } finally {
    globalThis.fetch = original;
  }
});

test('GEV_RATELIMIT_OPENAI_PER_MIN=0 disables the default-on throttle', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ output_text: 'a b c d e' }), { status: 200 });
  try {
    const env = { OPENAI_API_KEY: 'k', GEV_RATELIMIT_OPENAI_PER_MIN: '0' };
    const headers = { 'CF-Connecting-IP': '10.0.1.31' }; // already exhausted above
    for (let i = 0; i < 32; i += 1) {
      const res = await onRequest(ctx(new Request('https://x/api/openai/hud-summary', {
        method: 'POST', headers, body: '{}',
      }), env));
      assert.equal(res.status, 200, `escape-hatch summary ${i} is unlimited`);
    }
  } finally {
    globalThis.fetch = original;
  }
});
