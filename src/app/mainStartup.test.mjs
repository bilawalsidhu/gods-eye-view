import { createFakeEngine } from '../globe/testing/fakeEngine.js';
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as choices from './engineChoice.js';

const source = readFileSync(new URL('../main.js', import.meta.url), 'utf8')
  .replace(/^import[\s\S]*?;\n/gm, '')
  .replaceAll('import.meta.env', 'env')
  .replace(/export \{ application \};/, '');
const settle = async () => {
  for (let i = 0; i < 15; i++) await new Promise((r) => setTimeout(r, 0));
};

function boot(
  t,
  { search = '', failures = ['navara'], initialRestorePromise } = {},
) {
  document.body.innerHTML =
    '<div id="loading-screen"><div class="loader-content"><p class="loader-status"></p></div></div>';
  const starts = [];
  const switches = [];
  const toasts = [];
  const toastDurations = [];
  const flushes = [];
  const addresses = [];
  const stored = new Map([[choices.ENGINE_STORAGE_KEY, 'navara']]);
  const location = { search, href: `https://example.test/${search}` };
  const localStorage = {
    getItem: (key) => stored.get(key),
    setItem: (key, value) => stored.set(key, value),
  };
  const lifetime = new AbortController();
  t.after(() => lifetime.abort());
  const deps = {
    ...choices,
    env: {},
    location,
    localStorage,
    history: { replaceState() {} },
    guardCesiumGlobal() {},
    t: (key, values = {}) =>
      key.replace(/\{(\w+)\}/g, (_, name) => values[name] ?? ''),
    describeError: (error) => error.message,
    createSessionDiagnostics: () => ({ count() {} }),
    createRendererCache: () => ({ clear() {} }),
    createLayerSession: () => ({ lifetime }),
    useDisplayStore: () => ({ presentGlobeEngine() {} }),
    applicationPinia() {},
    pageEngineKind: () =>
      choices.resolveEngineKind({
        search: location.search,
        storage: localStorage,
      }),
    createEngineAddress: (options) => {
      addresses.push(options);
      return {
        restore(kind) {
          location.search = `?engine=${kind}`;
        },
      };
    },
    createSceneSwitcher: (options) => {
      switches.push(options);
      return {
        state: () => ({
          kind: options.kind,
          engine: options.kind,
          busy: false,
        }),
        reconcile: async () => {},
        select: async () => {},
      };
    },
    createStandaloneApplication: ({ engineKind }) => {
      const engine = createFakeEngine({ kind: engineKind });
      engine.camera.completeFlight = () => flushes.push('flight');
      const styleManager = {
        initialRestorePromise,
        shareLinkManager: { flush: () => flushes.push('share link') },
        _showToast(text, durationMs) {
          toasts.push(text);
          toastDurations.push(durationMs);
        },
      };
      return {
        async start() {
          starts.push(engineKind);
          if (failures.includes(engineKind)) throw new Error('Engine failed');
        },
        async destroy() {},
        getState: () => ({
          status: failures.includes(engineKind) ? 'failed' : 'ready',
        }),
        getComponents: () => ({
          scene: {
            engine: engine,
          },
          controls: { styleManager },
        }),
      };
    },
    console: { error() {} },
  };
  new Function(...Object.keys(deps), source)(...Object.values(deps));
  return {
    starts,
    switches,
    stored,
    toasts,
    toastDurations,
    flushes,
    addresses,
  };
}

test('a failed stored engine falls back to Cesium and remembers the recovery', async (t) => {
  const f = boot(t);
  await settle();
  assert.deepEqual(f.starts, ['navara', 'cesium']);
  assert.equal(f.stored.get(choices.ENGINE_STORAGE_KEY), 'cesium');
  assert.equal(f.switches[0].kind, 'cesium');
  assert.deepEqual(f.toasts, [
    'Globe engine failed to start. Running Cesium: Engine failed',
  ]);
  assert.deepEqual(f.toastDurations, [6000]);
});

test('a failed explicit first engine offers a usable retry picker', async (t) => {
  const f = boot(t, { search: '?engine=navara' });
  await settle();
  assert.deepEqual(f.starts, ['navara']);
  const retry = document.querySelector('[data-engine="cesium"]');
  assert.ok(retry);
  assert.ok(document.activeElement === retry);
  const status = document.querySelector('.loader-status');
  assert.equal(status.textContent, 'Could not start Navara: Engine failed');
  assert.equal(status.getAttribute('role'), 'alert');
  assert.equal(
    document.getElementById('engine-switch-retry-label').textContent,
    'Choose an engine to try again.',
  );
  retry.click();
  assert.equal(status.getAttribute('role'), null);
  await settle();
  assert.deepEqual(f.starts, ['navara', 'cesium']);
  assert.equal(f.switches[0].kind, 'cesium');
  assert.equal(document.querySelector('.engine-switch-retry'), null);
});

test('a recovered engine switch names the globe that remains running', async (t) => {
  const f = boot(t, { search: '?engine=cesium', failures: [] });
  await settle();
  f.switches[0].onFailure(new Error('Initialization failed'), {
    recovered: true,
    kind: 'cesium',
  });
  await settle();
  assert.deepEqual(f.toasts, [
    'Globe engine failed to start. Running Cesium: Initialization failed',
  ]);
});

test('the startup cover stays until the share-link restore settles', async (t) => {
  // start() has resolved; startApplicationChrome hides the cover once the
  // share restore (initialRestorePromise) settles.
  const f = boot(t, { search: '?engine=cesium', failures: [] });
  await settle();
  assert.deepEqual(f.starts, ['cesium']);
  const loading = document.getElementById('loading-screen');
  assert.equal(loading.classList.contains('hidden'), false);
  f.switches[0].onSettled();
  assert.equal(loading.classList.contains('hidden'), false);
});

test('the fallback notice waits for the restored view', async (t) => {
  let restore;
  const initialRestorePromise = new Promise((resolve) => {
    restore = resolve;
  });
  const f = boot(t, { initialRestorePromise });
  await settle();
  assert.deepEqual(f.starts, ['navara', 'cesium']);
  assert.deepEqual(f.toasts, []);
  restore();
  await settle();
  assert.deepEqual(f.toasts, [
    'Globe engine failed to start. Running Cesium: Engine failed',
  ]);
});

test('a successful retry keeps the failure cover until its view is restored', async (t) => {
  let restore;
  const initialRestorePromise = new Promise((resolve) => {
    restore = resolve;
  });
  boot(t, { search: '?engine=navara', initialRestorePromise });
  await settle();
  document.querySelector('[data-engine="cesium"]').click();
  await settle();
  const loading = document.getElementById('loading-screen');
  assert.equal(loading.classList.contains('hidden'), false);
  restore();
  await settle();
  assert.equal(loading.classList.contains('hidden'), true);
  assert.equal(document.querySelector('.engine-switch-retry'), null);
});

test('a pick made mid-flight lands the flight before the view is written', async (t) => {
  const f = boot(t, { search: '?engine=cesium', failures: [] });
  await settle();
  f.addresses.find((options) => options.flush).flush();
  assert.deepEqual(f.flushes, ['flight', 'share link']);
});
