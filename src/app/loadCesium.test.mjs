import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { createCesiumLoader } from './loadCesium.js';

function fixture(globals = {}, { script = true } = {}) {
  const elements = [];
  const document = {
    createElement: (tag) => ({
      tag,
      remove() {
        elements.splice(elements.indexOf(this), 1);
      },
    }),
    head: { append: (element) => elements.push(element) },
  };
  return {
    elements,
    globals,
    loader: createCesiumLoader({
      document,
      globals,
      base: '/app/cesium/',
      script,
    }),
  };
}

test('a Cesium globe loads the SDK and its styles together, once, on demand', async () => {
  const { elements, globals, loader } = fixture();
  assert.equal(elements.length, 0);
  const first = loader.viewer();
  assert.equal(globals.CESIUM_BASE_URL, '/app/cesium/');
  assert.deepEqual(
    elements.map((e) => e.href ?? e.src),
    ['/app/cesium/Widgets/widgets.css', '/app/cesium/Cesium.js'],
  );
  const again = loader.viewer();
  assert.equal(elements.length, 2, 'a second request shares the first');
  elements.forEach((e) => e.onload());
  await first;
  await again;
  await loader.viewer();
  assert.equal(elements.length, 2);
});

test('a feature on Navara loads the SDK alone, and a later globe adds only the styles', async () => {
  const { elements, loader } = fixture();
  const sdk = loader.sdk();
  assert.deepEqual(
    elements.map((e) => e.src ?? e.href),
    ['/app/cesium/Cesium.js'],
  );
  elements[0].onload();
  await sdk;
  const viewer = loader.viewer();
  assert.deepEqual(
    elements.map((e) => e.src ?? e.href),
    ['/app/cesium/Cesium.js', '/app/cesium/Widgets/widgets.css'],
  );
  elements[1].onload();
  await viewer;
});

test('the SDK is not loaded where the page already has it or imports its module', async () => {
  const present = fixture({ Cesium: {} });
  await present.loader.sdk();
  assert.equal(present.elements.length, 0);
  const getter = {};
  Object.defineProperty(getter, 'Cesium', { get: () => ({}) });
  const trapped = fixture(getter);
  trapped.loader.sdk();
  assert.equal(trapped.elements.length, 1, 'a getter is not read as the SDK');
  const dev = fixture({}, { script: false });
  await dev.loader.sdk();
  assert.equal(dev.elements.length, 0);
});

test('a page that ran Cesium.js from its markup loads no styles either', async () => {
  // The panel build's HTML lists Cesium.js and widgets.css; the panel host
  // answers only those, not a stylesheet added later.
  const { elements, loader } = fixture({ Cesium: {} });
  await loader.viewer();
  assert.equal(elements.length, 0);
});

test('a failed Cesium asset load can be retried and preserves the configured base', async () => {
  const { elements, globals, loader } = fixture({
    CESIUM_BASE_URL: '/custom/',
  });
  const failed = loader.viewer();
  elements[1].onerror();
  await assert.rejects(failed, /Could not load/);
  assert.deepEqual(
    elements.map((e) => e.href),
    ['/custom/Widgets/widgets.css'],
    'the failed script is removed',
  );
  const retried = loader.viewer();
  assert.equal(globals.CESIUM_BASE_URL, '/custom/');
  assert.equal(elements[1].src, '/custom/Cesium.js');
  elements.forEach((e) => e.onload());
  await retried;
});

test('the standalone startup graph can be imported before the Cesium SDK exists', () => {
  // Empty SDK exports make any boot-time native constructor or enum read fail.
  // mgrs is CJS in Node; its browser named export is unrelated to this gate.
  const script = `
    import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier, context, next) {
      const code = specifier === 'cesium'
        ? 'export const Axis=undefined,ScreenSpaceEventType=undefined,BoundingSphere=undefined,Color=undefined,PostProcessStage=undefined;'
        : specifier === 'mgrs' ? 'export function forward() {}' : null;
      return code ? { url: 'data:text/javascript,' + encodeURIComponent(code), shortCircuit: true } : next(specifier, context);
    }});
    await import('./src/standalone/application.js');
    const { loadLayerRenderers } = await import('./src/app/layers/renderers.js');
    await loadLayerRenderers('navara');
    const { createStandaloneCatalog } = await import('./src/standalone/catalog.js');
    const lifetime = new AbortController();
    const catalog = createStandaloneCatalog({ engineKind: 'navara', signal: lifetime.signal });
    if (catalog.layers.length !== 40) throw new Error('Incomplete cold Navara catalog');
    lifetime.abort();
  `;
  const result = spawnSync(
    process.execPath,
    ['--import=./build/registerVue.js', '--input-type=module', '-e', script],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
});

test('a read before the SDK loads is reported and starts the load; the SDK then reads plainly', async () => {
  const { guardCesiumGlobal } = await import('./loadCesium.js');
  const globals = {};
  const reports = [];
  let loads = 0;
  guardCesiumGlobal({
    globals,
    script: true,
    report: (stack) => reports.push(stack),
    load: async () => loads++,
  });
  assert.equal(globals.Cesium, undefined);
  assert.equal(reports.length, 1);
  assert.equal(loads, 1);
  const sdk = { Cartesian3: {} };
  globals.Cesium = sdk;
  assert.equal(globals.Cesium, sdk);
  assert.equal(Object.getOwnPropertyDescriptor(globals, 'Cesium').value, sdk);
  assert.equal(reports.length, 1);
  const trapped = { Cesium: 'host' };
  guardCesiumGlobal({ globals: trapped, script: true });
  assert.equal(trapped.Cesium, 'host', 'an existing global is left alone');
  const dev = {};
  guardCesiumGlobal({ globals: dev, script: false });
  assert.equal(Object.getOwnPropertyDescriptor(dev, 'Cesium'), undefined);
});
