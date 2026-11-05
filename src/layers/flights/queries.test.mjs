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
    _scratchCarto: new Cesium.Cartographic(),
    _models: new Map(),
    _detectionObjects: new Map(),
    records: { data: new Map([['abc123', info]]), missingPolls: new Map() },
  };
  let formats = 0;
  const services = {
    aircraftPresentation: { tr3bTypeLabel: (_id, label) => label, tr3bAircraftClass: (_id, klass) => klass },
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
    tracking: { _trackedModelRegimeActive: () => true, _routeIsPlausible: () => false },
    motion: { _trackedVisualCached: () => null, _deadReckon: () => null },
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

test('exact flight lookup scans all loaded contacts, not prefixes or the capped roster', () => {
  const f = fixture();
  f.bb.position = Cesium.Cartesian3.fromDegrees(-73, 40, 1000);
  f.info.observedReceiptMs = 123456;
  const one = f.queries.findExactFlightMatches({ kind: 'callsign', value: 'TEST123' });
  assert.equal(one.status, 'found');
  assert.equal(one.matches.length, 1);
  assert.equal(one.matches[0].icao24, 'abc123');
  assert.equal(one.matches[0].observedAtMs, 123456);
  assert.ok(Math.abs(one.matches[0].latitude - 40) < 0.01);
  assert.equal(f.queries.findExactFlightMatches({ kind: 'callsign', value: 'TEST' }).status, 'missing');
  assert.equal(f.queries.findExactFlightMatches({ kind: 'icao24', value: 'abc123' }).matches.length, 1);
});

test('callsign collisions and hex/callsign collisions never auto-pick a first match', () => {
  const f = fixture();
  f.bb.position = Cesium.Cartesian3.fromDegrees(10, 20, 2500);
  f.flightState.records.data.set('def456', { callsign: 'TEST123' });
  f.flightState._billboards.set('def456', { position: Cesium.Cartesian3.fromDegrees(11, 21, 3200), show: true });
  const same = f.queries.findExactFlightMatches({ kind: 'callsign', value: 'TEST123' });
  assert.equal(same.status, 'found');
  assert.equal(same.matches.length, 2);
  f.info.callsign = 'ABC123';
  const uncertain = f.queries.findExactFlightMatches({ kind: 'either', value: 'ABC123' });
  assert.equal(uncertain.matches.length, 1);
  f.flightState.records.data.set('abc124', { callsign: 'ABC123' });
  f.flightState._billboards.set('abc124', { position: Cesium.Cartesian3.fromDegrees(12, 22, 3500), show: true });
  assert.equal(f.queries.findExactFlightMatches({ kind: 'either', value: 'ABC123' }).matches.length, 2);
});

test('disabled, unloaded and stale flight data cannot look like a fresh selection', () => {
  const f = fixture();
  f.bb.position = Cesium.Cartesian3.fromDegrees(10, 20, 2300);
  f.flightState._billboardCollection.show = false;
  assert.equal(f.queries.findExactFlightMatches({ kind: 'callsign', value: 'TEST123' }).status, 'disabled');
  f.flightState._billboardCollection.show = true;
  f.flightState.records.missingPolls.set('abc123', 1);
  assert.equal(f.queries.findExactFlightMatches({ kind: 'callsign', value: 'TEST123' }).status, 'stale');
  f.flightState.records.missingPolls.clear();
  f.flightState._billboards.clear();
  assert.equal(f.queries.findExactFlightMatches({ kind: 'callsign', value: 'TEST123' }).status, 'unavailable');
});
