import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as Cesium from 'cesium';
import { satelliteClassColor } from '../../data/satelliteClass.js';
import satellitesLayer, {
  _clearSatelliteLabelLifecycleForTest,
  _setSatelliteLabelLifecycleStateForTest,
} from '../../data/satellites.js';
import {
  POINT_STYLES,
  TRACK_VIEW_FROM_LEO,
  TRACKED_ORBIT_COLOR,
} from './policy.js';
import { createRendering } from './rendering.js';

const rgba = (color) => [color.red, color.green, color.blue, color.alpha];

test('point styles keep the colours the dots were drawn in', () => {
  const outline = rgba(Cesium.Color.WHITE.withAlpha(0.3));
  const expected = {
    iss: Cesium.Color.fromCssColorString('#ff4444'),
    dense: Cesium.Color.fromCssColorString(
      satelliteClassColor('dense'),
    ).withAlpha(0.9),
  };
  for (const [group, style] of Object.entries(POINT_STYLES)) {
    const color =
      expected[group] ??
      Cesium.Color.fromCssColorString(satelliteClassColor(group));
    assert.deepEqual([...style.color], rgba(color), `${group} colour`);
    assert.deepEqual([...style.outlineColor], outline, `${group} outline`);
  }
  assert.deepEqual([...TRACKED_ORBIT_COLOR], rgba(Cesium.Color.YELLOW));
  assert.deepEqual(
    { ...TRACK_VIEW_FROM_LEO },
    {
      x: -450000,
      y: -450000,
      z: 350000,
    },
  );
});

test('positions read back from the drawn dots match the Cesium geodetic conversion', () => {
  const position = Cesium.Cartesian3.fromDegrees(-97.7, 30.2, 420_000);
  const point = { position, show: true };
  _setSatelliteLabelLifecycleStateForTest({
    viewer: { scene: { frameState: { frameNumber: 1 } } },
    satrec: null,
    point,
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
  });
  try {
    const [row] = satellitesLayer.getAllPositions();
    const carto = Cesium.Cartographic.fromCartesian(position);
    assert.equal(row.id, 25544);
    assert.equal(row.position, position, 'the drawn position itself');
    assert.ok(
      Math.abs(row.latitude - Cesium.Math.toDegrees(carto.latitude)) < 1e-9,
    );
    assert.ok(
      Math.abs(row.longitude - Cesium.Math.toDegrees(carto.longitude)) < 1e-9,
    );
    assert.ok(Math.abs(row.altitudeM - carto.height) < 1e-6);
  } finally {
    _clearSatelliteLabelLifecycleForTest();
  }
});

test('only the rendering part drives Cesium', () => {
  const offList = [
    'catalog',
    'controls',
    'index',
    'ingestion',
    'interaction',
    'labels',
    'lifecycle',
    'orbits',
    'policy',
    'records',
    'source',
    'state',
    'testing',
    'tracking',
  ];
  const forbidden = [
    /from 'cesium'/,
    /render\/cesium\//,
    /\bCesium\./,
    /viewer\??\.entities\b/,
    /\.scene\b/,
    /\bscene\./,
    /\.primitive\b/,
    // The dots, rings and tracked entity are the rendering part's. Elsewhere
    // the handles are only stored, cleared, tested or passed on whole, and
    // the maps answer by id: no member of a handle is read, with or without
    // optional chaining, and no handle is taken into a local name.
    /\b_(pointCollection|trackedEntity)\s*(\?\.|\.|\[)/,
    /\b_(points|orbitPaths)\s*(\?\.|\.|\[)\s*(?!(has|keys|size|clear|set|delete)\b)/,
    /of\s+[\w.?]*\b_(points|orbitPaths)\s*\)/,
    /(\.\.\.|Array\.from\()\s*[\w.?]*\b_(points|orbitPaths)\b(?!\s*\??\.)/,
    /(^|[;{}(\s])\w+\s*=\s*\(*\s*[\w.?]*\b_(pointCollection|trackedEntity|points|orbitPaths)\s*(;|,|\)|\?\?|\|\||&&)/,
    /\}\s*=\s*\(*\s*[\w.?]*\b_(pointCollection|trackedEntity|points|orbitPaths)\b/,
    /[\w)\]]\s*(\?\.)?\[\s*['"`]_(pointCollection|trackedEntity|points|orbitPaths)\b/,
    /\{[^}]*\b_(pointCollection|trackedEntity|points|orbitPaths)\b[^}]*\}\s*=[^=]/,
  ];
  for (const name of offList) {
    const source = readFileSync(
      new URL(`./${name}.js`, import.meta.url),
      'utf8',
    );
    for (const pattern of forbidden)
      assert.doesNotMatch(source, pattern, `${name}.js: ${pattern}`);
  }
  // The patterns themselves still catch what they are for.
  const caught = [
    'layerState._trackedEntity.position.setValue(p)',
    'layerState._pointCollection?.removeAll()',
    'state._trackedEntity?.["position"]',
    'layerState._points.get(id).show = false',
    'layerState._orbitPaths?.values()',
    'for (const p of layerState._points) {}',
    'const pc = layerState._pointCollection;',
    'const { _trackedEntity: e } = layerState;',
    'const e = layerState?._trackedEntity;',
    'for (const p of layerState?._points) {}',
    '[...layerState._points]',
    'Array.from(layerState._orbitPaths)',
    'e = layerState._trackedEntity;',
    'let e; e = layerState._trackedEntity;',
    'const { position } = layerState._trackedEntity;',
    'const e = layerState._trackedEntity ?? null;',
    'const e = (layerState._trackedEntity);',
    'const { get } = layerState._points;',
    'layerState["_trackedEntity"].position',
  ];
  for (const line of caught)
    assert.ok(
      forbidden.some((pattern) => pattern.test(line)),
      `not caught: ${line}`,
    );
  const allowed = [
    'layerState._points.has(id)',
    'layerState._points.size',
    'layerState._trackedEntity = null;',
    'parts.rendering._removeTrackedEntity(layerState._trackedEntity);',
    'layerState._trackedEntityChangedRemove();',
    'const had = layerState._points.has(id);',
    'const t = layerState._trackedEntity\n    ? a\n    : b;',
    'const ids = ["_points", "_orbitPaths"];',
    'const n = layerState._orbitPaths.size;',
    '[...layerState._points.keys()]',
    'layerState._trackedEntity = parts.rendering._addTrackedEntity({',
  ];
  for (const line of allowed)
    assert.ok(
      !forbidden.some((pattern) => pattern.test(line)),
      `wrongly caught: ${line}`,
    );
});

test('the rendering part draws the dots and rings in Cesium colours', () => {
  const added = [];
  const state = {
    _points: new Map(),
    _orbitPaths: new Map(),
    _catalog: new Map([[25544, { satrec: {} }]]),
    _pointCollection: { add: (options) => ({ ...options }) },
    _viewer: { scene: { primitives: { add: (p) => added.push(p) } } },
  };
  const path = [
    { x: 7e6, y: 0, z: 0 },
    { x: 0, y: 7e6, z: 0 },
    { x: -7e6, y: 0, z: 0 },
  ];
  const rendering = createRendering({
    state,
    services: { focus: {} },
    parts: { orbits: { computeOrbitPath: () => path } },
  });
  rendering._addPoint(25544, { x: 1, y: 2, z: 3 }, POINT_STYLES.iss);
  const point = state._points.get(25544);
  assert.ok(point.position instanceof Cesium.Cartesian3);
  assert.deepEqual(
    [point.position.x, point.position.y, point.position.z],
    [1, 2, 3],
  );
  assert.ok(point.color instanceof Cesium.Color);
  assert.deepEqual(
    rgba(point.color),
    rgba(Cesium.Color.fromCssColorString('#ff4444')),
  );
  assert.deepEqual(
    rgba(point.outlineColor),
    rgba(Cesium.Color.WHITE.withAlpha(0.3)),
  );
  assert.equal(point.pixelSize, 12);
  assert.equal(point.outlineWidth, 2);
  assert.equal(point.id, 25544);
  assert.ok(
    Cesium.NearFarScalar.equals(
      point.scaleByDistance,
      new Cesium.NearFarScalar(1e6, 1.5, 2e7, 0.6),
    ),
  );

  rendering._showOrbitPath(25544, TRACKED_ORBIT_COLOR);
  assert.equal(added.length, 1);
  const instance = added[0].geometryInstances;
  assert.deepEqual(
    [...instance.attributes.color.value],
    [255, 255, 0, Cesium.Color.floatToByte(0.6)],
  );
  assert.ok(
    instance.geometry._positions.every((p) => p instanceof Cesium.Cartesian3),
  );
  assert.ok(
    rendering
      ._rendererPositions(path)
      .every((p, i) => p instanceof Cesium.Cartesian3 && p.x === path[i].x),
  );
});
