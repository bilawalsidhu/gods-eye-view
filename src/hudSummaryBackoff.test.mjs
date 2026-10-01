// T4 (breaker MAJOR on T3): after a 429 from /api/openai/hud-summary the HUD
// marked the summary dirty and asked again on every 15 s tick (and on every
// show()/first settle), burning the per-IP OpenAI budget the voice token
// needs. It must back off for the server's Retry-After, or 60 s without one.
//
// hud.js imports `mgrs` (CommonJS, named exports invisible to Node's ESM
// loader), so the same module hook src/hudAltitudeDatum.test.mjs uses swaps
// it for a stub before the import.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { hudSummaryRetryDelayMs } from './hudSummaryResponse.js';

const MGRS_STUB_URL = 'gev-test-stub:mgrs';
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'mgrs') return { url: MGRS_STUB_URL, shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === MGRS_STUB_URL) {
      return {
        format: 'module',
        shortCircuit: true,
        source:
          'export function forward() { return "10SEG55776339"; }\nexport default { forward };\n',
      };
    }
    return next(url, context);
  },
});

const { IntelHUD } = await import('./hud.js');

function installHud(t, responses) {
  const previous = { document: globalThis.document, window: globalThis.window };
  const element = { textContent: '' };
  globalThis.document = {
    getElementById: (id) => (id === 'hud-summary' ? element : null),
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
  };
  globalThis.window = globalThis;
  const calls = [];
  const summaryService = {
    async summarize(context) {
      calls.push(context);
      return responses.shift() ?? ok();
    },
  };
  const viewer = {
    camera: { moveEnd: { addEventListener() {}, removeEventListener() {} } },
  };
  const hud = new IntelHUD(viewer, { summaryService });
  hud._latestMetrics = { altM: 1000 };
  hud._composeSummary = () => 'DETERMINISTIC LINE';
  let n = 0;
  // A fresh context each time, so only the backoff can suppress a request.
  hud._summaryContext = async () => ({ n: (n += 1) });
  t.after(() => {
    hud.destroy();
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[name];
      else globalThis[name] = value;
    }
  });
  return { hud, calls };
}

const limited = (retryAfter) => ({
  ok: false,
  status: 429,
  headers: new Headers(
    retryAfter === undefined ? {} : { 'retry-after': retryAfter },
  ),
  data: { error: 'Rate limit exceeded' },
});
const ok = () => ({
  ok: true,
  status: 200,
  headers: new Headers(),
  data: { summary: 'Austin downtown traffic flowing normally' },
});

test('T4: hudSummaryRetryDelayMs reads Retry-After seconds, else 60 s', () => {
  assert.equal(hudSummaryRetryDelayMs(429, new Headers({ 'retry-after': '30' })), 30_000);
  assert.equal(hudSummaryRetryDelayMs(429, new Headers()), 60_000);
  assert.equal(hudSummaryRetryDelayMs(429, new Headers({ 'retry-after': 'soon' })), 60_000);
  assert.equal(hudSummaryRetryDelayMs(429, new Headers({ 'retry-after': '0' })), 1_000);
  assert.equal(hudSummaryRetryDelayMs(429, null), 60_000);
  assert.equal(hudSummaryRetryDelayMs(200, new Headers({ 'retry-after': '30' })), 0);
  assert.equal(hudSummaryRetryDelayMs(502, new Headers()), 0);
});

test('T4: after a 429 the HUD waits out Retry-After instead of retrying every tick', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
  const { hud, calls } = installHud(t, [limited('30')]);

  await hud._updateSummary(false, true);
  assert.equal(calls.length, 1);

  // Periodic ticks and forced show()/settle calls inside the window: silent.
  for (let i = 0; i < 3; i += 1) {
    t.mock.timers.tick(9_000);
    await hud._updateSummary(false);
    await hud._updateSummary(false, true);
  }
  assert.equal(calls.length, 1, 'no request inside the Retry-After window');

  t.mock.timers.tick(3_000); // 30 s since the 429
  await hud._updateSummary(false);
  assert.equal(calls.length, 2, 'the summary retries once the window ends');
});

test('T4: a 429 without Retry-After backs off for 60 s', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
  const { hud, calls } = installHud(t, [limited()]);

  await hud._updateSummary(false, true);
  t.mock.timers.tick(59_999);
  await hud._updateSummary(false, true);
  assert.equal(calls.length, 1);
  t.mock.timers.tick(1);
  await hud._updateSummary(false, true);
  assert.equal(calls.length, 2);
});
