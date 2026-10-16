import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FORBIDDEN_MARKERS,
  entryFromHtml,
  entryFromManifest,
  forbiddenMarkersIn,
  initialChunks,
  staticImportsOf,
} from './mainChunk.js';

test('the entry is the module script the built index.html loads', () => {
  const html = `<!doctype html><head>
    <script src="/cesium/Cesium.js"></script>
    <script type="module" crossorigin src="/assets/index--RGa-KXE.js"></script>
    <link rel="modulepreload" crossorigin href="/assets/vendor-Ab.js">
  </head>`;
  assert.equal(entryFromHtml(html), 'assets/index--RGa-KXE.js');
});

test('an index.html without a module script has no entry', () => {
  assert.equal(
    entryFromHtml('<script src="/cesium/Cesium.js"></script>'),
    null,
  );
});

test('the entry of a Vite manifest is the chunk marked isEntry for index.html', () => {
  const manifest = {
    'src/app/navaraMode.js': {
      file: 'assets/navaraMode-B.js',
      isDynamicEntry: true,
    },
    'index.html': {
      file: 'assets/index-A.js',
      isEntry: true,
      src: 'index.html',
      imports: ['_vendor-C.js'],
    },
    '_vendor-C.js': { file: 'assets/vendor-C.js' },
  };
  assert.equal(entryFromManifest(manifest), 'assets/index-A.js');
});

test('static imports are found, dynamic imports are not', () => {
  const code =
    'import{a as b}from"./vendor-C.js";import"./side-D.js";' +
    'const x=()=>import("./navaraMode-B.js");' +
    "import { y } from './spaced-E.js';";
  assert.deepEqual(staticImportsOf(code), [
    'vendor-C.js',
    'side-D.js',
    'spaced-E.js',
  ]);
});

test('the initial chunks are the entry and everything it imports statically', () => {
  const files = {
    'assets/index-A.js': 'import"./vendor-C.js";import("./lazy-L.js")',
    'assets/vendor-C.js': 'import{z}from"./deep-D.js"',
    'assets/deep-D.js': 'import"./vendor-C.js"',
    'assets/lazy-L.js': 'THREE.WebGLRenderer',
  };
  assert.deepEqual(
    initialChunks('assets/index-A.js', (file) => files[file]),
    ['assets/index-A.js', 'assets/vendor-C.js', 'assets/deep-D.js'],
  );
});

test('three and Navara markers are reported, ordinary engine names are not', () => {
  assert.deepEqual(
    forbiddenMarkersIn(
      'B4=Object.freeze(["cesium","navara"]);FP={cesium:49,navara:80}',
    ),
    [],
  );
  assert.deepEqual(
    forbiddenMarkersIn('console.warn("THREE.WebGLRenderer: Context Lost.")'),
    ['three'],
  );
  assert.deepEqual(forbiddenMarkersIn('import "@navaramap/three"'), ['navara']);
  assert.deepEqual(forbiddenMarkersIn('new URL("navara_wasm_bg.wasm")'), [
    'navara',
  ]);
  assert.ok(FORBIDDEN_MARKERS.length >= 2);
});
