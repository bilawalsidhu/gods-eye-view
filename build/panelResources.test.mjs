import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserViteConfig } from './vite.js';
import { panelBuildConfig } from './panel.js';

test('panel HTML lists Cesium assets for the host resource loader', () => {
  const config = panelBuildConfig(createBrowserViteConfig());
  const plugin = config.plugins.find(
    ({ name }) => name === 'vite-plugin-cesium',
  );
  plugin.config(config, { command: 'build' });
  assert.equal(typeof plugin.transformIndexHtml, 'function');
  const tags = plugin.transformIndexHtml();
  assert.ok(tags.some(({ attrs }) => attrs.src === '/panel/cesium/Cesium.js'));
  assert.ok(
    tags.some(
      ({ attrs }) => attrs.href === '/panel/cesium/Widgets/widgets.css',
    ),
  );
});

test('the panel replaces Navara entry points and retains browser aliases', () => {
  const browser = createBrowserViteConfig();
  const config = panelBuildConfig(browser);
  const alias = config.resolve.alias.find(({ find }) =>
    find.test('./navaraMode.js'),
  );
  assert.ok(alias.replacement.endsWith('/build/panelNavara.js'));
  // Navara's wind mesh imports three; the Cesium wind backend stays.
  assert.equal(
    '../../globe/navara/windFlowMesh.js'.replace(alias.find, alias.replacement),
    alias.replacement,
  );
  assert.equal(alias.find.test('../../globe/cesium/windFlow.js'), false);
  assert.ok(config.resolve.alias.includes(browser.resolve.alias[0]));
});

test('Three imports and requires share its ESM entry', () => {
  const { resolve } = createBrowserViteConfig();
  assert.deepEqual(resolve.dedupe, ['three']);
  const alias = resolve.alias.find(({ find }) => find.test('three'));
  assert.ok(alias.replacement.endsWith('/three/build/three.module.js'));
  assert.equal(alias.find.test('three/addons/loaders/GLTFLoader.js'), false);
});
