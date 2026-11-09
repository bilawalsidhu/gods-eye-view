import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createQueries } from './queries.js';
import { createRendering } from './rendering.js';

function fixture() {
  const info = {
    callsign: ' TEST123 ',
    registration: ' N123 ',
    altitude: 1000,
  };
  const bb = { show: true, position: new Cesium.Cartesian3(1, 2, 3) };
  const flightState = {
    feed: {},
    _billboardCollection: { show: true },
    _billboards: new Map([['abc123', bb]]),
    _models: new Map(),
    _detectionObjects: new Map(),
    records: { data: new Map([['abc123', info]]) },
  };
  let formats = 0;
  const services = {
    aircraftPresentation: {},
    militaryRegistry: {},
    camera: {},
    focus: {},
    recession: {},
    labels: {
      formatFlightLevel: (altitude) => {
        formats++;
        return String(altitude);
      },
    },
  };
  const parts = {
    testing: {},
    tracking: { _trackedModelRegimeActive: () => true },
    motion: { _trackedVisualCached: () => null },
  };
  parts.rendering = createRendering({ flightState, services, parts });
  const queries = createQueries({ flightState, services, parts }).methods;
  return { flightState, info, bb, parts, queries, formats: () => formats };
}

test('candidate text follows in-place enrichment without freezing identity or positions', () => {
  const f = fixture();
  const [first] = f.queries.getDetectableObjects();
  assert.equal(first.id, 'TEST123');
  assert.equal(first.sourceId, 'abc123');
  f.bb.position = new Cesium.Cartesian3(4, 5, 6);
  assert.equal(f.queries.getDetectableObjects()[0], first);
  assert.equal(first.position, f.bb.position);
  assert.equal(f.formats(), 1);
  f.info.callsign = ' NEW456 ';
  assert.equal(f.queries.getDetectableObjects()[0].id, 'NEW456');
  f.info.callsign = '   ';
  assert.equal(f.queries.getDetectableObjects()[0].id, 'N123');
  f.info.registration = ' N456 ';
  f.info.altitude = 2000;
  assert.equal(f.queries.getDetectableObjects()[0].id, 'N456');
  assert.equal(first.metric, '2000');
  assert.equal(f.formats(), 2);
  f.flightState.records.data.set('abc123', { ...f.info });
  assert.equal(f.queries.getDetectableObjects()[0], first);
  f.flightState.records.data.delete('abc123');
  assert.equal(f.queries.getDetectableObjects()[0].id, 'abc123');
  assert.equal(first.sourceId, 'abc123');
});

test('unchanged candidate text is normalized once across paints', (t) => {
  const f = fixture();
  const trim = String.prototype.trim;
  let calls = 0;
  t.mock.method(String.prototype, 'trim', function () {
    if (String(this) === ' TEST123 ') calls++;
    return trim.call(this);
  });
  for (let i = 0; i < 20; i++) f.queries.getDetectableObjects();
  assert.equal(calls, 1);
});

test('candidate collection resolves models once and keeps handoffs live', (t) => {
  const f = fixture();
  const get = t.mock.method(f.flightState._models, 'get');
  const [candidate] = f.queries.getDetectableObjects();
  assert.equal(get.mock.callCount(), 1);
  const model = {
    ready: false,
    show: true,
    modelMatrix: Cesium.Matrix4.fromTranslation(
      new Cesium.Cartesian3(10, 20, 30),
    ),
  };
  f.parts.rendering._modelSpec = () => ({
    visualCenterNative: Cesium.Cartesian3.ZERO,
    scale: 1,
  });
  f.flightState._models.set('abc123', model);
  f.bb.show = false;
  assert.deepEqual(f.queries.getDetectableObjects(), []);
  model.ready = true;
  assert.equal(f.queries.getDetectableObjects()[0], candidate);
  assert.deepEqual(candidate.position, new Cesium.Cartesian3(10, 20, 30));
  Cesium.Matrix4.setTranslation(
    model.modelMatrix,
    new Cesium.Cartesian3(40, 50, 60),
    model.modelMatrix,
  );
  f.queries.getDetectableObjects();
  assert.deepEqual(candidate.position, new Cesium.Cartesian3(40, 50, 60));
  model.show = false;
  assert.deepEqual(f.queries.getDetectableObjects(), []);
  f.bb.show = true;
  assert.equal(f.queries.getDetectableObjects()[0].position, f.bb.position);
  assert.equal(get.mock.callCount(), 6);
  model.show = true;
  assert.equal(f.parts.rendering._modelOwnsVisual('abc123'), true);
  assert.equal(get.mock.callCount(), 7);
});

test('tracked ownership and live anchors remain independent of fleet models', () => {
  const f = fixture();
  f.flightState._trackedIcao = 'abc123';
  f.flightState._trackedModel = { ready: true, show: true };
  f.parts.rendering._modelSpec = () => ({});
  let anchor = new Cesium.Cartesian3(10, 20, 30);
  f.parts.motion._trackedVisualCached = () => anchor;
  const [candidate] = f.queries.getDetectableObjects();
  assert.equal(candidate.position, anchor);
  assert.equal(candidate.skipLabel, true);
  assert.equal(f.parts.rendering._modelOwnsVisual('abc123', null), true);
  anchor = new Cesium.Cartesian3(40, 50, 60);
  assert.equal(f.queries.getDetectableObjects()[0].position, anchor);
  for (const tracked of [
    null,
    { ready: false, show: true },
    { ready: true, show: false },
  ]) {
    f.flightState._trackedModel = tracked;
    assert.equal(
      f.parts.rendering._modelOwnsVisual('abc123', { ready: true, show: true }),
      false,
    );
  }
  f.flightState._trackedModel = { ready: true, show: true };
  f.parts.tracking._trackedModelRegimeActive = () => false;
  assert.equal(f.parts.rendering._modelOwnsVisual('abc123', null), false);
});
