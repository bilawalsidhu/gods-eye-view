import test from 'node:test';
import assert from 'node:assert/strict';
import {
  KEYED_HTTP_REFUSED,
  assertKeyedHttps,
  createCreditGovernor,
  createDailyBudget,
  openskyPollIntervalMs,
} from './governors.js';

/** Preferences-shaped in-memory store. */
function memoryStore(values = new Map()) {
  return {
    values,
    get: async ({ key }) => ({
      value: values.has(key) ? values.get(key) : null,
    }),
    set: async ({ key, value }) => {
      values.set(key, String(value));
    },
    remove: async ({ key }) => {
      values.delete(key);
    },
  };
}

// ---------------------------------------------------------------------------
// keyed-transport guard
// ---------------------------------------------------------------------------

test('assertKeyedHttps allows https and wss only', () => {
  assert.doesNotThrow(() => assertKeyedHttps('https://api.example.com/x'));
  assert.doesNotThrow(() => assertKeyedHttps('wss://stream.example.com/v0'));
});

test('assertKeyedHttps refuses plain http and ws without leaking the query', () => {
  for (const url of [
    'http://api.example.com/x?key=should-never-appear',
    'ws://stream.example.com/v0',
  ]) {
    assert.throws(() => assertKeyedHttps(url), (error) => {
      assert.equal(error.code, KEYED_HTTP_REFUSED);
      assert.ok(!String(error.message).includes('should-never-appear'));
      assert.match(String(error.message), /stream\.example\.com|api\.example\.com/);
      return true;
    });
  }
  assert.throws(() => assertKeyedHttps('not a url'), (error) => {
    assert.equal(error.code, KEYED_HTTP_REFUSED);
    return true;
  });
});

// ---------------------------------------------------------------------------
// OpenSky credit governor
// ---------------------------------------------------------------------------

test('openSky poll tiers stretch as the credit budget thins', () => {
  assert.equal(openskyPollIntervalMs(2500), 30_000);
  assert.equal(openskyPollIntervalMs(1201), 30_000);
  assert.equal(openskyPollIntervalMs(1200), 90_000);
  assert.equal(openskyPollIntervalMs(401), 90_000);
  assert.equal(openskyPollIntervalMs(400), 300_000);
  assert.equal(openskyPollIntervalMs(0), 300_000);
  assert.equal(openskyPollIntervalMs(NaN), 30_000);
  assert.equal(openskyPollIntervalMs(null), 30_000);
});

test('credit exhaustion stretches polling (persisted across instances)', async () => {
  let nowMs = 1_790_000_000_000;
  const storage = memoryStore();
  const governor = createCreditGovernor({ storage, clock: () => nowMs });
  await governor.notePoll();
  await governor.reportRemaining(2000);
  const healthyDelay = await governor.pollDelayMs();
  assert.ok(healthyDelay > 29_000 && healthyDelay <= 30_000, `expected ~30s, got ${healthyDelay}`);
  const fresh = createCreditGovernor({ storage, clock: () => nowMs });
  assert.equal((await fresh.snapshot()).remaining, 2000);
  await fresh.reportRemaining(50);
  nowMs += 30_000;
  await fresh.notePoll();
  const delay = await fresh.pollDelayMs();
  assert.ok(delay >= 299_000 && delay <= 300_000, `expected ~300s, got ${delay}`);
});

test('a fresh governor polls immediately and honors rate-limit cooldowns', async () => {
  let nowMs = 1_790_000_000_000;
  const governor = createCreditGovernor({ clock: () => nowMs });
  assert.equal(await governor.pollDelayMs(), 0);
  await governor.notePoll();
  await governor.reportRateLimited(120_000);
  const delay = await governor.pollDelayMs();
  assert.ok(delay > 119_000 && delay <= 120_000, `expected ~120s, got ${delay}`);
  nowMs += 121_000;
  assert.equal(await governor.pollDelayMs(), 0);
});

// ---------------------------------------------------------------------------
// TomTom daily budget
// ---------------------------------------------------------------------------

test('daily budget spends down from the limit and then refuses', async () => {
  const budget = createDailyBudget({ clock: () => Date.parse('2026-10-12T10:00:00.000Z'), limit: 3 });
  assert.equal(await budget.count(), 0);
  assert.equal(await budget.remaining(), 3);
  assert.equal(await budget.trySpend(), true);
  assert.equal(await budget.trySpend(), true);
  assert.equal(await budget.trySpend(), true);
  assert.equal(await budget.trySpend(), false);
  assert.equal(await budget.count(), 3);
  assert.equal(await budget.remaining(), 0);
});

test('day rollover resets the persisted budget (injected clock)', async () => {
  let nowMs = Date.parse('2026-10-12T23:59:00.000Z');
  const storage = memoryStore();
  const budget = createDailyBudget({ storage, clock: () => nowMs, limit: 6000 });
  assert.equal(await budget.trySpend(), true);
  assert.equal(await budget.trySpend(), true);
  assert.equal(await budget.count(), 2);
  nowMs = Date.parse('2026-10-13T00:01:00.000Z');
  assert.equal(await budget.count(), 0);
  assert.equal(await budget.remaining(), 6000);
  assert.equal(await budget.trySpend(), true);
  const reloaded = createDailyBudget({ storage, clock: () => nowMs, limit: 6000 });
  assert.equal(await reloaded.count(), 1);
});

test('daily budget defaults to the TomTom monthly-allowance-safe limit', async () => {
  const budget = createDailyBudget({ clock: () => Date.now() });
  assert.equal((await budget.state()).limit, 6000);
});
