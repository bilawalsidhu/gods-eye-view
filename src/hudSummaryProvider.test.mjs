import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import {
  GEMINI_HUD_SUMMARY_MODEL_DEFAULT,
  handleHudSummary,
  resolveHudSummaryProvider,
} from '../server/providers/openai/hud-summary.js';
import { HUD_SUMMARY_INSTRUCTIONS } from './hudSummaryResponse.js';
import { KEY_SETUP_KEYS } from './keySetupCore.mjs';

/** Set an env var for one test and put the old value back afterwards. */
function env(t, name, value) {
  const old = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  t.after(() => {
    if (old === undefined) delete process.env[name];
    else process.env[name] = old;
  });
}

/** Replace fetch for one test, recording every call. */
function stubFetch(t, reply) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init, body: JSON.parse(init.body) });
    return reply();
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}

function request(handler, remoteAddress) {
  return new Promise((resolve, reject) => {
    const req = Readable.from([Buffer.from('{"view":"Austin"}')]);
    Object.assign(req, {
      method: 'POST',
      url: '/',
      headers: { host: 'localhost:4173', 'content-type': 'application/json' },
      socket: { remoteAddress },
    });
    const res = {
      statusCode: 200,
      setHeader() {},
      end(body = '') {
        resolve({ status: this.statusCode, body: JSON.parse(String(body)) });
      },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

function keys(t, { openai, gemini, provider, model } = {}) {
  env(t, 'OPENAI_API_KEY', openai);
  env(t, 'GEMINI_API_KEY', gemini);
  env(t, 'GEV_HUD_SUMMARY_PROVIDER', provider);
  env(t, 'GEMINI_HUD_SUMMARY_MODEL', model);
  env(t, 'OPENAI_HUD_SUMMARY_MODEL', undefined);
}

test('OpenAI stays first, Gemini answers only when it holds the only key', () => {
  assert.equal(resolveHudSummaryProvider({}), null);
  assert.equal(
    resolveHudSummaryProvider({ OPENAI_API_KEY: '  ', GEMINI_API_KEY: '' }),
    null,
  );
  assert.deepEqual(resolveHudSummaryProvider({ OPENAI_API_KEY: 'o' }), {
    id: 'openai',
    apiKey: 'o',
  });
  assert.deepEqual(resolveHudSummaryProvider({ GEMINI_API_KEY: ' g ' }), {
    id: 'gemini',
    apiKey: 'g',
  });
  assert.equal(
    resolveHudSummaryProvider({ OPENAI_API_KEY: 'o', GEMINI_API_KEY: 'g' }).id,
    'openai',
  );
  for (const provider of ['auto', '', 'anthropic', 'constructor'])
    assert.equal(
      resolveHudSummaryProvider({
        GEV_HUD_SUMMARY_PROVIDER: provider,
        OPENAI_API_KEY: 'o',
        GEMINI_API_KEY: 'g',
      }).id,
      'openai',
      provider,
    );
});

test('naming a provider is binding: its missing key is keyless, not the other account', () => {
  assert.equal(
    resolveHudSummaryProvider({
      GEV_HUD_SUMMARY_PROVIDER: ' Gemini ',
      OPENAI_API_KEY: 'o',
      GEMINI_API_KEY: 'g',
    }).id,
    'gemini',
  );
  assert.equal(
    resolveHudSummaryProvider({
      GEV_HUD_SUMMARY_PROVIDER: 'gemini',
      OPENAI_API_KEY: 'o',
    }),
    null,
  );
  assert.equal(
    resolveHudSummaryProvider({
      GEV_HUD_SUMMARY_PROVIDER: 'openai',
      GEMINI_API_KEY: 'g',
    }),
    null,
  );
});

test('a Gemini-only install gets its HUD summary from one stateless interaction', async (t) => {
  keys(t, { gemini: 'fixture-gemini-secret' });
  const calls = stubFetch(t, () =>
    Response.json({
      id: 'int_1',
      status: 'completed',
      steps: [
        {
          type: 'model_output',
          content: [
            {
              type: 'text',
              text: 'Austin downtown, traffic flowing, nominal.',
            },
          ],
        },
      ],
    }),
  );
  const result = await request(handleHudSummary, '10.0.0.1');
  assert.deepEqual(result, {
    status: 200,
    body: { summary: 'Austin downtown traffic flowing nominal', error: null },
  });
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    'https://generativelanguage.googleapis.com/v1beta/interactions',
  );
  assert.equal(
    calls[0].init.headers['x-goog-api-key'],
    'fixture-gemini-secret',
  );
  assert.equal(calls[0].body.model, GEMINI_HUD_SUMMARY_MODEL_DEFAULT);
  assert.equal(calls[0].body.system_instruction, HUD_SUMMARY_INSTRUCTIONS);
  assert.equal(calls[0].body.input, '{"view":"Austin"}');
  assert.equal(calls[0].body.store, false);
  assert.equal(calls[0].body.generation_config.thinking_level, 'minimal');
});

test('a Gemini failure keeps its status and never relays Google wording', async (t) => {
  keys(t, { gemini: 'g' });
  stubFetch(t, () =>
    Response.json(
      { error: { code: 429, message: 'Quota exceeded for project 12345' } },
      { status: 429 },
    ),
  );
  const result = await request(handleHudSummary, '10.0.0.2');
  assert.deepEqual(result, {
    status: 429,
    body: { summary: null, error: 'Gemini HUD summary request failed' },
  });
});

test('an unusable GEMINI_HUD_SUMMARY_MODEL fails closed before any request', async (t) => {
  keys(t, { gemini: 'g', model: 'gemini?alt=sse' });
  const calls = stubFetch(t, () => Response.json({}));
  const result = await request(handleHudSummary, '10.0.0.3');
  assert.deepEqual(result, {
    status: 502,
    body: { error: 'Gemini HUD summary request failed' },
  });
  assert.equal(calls.length, 0);
});

test('with both keys the existing OpenAI request is what goes out', async (t) => {
  keys(t, { openai: 'o', gemini: 'g' });
  const calls = stubFetch(t, () =>
    Response.json({ output_text: 'Austin skyline clear nominal feeds' }),
  );
  const result = await request(handleHudSummary, '10.0.0.4');
  assert.equal(result.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/responses');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer o');
  assert.deepEqual(calls[0].body, {
    model: 'gpt-5-nano',
    instructions: HUD_SUMMARY_INSTRUCTIONS,
    input: '{"view":"Austin"}',
    reasoning: { effort: 'minimal' },
    max_output_tokens: 100,
  });
});

test('no key for the chosen provider is the keyless response, with no request', async (t) => {
  keys(t, { openai: 'o', provider: 'gemini' });
  const calls = stubFetch(t, () => Response.json({}));
  const result = await request(handleHudSummary, '10.0.0.5');
  assert.equal(result.status, 200);
  assert.equal(result.body.configured, false);
  assert.equal(calls.length, 0);
});

test('the POWER UP panel saves the same variables the HUD summary reads', () => {
  for (const [id, variable] of [
    ['openai', 'OPENAI_API_KEY'],
    ['gemini', 'GEMINI_API_KEY'],
  ]) {
    const entry = KEY_SETUP_KEYS.find((key) => key.id === id);
    assert.deepEqual(entry?.envVars, [variable], id);
    assert.equal(entry.hidden, undefined, `${id} is a visible row`);
    assert.equal(
      resolveHudSummaryProvider({
        [variable]: 'k',
        GEV_HUD_SUMMARY_PROVIDER: id,
      })?.id,
      id,
    );
  }
});
