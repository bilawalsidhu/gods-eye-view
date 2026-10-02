import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { onDeviceRuntimePlugin } from '../../../build/onDeviceRuntime.js';
import { createBrowserViteConfig } from '../../../build/vite.js';

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..',
);
const assetsModule = path.join(
  root,
  'src/voice/local/workers/runtimeAssets.js',
);

test('the build serves every runtime file from installed packages', () => {
  const plugin = onDeviceRuntimePlugin({ root });
  const source = plugin.load(assetsModule);
  const imports = [...source.matchAll(/from "([^"]+)"/g)].map(
    (match) => match[1].split('?')[0],
  );
  assert.equal(imports.length, 8);
  for (const file of imports) {
    assert.ok(existsSync(file), file);
    assert.ok(file.includes(`${path.sep}node_modules${path.sep}`), file);
  }
  assert.doesNotMatch(source, /https?:/);
  assert.match(source, /export const litertRuntimes/);
  assert.match(source, /export const onnxWasmPaths/);
  assert.equal(plugin.load(path.join(root, 'src/main.js')), null);
});

test('only the LiteRT-LM loaders gain a module export', () => {
  const plugin = onDeviceRuntimePlugin({ root });
  const loader = [
    ...plugin
      .load(assetsModule)
      .matchAll(/import internalFactory from "([^"]+)"/g),
  ][0][1];
  const code = readFileSync(loader, 'utf8');
  assert.match(
    plugin.transform(code, loader).code,
    /export default ModuleFactory;\n$/,
  );
  assert.equal(plugin.transform('x', path.join(root, 'src/main.js')), null);
});

test('workers and pages both get the runtime plugin', () => {
  const config = createBrowserViteConfig();
  assert.ok(
    config.plugins.some((plugin) => plugin?.name === 'gev-on-device-runtime'),
  );
  assert.ok(
    config.worker
      .plugins()
      .some((plugin) => plugin.name === 'gev-on-device-runtime'),
  );
});

test('workers load runtimes only through the build-provided module', () => {
  for (const name of ['llm', 'stt', 'tts']) {
    const code = readFileSync(
      path.join(root, `src/voice/local/workers/${name}.worker.js`),
      'utf8',
    );
    assert.match(code, /from '\.\/runtimeAssets\.js'/);
    assert.doesNotMatch(code, /\beval\b|importScripts|cdn\.jsdelivr/);
  }
});
