import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  cableViewportPass,
  syncCableResidency,
  splitCablePositions,
  cableSegmentRecords,
  syncCableSegment,
  rhumbPositionBounds,
} from './residency.js';

function viewerAt(lon, lat, height = 1_000_000) {
  const ground = Cesium.Cartesian3.fromDegrees(lon, lat);
  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(ground);
  const up = Cesium.Matrix4.getColumn(enu, 2, new Cesium.Cartesian4());
  const north = Cesium.Matrix4.getColumn(enu, 1, new Cesium.Cartesian4());
  const position = Cesium.Cartesian3.add(
    ground,
    Cesium.Cartesian3.multiplyByScalar(up, height, new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  );
  return {
    camera: {
      positionWC: position,
      directionWC: Cesium.Cartesian3.negate(up, new Cesium.Cartesian3()),
      upWC: north,
      frustum: new Cesium.PerspectiveFrustum({
        fov: Math.PI / 3,
        aspectRatio: 1440 / 860,
        near: 1,
        far: 50_000_000,
      }),
    },
    scene: { mode: Cesium.SceneMode.SCENE3D, canvas: { clientHeight: 860 } },
  };
}

test('cable point residency follows the padded viewport without losing entity identity or selected details', () => {
  const viewer = viewerAt(-98, 38),
    source = new Cesium.CustomDataSource();
  const near = new Cesium.Entity({
    id: 'near',
    position: Cesium.Cartesian3.fromDegrees(-98, 38),
    properties: { name: 'Near' },
  });
  const far = new Cesium.Entity({
    id: 'far',
    position: Cesium.Cartesian3.fromDegrees(100, 15),
    properties: { name: 'Far' },
  });
  const records = [near, far].map((entity) => ({
    entity,
    base: entity.position.getValue(),
  }));
  const pass = cableViewportPass(viewer);
  for (const record of records)
    syncCableResidency(
      source,
      record.entity,
      pass.visible(record, false),
      viewer,
    );
  assert.deepEqual(
    source.entities.values.map((entity) => entity.id),
    ['near'],
  );
  viewer.selectedEntity = near;
  syncCableResidency(source, near, false, viewer);
  assert.equal(
    source.entities.contains(near),
    true,
    'selected detail keeps its native entity',
  );
  viewer.selectedEntity = undefined;
  syncCableResidency(source, near, false, viewer);
  assert.equal(source.entities.values.length, 0);
  syncCableResidency(source, near, true, viewer);
  assert.equal(
    source.entities.getById('near'),
    near,
    'returning to the view reuses the original identity',
  );
  assert.equal(near.properties.name.getValue(), 'Near');
});

test('a route crossing the view stays admitted even when its label reference is elsewhere, including the dateline', () => {
  for (const [lon, coordinates] of [
    [-98, [-101, 38, -95, 38]],
    [180, [179, 38, -179, 38]],
  ]) {
    const viewer = viewerAt(lon, 38),
      pass = cableViewportPass(viewer);
    const record = {
      entity: new Cesium.Entity({
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArray(coordinates),
        },
      }),
      base: Cesium.Cartesian3.fromDegrees(0, -70),
    };
    assert.equal(pass.visible(record, false), true);
  }
});

test('non-3D and incomplete viewers preserve the legacy visibility path', () => {
  assert.equal(cableViewportPass({ camera: {}, scene: {} }), null);
  const viewer = viewerAt(-98, 38);
  viewer.scene.mode = Cesium.SceneMode.SCENE2D;
  assert.equal(cableViewportPass(viewer), null);
});

test('long and dateline routes split on their original rhumb curve, preserving vertices and seamless joins', () => {
  const positions = Cesium.Cartesian3.fromDegreesArray([
    160, 38, 179, 38, -160, 38, -100, 20,
  ]);
  const chunks = splitCablePositions(positions);
  assert.ok(chunks.length > 10);
  for (const position of positions)
    assert.ok(chunks.some((chunk) => chunk.includes(position)));
  for (let i = 1; i < chunks.length; i++)
    assert.equal(chunks[i][0], chunks[i - 1].at(-1));
  const rhumb = new Cesium.EllipsoidRhumbLine(
    Cesium.Cartographic.fromCartesian(positions[0]),
    Cesium.Cartographic.fromCartesian(positions[1]),
  );
  const firstInserted = Cesium.Cartographic.fromCartesian(chunks[0][1]);
  const expected = rhumb.interpolateUsingFraction(
    1 / Math.ceil(rhumb.surfaceDistance / 500000),
  );
  assert.ok(Math.abs(firstInserted.longitude - expected.longitude) < 1e-12);
  assert.ok(Math.abs(firstInserted.latitude - expected.latitude) < 1e-12);
});

test('tight route bounds enclose the entire curve, including polar and dateline arcs', () => {
  for (const coords of [
    [160, 38, -160, 38],
    [-98, 20, -60, 45],
    [10, 89, 170, 89],
  ]) {
    const positions = Cesium.Cartesian3.fromDegreesArray(coords),
      bound = rhumbPositionBounds(positions);
    const curve = new Cesium.EllipsoidRhumbLine(
      Cesium.Cartographic.fromCartesian(positions[0]),
      Cesium.Cartographic.fromCartesian(positions[1]),
    );
    for (let i = 0; i <= 1000; i++) {
      const point = Cesium.Ellipsoid.WGS84.cartographicToCartesian(
        curve.interpolateUsingFraction(i / 1000),
      );
      assert.ok(
        Cesium.Cartesian3.distance(point, bound.center) <= bound.radius,
      );
    }
  }
});

test('segment descriptors allocate native geometry only in view and retain style, classification, metadata and pick ownership', () => {
  const viewer = viewerAt(-98, 38),
    source = new Cesium.CustomDataSource();
  const entity = new Cesium.Entity({
    id: 'route',
    polyline: {
      positions: Cesium.Cartesian3.fromDegreesArray([-120, 38, -70, 38]),
      material: Cesium.Color.CYAN.withAlpha(0.92),
      width: 2.5,
      arcType: Cesium.ArcType.RHUMB,
      clampToGround: true,
    },
  });
  const info = {
    kind: 'cable',
    reference: { lon: -98, lat: 38 },
    label: 'Route',
  };
  const records = cableSegmentRecords(
    entity,
    { properties: { id: 'route', name: 'Route' } },
    source,
    info,
    Cesium.ClassificationType.TERRAIN,
  );
  assert.ok(records.length > 5);
  assert.equal(source.entities.values.length, 0);
  const pass = cableViewportPass(viewer);
  for (const record of records)
    syncCableSegment(record, pass.visible(record, false), viewer);
  assert.ok(
    source.entities.values.length > 0 &&
      source.entities.values.length < records.length,
  );
  const record = records.find((row) => row.entity),
    native = record.entity,
    time = Cesium.JulianDate.now();
  assert.equal(native.__gevTeleGeography, info);
  assert.equal(native.polyline.width.getValue(time), 2.5);
  assert.equal(native.polyline.arcType.getValue(time), Cesium.ArcType.RHUMB);
  assert.equal(
    native.polyline.classificationType.getValue(time),
    Cesium.ClassificationType.TERRAIN,
  );
  assert.equal(native.polyline.material.getValue(time).color.alpha, 0.92);
  syncCableSegment(record, false, viewer);
  assert.equal(record.entity, null);
  assert.equal(
    native.show,
    true,
    'eviction must not enqueue visibility changes on removed ground geometry',
  );
  syncCableSegment(record, true, viewer);
  assert.equal(record.entity.id, native.id);
  assert.equal(record.entity.properties.name.getValue(), 'Route');
});
