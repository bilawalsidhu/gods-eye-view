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
