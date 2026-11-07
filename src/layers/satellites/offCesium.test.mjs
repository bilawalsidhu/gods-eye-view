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
    // The dots and rings are the rendering part's: ids only elsewhere.
    /_pointCollection\./,
    /_points\.(get|values|entries|forEach)\b/,
    /of (layerState|state)\._points\)/,
    /_orbitPaths\.(get|values|entries|forEach)\b/,
  ];
  for (const name of offList) {
    const source = readFileSync(
      new URL(`./${name}.js`, import.meta.url),
      'utf8',
    );
    for (const pattern of forbidden)
      assert.doesNotMatch(source, pattern, `${name}.js: ${pattern}`);
  }
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
