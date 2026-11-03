import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { createCesiumLoader } from './loadCesium.js';

function fixture(globals = {}) {
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
    load: createCesiumLoader({
      document,
      globals,
      base: '/app/cesium/',
      script: true,
    }),
  };
}

test('Cesium assets load together only on demand and are shared across starts', async () => {
  const { elements, globals, load } = fixture();
  assert.equal(elements.length, 0);
  const first = load();
  assert.equal(load(), first);
  assert.equal(globals.CESIUM_BASE_URL, '/app/cesium/');
  assert.deepEqual(
    elements.map((e) => e.href ?? e.src),
    ['/app/cesium/Widgets/widgets.css', '/app/cesium/Cesium.js'],
  );
  elements.forEach((e) => e.onload());
  await first;
  await load();
  assert.equal(elements.length, 2);
});

test('a failed Cesium asset load can be retried and preserves the configured base', async () => {
  const { elements, globals, load } = fixture({ CESIUM_BASE_URL: '/custom/' });
  const failed = load();
  elements[1].onerror();
  await assert.rejects(failed, /Could not load/);
  assert.equal(elements.length, 0);
  const retried = load();
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
    const { registerNavaraLayerRenderers } = await import('./src/app/navaraMode.js');
    await registerNavaraLayerRenderers();
    const { createStandaloneCatalog } = await import('./src/standalone/catalog.js');
    const lifetime = new AbortController();
    const catalog = createStandaloneCatalog({ engineKind: 'navara', signal: lifetime.signal });
    if (catalog.layers.length !== 33) throw new Error('Incomplete cold Navara catalog');
    lifetime.abort();
  `;
  const result = spawnSync(
    process.execPath,
    ['--import=./build/registerVue.js', '--input-type=module', '-e', script],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
});
