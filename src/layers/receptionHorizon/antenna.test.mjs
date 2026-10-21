import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LOCAL_RECEIVER_POSITION_URL,
  createReceiverPositionSource,
  resolveAntenna,
} from './antenna.js';

const FEED = {
  band: '1090',
  label: '1090 MHz',
  status: 'located',
  position: { lat: 30.27, lon: -97.74 },
};

test('a position set on the map beats the decoder, which beats browser location', () => {
  const browserLocation = { latitude: 30.1, longitude: -97.6 };
  assert.deepEqual(
    resolveAntenna({
      manual: { lat: 29.5, lon: -98.5 },
      receivers: [FEED],
      browserLocation,
    }),
    { lat: 29.5, lon: -98.5, source: 'manual', feedLabel: null },
  );
  assert.deepEqual(resolveAntenna({ receivers: [FEED], browserLocation }), {
    lat: 30.27,
    lon: -97.74,
    source: 'feed',
    feedLabel: '1090 MHz',
  });
  assert.deepEqual(resolveAntenna({ browserLocation }), {
    lat: 30.1,
    lon: -97.6,
    source: 'browser',
    feedLabel: null,
  });
  assert.equal(resolveAntenna(), null);
});

test('decoders without a location are skipped in favour of one that has it', () => {
  assert.deepEqual(
    resolveAntenna({
      receivers: [
        { label: '978 MHz UAT', status: 'unlocated', position: null },
        { label: '1090 MHz', status: 'unreachable', position: null },
        { ...FEED, label: '1090 MHz #2' },
      ],
    }),
    { lat: 30.27, lon: -97.74, source: 'feed', feedLabel: '1090 MHz #2' },
  );
  assert.equal(
    resolveAntenna({
      receivers: [{ label: 'x', position: { lat: 0, lon: 0 } }],
      browserLocation: { latitude: null, longitude: 4 },
    }),
    null,
  );
});

function response(body, ok = true) {
  return { ok, json: async () => body };
}

async function until(predicate, ms = 1_000) {
  const end = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

test('the position source reads on start and again each interval until stopped', async () => {
  const urls = [];
  const source = createReceiverPositionSource({
    intervalMs: 5,
    now: () => 77,
    fetchImpl: async (url) => {
      urls.push(url);
      return response({ configured: true, receivers: [FEED] });
    },
  });
  const seen = [];
  source.subscribe((state) => seen.push(state));
  source.start();
  await until(() => urls.length >= 3);
  source.stop();
  const settled = urls.length;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(urls.length <= settled + 1, 'no polling after stop');
  assert.ok(urls.every((url) => url === LOCAL_RECEIVER_POSITION_URL));
  const state = source.getState();
  assert.equal(state.configured, true);
  assert.equal(state.polling, false);
  assert.deepEqual(state.receivers, [FEED]);
  assert.equal(state.updatedAt, 77);
  assert.ok(seen.length >= 2);
});

test('a server without feeds stops the loop after one answer', async () => {
  let calls = 0;
  const source = createReceiverPositionSource({
    intervalMs: 1,
    fetchImpl: async () => {
      calls += 1;
      return response({ configured: false, receivers: [] });
    },
  });
  source.start();
  await until(() => source.getState().configured === false);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(calls, 1);
  assert.equal(source.getState().polling, false);
});

test('a failure after a good answer keeps the last positions and retries', async () => {
  let calls = 0;
  const source = createReceiverPositionSource({
    intervalMs: 2,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 2) throw new Error('decoder restarting');
      return response({ configured: true, receivers: [FEED] });
    },
  });
  const errors = [];
  source.subscribe((state) => errors.push(state.error));
  source.start();
  await until(() => calls >= 3);
  source.destroy();
  assert.ok(errors.includes('unavailable'));
  assert.deepEqual(source.getState().receivers, [FEED]);
  assert.equal(source.getState().configured, true);
});

test('a route that never answers is not polled again', async () => {
  let calls = 0;
  const source = createReceiverPositionSource({
    intervalMs: 1,
    fetchImpl: async () => {
      calls += 1;
      return response(null, false);
    },
  });
  source.start();
  await until(() => source.getState().error === 'unavailable');
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(calls, 1);
  assert.equal(source.getState().configured, false);
});

test('stop aborts a request in flight and ignores its late answer', async () => {
  let signal = null;
  let release = null;
  const source = createReceiverPositionSource({
    fetchImpl: (_url, options) => {
      signal = options.signal;
      return new Promise((resolve) => {
        release = () =>
          resolve(response({ configured: true, receivers: [FEED] }));
      });
    },
  });
  source.start();
  await until(() => signal);
  source.stop();
  assert.equal(signal.aborted, true);
  release();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(source.getState().receivers, []);
  assert.equal(source.getState().configured, null);
});
