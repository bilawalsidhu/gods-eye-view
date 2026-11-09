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

function boot(t, { search = '', failures = ['navara'] } = {}) {
  document.body.innerHTML =
    '<div id="loading-screen"><div class="loader-content"><p class="loader-status"></p></div></div>';
  const starts = [];
  const switches = [];
  const toasts = [];
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
    createEngineAddress: () => ({
      restore(kind) {
        location.search = `?engine=${kind}`;
      },
    }),
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
    createStandaloneApplication: ({ engineKind }) => ({
      async start() {
        starts.push(engineKind);
        if (failures.includes(engineKind)) throw new Error('Engine failed');
      },
      async destroy() {},
      getState: () => ({
        status: failures.includes(engineKind) ? 'failed' : 'ready',
      }),
      getComponents: () => ({
        scene: { engine: {} },
        controls: { styleManager: { _showToast: (text) => toasts.push(text) } },
      }),
    }),
    console: { error() {} },
  };
  new Function(...Object.keys(deps), source)(...Object.values(deps));
  return { starts, switches, stored, toasts };
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
});

test('a failed explicit first engine offers a usable retry picker', async (t) => {
  const f = boot(t, { search: '?engine=navara' });
  await settle();
  assert.deepEqual(f.starts, ['navara']);
  const retry = document.querySelector('[data-engine="cesium"]');
  assert.ok(retry);
  retry.click();
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
  assert.deepEqual(f.toasts, [
    'Globe engine failed to start. Running Cesium: Initialization failed',
  ]);
});
