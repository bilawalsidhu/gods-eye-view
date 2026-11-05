import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ENGINE_ONLY_MODULES,
  initialChunkGuard,
  initialChunkViolations,
} from '../../build/initialChunkGuard.js';

const chunk = (fields) => ({
  type: 'chunk',
  isEntry: false,
  imports: [],
  moduleIds: [],
  ...fields,
});

const bundle = () => ({
  'assets/index-A.js': chunk({
    isEntry: true,
    imports: ['assets/vendor-B.js'],
    moduleIds: ['/repo/src/main.js', '/repo/node_modules/cesium/index.js'],
  }),
  'assets/vendor-B.js': chunk({
    moduleIds: ['/repo/node_modules/satellite.js/dist/index.js'],
  }),
  'assets/navara-engine-C.js': chunk({
    isDynamicEntry: true,
    moduleIds: [
      '/repo/node_modules/three/build/three.module.js',
      '/repo/node_modules/@navaramap/three/dist/index.js',
    ],
  }),
  'assets/style.css': { type: 'asset' },
});

test('lazy chunks may hold three and Navara; initial chunks are clean', () => {
  assert.deepEqual(initialChunkViolations(bundle()), []);
  assert.ok(ENGINE_ONLY_MODULES.test('/x/node_modules/three/src/a.js'));
  assert.ok(
    ENGINE_ONLY_MODULES.test('C:\\x\\node_modules\\@navaramap\\three\\a.js'),
  );
  assert.ok(!ENGINE_ONLY_MODULES.test('/x/node_modules/three-geojson/a.js'));
  assert.ok(!ENGINE_ONLY_MODULES.test('/x/src/layers/threeD.js'));
});

test('three or Navara reached by a static import from the entry is reported', () => {
  const broken = bundle();
  broken['assets/vendor-B.js'].moduleIds.push(
    '/repo/node_modules/three/build/three.core.js',
  );
  broken['assets/index-A.js'].moduleIds.push(
    '/repo/node_modules/@navaramap/three-default-plugin/dist/index.js',
  );
  assert.deepEqual(initialChunkViolations(broken), [
    {
      chunk: 'assets/index-A.js',
      module:
        '/repo/node_modules/@navaramap/three-default-plugin/dist/index.js',
    },
    {
      chunk: 'assets/vendor-B.js',
      module: '/repo/node_modules/three/build/three.core.js',
    },
  ]);
});

test('the plugin fails the build on a violation and passes a clean bundle', () => {
  const plugin = initialChunkGuard({ log: () => {} });
  const errors = [];
  const context = { error: (message) => errors.push(message) };
  plugin.generateBundle.call(context, {}, bundle());
  assert.deepEqual(errors, []);
  const broken = bundle();
  broken['assets/index-A.js'].moduleIds.push('/r/node_modules/three/a.js');
  plugin.generateBundle.call(context, {}, broken);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Navara-only.*index-A\.js.*three/s);
});
