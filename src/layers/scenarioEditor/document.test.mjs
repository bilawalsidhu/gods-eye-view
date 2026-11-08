import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_ALT_FT,
  DEFAULT_SPEED_KT,
  addAircraft,
  appendWaypoint,
  clearWaypoints,
  documentSummary,
  emptyDocument,
  nextAircraftId,
  parseDocument,
  playableDocument,
  removeAircraft,
  removeLastWaypoint,
  serializeDocument,
  setAircraftLoop,
  validateDocument,
  waypointDefaults,
  withCameras,
} from './document.js';

test('an empty document grows aircraft with generated ids and waypoints with inherited values', () => {
  const empty = emptyDocument('demo', 'Demo');
  assert.deepEqual(empty, { version: 1, id: 'demo', title: 'Demo', aircraft: [], cameras: [] });
  assert.throws(() => emptyDocument('Bad Id'), /scenario id/);
  const { doc: one, id } = addAircraft(empty);
  assert.equal(id, 'aircraft-1');
  assert.equal(one.aircraft[0].callsign, 'AIRCRAFT1');
  assert.equal(one.aircraft[0].loop, true);
  assert.equal(empty.aircraft.length, 0, 'operations never mutate their input');
  assert.deepEqual(waypointDefaults(one, id), { altFt: DEFAULT_ALT_FT, speedKt: DEFAULT_SPEED_KT });
  const two = appendWaypoint(one, id, { lat: 37.8, lon: -122.4, altFt: 1500, speedKt: 300 });
  const three = appendWaypoint(two, id, { lat: 37.81, lon: -122.39 });
  assert.deepEqual(three.aircraft[0].waypoints[1], { lat: 37.81, lon: -122.39, altFt: 1500, speedKt: 300 });
  assert.equal(nextAircraftId(three), 'aircraft-2');
  assert.throws(() => appendWaypoint(three, 'ghost', { lat: 0, lon: 0 }), /no aircraft/);
  assert.throws(() => appendWaypoint(three, id, { lat: 99, lon: 0 }), /lat\/lon/);
  assert.throws(() => addAircraft(three, { id: 'aircraft-1' }), /exists/);
});

test('undo, clear, loop and remove edit one aircraft and keep cameras consistent', () => {
  let doc = addAircraft(emptyDocument()).doc;
  doc = appendWaypoint(doc, 'aircraft-1', { lat: 1, lon: 1 });
  doc = appendWaypoint(doc, 'aircraft-1', { lat: 2, lon: 2 });
  doc = withCameras(doc, [{ id: 'cam', type: 'chase', target: 'aircraft-1' }]);
  assert.equal(removeLastWaypoint(doc, 'aircraft-1').aircraft[0].waypoints.length, 1);
  assert.equal(clearWaypoints(doc, 'aircraft-1').aircraft[0].waypoints.length, 0);
  assert.equal(setAircraftLoop(doc, 'aircraft-1', false).aircraft[0].loop, false);
  const removed = removeAircraft(doc, 'aircraft-1');
  assert.equal(removed.aircraft.length, 0);
  assert.equal(removed.cameras[0].target, null, 'a camera loses a removed target');
  assert.deepEqual(documentSummary(doc), { aircraft: 1, waypoints: 2, cameras: 1 });
});

test('playableDocument keeps only flyable aircraft and valid camera targets', () => {
  let doc = addAircraft(emptyDocument()).doc;
  doc = addAircraft(doc).doc;
  doc = appendWaypoint(doc, 'aircraft-1', { lat: 1, lon: 1 });
  doc = appendWaypoint(doc, 'aircraft-1', { lat: 2, lon: 2 });
  doc = appendWaypoint(doc, 'aircraft-2', { lat: 3, lon: 3 });
  doc = withCameras(doc, [
    { id: 'a', type: 'chase', target: 'aircraft-1' },
    { id: 'b', type: 'chase', target: 'aircraft-2' },
    { id: 'c', type: 'orbit' },
  ]);
  const playable = playableDocument(doc);
  assert.deepEqual(playable.aircraft.map((entry) => entry.id), ['aircraft-1']);
  assert.deepEqual(playable.cameras.map((camera) => camera.id), ['a', 'c']);
  assert.equal(validateDocument(playable).ok, true);
  assert.equal(validateDocument(doc).ok, false, 'a one-waypoint aircraft is not loadable');
});

test('serialize and parse round-trip; bad files are refused with a reason', () => {
  let doc = addAircraft(emptyDocument('x', 'X')).doc;
  doc = appendWaypoint(doc, 'aircraft-1', { lat: 1, lon: 1 });
  doc = appendWaypoint(doc, 'aircraft-1', { lat: 2, lon: 2 });
  const text = serializeDocument(doc);
  assert.ok(text.endsWith('\n'));
  const parsed = parseDocument(text);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.doc, doc);
  assert.match(parseDocument('{nope').error, /not JSON/);
  assert.match(parseDocument('{"version":1,"id":"x","aircraft":[]}').error, /non-empty/);
  const camerasDefault = parseDocument(JSON.stringify({ ...doc, cameras: undefined }));
  assert.deepEqual(camerasDefault.doc.cameras, []);
});

test('withCameras replaces by id and appends new ones', () => {
  const doc = withCameras(emptyDocument(), [{ id: 'a', type: 'orbit', radiusM: 10 }]);
  const merged = withCameras(doc, [{ id: 'a', type: 'orbit', radiusM: 20 }, { id: 'b', type: 'chase' }]);
  assert.deepEqual(merged.cameras.map((camera) => [camera.id, camera.radiusM]), [['a', 20], ['b', undefined]]);
});
