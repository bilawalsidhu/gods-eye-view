import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createCompactInfrastructureSource } from './compactInfrastructure.js';

const ring = [
  [0, 0],
  [0.01, 0],
  [0, 0.01],
  [0, 0],
];
const features = [
  {
    type: 'Feature',
    id: 'polygon',
    properties: { name: 'Example' },
    geometry: { type: 'Polygon', coordinates: [ring] },
  },
  {
    type: 'Feature',
    id: 'multi',
    properties: { name: 'Two parts' },
    geometry: { type: 'MultiPolygon', coordinates: [[ring], [ring]] },
  },
];

test('compact infrastructure preserves multipart ids and exact analyst anchors without creating render entities', async () => {
  const original = await Cesium.GeoJsonDataSource.load({
    type: 'FeatureCollection',
    features,
  });
  const compact = createCompactInfrastructureSource(features, {});
  assert.deepEqual(
    compact.compactEntities.map((f) => f.id),
    original.entities.values.map((f) => f.id),
  );
  for (let i = 0; i < original.entities.values.length; i++) {
    const positions = original.entities.values[i].polygon.hierarchy.getValue(
      Cesium.JulianDate.now(),
    ).positions;
    assert.deepEqual(
      compact.compactEntities[i].position.getValue(),
      Cesium.BoundingSphere.fromPoints(positions).center,
    );
    assert.deepEqual(
      compact.compactEntities[i].properties,
      features[i ? 1 : 0].properties,
    );
  }
  assert.equal(compact.entities.values.length, 0);
});

test('visible infrastructure materializes on demand, mirrors geometry, preserves selection, and releases shared subscriptions', () => {
  const viewer = {};
  const source = createCompactInfrastructureSource(features, viewer);
  const feature = source.compactEntities[0];
  const color = new Cesium.ColorMaterialProperty(Cesium.Color.CYAN);
  const width = new Cesium.ConstantProperty(3.5);
  const point = new Cesium.PointGraphics({ pixelSize: 10 });
  const position = feature.position.getValue();
  feature.polyline = {
    positions: [position, position],
    width,
    material: color,
  };
  feature.point = point;
  feature.__localLayerId = 'local-datacenters';
  feature.__gevContextId = 'dc:polygon';
  feature.show = true;
  const native = feature.native;
  assert.equal(source.entities.values.length, 1);
  assert.equal(native.__gevContextId, 'dc:polygon');
  feature.position.setValue(Cesium.Cartesian3.UNIT_X);
  assert.deepEqual(
    native.position.getValue(Cesium.JulianDate.now()),
    Cesium.Cartesian3.UNIT_X,
  );
  viewer.selectedEntity = native;
  feature.show = false;
  assert.equal(
    source.entities.values.length,
    1,
    'selected detail stays valid outside the frame',
  );
  viewer.selectedEntity = undefined;
  source.releaseUnselected();
  assert.equal(source.entities.values.length, 0);
  assert.equal(point.definitionChanged.numberOfListeners, 0);
  assert.equal(color.definitionChanged.numberOfListeners, 0);
  assert.equal(width.definitionChanged.numberOfListeners, 0);
  feature.show = true;
  assert.notEqual(feature.native, native);
});

test('normal presentation preserves polygon footprints, holes, colors and native line geometry', async () => {
  const color = Cesium.Color.fromCssColorString('#0088ff');
  const input = [
    {
      ...features[0],
      properties: {
        name: 'Styled polygon',
        stroke: '#ff8800',
        'stroke-opacity': 0.5,
        'stroke-width': 4,
        fill: '#44ff88',
        'fill-opacity': 0.2,
      },
      geometry: {
        type: 'Polygon',
        coordinates: [ring, ring.map(([x, y]) => [x * 0.1, y * 0.1])],
      },
    },
    ...features.slice(1),
    {
      type: 'Feature',
      id: 'line',
      properties: { name: 'A line' },
      geometry: {
        type: 'LineString',
        coordinates: [
          [0, 0],
          [1, 1],
        ],
      },
    },
  ];
  const original = await Cesium.GeoJsonDataSource.load(
    { type: 'FeatureCollection', features: input },
    {
      clampToGround: true,
      stroke: color,
      fill: color.withAlpha(0.3),
      strokeWidth: 2,
    },
  );
  const source = createCompactInfrastructureSource(
    input,
    {},
    { detailed: true, color },
  );
  assert.equal(
    source.entities.values.length,
    1,
    'the existing native line is preserved before the stem LOD runs',
  );
  source.compactEntities[0].show = true;
  const native = source.compactEntities[0].native;
  const expected = original.entities.getById('polygon');
  const time = Cesium.JulianDate.now();
  assert.deepEqual(
    native.polygon.hierarchy.getValue(time),
    expected.polygon.hierarchy.getValue(time),
  );
  assert.deepEqual(
    native.polygon.material.getValue(time),
    expected.polygon.material.getValue(time),
  );
  assert.deepEqual(
    native.polygon.outlineColor.getValue(time),
    expected.polygon.outlineColor.getValue(time),
  );
  assert.equal(
    native.polygon.outlineWidth.getValue(time),
    expected.polygon.outlineWidth.getValue(time),
  );
  assert.equal(
    native.polygon.arcType.getValue(time),
    expected.polygon.arcType.getValue(time),
  );
  assert.deepEqual(
    source.entities.getById('line').polyline.positions.getValue(time),
    original.entities.getById('line').polyline.positions.getValue(time),
  );
});

test('normal point markers retain their pin image and clamping policy', () => {
  const input = [
    {
      type: 'Feature',
      id: 'point',
      properties: { name: 'Point' },
      geometry: { type: 'Point', coordinates: [10, 20] },
    },
  ];
  const source = createCompactInfrastructureSource(
    input,
    {},
    { detailed: true, createPin: () => 'fixture.png' },
  );
  const point = source.compactEntities[0];
  point.show = true;
  const time = Cesium.JulianDate.now();
  assert.equal(point.native.billboard.image.getValue(time), 'fixture.png');
  assert.equal(
    point.native.billboard.heightReference.getValue(time),
    Cesium.HeightReference.CLAMP_TO_GROUND,
  );
  assert.deepEqual(
    point.native.position.getValue(time),
    Cesium.Cartesian3.fromDegrees(10, 20),
  );
});
