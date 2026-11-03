import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  REGISTRY_PATH,
  compareRegistry,
  firstBoundaryOwner,
  insertRows,
  parseRegistry,
  proposeRow,
  sdkImports,
  serializeRegistry,
} from './files-registry.mjs';

const TEST_OP = 'Сохранить проверку';
const MODEL_OP = 'Отделить источник';
const SDK_OP = 'Разобрать прямой SDK импорт';

const rows = [
  [
    'docs/migration/planet-separation/',
    'VERIFY',
    '',
    '',
    'Сохранить историю',
    '—',
  ],
  [
    'src/layers/wind/index.js',
    'LAYER',
    'wind',
    'cesium',
    SDK_OP,
    'application-components',
  ],
  [
    'src/layers/wind/model.js',
    'LAYER',
    'wind',
    '',
    MODEL_OP,
    'application-components',
  ],
  ['src/layers/wind/model.test.mjs', 'LAYER', 'wind', '', TEST_OP, '—'],
  ['src/old.js', 'UI', '', '', 'x', '—'],
];

test('directory rows cover their subtree; orphans are rows without a tracked path', () => {
  const tracked = [
    'docs/migration/planet-separation/acceptance-run/a.log',
    'src/layers/wind/index.js',
    'src/layers/wind/model.js',
    'src/layers/wind/model.test.mjs',
    'src/layers/wind/render/navara.js',
  ];
  assert.deepEqual(compareRegistry(rows, tracked), {
    unregistered: ['src/layers/wind/render/navara.js'],
    orphans: ['src/old.js'],
  });
  const withoutDocs = compareRegistry(rows, tracked.slice(1));
  assert.ok(withoutDocs.orphans.includes('docs/migration/planet-separation/'));
});

test('SDK imports list the rendering packages a module names, sorted', () => {
  const source = [
    "import * as Cesium from 'cesium';",
    "import { Mesh } from 'three';",
    "import { LineMaterial } from 'three/addons/lines/LineMaterial.js';",
    "export { Effect } from 'postprocessing';",
    "const lazy = () => import('@navaramap/three');",
    "import local from './cesiumHelpers.js';",
    "import 'cesium/Build/Cesium/Widgets/widgets.css';",
  ].join('\n');
  assert.equal(
    sdkImports(source),
    '@navaramap/three,cesium,cesium/Build/Cesium/Widgets/widgets.css,postprocessing,three,three/addons/lines/LineMaterial.js',
  );
  assert.equal(sdkImports("import { x } from '../three.js';"), '');
});

test('a proposal follows the nearest registered neighbours of the same kind', () => {
  assert.deepEqual(proposeRow('src/layers/wind/edgeCases.test.mjs', rows), [
    'src/layers/wind/edgeCases.test.mjs',
    'LAYER',
    'wind',
    '',
    TEST_OP,
    '—',
  ]);
  assert.deepEqual(
    proposeRow('src/layers/wind/render/cesium.js', rows, {
      sdk: 'cesium',
      owner: 'wind-layer',
    }),
    [
      'src/layers/wind/render/cesium.js',
      'LAYER',
      'wind',
      'cesium',
      SDK_OP,
      'wind-layer',
    ],
  );
  assert.equal(proposeRow('src/layers/wind/source.js', rows)[4], MODEL_OP);
  assert.deepEqual(
    proposeRow('tools/new.mjs', [
      ['package.json', 'DELIVERY', '', '', 'y', '—'],
    ]),
    ['tools/new.mjs', 'DELIVERY', '', '', 'y', '—'],
  );
});

test('the boundary owner is the first group listing the module', () => {
  const boundaries = {
    first: { modules: ['src/a.js'] },
    second: { modules: ['src/a.js', 'src/b.js'] },
  };
  assert.equal(firstBoundaryOwner('src/a.js', boundaries), 'first');
  assert.equal(firstBoundaryOwner('src/b.js', boundaries), 'second');
  assert.equal(firstBoundaryOwner('src/c.js', boundaries), '—');
});

test('inserted rows keep the registry in code-unit order', () => {
  const sorted = insertRows(rows.slice(1, 3), [
    ['src/layers/wind/a.js', 'LAYER', 'wind', '', MODEL_OP, '—'],
  ]);
  assert.deepEqual(
    sorted.map((fields) => fields[0]),
    [
      'src/layers/wind/a.js',
      'src/layers/wind/index.js',
      'src/layers/wind/model.js',
    ],
  );
});

test('the checked-in registry parses, round-trips and is sorted without duplicates', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const text = readFileSync(path.join(root, REGISTRY_PATH), 'utf8');
  const registry = parseRegistry(text);
  assert.equal(serializeRegistry(registry), text);
  const paths = registry.rows.map((fields) => fields[0]);
  for (let i = 1; i < paths.length; i += 1) {
    assert.ok(paths[i - 1] < paths[i], `${paths[i - 1]} before ${paths[i]}`);
  }
});
