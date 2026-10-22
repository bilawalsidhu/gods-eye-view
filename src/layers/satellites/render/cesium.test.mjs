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

test('native own follow release is guarded without hiding later external release', () => {
  const event = new Cesium.Event();
  let entity = { id: 'satellite' };
  const viewer = {
    trackedEntityChanged: event,
    get trackedEntity() {
      return entity;
    },
    set trackedEntity(value) {
      entity = value;
      event.raiseEvent(value);
    },
  };
  const renderer = createSatellitesCesiumRenderer(null, { viewer });
  const guards = [];
  renderer.follow.onChanged(() => guards.push(renderer.follow.releasing()));
  renderer.follow.release();
  viewer.trackedEntity = { id: 'other' };
  viewer.trackedEntity = undefined;
  assert.deepEqual(guards, [true, false, false]);
  assert.equal(renderer.follow.releasing(), false);
});

test('native follow takeover reports its starting entity through an intermediate null', () => {
  const event = new Cesium.Event();
  let current = { id: 'foreign' };
  const viewer = {
    clock: { currentTime: Cesium.JulianDate.now() },
    trackedEntityChanged: event,
    get trackedEntity() {
      return current;
    },
    set trackedEntity(v) {
      current = v;
      event.raiseEvent();
    },
  };
  const engine = {
    camera: {
      follow: ({ native }) => {
        viewer.trackedEntity = undefined;
        viewer.trackedEntity = native;
      },
    },
  };
  const renderer = createSatellitesCesiumRenderer(engine, { viewer });
  const entity = {
    id: 'own',
    position: {
      getValue() {
        return geo.cartesian3.ZERO;
      },
    },
    viewFrom: {
      getValue() {
        return geo.cartesian3.ZERO;
      },
    },
  };
  const seen = [];
  renderer.follow.onChanged(() => seen.push(renderer.follow.current()));
  renderer.follow.start(entity);
  assert.deepEqual(seen, [entity, entity]);
  assert.equal(renderer.follow.current(), entity);
});
