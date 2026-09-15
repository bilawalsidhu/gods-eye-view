import test from 'node:test';
import assert from 'node:assert/strict';
import { createWeatherSource } from './source.js';
import { isNoKeyError, liveFrame, NO_KEY } from './model.js';
import { WEATHER_LAYER_SPECS, STATUS_URL } from './policy.js';

const [TIER] = WEATHER_LAYER_SPECS;
const ok = (body) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

test('construction is inert, and the only address is this app itself', async () => {
  createWeatherSource({
    fetchImpl: () => assert.fail('construction fetched data'),
  });

  const calls = [];
  const source = createWeatherSource({
    fetchImpl: (url) => {
      calls.push(String(url));
      return Promise.resolve(ok({ hasKey: true, refreshMs: 900000 }));
    },
  });
  await source.getFrame(TIER);
  assert.deepEqual(calls, [STATUS_URL]);
  // No scheme and no host: the browser is structurally unable to reach the
  // vendor, which is the point — the credential sits in the upstream URL path.
  assert.ok(calls[0].startsWith('/api/'));
});

test('the server owns the refresh cadence', async () => {
  const source = createWeatherSource({
    fetchImpl: async () => ok({ hasKey: true, refreshMs: 300000 }),
  });
  const frame = await source.getFrame(TIER);
  assert.equal(frame.refreshMs, 300000);
  // An absent or nonsensical cadence must not become a zero-delay poll loop
  // against a source that bills per tile.
  for (const refreshMs of [undefined, 0, -1, 'soon', null]) {
    const loose = createWeatherSource({
      fetchImpl: async () => ok({ hasKey: true, refreshMs }),
    });
    assert.equal((await loose.getFrame(TIER)).refreshMs, null);
  }
});

test('no key is a distinct, nameable failure', async () => {
  const source = createWeatherSource({
    fetchImpl: async () => ok({ hasKey: false, refreshMs: 3600000 }),
  });
  await assert.rejects(source.getFrame(TIER), (error) => {
    assert.equal(error.code, NO_KEY);
    assert.ok(isNoKeyError(error));
    assert.match(error.message, /ADD XWEATHER KEY/);
    return true;
  });
});

test('a malformed or failing status is unhealthy, never a missing key', async () => {
  // Reading an absent field as `false` would tell someone whose key is fine to
  // go and add one.
  for (const body of [{}, { hasKey: 'yes' }, { hasKey: null }, []]) {
    const source = createWeatherSource({
      fetchImpl: async () => ok(body),
    });
    await assert.rejects(source.getFrame(TIER), (error) => {
      assert.match(error.message, /Malformed weather status/);
      assert.ok(!isNoKeyError(error));
      return true;
    });
  }
  const failing = createWeatherSource({
    fetchImpl: async () => new Response('nope', { status: 503 }),
  });
  await assert.rejects(failing.getFrame(TIER), (error) => {
    assert.match(error.message, /HTTP 503/);
    assert.ok(!isNoKeyError(error));
    return true;
  });
});

test('cancellation is honored after the body resolves', async () => {
  const controller = new AbortController();
  const source = createWeatherSource({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async json() {
        controller.abort();
        return { hasKey: true, refreshMs: 3600000 };
      },
    }),
  });
  await assert.rejects(
    source.getFrame(TIER, { signal: controller.signal }),
    (error) => error?.name === 'AbortError',
  );
});

test('a live frame changes key each poll so the imagery actually refreshes', () => {
  // The tile URL never changes, so a new frame key is the entire mechanism by
  // which Cesium is made to re-request.
  const first = liveFrame(1000);
  const second = liveFrame(2000);
  assert.notEqual(first.key, second.key);
  assert.equal(first.validTime, null, 'an observation claims no forecast step');
  assert.equal(first.referenceTime, null, 'and no model run');
});
