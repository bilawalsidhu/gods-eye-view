import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  TERRAIN_RETRY_ATTEMPTS,
  TERRAIN_RETRY_BASE_MS,
  TERRAIN_RETRY_MAX_MS,
  TERRAIN_RETRY_SPREAD_MS,
  createTerrainRetryPolicy,
  parseRetryAfter,
} from './terrainRetry.js';
import {
  KEYLESS_TERRAIN_URL,
  createKeylessTerrainResource,
} from './terrain.js';

const START = 1_700_000_000_000;

/** Deterministic clock: `wait` records each sleep and advances time by it. */
const fakeClock = () => {
  let now = START;
  const waits = [];
  return {
    now: () => now,
    wait: async (ms) => {
      waits.push(ms);
      now += ms;
    },
    waits,
    elapsed: () => now - START,
  };
};

const throttled = (headers) => ({ statusCode: 429, responseHeaders: headers });

test('parseRetryAfter reads delay-seconds and HTTP dates, ignores garbage', () => {
  assert.equal(parseRetryAfter(undefined, START), null);
  assert.equal(parseRetryAfter('', START), null);
  assert.equal(parseRetryAfter('soon', START), null);
  assert.equal(parseRetryAfter('2', START), 2000);
  assert.equal(parseRetryAfter(' 7 ', START), 7000);
  assert.equal(
    parseRetryAfter(new Date(START + 4000).toUTCString(), START),
    4000,
  );
  assert.equal(parseRetryAfter(new Date(START - 4000).toUTCString(), START), 0);
});

test('only throttled and gateway replies retry; everything else fails fast', async () => {
  const clock = fakeClock();
  const policy = createTerrainRetryPolicy({ ...clock, random: () => 0 });
  for (const statusCode of [400, 403, 404, 500, undefined]) {
    assert.equal(await policy.retryCallback({}, { statusCode }), false);
  }
  assert.equal(await policy.retryCallback({}, undefined), false);
  assert.deepEqual(clock.waits, []);
  for (const statusCode of [429, 502, 503, 504]) {
    assert.equal(await policy.retryCallback({}, { statusCode }), true);
  }
  assert.equal(policy.retryAttempts, TERRAIN_RETRY_ATTEMPTS);
});

test('a throttled tile waits out an escalating backoff before Cesium re-requests it', async () => {
  const clock = fakeClock();
  const policy = createTerrainRetryPolicy({ ...clock, random: () => 0 });
  const tile = {};
  const expected = [
    TERRAIN_RETRY_BASE_MS,
    TERRAIN_RETRY_BASE_MS * 2,
    TERRAIN_RETRY_BASE_MS * 4,
  ];
  for (const delay of expected) {
    const before = clock.elapsed();
    assert.equal(await policy.retryCallback(tile, throttled()), true);
    assert.equal(clock.elapsed() - before, delay);
  }
  // Another tile starts its own backoff ladder from the first rung.
  const before = clock.elapsed();
  assert.equal(await policy.retryCallback({}, throttled()), true);
  assert.equal(clock.elapsed() - before, TERRAIN_RETRY_BASE_MS);
});

test('Retry-After extends the wait, case-insensitively and capped', async () => {
  const clock = fakeClock();
  const policy = createTerrainRetryPolicy({ ...clock, random: () => 0 });
  let before = clock.elapsed();
  await policy.retryCallback({}, throttled({ 'Retry-After': '3' }));
  assert.equal(clock.elapsed() - before, 3000);
  before = clock.elapsed();
  await policy.retryCallback(
    {},
    throttled({ 'retry-after': new Date(clock.now() + 5000).toUTCString() }),
  );
  assert.equal(clock.elapsed() - before, 5000);
  before = clock.elapsed();
  await policy.retryCallback({}, throttled({ 'retry-after': '9999' }));
  assert.equal(clock.elapsed() - before, TERRAIN_RETRY_MAX_MS);
  // A Retry-After shorter than the backoff never shortens the wait.
  before = clock.elapsed();
  await policy.retryCallback({}, throttled({ 'retry-after': '0' }));
  assert.equal(clock.elapsed() - before, TERRAIN_RETRY_BASE_MS);
});

test('a burst shares one cooldown and trickles out with jitter instead of re-bursting', async () => {
  let now = START;
  /** @type {Array<{at: number, resolve: () => void}>} */
  const sleepers = [];
  const wait = (ms) =>
    new Promise((resolve) => sleepers.push({ at: now + ms, resolve }));
  const release = async () => {
    // Advance to the earliest sleeper, wake everything due, let it settle.
    sleepers.sort((a, b) => a.at - b.at);
    now = Math.max(now, sleepers[0].at);
    while (sleepers.length && sleepers[0].at <= now) sleepers.shift().resolve();
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
  };
  const jitters = [0, 0.5, 1 - Number.EPSILON];
  let draw = 0;
  const events = [];
  const policy = createTerrainRetryPolicy({
    now: () => now,
    wait,
    random: () => jitters[draw++ % jitters.length],
    onThrottle: (info) => events.push(info),
  });

  const releasedAt = [];
  const pending = Array.from({ length: 30 }, () =>
    policy.retryCallback({}, throttled()).then((ok) => {
      releasedAt.push(now);
      return ok;
    }),
  );
  await Promise.resolve();
  // One window opened at the burst, not thirty stacked ones.
  assert.equal(policy.cooldownUntil(), START + TERRAIN_RETRY_BASE_MS);
  assert.deepEqual(
    events.map((event) => event.inWindow),
    Array.from({ length: 30 }, (_, i) => i + 1),
  );
  assert.ok(events.every((event) => event.delayMs === TERRAIN_RETRY_BASE_MS));

  // A straggler throttled mid-window pushes the window out for everyone.
  now = START + 400;
  const straggler = policy.retryCallback({}, throttled());
  await Promise.resolve();
  assert.equal(policy.cooldownUntil(), START + 400 + TERRAIN_RETRY_BASE_MS);

  while (sleepers.length) await release();
  assert.ok((await Promise.all([...pending, straggler])).every(Boolean));
  const earliest = Math.min(...releasedAt);
  const latest = Math.max(...releasedAt);
  assert.ok(
    earliest >= START + 400 + TERRAIN_RETRY_BASE_MS,
    'nothing retried inside the window',
  );
  assert.ok(
    latest <= START + 400 + TERRAIN_RETRY_BASE_MS + TERRAIN_RETRY_SPREAD_MS,
    'retries spread across the jitter window',
  );
  assert.ok(
    latest - earliest >= TERRAIN_RETRY_SPREAD_MS / 2,
    'retries do not re-burst',
  );
});

test('Cesium copies the policy onto every derived tile resource and honours its verdicts', async () => {
  const clock = fakeClock();
  const calls = [];
  const policy = createTerrainRetryPolicy({
    ...clock,
    random: () => 0,
    onThrottle: (info) => calls.push(info.attempt),
  });
  const resource = createKeylessTerrainResource(policy);
  assert.equal(resource.url, KEYLESS_TERRAIN_URL);
  resource.appendForwardSlash(); // what CesiumTerrainProvider.fromUrl does
  const tile = resource.getDerivedResource({ url: '4/7/13.terrain' });
  assert.equal(tile.url, `${KEYLESS_TERRAIN_URL}/4/7/13.terrain`);
  assert.equal(tile.retryCallback, policy.retryCallback);
  assert.equal(tile.retryAttempts, TERRAIN_RETRY_ATTEMPTS);

  // Cesium charges every consulted failure against the budget, declined ones
  // included, so the 404 probe uses its own tile.
  const missing = resource.getDerivedResource({ url: '4/7/14.terrain' });
  assert.equal(
    await missing.retryOnError(new Cesium.RequestErrorEvent(404)),
    false,
  );
  assert.deepEqual(clock.waits, []);
  const headers = 'content-type: text/html\r\nretry-after: 2\r\n';
  for (let attempt = 1; attempt <= TERRAIN_RETRY_ATTEMPTS; attempt += 1) {
    const before = clock.elapsed();
    assert.equal(
      await tile.retryOnError(
        new Cesium.RequestErrorEvent(429, undefined, headers),
      ),
      true,
    );
    assert.equal(
      clock.elapsed() - before,
      Math.max(2000, TERRAIN_RETRY_BASE_MS * 2 ** (attempt - 1)),
    );
  }
  // The attempt budget is Cesium's: a fourth throttle fails without consulting the policy.
  assert.equal(
    await tile.retryOnError(new Cesium.RequestErrorEvent(429)),
    false,
  );
  assert.deepEqual(calls, [1, 2, 3]);
  // Budgets are per tile: a sibling starts fresh.
  const sibling = resource.getDerivedResource({ url: '4/8/13.terrain' });
  assert.equal(
    await sibling.retryOnError(new Cesium.RequestErrorEvent(503)),
    true,
  );
});

test('the default resource carries the policy without any injected clock', () => {
  const resource = createKeylessTerrainResource();
  assert.equal(resource.retryAttempts, TERRAIN_RETRY_ATTEMPTS);
  assert.equal(typeof resource.retryCallback, 'function');
});

/** A sleeper the test resolves by hand, so later replies can land mid-wait. */
const manualClock = () => {
  const clock = { now: START, sleeps: [] };
  clock.wait = (ms) =>
    new Promise((resolve) => clock.sleeps.push({ ms, resolve }));
  return clock;
};
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('one attempt never waits past the maximum backoff plus spread', async () => {
  const clock = manualClock();
  const policy = createTerrainRetryPolicy({
    now: () => clock.now,
    wait: clock.wait,
    random: () => 0,
  });
  let verdict;
  policy.retryCallback({}, throttled()).then((value) => (verdict = value));
  let waited = 0;
  for (let i = 0; i < 10 && verdict === undefined; i += 1) {
    const sleep = clock.sleeps.at(-1);
    clock.now += sleep.ms;
    waited += sleep.ms;
    // A fresh 15 s throttle lands while this tile sleeps and pushes the
    // shared window out again; its own sleep is never resolved here.
    policy.retryCallback({}, throttled({ 'Retry-After': '15' }));
    sleep.resolve();
    await flush();
  }
  assert.equal(verdict, true);
  assert.equal(waited, TERRAIN_RETRY_MAX_MS + TERRAIN_RETRY_SPREAD_MS);
  assert.ok(policy.cooldownUntil() - START > waited, 'window moved further');
});

test('a tile cancelled before or during its wait is not re-requested', async () => {
  assert.equal(Cesium.RequestState.CANCELLED, 4);
  const clock = manualClock();
  const policy = createTerrainRetryPolicy({
    now: () => clock.now,
    wait: clock.wait,
    random: () => 0,
  });
  const gone = { request: { state: Cesium.RequestState.CANCELLED } };
  assert.equal(await policy.retryCallback(gone, throttled()), false);
  assert.equal(clock.sleeps.length, 0, 'no wait for a cancelled tile');

  const request = new Cesium.Request({ url: KEYLESS_TERRAIN_URL });
  const pending = policy.retryCallback({ request }, throttled());
  request.cancel();
  clock.now += clock.sleeps.at(-1).ms;
  clock.sleeps.at(-1).resolve();
  assert.equal(await pending, false);
});
