import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// HUD's existing Node tests stub this CommonJS named export before importing
// Cesium, which must see no partial browser globals during module evaluation.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'mgrs')
      return { url: 'hud-timing:mgrs', shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === 'hud-timing:mgrs')
      return {
        format: 'module',
        shortCircuit: true,
        source:
          'export function forward() { return "test"; } export default { forward };',
      };
    return next(url, context);
  },
});
const { IntelHUD } = await import('./hud.js');
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

function fixture(t, summaryPolicy = {}, { ignoreAbort = false } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  t.mock.method(IntelHUD.prototype, '_buildDOM', () => {});
  t.mock.method(IntelHUD.prototype, '_startTimers', () => {});
  const originalWindow = globalThis.window;
  globalThis.window = {
    setTimeout: (...args) => setTimeout(...args),
    clearTimeout: (...args) => clearTimeout(...args),
  };
  t.after(() => {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  });
  const requests = [];
  const painted = [];
  const hud = new IntelHUD(
    {
      camera: { moveEnd: { addEventListener() {}, removeEventListener() {} } },
    },
    {
      summaryPolicy,
      summaryService: {
        summarize(_context, { signal }) {
          return new Promise((resolve, reject) => {
            requests.push({ signal, resolve, reject });
            if (!ignoreAbort)
              signal.addEventListener(
                'abort',
                () => reject(new DOMException('Cancelled', 'AbortError')),
                { once: true },
              );
          });
        },
      },
    },
  );
  hud._latestMetrics = {};
  hud._summaryContext = async () => ({ placeLabels: ['London'] });
  hud._composeSummary = () => 'London telemetry';
  hud._setSummaryText = (value) => painted.push(value);
  t.after(() => hud.destroy());
  const complete = (index = 0) =>
    requests[index].resolve({
      ok: true,
      status: 200,
      data: { summary: 'London aircraft observed with uncertainty' },
    });
  return { hud, requests, painted, complete };
}

test('local HUD policy keeps telemetry visible and accepts six-second inference without overlapping refreshes', async (t) => {
  const f = fixture(t, { requestTimeoutMs: 65_000 });
  const first = f.hud._updateSummary(false, true);
  await flush();
  assert.deepEqual(f.painted, ['London telemetry']);
  t.mock.timers.tick(6000);
  assert.equal(f.requests[0].signal.aborted, false);
  await f.hud._updateSummary(false, true);
  assert.equal(
    f.requests.length,
    1,
    'a forced/periodic refresh cannot overlap pending inference',
  );
  f.complete();
  await first;
  assert.equal(f.painted.at(-1), 'London aircraft observed with uncertainty');
});

test('default HUD keeps its five-second budget and a timeout remains retryable', async (t) => {
  const f = fixture(t);
  const first = f.hud._updateSummary(false, true);
  await flush();
  t.mock.timers.tick(5000);
  await first;
  assert.equal(f.requests[0].signal.aborted, true);
  assert.equal(f.hud._summaryDirty, true);
  assert.equal(f.painted.at(-1), 'London telemetry');
  const retry = f.hud._updateSummary();
  await flush();
  assert.equal(f.requests.length, 2);
  f.complete(1);
  await retry;
});

test('local HUD still cancels at its deadline; policy cannot exceed ninety seconds', async (t) => {
  const f = fixture(t, { requestTimeoutMs: 300_000 });
  const pending = f.hud._updateSummary(false, true);
  await flush();
  t.mock.timers.tick(89_999);
  assert.equal(f.requests[0].signal.aborted, false);
  t.mock.timers.tick(1);
  await pending;
  assert.equal(f.requests[0].signal.aborted, true);
  assert.equal(f.hud._summaryRequest, null);
});

test('a late failed summary cannot restore the prior view over current telemetry', async (t) => {
  const f = fixture(t, { requestTimeoutMs: 65_000 });
  const pending = f.hud._updateSummary(false, true);
  await flush();
  f.hud._markSummaryDirty();
  f.hud._setSummaryText('Paris telemetry');
  f.requests[0].reject(new Error('Old view inference failed'));
  await pending;
  assert.deepEqual(f.painted, ['London telemetry', 'Paris telemetry']);
  assert.equal(f.hud._summaryDirty, true);
});

test('destroy aborts local inference and discards a provider that resolves after cancellation', async (t) => {
  const f = fixture(t, { requestTimeoutMs: 65_000 }, { ignoreAbort: true });
  const pending = f.hud._updateSummary(false, true);
  await flush();
  f.hud.destroy();
  assert.equal(f.requests[0].signal.aborted, true);
  f.complete();
  await pending;
  assert.deepEqual(f.painted, ['London telemetry']);
});

for (const outcome of [
  'success',
  '429',
  '503',
  'timeout',
  'transport failure',
]) {
  test(`HUD minimum interval prevents repeated requests after ${outcome}, including forced refreshes`, async (t) => {
    const f = fixture(t, { minIntervalMs: 300_000 });
    t.mock.method(console, 'warn', () => {});
    const startedAt = Date.now();
    const first = f.hud._updateSummary(false, true);
    await flush();
    assert.equal(f.requests.length, 1);
    if (outcome === 'success') f.complete();
    else if (outcome === 'timeout') t.mock.timers.tick(5000);
    else if (outcome === 'transport failure')
      f.requests[0].reject(new Error('Fixture transport failure'));
    else
      f.requests[0].resolve({
        ok: false,
        status: Number(outcome),
        data: { error: 'Fixture provider unavailable' },
      });
    await first;

    f.hud._composeSummary = () => 'Paris telemetry';
    f.hud._markSummaryDirty();
    await f.hud._updateSummary(false, true);
    assert.equal(
      f.requests.length,
      1,
      'force cannot bypass the attempt interval',
    );
    assert.equal(f.painted.at(-1), 'Paris telemetry');
    assert.equal(f.hud._summaryDirty, true);
    t.mock.timers.tick(299_999 - (Date.now() - startedAt));
    await f.hud._updateSummary(false, true);
    assert.equal(f.requests.length, 1);
    t.mock.timers.tick(1);
    const next = f.hud._updateSummary(false, true);
    await flush();
    assert.equal(f.requests.length, 2);
    f.complete(1);
    await next;
  });
}

test('HUD interval is checked after asynchronous context creation', async (t) => {
  const f = fixture(t, { minIntervalMs: 300_000 });
  let releaseContext;
  const first = f.hud._updateSummary(false, true);
  await flush();
  f.hud._summaryContext = () =>
    new Promise((resolve) => {
      releaseContext = resolve;
    });
  const overlapping = f.hud._updateSummary(false, true);
  f.complete();
  await first;
  releaseContext({ placeLabels: ['Paris'] });
  await overlapping;
  assert.equal(
    f.requests.length,
    1,
    'an older pending context cannot bypass the interval',
  );
});
