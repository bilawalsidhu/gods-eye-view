import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NOMINATIM_MIN_INTERVAL_MS,
  OSRM_MIN_INTERVAL_MS,
  UPSTREAM_NOT_ALLOWED,
  createPacer,
  isCapacitorNative,
  isUpstreamRefusal,
  selectSource,
  shouldUseDirect,
} from './sourcePolicy.js';

test('shouldUseDirect is true only for Capacitor with no stored backend', () => {
  assert.equal(
    shouldUseDirect({ capacitor: true, apiBase: '' }),
    true,
    'Capacitor with no backend goes direct',
  );
  assert.equal(
    shouldUseDirect({ capacitor: true, apiBase: 'https://home.lan:4173' }),
    false,
    'configured backend keeps the proxy path',
  );
  assert.equal(
    shouldUseDirect({ capacitor: false, apiBase: '' }),
    false,
    'web stays on the proxy path',
  );
  assert.equal(
    shouldUseDirect({ capacitor: false, apiBase: 'https://home.lan:4173' }),
    false,
    'web with backend stays on the proxy path',
  );
});

test('shouldUseDirect defaults to the live environment (web stays legacy)', () => {
  assert.equal(isCapacitorNative(), false);
  assert.equal(shouldUseDirect(), false);
});

test('isCapacitorNative follows window.Capacitor.isNativePlatform', () => {
  const previous = globalThis.Capacitor;
  try {
    globalThis.Capacitor = { isNativePlatform: () => true };
    assert.equal(isCapacitorNative(), true);
    globalThis.Capacitor = { isNativePlatform: () => false };
    assert.equal(isCapacitorNative(), false);
    globalThis.Capacitor = {};
    assert.equal(isCapacitorNative(), false);
  } finally {
    if (previous === undefined) delete globalThis.Capacitor;
    else globalThis.Capacitor = previous;
  }
});

test('selectSource builds only the chosen factory', () => {
  let directCalls = 0;
  let legacyCalls = 0;
  const direct = selectSource(
    () => {
      directCalls += 1;
      return 'direct';
    },
    () => {
      legacyCalls += 1;
      return 'legacy';
    },
    { capacitor: true, apiBase: '' },
  );
  assert.equal(direct, 'direct');
  assert.equal(directCalls, 1);
  assert.equal(legacyCalls, 0);
  const legacy = selectSource(
    () => {
      directCalls += 1;
      return 'direct';
    },
    () => {
      legacyCalls += 1;
      return 'legacy';
    },
    { capacitor: false, apiBase: '' },
  );
  assert.equal(legacy, 'legacy');
  assert.equal(directCalls, 1);
  assert.equal(legacyCalls, 1);
});

test('selectSource rejects non-factory arguments', () => {
  assert.throws(() => selectSource(null, () => {}), TypeError);
  assert.throws(() => selectSource(() => {}, null), TypeError);
});

test('isUpstreamRefusal recognizes the registry refusal code only', () => {
  assert.equal(
    isUpstreamRefusal(
      Object.assign(new Error('nope'), { code: UPSTREAM_NOT_ALLOWED }),
    ),
    true,
  );
  assert.equal(isUpstreamRefusal(new Error('nope')), false);
  assert.equal(isUpstreamRefusal(null), false);
  assert.equal(isUpstreamRefusal({ code: 'OTHER' }), false);
});

test('createPacer lets the first call through and spaces the next', async () => {
  let nowMs = 1_000;
  const slept = [];
  const pacer = createPacer(1_100, {
    now: () => nowMs,
    sleep: async (ms) => {
      slept.push(ms);
      nowMs += ms;
    },
  });
  await pacer.wait();
  assert.deepEqual(slept, []);
  nowMs += 200;
  await pacer.wait();
  assert.deepEqual(slept, [900]);
});

test('createPacer honors an already-aborted signal without sleeping', async () => {
  let slept = 0;
  const pacer = createPacer(1_100, {
    now: () => 0,
    sleep: async () => {
      slept += 1;
    },
  });
  await pacer.wait();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(pacer.wait({ signal: controller.signal }), (error) => {
    assert.equal(error.name, 'AbortError');
    return true;
  });
  assert.equal(slept, 0);
});

test('upstream pacer intervals match the published courtesy policies', () => {
  assert.equal(NOMINATIM_MIN_INTERVAL_MS, 1_100);
  assert.equal(OSRM_MIN_INTERVAL_MS, 1_000);
});
