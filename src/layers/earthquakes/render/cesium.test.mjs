import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import * as geo from '../../../geo/index.js';
import { createEarthquakesLayer } from '../index.js';
import { createEarthquakesCesiumRenderer } from './cesium.js';

const rows = [
  {
    stableId: 'a',
    usgsId: 'us-a',
    lon: -122.42,
    lat: 37.77,
    depthKm: 8,
    mag: 2.5,
    place: 'A',
    time: 1000,
  },
  {
    stableId: 'b',
    usgsId: 'us-b',
    lon: 30,
    lat: 20,
    depthKm: 70,
    mag: 5,
    place: 'B',
    time: 2000,
  },
  {
    stableId: 'c',
    usgsId: null,
    lon: 150,
    lat: -30,
    depthKm: 300,
    mag: 6,
    place: 'C',
    time: 3000,
  },
];
function harness() {
  const sources = new Set();
  const viewer = {
    dataSources: {
      add(source) {
        sources.add(source);
      },
      remove(source, destroy) {
        assert.equal(destroy, true);
        return sources.delete(source);
      },
    },
  };
  let snapshot = rows;
  const layer = createEarthquakesLayer({
    source: {
      async getSnapshot() {
        if (snapshot instanceof Error) throw snapshot;
        return snapshot;
      },
    },
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
    renderer: {
      create: (options) => createEarthquakesCesiumRenderer(null, options),
    },
  });
  layer.init(viewer);
  layer.enable();
  return {
    viewer,
    sources,
    layer,
    setSnapshot(value) {
      snapshot = value;
    },
  };
}

test('extracted native ground discs preserve static axes, depth palette and analyst identity', async () => {
  const h = harness();
  try {
    assert.equal(await h.layer.update(), true);
    const dataSource = [...h.sources][0];
    const now = Cesium.JulianDate.now();
    const colors = [Cesium.Color.RED, Cesium.Color.ORANGE, Cesium.Color.YELLOW];
    dataSource.entities.values.forEach((entity, index) => {
      const row = rows[index];
      const ellipse = entity.ellipse;
      assert.equal(entity.id, `earthquake:${row.stableId}`);
      assert.equal(ellipse.semiMajorAxis.isConstant, true);
      assert.equal(ellipse.semiMinorAxis.getValue(now), 2 ** row.mag * 1000);
      assert.equal(ellipse.semiMajorAxis.getValue(now), 2 ** row.mag * 1000);
      assert.equal(
        ellipse.heightReference.getValue(now),
        Cesium.HeightReference.CLAMP_TO_GROUND,
      );
      assert.equal(ellipse.outlineWidth.getValue(now), row.mag >= 5 ? 3 : 2);
      assert.deepEqual(
        { ...ellipse.material.color.getValue(now) },
        { ...colors[index].withAlpha(row.mag >= 5 ? 0.4 : 0.3) },
      );
      const expected = Cesium.Cartesian3.fromDegrees(row.lon, row.lat);
      assert.deepEqual(entity.position.getValue(now), expected);
      assert.deepEqual(
        { ...geo.cartesian3.fromDegrees(row.lon, row.lat) },
        {
          x: expected.x,
          y: expected.y,
          z: expected.z,
        },
      );
    });
    const records = h.layer.getAnalystRecords();
    assert.deepEqual(
      records.map((r) => r.id),
      ['us-a', 'us-b', 'QUAKE-0002'],
    );
    assert.equal(h.layer.getAnalystRecords(1).length, 1);
    assert.equal(h.layer.getAnalystRecords(0).length, 1);
    assert.equal(h.layer.getAnalystRecords(Infinity).length, 3);
    h.layer.disable();
    assert.deepEqual(h.layer.getAnalystRecords(), []);
    assert.equal(dataSource.show, false);
  } finally {
    h.layer.destroy();
  }
  assert.equal(h.sources.size, 0);
});

test('failed native refresh retains the last complete geometry and analyst snapshot', async () => {
  const h = harness();
  try {
    await h.layer.update();
    const source = [...h.sources][0];
    const before = [...source.entities.values];
    const records = h.layer.getAnalystRecords();
    h.setSnapshot(new Error('fixture source unavailable'));
    assert.equal(await h.layer.update(), false);
    assert.deepEqual(source.entities.values, before);
    assert.deepEqual(h.layer.getAnalystRecords(), records);
    assert.equal(h.layer.getStats().error, 'fixture source unavailable');
    h.setSnapshot([]);
    assert.equal(await h.layer.update(), true);
    assert.equal(source.entities.values.length, 0);
    assert.equal(h.layer.getStats().error, null);
  } finally {
    h.layer.destroy();
  }
});

test('renderer destroys its owner even when passed another viewer and repeated destroy is safe', () => {
  const h = harness();
  const alien = {
    dataSources: {
      remove() {
        assert.fail('must not remove from another viewer');
      },
    },
  };
  h.layer.destroy(alien);
  h.layer.destroy(alien);
  assert.equal(h.sources.size, 0);
});
