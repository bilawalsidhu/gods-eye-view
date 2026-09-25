import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { cesiumPlugin, resolveAssetPath } from '../../build/cesium.js';

const root = path.resolve('node_modules/cesium/Build/CesiumUnminified');

test('asset resolution stays inside the Cesium build directory', () => {
  assert.equal(
    resolveAssetPath(root, '/Widgets/widgets.css'),
    path.join(root, 'Widgets/widgets.css'),
  );
  assert.equal(
    resolveAssetPath(root, '/Assets/Images/cesium_credit.png?v=1#frag'),
    path.join(root, 'Assets/Images/cesium_credit.png'),
  );
  assert.equal(
    resolveAssetPath(root, '/Workers/%63hunk.js'),
    path.join(root, 'Workers/chunk.js'),
  );
  // Traversal is folded away rather than escaping: every result stays under root.
  for (const attempt of [
    '/../package.json',
    '/%2e%2e/package.json',
    '/..%2f..%2fpackage.json',
    '/....//package.json',
    '/Assets/../../../../package.json',
  ]) {
    const resolved = resolveAssetPath(root, attempt);
    assert.ok(
      resolved === null || resolved.startsWith(root + path.sep),
      `${attempt} resolved outside the build directory: ${resolved}`,
    );
  }
  assert.equal(resolveAssetPath(root, '/%ZZ'), null);
  assert.equal(resolveAssetPath(root, '/Assets/%00.png'), null);
});

test('development defines the base URL and ships no bundler externals', () => {
  const plugin = cesiumPlugin();
  assert.equal(plugin.name, 'gev-cesium');
  const config = plugin.config({}, { command: 'serve' });
  assert.deepEqual(config, { define: { CESIUM_BASE_URL: '"/cesium/"' } });
  assert.deepEqual(
    plugin.transformIndexHtml().map((tag) => tag.tag),
    ['link'],
  );
  assert.equal(
    plugin.transformIndexHtml()[0].attrs.href,
    '/cesium/Widgets/widgets.css',
  );
});

test('builds externalise Cesium and load the prebuilt global from the page', () => {
  const plugin = cesiumPlugin();
  const config = plugin.config({}, { command: 'build' });
  assert.equal(config.define, undefined);
  assert.deepEqual(config.build.rollupOptions.external, ['cesium']);
  assert.equal(config.build.rollupOptions.plugins.length, 1);
  const tags = plugin.transformIndexHtml();
  assert.deepEqual(
    tags.map((tag) => tag.attrs.href ?? tag.attrs.src),
    ['/cesium/Widgets/widgets.css', '/cesium/Cesium.js'],
  );
  assert.equal(tags[1].tag, 'script');
});

test('a configured base prefixes both the define and the emitted tags', () => {
  const plugin = cesiumPlugin();
  const config = plugin.config({ base: '/globe/' }, { command: 'serve' });
  assert.equal(config.define.CESIUM_BASE_URL, '"/globe/cesium/"');
  assert.equal(
    plugin.transformIndexHtml()[0].attrs.href,
    '/globe/cesium/Widgets/widgets.css',
  );
});

test('the output directory resolves against the configured root', () => {
  const plugin = cesiumPlugin();
  plugin.config({}, { command: 'build' });
  plugin.configResolved({ root: '/project', build: { outDir: 'dist' } });
  assert.equal(typeof plugin.closeBundle, 'function');
});
