import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { openAiRealtimeProxy } from '../../server/providers/openai.js';

// T4 (breaker MAJOR on T3): the HUD summary and the Realtime token shared one
// per-IP bucket. With Terraform's 3/min, the HUD's 15 s poll (plus its retry
// after a 429) spent the whole budget and the mic failed to start with a 429.
// The two routes must have separate buckets.

const ENV = [
  'OPENAI_API_KEY',
  'GEV_RATELIMIT_OPENAI_PER_MIN',
  'GEV_RATELIMIT_HUD_PER_MIN',
  'WEBSITE_INSTANCE_ID',
];

function setup(t, env) {
  for (const name of ENV) {
    const previous = process.env[name];
    if (name in env) process.env[name] = env[name];
    else delete process.env[name];
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
  }
  t.mock.method(globalThis, 'fetch', async (raw) => {
    const url = String(raw);
    const payload = url.includes('/responses')
      ? { output_text: 'Austin downtown flights live now' }
      : { value: 'ek_fixture', expires_at: 0 };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  const routes = new Map();
  openAiRealtimeProxy().configurePreviewServer({
    middlewares: {
      use(path, handler) {
        routes.set(path, handler);
      },
    },
  });
  return {
    token: (ip) => invoke(routes.get('/api/realtime/token'), 'GET', ip),
    hud: (ip) => invoke(routes.get('/api/openai/hud-summary'), 'POST', ip),
  };
}

function invoke(handler, method, remoteAddress) {
  return new Promise((resolve, reject) => {
    const req = Readable.from(method === 'POST' ? [Buffer.from('{}')] : []);
    Object.assign(req, {
      method,
      url: '/',
      headers: {},
      socket: { remoteAddress },
    });
    const headers = new Map();
    const res = {
      statusCode: 200,
      setHeader(name, value) {
        headers.set(String(name).toLowerCase(), String(value));
      },
      end() {
        resolve({ status: this.statusCode, headers: Object.fromEntries(headers) });
      },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

test('T4: a HUD polling at 4/min cannot 429 the voice token (Terraform defaults)', async (t) => {
  const { token, hud } = setup(t, {
    OPENAI_API_KEY: 'sk-fixture',
    GEV_RATELIMIT_OPENAI_PER_MIN: '3',
    GEV_RATELIMIT_HUD_PER_MIN: '6',
  });
  const ip = '198.51.100.40';
  // One minute of the breaker's replay: first settle + three 15 s ticks.
  for (let i = 0; i < 4; i += 1) assert.equal((await hud(ip)).status, 200);
  const mic = await token(ip);
  assert.equal(mic.status, 200, 'the voice token keeps its own budget');
});

test('T4: with only GEV_RATELIMIT_OPENAI_PER_MIN set, the HUD still has its own bucket', async (t) => {
  const { token, hud } = setup(t, {
    OPENAI_API_KEY: 'sk-fixture',
    GEV_RATELIMIT_OPENAI_PER_MIN: '3',
  });
  const ip = '198.51.100.41';
  for (let i = 0; i < 6; i += 1) await hud(ip);
  assert.equal((await token(ip)).status, 200);
});

test('T4: the HUD bucket honours GEV_RATELIMIT_HUD_PER_MIN and sends Retry-After', async (t) => {
  const { hud } = setup(t, {
    OPENAI_API_KEY: 'sk-fixture',
    GEV_RATELIMIT_OPENAI_PER_MIN: '3',
    GEV_RATELIMIT_HUD_PER_MIN: '2',
  });
  const ip = '198.51.100.42';
  assert.equal((await hud(ip)).status, 200);
  assert.equal((await hud(ip)).status, 200);
  const limited = await hud(ip);
  assert.equal(limited.status, 429);
  const retryAfter = Number(limited.headers['retry-after']);
  assert.ok(
    Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 60,
    `Retry-After is whole seconds within the window, got ${limited.headers['retry-after']}`,
  );
  assert.ok(retryAfter > 5, 'Retry-After reflects the window, not a fixed 5 s');
});

test('T4: the token bucket still caps the voice token alone', async (t) => {
  const { token } = setup(t, {
    OPENAI_API_KEY: 'sk-fixture',
    GEV_RATELIMIT_OPENAI_PER_MIN: '1',
    GEV_RATELIMIT_HUD_PER_MIN: '6',
  });
  const ip = '198.51.100.43';
  assert.equal((await token(ip)).status, 200);
  const limited = await token(ip);
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers['retry-after']) >= 1);
});

test('T4: with neither limit set, both routes stay unlimited (local dev)', async (t) => {
  const { token, hud } = setup(t, { OPENAI_API_KEY: 'sk-fixture' });
  const ip = '198.51.100.44';
  for (let i = 0; i < 10; i += 1) {
    assert.equal((await hud(ip)).status, 200);
    assert.equal((await token(ip)).status, 200);
  }
});
