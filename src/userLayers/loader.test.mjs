import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectUserLayerEntries, instantiateUserLayer } from './index.js';

const mod = (id, extra = {}) => ({
  default: { id, createLayer: () => ({ id, ...extra }) },
});

test('collects descriptors from a Vite-style module map', () => {
  const entries = collectUserLayerEntries({
    './a.layer.js': mod('alpha'),
    './b.layer.js': {
      default: { id: 'bravo', label: 'B', createLayer: () => ({}) },
    },
  });
  assert.deepEqual(
    entries.map((e) => e.id),
    ['alpha', 'bravo'],
  );
  assert.equal(entries[1].label, 'B');
});

test('names the offending file when a module is malformed', () => {
  // The path is the only thing that tells an author which file to open.
  assert.throws(
    () => collectUserLayerEntries({ './broken.layer.js': {} }),
    /broken\.layer\.js has no default export/,
  );
  assert.throws(
    () => collectUserLayerEntries({ './x.layer.js': { default: { id: 'x' } } }),
    /x\.layer\.js must export a createLayer function/,
  );
});

test('an empty module map is not an error', () => {
  assert.deepEqual(collectUserLayerEntries({}), []);
  assert.deepEqual(collectUserLayerEntries(undefined), []);
});

test('user layers are panel-visible by default', () => {
  // Otherwise the layer registers correctly and then never appears, which is
  // the worst possible failure mode for someone adding their first layer.
  const layer = instantiateUserLayer({
    id: 'a',
    createLayer: () => ({ id: 'a' }),
  });
  assert.equal(layer.showInTogglePanel, true);
});

test('an explicit showInTogglePanel is honoured in both directions', () => {
  const hidden = instantiateUserLayer({
    id: 'h',
    createLayer: () => ({ id: 'h', showInTogglePanel: false }),
  });
  assert.equal(hidden.showInTogglePanel, false);
  const shown = instantiateUserLayer({
    id: 's',
    createLayer: () => ({ id: 's', showInTogglePanel: true }),
  });
  assert.equal(shown.showInTogglePanel, true);
});

test('the shipped example implements every method the manager calls unconditionally', async () => {
  // `lifecycle.js` calls init/enable/disable/update on a layer without first
  // checking that they exist. A missing one is invisible until the operator
  // clicks the toggle and gets a console warning, so the example — the file
  // everyone copies — is pinned against the manager's own source here rather
  // than against a list somebody has to remember to update.
  const { readFileSync } = await import('node:fs');
  const lifecycle = readFileSync(
    new URL('../data/lifecycle.js', import.meta.url),
    'utf8',
  );
  const called = new Set(
    [...lifecycle.matchAll(/\bentry\.module\.([a-zA-Z]+)\(/g)].map(
      ([, name]) => name,
    ),
  );
  // A method the manager feature-detects anywhere is optional; what is left is
  // what every layer must provide.
  const optional = new Set(
    [
      ...lifecycle.matchAll(
        /typeof entry\.module\??\.([a-zA-Z]+) [!=]==? 'function'/g,
      ),
    ].map(([, name]) => name),
  );
  const required = [...called].filter((name) => !optional.has(name));
  assert.deepEqual(
    required.sort(),
    ['disable', 'enable', 'init', 'update'],
    "the manager's unguarded layer contract changed; update the example too",
  );

  const example = readFileSync(
    new URL('./example.layer.js.example', import.meta.url),
    'utf8',
  );
  const { default: descriptor } = await import(
    `data:text/javascript,${encodeURIComponent(example)}`
  );
  const layer = instantiateUserLayer(descriptor);
  for (const name of required)
    assert.equal(
      typeof layer[name],
      'function',
      `the example layer is missing ${name}(), which the manager calls without a guard`,
    );
});
