import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import * as geo from '../../../geo/index.js';
import { createSatellitesCesiumRenderer } from './cesium.js';

test('native satellite viewFrom fills the scratch vector used by EntityView', () => {
  const viewer = { entities: new Cesium.EntityCollection() };
  const renderer = createSatellitesCesiumRenderer(null, { viewer });
  const viewFrom = geo.cartesian3.create(-450000, -450000, 350000);
  const entity = renderer.createTracked({
    position: () => geo.cartesian3.fromDegrees(0, 0, 420000),
    viewFrom,
  });
  assert.equal(
    entity.trackingReferenceFrame,
    Cesium.TrackingReferenceFrame.ENU,
  );
  const scratch = new Cesium.Cartesian3();
  const value = entity.viewFrom.getValue(Cesium.JulianDate.now(), scratch);
  assert.equal(value, scratch);
  assert.deepEqual(
    [scratch.x, scratch.y, scratch.z],
    [viewFrom.x, viewFrom.y, viewFrom.z],
  );
  renderer.removeTracked(entity);
  assert.equal(viewer.entities.values.length, 0);
});

test('native satellite follow goes through the shared camera contract', () => {
  let options;
  const viewer = {
    entities: new Cesium.EntityCollection(),
    clock: { currentTime: Cesium.JulianDate.now() },
  };
  const engine = {
    camera: {
      follow: (spec) => {
        options = spec;
      },
    },
  };
  const renderer = createSatellitesCesiumRenderer(engine, { viewer });
  const position = geo.cartesian3.fromDegrees(0, 0, 20200000);
  const offset = geo.cartesian3.create(-1800000, -1800000, 1400000);
  const entity = renderer.createTracked({
    position: () => position,
    viewFrom: offset,
  });
  renderer.follow.start(entity);
  assert.equal(options.native, entity);
  assert.equal(options.position(), position);
  assert.deepEqual({ ...options.viewFrom() }, { ...offset });
});
