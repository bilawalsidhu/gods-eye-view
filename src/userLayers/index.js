/**
 * Discovery for operator-supplied layers.
 *
 * Drop a `<name>.layer.js` file in this directory and it is picked up at build
 * time — no edit to any tracked file. `.gitignore` covers `*.layer.js` here,
 * so local layers never appear in a diff or a pull request.
 *
 * Discovery is BUILD-time, not runtime: Vite has to see the specifiers to
 * bundle them, and a runtime `import(someString)` would neither be bundled nor
 * survive the app's CSP.
 *
 * `import.meta.glob` is a Vite compile-time macro, which is why it is isolated
 * in this module. Everything it feeds — the registry and the state codec — is
 * plain ESM that runs under `node --test` without a bundler.
 *
 * @module userLayers
 */

import { registerUserLayers } from '../data/layerState.js';

/**
 * Turn discovered modules into registry entries.
 *
 * Exported separately from the glob so it can be unit-tested with a plain
 * object standing in for Vite's module map.
 */
export function collectUserLayerEntries(modules) {
  const entries = [];
  for (const [path, module] of Object.entries(modules || {})) {
    const descriptor = module?.default;
    if (!descriptor)
      throw new Error(`User layer ${path} has no default export`);
    const { id, label, createLayer } = descriptor;
    if (typeof createLayer !== 'function')
      throw new Error(`User layer ${path} must export a createLayer function`);
    entries.push({ id, label, createLayer });
  }
  return entries;
}

/**
 * Build one layer and give it panel visibility by default.
 *
 * `layerPanel` skips any layer whose `showInTogglePanel` is falsy. A built-in
 * opts in deliberately, but someone who went to the trouble of adding a local
 * layer almost certainly wants to see it — defaulting the other way makes the
 * layer load, register and then silently never appear, which is a miserable
 * thing to debug. An explicit `false` is still honoured.
 */
export function instantiateUserLayer(entry) {
  const layer = entry.createLayer();
  if (layer && layer.showInTogglePanel === undefined)
    layer.showInTogglePanel = true;
  return layer;
}

/**
 * Register every discovered user layer and return their live instances for
 * the catalog. Returns an empty array when the directory holds no layers,
 * which is the shipped state.
 */
export function loadUserLayers() {
  let modules = {};
  try {
    // Vite rewrites this call site at build time. Under plain `node --test`
    // there is no bundler to rewrite it and the property does not exist, so
    // the throw is the signal that discovery is unavailable — which is the
    // correct answer there: unit tests run with no user layers.
    modules = import.meta.glob('./*.layer.js', { eager: true });
  } catch {
    modules = {};
  }
  const entries = registerUserLayers(collectUserLayerEntries(modules));
  return entries.map((entry) => instantiateUserLayer(entry));
}
