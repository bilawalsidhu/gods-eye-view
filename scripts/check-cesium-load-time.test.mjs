import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { loadTimeReferences, sourceFiles } from './check-cesium-load-time.mjs';

const reads = (code) =>
  loadTimeReferences(code).map(({ line, name }) => `${line}:${name}`);

test('reads that run while a module loads are found; reads inside later code are not', () => {
  assert.deepEqual(
    reads(`import * as Cesium from 'cesium';
const color = Cesium.Color.RED;
export function later() { return Cesium.Color.BLUE; }
const lazy = () => Cesium.Math.PI;
class Shape { static axis = Cesium.Axis.Y; field = Cesium.Axis.Z; draw() { return Cesium; } }
(() => Cesium.VERSION)();
export const fallback = (sdk = Cesium) => sdk;`),
    ['2:Cesium', '5:Cesium', '6:Cesium'],
  );
  assert.deepEqual(
    reads(`import { Cartesian3 as C3, Color } from 'cesium';
export const ORIGIN = C3.ZERO;
export function white() { return Color.WHITE; }`),
    ['2:C3'],
  );
  assert.deepEqual(reads(`export { Axis } from 'cesium';`), [
    '1:export from cesium',
  ]);
  assert.deepEqual(
    reads(`window.__CESIUM__ = Cesium;`),
    ['1:Cesium'],
    'the global counts where the module does not import it',
  );
  assert.deepEqual(reads(`const geo = { Cesium: 1 }; geo.Cesium;`), []);
});

test('no shipped module reads Cesium while it loads', () => {
  const found = sourceFiles().flatMap((path) =>
    loadTimeReferences(readFileSync(path, 'utf8'), path),
  );
  assert.deepEqual(found, []);
});

test('re-exporting imported Cesium bindings reads them while loading', () => {
  assert.deepEqual(
    reads("import { Color } from 'cesium'; export { Color as Tint };"),
    ['1:Color'],
  );
  assert.deepEqual(reads("import * as C from 'cesium'; export { C };"), [
    '1:C',
  ]);
});

test('Vue scripts participate in the load-time check with original line numbers', () => {
  assert.deepEqual(
    loadTimeReferences(
      `<template><span>Cesium</span></template>
<script>
import { Color } from 'cesium';
export const tint = Color.RED;
</script>`,
      'src/View.vue',
    ).map(({ line, name }) => `${line}:${name}`),
    ['4:Color'],
  );
});
