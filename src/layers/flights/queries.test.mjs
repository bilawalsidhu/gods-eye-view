import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createQueries } from './queries.js';
import { createRendering } from './rendering.js';
import { createIcons } from './icons.js';
import { createIconSet } from '../../data/iconSet.js';
import { writeHoldSegment } from '../../data/iconSegment.js';
import {
  createModelRecord,
  placeModel,
  showModel,
} from '../../data/modelRecord.js';

function fixture() {
  const info = {
    callsign: ' TEST123 ',
    registration: ' N123 ',
    altitude: 1000,
  };
  const icons = createIconSet();
  const flightState = {
    feed: {},
    _icons: icons,
    _scratchIconRenderTime: new Cesium.JulianDate(),
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
  parts.icons = createIcons({ flightState, services, parts });
  const queries = createQueries({ flightState, services, parts }).methods;
  const row = () => icons.row('abc123');
  /** Hold the contact's icon at `position`. */
  const place = (position) => {
    writeHoldSegment(icons.segments, row(), position, 0);
    icons.segmentWritten(row());
  };
  icons.add('abc123', { id: 'abc123' });
  place(new Cesium.Cartesian3(1, 2, 3));
  icons.setShown(row(), true);
  return {
    flightState,
    info,
    parts,
    queries,
    formats: () => formats,
    place,
    show: (shown) => icons.setShown(row(), shown),
    drawn: () => parts.icons._iconPosition('abc123'),
  };
}

test('candidate text follows in-place enrichment without freezing identity or positions', () => {
  const f = fixture();
  const [first] = f.queries.getDetectableObjects();
  assert.equal(first.id, 'TEST123');
  assert.equal(first.sourceId, 'abc123');
  f.place(new Cesium.Cartesian3(4, 5, 6));
  assert.equal(f.queries.getDetectableObjects()[0], first);
  assert.deepEqual(first.position, f.drawn());
  assert.deepEqual(first.position, new Cesium.Cartesian3(4, 5, 6));
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
  const record = createModelRecord({
    ready: false,
    show: true,
    modelMatrix: Cesium.Matrix4.fromTranslation(
      new Cesium.Cartesian3(10, 20, 30),
    ),
  });
  f.parts.rendering._modelSpec = () => ({
    visualCenterNative: Cesium.Cartesian3.ZERO,
    scale: 1,
  });
  f.flightState._models.set('abc123', record);
  f.show(false);
  assert.deepEqual(f.queries.getDetectableObjects(), []);
  record.model.ready = true;
  assert.equal(f.queries.getDetectableObjects()[0], candidate);
  assert.deepEqual(candidate.position, new Cesium.Cartesian3(10, 20, 30));
  placeModel(
    record,
    Cesium.Matrix4.fromTranslation(new Cesium.Cartesian3(40, 50, 60)),
  );
  f.queries.getDetectableObjects();
  assert.deepEqual(candidate.position, new Cesium.Cartesian3(40, 50, 60));
  showModel(record, false);
  assert.deepEqual(f.queries.getDetectableObjects(), []);
  f.show(true);
  assert.deepEqual(f.queries.getDetectableObjects()[0].position, f.drawn());
  assert.equal(get.mock.callCount(), 6);
  showModel(record, true);
  assert.equal(f.parts.rendering._modelOwnsVisual('abc123'), true);
  assert.equal(get.mock.callCount(), 7);
});

test('tracked ownership and live anchors remain independent of fleet models', () => {
  const f = fixture();
  f.flightState._trackedIcao = 'abc123';
  f.flightState._trackedModel = createModelRecord({ ready: true, show: true });
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
    createModelRecord({ ready: false, show: true }),
    createModelRecord({ ready: true, show: false }),
  ]) {
    f.flightState._trackedModel = tracked;
    assert.equal(
      f.parts.rendering._modelOwnsVisual('abc123', createModelRecord({ ready: true, show: true })),
      false,
    );
  }
  f.flightState._trackedModel = createModelRecord({ ready: true, show: true });
  f.parts.tracking._trackedModelRegimeActive = () => false;
  assert.equal(f.parts.rendering._modelOwnsVisual('abc123', null), false);
});
