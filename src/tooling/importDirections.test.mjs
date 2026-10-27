import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzeModule } from '../../scripts/module-analysis.mjs';
import { checkImportDirections } from '../../scripts/check-import-directions.mjs';

function fixture(t, exports = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'gev-directions-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  const write = (name, source = '') => {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), source);
  };
  write(
    'package.json',
    JSON.stringify({ name: '@gods-eye-view/core', exports }),
  );
  write('src/data/feedState.js');
  return { root, write };
}

test('module analysis parses dependencies and platform references without reading comments or property labels', () => {
  assert.deepEqual(
    analyzeModule(
      "// import('node:fs'); document\nimport x from 'one'; export { x } from 'two'; export * from 'three'; import('four'); const data = { document: 1 }; data.window;",
    ),
    { imports: ['one', 'two', 'three', 'four'], browser: [] },
  );
  assert.deepEqual(
    analyzeModule(
      "const data = { element: document }; globalThis['navigator'];",
    ).browser,
    ['document', 'navigator'],
  );
  assert.throws(() => analyzeModule('import(name)'), /Computed/);
  assert.throws(() => analyzeModule("require('node:fs')"), /ES imports/);
});

test('portable sources can share records, and standalone can assemble rendering', (t) => {
  const { root, write } = fixture(t, {
    './layers/demo/source': './src/layers/demo/source.js',
  });
  write('src/layers/demo/source.js', "export { read } from './records.js';");
  write('src/layers/demo/records.js', 'export const read = (value) => value;');
  write('src/standalone/catalog.js', "import '../layers/demo/index.js';");
  write('src/layers/demo/index.js', "import * as Cesium from 'cesium';");
  assert.equal(checkImportDirections(root).modules, 5);
});

for (const [name, files, pattern] of [
  [
    'unreachable source imports rendering',
    {
      'src/layers/demo/source.js': "import './rendering.js';",
      'src/layers/demo/rendering.js': '',
    },
    /Source imports rendering/,
  ],
  [
    'source reaches a platform through a record helper',
    {
      'src/layers/demo/source.js': "import './records.js';",
      'src/layers/demo/records.js': "import 'cesium';",
    },
    /reaches platform\/rendering/,
  ],
  [
    'source reaches a DOM helper',
    {
      'src/sources/demo.js': "import '../data/helper.js';",
      'src/data/helper.js': 'export const view = () => globalThis.document;',
    },
    /reaches browser globals/,
  ],
  [
    'W1 shared focusDeemphasis keeps native imports in render',
    { 'src/data/focusDeemphasis.js': "import 'cesium';" },
    /cesium only in the layer's render/,
  ],
  [
    'W1 shared trailRenderer keeps native imports in render',
    { 'src/data/trailRenderer.js': "import 'cesium';" },
    /cesium only in the layer's render/,
  ],
  [
    'W1 shared contactTrailRenderer keeps native imports in render',
    { 'src/data/contactTrailRenderer.js': "import 'cesium';" },
    /cesium only in the layer's render/,
  ],
  [
    'W1 shared iconOrientation keeps native imports in render',
    { 'src/data/iconOrientation.js': "import 'cesium';" },
    /cesium only in the layer's render/,
  ],
  [
    'W1 shared modelVisualAnchor keeps native imports in render',
    { 'src/data/modelVisualAnchor.js': "import 'cesium';" },
    /cesium only in the layer's render/,
  ],
  [
    'W1 shared trackingClickGesture keeps native imports in render',
    { 'src/data/trackingClickGesture.js': "import 'cesium';" },
    /cesium only in the layer's render/,
  ],
  [
    'geo module imports cesium',
    { 'src/geo/demo.js': "import 'cesium';" },
    /src\/geo\/demo\.js: geo reaches platform\/rendering dependency: cesium/,
  ],
  [
    'geo module imports a Cesium workspace package',
    { 'src/geo/demo.js': "import { Cartesian3 } from '@cesium/engine';" },
    /src\/geo\/demo\.js: geo reaches platform\/rendering dependency: @cesium\/engine/,
  ],
  [
    'geo module reaches cesium through a helper',
    {
      'src/geo/demo.js': "import '../data/helper.js';",
      'src/data/helper.js': "export * from 'cesium';",
    },
    /src\/data\/helper\.js: geo reaches platform\/rendering dependency: cesium/,
  ],
  [
    'app clock imports cesium',
    { 'src/time/clock.js': "import 'cesium';" },
    /src\/time\/clock\.js: time reaches platform\/rendering dependency: cesium/,
  ],
  [
    'app clock imports three',
    { 'src/time/clock.js': "import * as THREE from 'three';" },
    /src\/time\/clock\.js: time reaches platform\/rendering dependency: three/,
  ],
  [
    'app clock reaches the DOM',
    {
      'src/time/clock.js': 'export const now = () => window.performance.now();',
    },
    /src\/time\/clock\.js: time reaches browser globals/,
  ],
  [
    'globe contract imports cesium',
    { 'src/globe/contract.js': "import 'cesium';" },
    /src\/globe\/contract\.js: globe contract reaches engine dependency: cesium/,
  ],
  [
    'globe contract imports three',
    { 'src/globe/contract.js': "import * as THREE from 'three';" },
    /globe contract reaches engine dependency: three/,
  ],
  [
    'globe testing support imports a Navara package',
    { 'src/globe/testing/fakeEngine.js': "import '@navaramap/three';" },
    /src\/globe\/testing\/fakeEngine\.js: globe contract reaches engine dependency: @navaramap\/three/,
  ],
  [
    'globe contract reaches cesium through a helper',
    {
      'src/globe/contract.js': "import '../data/helper.js';",
      'src/data/helper.js': "export * from '@cesium/engine';",
    },
    /src\/data\/helper\.js: globe contract reaches engine dependency: @cesium\/engine/,
  ],
  [
    'globe contract imports an engine implementation',
    {
      'src/globe/contract.js': "import('./navara/index.js');",
      'src/globe/navara/index.js': '',
    },
    /globe contract imports engine implementation: src\/globe\/navara\/index\.js/,
  ],
  [
    'Cesium globe engine imports Navara',
    { 'src/globe/cesium/engine.js': "import '@navaramap/three';" },
    /Cesium globe engine reaches @navaramap\/three/,
  ],
  [
    'Navara globe engine imports Cesium',
    { 'src/globe/navara/engine.js': "import { Cartesian3 } from 'cesium';" },
    /Navara globe engine reaches cesium/,
  ],
  [
    'Navara globe engine reaches Cesium through a helper',
    {
      'src/globe/navara/engine.js': "import '../../maps/helper.js';",
      'src/maps/helper.js': "export * from 'cesium';",
    },
    /src\/maps\/helper\.js: Navara globe engine reaches cesium/,
  ],
  [
    'Navara globe engine imports the Cesium engine',
    {
      'src/globe/navara/engine.js': "import '../cesium/camera.js';",
      'src/globe/cesium/camera.js': '',
    },
    /src\/globe\/navara\/engine\.js: Navara globe engine reaches src\/globe\/cesium\/camera\.js/,
  ],
  [
    'Cesium globe engine reaches three through a helper',
    {
      'src/globe/cesium/engine.js': "import '../../ui/helper.js';",
      'src/ui/helper.js': "import 'three/addons/controls.js';",
    },
    /src\/ui\/helper\.js: Cesium globe engine reaches three\/addons\/controls\.js/,
  ],
  [
    'Cesium globe engine reaches the Navara engine through a helper',
    {
      'src/globe/cesium/engine.js': "import '../shared.js';",
      'src/globe/shared.js': "import('./navara/engine.js');",
      'src/globe/navara/engine.js': '',
    },
    /Cesium globe engine reaches src\/globe\/navara\/engine\.js/,
  ],
  [
    'browser imports Node without prefix',
    { 'src/unused.mjs': "import 'fs/promises';" },
    /Node builtin/,
  ],
  [
    'browser hides Node outside src',
    {
      'src/unused.js': "import '../shared/helper.js';",
      'shared/helper.js': "export * from 'node:fs';",
    },
    /Browser graph reaches Node/,
  ],
  [
    'browser imports server',
    {
      'src/data/demo.js': "import '../../server/helper.js';",
      'server/helper.js': '',
    },
    /Browser imports server/,
  ],
  [
    'reusable module selects standalone',
    {
      'src/app/demo.js': "import '../standalone/catalog.js';",
      'src/standalone/catalog.js': '',
    },
    /Reusable module imports standalone/,
  ],
  [
    'provider selects application setup',
    {
      'server/providers/demo.js': "import '../standalone/key-setup.js';",
      'server/standalone/key-setup.js': '',
    },
    /Provider imports application/,
  ],
  [
    'voice controls reach protocol indirectly',
    {
      'src/voice/sessionCommands.js': "import './helper.js';",
      'src/voice/helper.js': "import './realtimeSession.js';",
      'src/voice/realtimeSession.js': '',
    },
    /Common voice controls import protocol/,
  ],
  [
    'dynamic import cannot evade direction',
    { 'src/app/demo.js': "const target = './module.js'; import(target);" },
    /Computed/,
  ],
  [
    'browser imports test helper',
    {
      'src/app/demo.js': "import '../testSupport/helper.js';",
      'src/testSupport/helper.js': '',
    },
    /non-runtime owner/,
  ],
]) {
  test(`rejects ${name}`, (t) => {
    const { root, write } = fixture(t);
    for (const [file, body] of Object.entries(files)) write(file, body);
    assert.throws(() => checkImportDirections(root), pattern);
  });
}

test('module analysis can tell dynamic imports from static ones', () => {
  assert.deepEqual(
    analyzeModule(
      "import a from 'one'; export * from 'two'; import('three'); const x = () => import('four');",
      { dynamic: true },
    ),
    {
      imports: ['one', 'two', 'three', 'four'],
      browser: [],
      dynamicImports: ['three', 'four'],
    },
  );
});

test('the app reaches the Navara engine only through a dynamic import', (t) => {
  const { root, write } = fixture(t);
  write('src/globe/navara/index.js', "import './engine.js';");
  write('src/globe/navara/engine.js', '');
  write(
    'src/app/scene.js',
    "export const load = () => import('../globe/navara/index.js');",
  );
  assert.doesNotThrow(() => checkImportDirections(root));
  write('src/app/scene.js', "import '../globe/navara/index.js';");
  assert.throws(
    () => checkImportDirections(root),
    /src\/app\/scene\.js: The Navara engine loads only through a dynamic import\(\): src\/globe\/navara\/index\.js/,
  );
  write(
    'src/app/scene.js',
    "export { createNavaraGlobe } from '../globe/navara/index.js';",
  );
  assert.throws(
    () => checkImportDirections(root),
    /only through a dynamic import/,
  );
});

test('layers moved onto renderers keep each engine in its render file', (t) => {
  const { root, write } = fixture(t);
  write('src/layers/flights/rendering.js', "import './render/cesium.js';");
  write('src/layers/flights/render/cesium.js', "import 'cesium';");
  write(
    'src/layers/flights/render/navara.js',
    "import 'three'; import '@navaramap/three';",
  );
  write('src/layers/aircraft/render/cesium.js', "import 'cesium';");
  write('src/layers/flights/render/cesium.test.mjs', "import 'cesium';");
  write(
    'src/app/navaraMode.js',
    "export const load = () => import('../layers/flights/render/navara.js');",
  );
  // A layer not moved yet still imports cesium anywhere (until its *a task).
  write('src/layers/wind/rendering.js', "import 'cesium';");
  assert.doesNotThrow(() => checkImportDirections(root));

  write('src/layers/flights/tracking.js', "import 'cesium';");
  assert.throws(
    () => checkImportDirections(root),
    /src\/layers\/flights\/tracking\.js: cesium only in the layer's render\/cesium\*\.js: cesium/,
  );
  write('src/layers/flights/tracking.js', '');
  write('src/layers/aircraft/render/cesium.js', "import 'three';");
  assert.throws(
    () => checkImportDirections(root),
    /src\/layers\/aircraft\/render\/cesium\.js: three and Navara only in the layer's render\/navara\*\.js: three/,
  );
  write('src/layers/aircraft/render/cesium.js', '');
  write('src/app/data.js', "import '../layers/flights/render/navara.js';");
  assert.throws(
    () => checkImportDirections(root),
    /src\/app\/data\.js: A Navara layer renderer loads only through the Navara mode's dynamic import\(\): src\/layers\/flights\/render\/navara\.js/,
  );
});

test('geo modules may import each other, and its tests may import cesium', (t) => {
  const { root, write } = fixture(t);
  write('src/geo/math.js', 'export const half = (value) => value / 2;');
  write('src/geo/demo.js', "export { half } from './math.js';");
  write('src/geo/demo.test.mjs', "import 'cesium'; import './demo.js';");
  assert.doesNotThrow(() => checkImportDirections(root));
});

test('globe engines use their own dependencies, and globe tests may import any engine', (t) => {
  const { root, write } = fixture(t);
  write('src/geo/math.js', 'export const half = (value) => value / 2;');
  write('src/globe/contract.js', "export { half } from '../geo/math.js';");
  write('src/globe/testing/suite.mjs', "import '../contract.js';");
  write('src/globe/testing/suite.test.mjs', "import 'cesium'; import 'three';");
  write(
    'src/globe/cesium/engine.js',
    "import 'cesium'; import '../contract.js';",
  );
  write(
    'src/globe/navara/engine.js',
    "import 'three'; import '@navaramap/three'; import '../contract.js';",
  );
  assert.doesNotThrow(() => checkImportDirections(root));
});

test('self package imports cannot evade portable ownership', (t) => {
  const { root, write } = fixture(t, { './view': './src/ui/view.js' });
  write('src/sources/demo.js', "import '@gods-eye-view/core/view';");
  write('src/ui/view.js');
  assert.throws(() => checkImportDirections(root), /Source imports rendering/);
});

test('compatibility exceptions are limited to the two existing composition entries', (t) => {
  const { root, write } = fixture(t);
  write('src/ui.js', "import './standalone/catalog.js';");
  write('src/standalone/catalog.js');
  write('server/providers/local.js', "import '../standalone/key-setup.js';");
  write('server/standalone/key-setup.js');
  assert.doesNotThrow(() => checkImportDirections(root));
  write('src/ui/new.js', "import '../standalone/catalog.js';");
  assert.throws(
    () => checkImportDirections(root),
    /Reusable module imports standalone/,
  );
});

test('symlink aliases do not hide renderer ownership', (t) => {
  const { root, write } = fixture(t);
  write('src/sources/demo.js', "import './helper/view.js';");
  write('src/ui/view.js');
  // Directory junctions exercise the same resolved edge without Windows symlink privileges.
  symlinkSync(
    path.join(root, 'src/ui'),
    path.join(root, 'src/sources/helper'),
    'junction',
  );
  assert.throws(() => checkImportDirections(root), /rendering|symlinks/);
});
