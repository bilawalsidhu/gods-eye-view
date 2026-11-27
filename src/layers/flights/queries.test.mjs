import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createQueries } from './queries.js';
import { createRendering } from './rendering.js';
import { createIcons } from './icons.js';
import { createContactIcons } from '../../data/aircraftIconLayer.js';
import { createModelRecord, showModel } from '../../data/modelRecord.js';

/** A model record in a given load and show state, placed at `at` unturned. */
function modelRecord({ ready, show, at = null }) {
  const record = createModelRecord({});
  record.ready = ready;
  record.show = show;
  if (at) placeAt(record, at);
  return record;
}

/** Place a record at `at` with no turn, as a test of where it reads. */
function placeAt(record, at) {
  record.matrix = Float64Array.from(Cesium.Matrix4.fromTranslation(at));
  record.position = { x: at.x, y: at.y, z: at.z };
  record.placed = true;
}

function fixture() {
  const info = {
    callsign: ' TEST123 ',
    registration: ' N123 ',
    altitude: 1000,
  };
  const icons = createContactIcons();
  const flightState = {
    feed: {},
    _icons: icons,
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
  /** Hold the contact's icon at `position`. */
  const place = (position) =>
    icons.update(
      'abc123',
      {
        pos: { x: position.x, y: position.y, z: position.z },
        motion: { kind: 'hold', courseDeg: 0 },
      },
      { expiresAt: Infinity },
    );
  icons.put({ id: 'abc123', pos: { x: 0, y: 0, z: 0 }, show: true });
  place(new Cesium.Cartesian3(1, 2, 3));
  return {
    flightState,
    info,
    parts,
    queries,
    formats: () => formats,
    place,
    show: (shown) => icons.setShown('abc123', shown),
    drawn: () => parts.icons._iconPosition('abc123', { x: 0, y: 0, z: 0 }),
  };
}

test('candidate text follows in-place enrichment without freezing identity or positions', () => {
  const f = fixture();
  const [first] = f.queries.getDetectableObjects();
  assert.equal(first.id, 'TEST123');
  assert.equal(first.sourceId, 'abc123');
  f.place(new Cesium.Cartesian3(4, 5, 6));
  assert.equal(f.queries.getDetectableObjects()[0], first);
  assert.deepEqual({ ...first.position }, f.drawn());
  assert.deepEqual({ ...first.position }, { x: 4, y: 5, z: 6 });
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
  const record = modelRecord({
    ready: false,
    show: true,
    at: new Cesium.Cartesian3(10, 20, 30),
  });
  f.parts.rendering._modelSpec = () => ({
    visualCenterNative: Cesium.Cartesian3.ZERO,
    scale: 1,
  });
  f.flightState._models.set('abc123', record);
  f.show(false);
  assert.deepEqual(f.queries.getDetectableObjects(), []);
  record.ready = true;
  assert.equal(f.queries.getDetectableObjects()[0], candidate);
  assert.deepEqual({ ...candidate.position }, { x: 10, y: 20, z: 30 });
  placeAt(record, new Cesium.Cartesian3(40, 50, 60));
  f.queries.getDetectableObjects();
  assert.deepEqual({ ...candidate.position }, { x: 40, y: 50, z: 60 });
  showModel(record, false);
  assert.deepEqual(f.queries.getDetectableObjects(), []);
  f.show(true);
  assert.deepEqual({ ...f.queries.getDetectableObjects()[0].position }, f.drawn());
  assert.equal(get.mock.callCount(), 6);
  showModel(record, true);
  assert.equal(f.parts.rendering._modelOwnsVisual('abc123'), true);
  assert.equal(get.mock.callCount(), 7);
});

test('tracked ownership and live anchors remain independent of fleet models', () => {
  const f = fixture();
  f.flightState._trackedIcao = 'abc123';
  f.flightState._trackedModel = modelRecord({ ready: true, show: true });
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
    modelRecord({ ready: false, show: true }),
    modelRecord({ ready: true, show: false }),
  ]) {
    f.flightState._trackedModel = tracked;
    assert.equal(
      f.parts.rendering._modelOwnsVisual(
        'abc123',
        modelRecord({ ready: true, show: true }),
      ),
      false,
    );
  }
  f.flightState._trackedModel = modelRecord({ ready: true, show: true });
  f.parts.tracking._trackedModelRegimeActive = () => false;
  assert.equal(f.parts.rendering._modelOwnsVisual('abc123', null), false);
});

test('repeated collection with nothing moved hands back the same array, objects and vectors', () => {
  const f = fixture();
  const first = f.queries.getDetectableObjects();
  const [candidate] = first;
  const position = candidate.position;
  for (let i = 0; i < 5; i++) {
    const again = f.queries.getDetectableObjects();
    assert.equal(again, first, 'one result array, refilled');
    assert.equal(again.length, 1);
    assert.equal(again[0], candidate, 'one object per contact');
    assert.equal(
      again[0].position,
      position,
      'its position vector rewritten in place',
    );
  }
  assert.deepEqual({ ...position }, { x: 1, y: 2, z: 3 });
  // Moving rewrites the same vector; it does not hand out a new one.
  f.place(new Cesium.Cartesian3(7, 8, 9));
  assert.equal(f.queries.getDetectableObjects()[0].position, position);
  assert.deepEqual({ ...position }, { x: 7, y: 8, z: 9 });
  // The id list is read as kept, not copied per call.
  let copies = 0;
  const ids = f.flightState._icons.ids;
  f.flightState._icons.ids = () => {
    copies++;
    return ids();
  };
  for (let i = 0; i < 5; i++) f.queries.getDetectableObjects();
  assert.equal(copies, 0);
  // Hidden, the same (now empty) array comes back.
  f.flightState._icons.show = false;
  assert.equal(f.queries.getDetectableObjects(), first);
  assert.equal(first.length, 0);
});
