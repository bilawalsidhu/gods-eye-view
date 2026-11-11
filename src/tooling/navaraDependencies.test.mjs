import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  navaraOnlyPackages,
  packagePattern,
} from '../../build/navaraDependencies.js';

function tree(packages, app) {
  const root = mkdtempSync(path.join(tmpdir(), 'gev-navara-deps-'));
  writeFileSync(path.join(root, 'package.json'), JSON.stringify(app));
  for (const [name, dependencies] of Object.entries(packages)) {
    const dir = path.join(root, 'node_modules', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name, dependencies }),
    );
  }
  return root;
}

test('engine-only packages: the Navara closure minus what the bundled app reaches', () => {
  const root = tree(
    {
      '@navaramap/three': { 'd3-geo': '1', shared: '1', draco3d: '1' },
      '@navaramap/three-default-plugin': { 'astronomy-engine': '1' },
      'd3-geo': { 'd3-array': '1' },
      'd3-array': {},
      'astronomy-engine': {},
      shared: {},
      draco3d: {},
      'mapillary-js': { shared: '1', three: '1' },
      cesium: { draco3d: '1' },
      three: {},
    },
    {
      dependencies: {
        '@navaramap/three': '1',
        '@navaramap/three-default-plugin': '1',
        'mapillary-js': '1',
        cesium: '1',
        three: '1',
      },
    },
  );
  assert.deepEqual(navaraOnlyPackages(root), [
    '@navaramap/three',
    '@navaramap/three-default-plugin',
    'astronomy-engine',
    'd3-array',
    'd3-geo',
    'draco3d', // only Cesium (external, not bundled) reaches it too
    'postprocessing',
    'three',
  ]);
});

test('the pattern matches node_modules/<package>/ and nothing longer', () => {
  const pattern = packagePattern(['three', '@navaramap/three', 'd3-geo']);
  assert.ok(pattern.test('/r/node_modules/three/build/three.module.js'));
  assert.ok(pattern.test('C:\\r\\node_modules\\@navaramap\\three\\dist\\i.js'));
  assert.ok(pattern.test('/r/node_modules/d3-geo/src/index.js'));
  assert.ok(!pattern.test('/r/node_modules/three-geojson/index.js'));
  assert.ok(!pattern.test('/r/node_modules/d3-geo-projection/index.js'));
  assert.ok(!pattern.test('/r/src/layers/threeD.js'));
});
