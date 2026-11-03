// Outline names are drawn by the DOM annotation overlay, never as Cesium
// text labels: the boundary data modules, the outline resolver and the
// annotation renderers must not import or construct Cesium label primitives,
// and drawing a bundled outline must create none at runtime.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as Cesium from 'cesium';
import { FEATURE_SOURCE_METHODS } from '../sources/featureSource.js';
import { createAnnotationResolver } from '../annotations/resolver.js';
import { createWorldAnnotationRenderer } from '../annotations/worldAnnotationRenderer.js';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

/** Pure data modules: no Cesium at all. */
const DATA_MODULES = [
  './adminBoundaries.js',
  './placeBoundaries.js',
  './neighborhoodPolygons.js',
  './local_data/us_census_places/files.js',
  './local_data/wof_neighborhoods/files.js',
];

/** Modules that use Cesium for outlines but must not draw text with it. */
const CESIUM_MODULES = [
  '../annotations/resolver.js',
  '../annotations/worldAnnotationRenderer.js',
  '../annotations/hybridAnnotationRenderer.js',
];

/** The DOM overlay: callout elements, never Cesium label primitives. */
const OVERLAY_MODULES = ['../annotations/screenAnnotationRenderer.js'];

const LABEL_PRIMITIVES = [
  /\bLabelCollection\b/,
  /\bLabelGraphics\b/,
  /\bLabelStyle\b/,
  /\bLabelVisualizer\b/,
];

/** Entity label options, inline or assigned later. */
const ENTITY_LABELS = [
  // `label: { text: … }` or `label: new …`
  /\blabel\s*:\s*\{[^{}]*\btext\s*:/s,
  /\blabel\s*:\s*new\b/,
  // `label: labelOptions` (anything but `null`)
  /\blabel\s*:\s*(?!null\b)[A-Za-z_$][\w$]*\s*[,}\n]/,
  // `entity.label = …`
  /\.label\s*=(?!=)/,
];

test('boundary data modules never import Cesium', () => {
  for (const path of DATA_MODULES) {
    const source = read(path);
    assert.doesNotMatch(source, /from\s+['"]cesium['"]/, path);
    assert.doesNotMatch(source, /import\(\s*['"]cesium['"]/, path);
  }
});

test('outline modules and renderers construct no Cesium labels', () => {
  for (const path of [...DATA_MODULES, ...CESIUM_MODULES, ...OVERLAY_MODULES])
    for (const pattern of LABEL_PRIMITIVES)
      assert.doesNotMatch(read(path), pattern, `${path}: ${pattern}`);
  for (const path of [...DATA_MODULES, ...CESIUM_MODULES])
    for (const pattern of ENTITY_LABELS)
      assert.doesNotMatch(read(path), pattern, `${path}: ${pattern}`);
});

test('the static check catches a Cesium label however it is written', () => {
  const offending = [
    'viewer.scene.primitives.add(new Cesium.LabelCollection());',
    "viewer.entities.add({ position, label: { text: 'Austin' } });",
    'const graphics = new LabelGraphics({ text });',
    'viewer.entities.add({ position, label: labelOptions });',
    'entity.label = new Cesium.LabelGraphics(options);',
    'entity.label = options;',
  ];
  const all = [...LABEL_PRIMITIVES, ...ENTITY_LABELS];
  for (const source of offending)
    assert.ok(
      all.some((pattern) => pattern.test(source)),
      source,
    );
  // Data, not Cesium labels: a result's label point, a stripped proxy label.
  for (const source of [
    'label: geometry.label,',
    'liveProxy(anno, { label: null });',
    'if (entity.label === x) {}',
  ])
    assert.ok(!ENTITY_LABELS.some((p) => p.test(source)), source);
});

test('drawing bundled place and neighborhood outlines creates no Cesium label', async (t) => {
  // Cesium's material setup checks for these browser image types.
  for (const name of [
    'HTMLCanvasElement',
    'HTMLImageElement',
    'ImageBitmap',
    'OffscreenCanvas',
  ]) {
    if (name in globalThis) continue;
    globalThis[name] = class {};
    t.after(() => delete globalThis[name]);
  }
  const featureSource = {};
  for (const method of FEATURE_SOURCE_METHODS)
    featureSource[method] = async () => null;
  const { resolveAnnotationTarget } = createAnnotationResolver({
    featureSource,
  });
  const primitives = [];
  const dataSources = [];
  const viewer = {
    camera: {
      positionCartographic: Cesium.Cartographic.fromDegrees(
        -97.7431,
        30.2672,
        3000,
      ),
    },
    scene: { primitives: { add: (p) => primitives.push(p) } },
    dataSources: {
      add: (ds) => dataSources.push(ds),
      remove() {},
    },
  };
  const renderer = createWorldAnnotationRenderer(viewer);
  for (const [target, lon, lat] of [
    ['Austin', -97.7431, 30.2672],
    ['Notting Hill', -0.2, 51.511],
  ]) {
    viewer.camera.positionCartographic = Cesium.Cartographic.fromDegrees(
      lon,
      lat,
      3000,
    );
    const resolved = await resolveAnnotationTarget({
      // The resolver reads only the camera (no scene to pick from).
      viewer: { camera: viewer.camera },
      target,
      footprint: true,
      deferFootprint: true,
    });
    assert.equal(resolved.source, 'bundled', target);
    renderer.add({
      id: target,
      type: 'area',
      label: resolved.label,
      ring: resolved.ring,
      polygons: resolved.polygons,
      footprintKind: resolved.footprintKind,
      synthesized: resolved.synthesized,
      anchor: { lon: resolved.lon, lat: resolved.lat, height: 0 },
      color: 'primary',
    });
  }
  assert.equal(primitives.length, 0, 'no primitive collections');
  const entities = dataSources.flatMap((ds) => ds.entities.values);
  assert.ok(entities.length >= 2, 'the outlines were drawn');
  for (const entity of entities) assert.equal(entity.label, undefined);
  renderer.destroy();
});
