import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createUsgsWaterRenderer } from './renderer.js';

const sites = [
  {
    id: 'USGS-08100001',
    name: 'Creek',
    lon: -98.5,
    lat: 29.42,
    numericReadingCount: 2,
  },
  {
    id: 'USGS-295000098200001',
    name: 'Well',
    lon: -98.492,
    lat: 29.424,
    numericReadingCount: 0,
  },
];
test('renderer places one ground-clamped entity per station without using stage or groundwater as altitude', async () => {
  const viewer = {
    dataSources: new Cesium.DataSourceCollection(),
    scene: { requestRender() {} },
  };
  const renderer = createUsgsWaterRenderer({ viewer });
  await renderer.replace(
    sites.map((site) => ({ ...site, stage: -30, groundwater: 5000 })),
  );
  assert.equal(viewer.dataSources.length, 1);
  const source = viewer.dataSources.get(0);
  assert.equal(source.entities.values.length, 2);
  const point = source.entities.getById(sites[0].id);
  const time = Cesium.JulianDate.now();
  assert.equal(
    point.point.heightReference.getValue(time),
    Cesium.HeightReference.CLAMP_TO_GROUND,
  );
  assert.ok(
    Math.abs(
      Cesium.Cartographic.fromCartesian(point.position.getValue(time)).height,
    ) < 1e-6,
  );
  renderer.setVisible(true);
  assert.equal(source.show, true);
  renderer.destroy();
  assert.equal(viewer.dataSources.length, 0);
  assert.equal(source.entities.values.length, 0);
});
test('late data-source add after destroy cannot leave an orphan station layer', async () => {
  let settle;
  const items = new Set();
  const viewer = {
    dataSources: {
      add(source) {
        return new Promise((resolve) => {
          settle = () => {
            items.add(source);
            resolve(source);
          };
        });
      },
      remove(source) {
        items.delete(source);
      },
    },
    scene: { requestRender() {} },
  };
  const renderer = createUsgsWaterRenderer({ viewer });
  const loading = renderer.replace(sites);
  renderer.destroy();
  settle();
  assert.equal(await loading, false);
  assert.equal(items.size, 0);
});
