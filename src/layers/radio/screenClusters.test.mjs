import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { clusterRadioPoints, createRadioPointOrder } from './screenClusters.js';

test('radio cluster seed order follows native FIFO point reuse across filters and reloads', () => {
  const native = new Cesium.EntityCluster();
  const items = [];
  native._pointCollection = {
    get length() {
      return items.length;
    },
    get: (i) => items[i],
    add() {
      const item = {};
      items.push(item);
      return item;
    },
  };
  const order = createRadioPointOrder();
  const records = Array.from({ length: 12 }, (_, i) => ({
    station: { id: String(i) },
    visible: true,
  }));
  const update = (visible = true) => {
    for (const record of records) {
      const entity = { id: record.station.id };
      if (!visible || !record.visible) native.removePoint(entity);
      else Object.assign(native.getPoint(entity), { id: entity, show: true });
    }
    assert.deepEqual(
      order.update(records, visible).map((record) => record.station.id),
      items.filter((item) => item.show).map((item) => item.id.id),
    );
  };
  update();
  for (const remainder of [0, 1, 2, 0]) {
    for (let i = 0; i < records.length; i++)
      records[i].visible = i % 3 === remainder;
    update();
  }
  update(false);
  update();
  for (const record of [...records].reverse())
    native.removePoint({ id: record.station.id });
  order.clear(records);
  for (const record of records) record.visible = true;
  update();
});

// Execute the installed SDK's actual declutter callback. Only projection and
// drawing collections are supplied by the fixture; clustering is not mocked.
function nativeOracle(records, project) {
  const native = new Cesium.EntityCluster({
    enabled: true,
    pixelRange: 42,
    minimumClusterSize: 3,
    clusterLabels: false,
    clusterBillboards: false,
  });
  const scene = {
    mode: Cesium.SceneMode.SCENE3D,
    ellipsoid: Cesium.Ellipsoid.WGS84,
    camera: {
      changed: new Cesium.Event(),
      positionWC: new Cesium.Cartesian3(20_000_000, 0, 0),
      positionCartographic: { height: 10_000_000 },
    },
  };
  native._initialize(scene);
  const drawing = () => ({
    items: [],
    get length() {
      return this.items.length;
    },
    add() {
      const item = {};
      this.items.push(item);
      return item;
    },
    removeAll() {
      this.items = [];
    },
    destroy() {},
  });
  const items = records.map((record) => ({
    position: record.position,
    id: { id: record.station.id, _point: {} },
    show: record.visible,
    pixelSize: 13,
    _pointPrimitiveCollection: {},
    computeScreenSpacePosition: () => project(record.position),
  }));
  native._pointCollection = { length: items.length, get: (i) => items[i] };
  let output = [];
  native.clusterEvent.addEventListener((ids, cluster) =>
    output.push({
      stationIds: ids.map(({ id }) => id),
      position: { ...cluster.point.position },
    }),
  );
  return {
    run(height) {
      output = [];
      for (let i = 0; i < items.length; i++) items[i].show = records[i].visible;
      native._clusterLabelCollection = drawing();
      native._clusterBillboardCollection = drawing();
      native._clusterPointCollection = drawing();
      scene.camera.positionCartographic.height = height;
      native._cluster();
      return {
        clusters: output,
        singletons: items
          .filter((item) => item.show && item.clusterShow)
          .map((item) => item.id.id),
        retained: native._previousClusters,
      };
    },
  };
}

test('radio screen clustering matches native membership, anchor and retained zoom clusters', (t) => {
  const original = Cesium.Billboard._computeScreenSpacePosition;
  let zoom = 1;
  const project = (p) =>
    p.x < 0 ? undefined : { x: p.y * zoom, y: p.z * zoom };
  Cesium.Billboard._computeScreenSpacePosition = (_matrix, position) =>
    project(position);
  t.after(() => {
    Cesium.Billboard._computeScreenSpacePosition = original;
  });
  const datasets = [
    [
      [0, 0],
      [48.5, 0],
      [0, 48.5],
      [48.50001, 0],
      [200, 200],
      [205, 205],
    ],
    Array.from({ length: 750 }, (_, i) => [
      Math.sin(i * 9.17) * 800,
      Math.cos(i * 4.13) * 500,
    ]),
    Array.from({ length: 100 }, (_, i) => [i * 45, 0]),
  ];
  for (const dataset of datasets) {
    const records = dataset.map(([y, z], i) => ({
      station: { id: String(i) },
      visible: true,
      position: { x: 6_378_140, y, z },
    }));
    const oracle = nativeOracle(records, project);
    let previousClusters = [],
      previousHeight;
    for (const [height, scale, filter] of [
      [10e6, 1, false],
      [9e6, 1.1, false],
      [8e6, 1.2, true],
      [3e6, 3, true],
      [12e6, 0.8, false],
      [12e6, 0.8, true],
    ]) {
      zoom = scale;
      records.forEach((record, i) => {
        record.visible = !filter || i % 3 !== 0;
      });
      const expected = oracle.run(height);
      const actual = clusterRadioPoints({
        records,
        project,
        horizonVisible: () => true,
        height,
        previousHeight,
        previousClusters,
      });
      assert.deepEqual(
        actual.clusters.map(({ stationIds, position }) => ({
          stationIds,
          position,
        })),
        expected.clusters,
      );
      assert.deepEqual(actual.singletons, expected.singletons);
      assert.deepEqual(
        actual.clusters.map(({ stationIds, ...rest }) => rest),
        expected.retained.map(({ position, ...rest }) => ({
          position: { ...position },
          ...rest,
        })),
      );
      previousClusters = actual.clusters;
      previousHeight = height;
    }
  }
});

test('radio clustering drops hidden and unprojectable points and keeps a two-point group separate', () => {
  const records = Array.from({ length: 5 }, (_, i) => ({
    station: { id: String(i) },
    visible: i !== 2,
    position: { x: i, y: 0, z: 0 },
  }));
  const result = clusterRadioPoints({
    records,
    project: (p) => (p.x === 3 ? undefined : { x: p.x, y: 0 }),
    horizonVisible: (p) => p.x !== 4,
    height: 1,
  });
  assert.deepEqual(result, { clusters: [], singletons: ['0', '1'] });
});
