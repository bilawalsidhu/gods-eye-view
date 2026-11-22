import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bhoteKoshiEvidenceRecords } from './bhoteKoshiEvent.js';
import {
  bhoteKoshiPlaceRecords,
  createBhoteKoshiLocatorLayer,
} from './bhoteKoshiLocator.js';
import { INCIDENT_OVERVIEW_PLACES } from './bhoteKoshiIncidentPlaces.js';

const pack = JSON.parse(
  readFileSync(
    new URL('../../public/events/bhote-koshi-2026/event.json', import.meta.url),
    'utf8',
  ),
);

test('every geolocated evidence observation becomes a positioned record', () => {
  const records = bhoteKoshiEvidenceRecords(pack.evidenceSpine);
  assert.equal(records.length, pack.evidenceSpine.length);
  const first = records[0];
  assert.equal(first.id, 'immediate-collapse-viewpoint');
  assert.equal(first.name, 'Collapse viewpoint');
  assert.ok(Number.isFinite(first.lat) && Number.isFinite(first.lon));
  assert.equal(first.capturedAtMs, null);
  assert.equal(
    new Set(records.map((record) => record.id)).size,
    records.length,
  );
});

test('evidence records skip unplaced observations and honour the cap', () => {
  const spine = [
    { id: 'a', title: 'A', lat: 28, lon: 85 },
    { id: 'b', title: 'B', lat: null, lon: 85 },
    { id: 'c', title: 'C', lat: 28.1, lon: 85.1 },
  ];
  assert.deepEqual(
    bhoteKoshiEvidenceRecords(spine).map((record) => record.id),
    ['a', 'c'],
  );
  assert.equal(bhoteKoshiEvidenceRecords(spine, 1).length, 1);
  assert.deepEqual(bhoteKoshiEvidenceRecords(null), []);
});

test('incident places become title-cased, positioned records', () => {
  const records = bhoteKoshiPlaceRecords(INCIDENT_OVERVIEW_PLACES);
  assert.equal(records.length, INCIDENT_OVERVIEW_PLACES.length);
  const syabru = records.find((record) => record.id === 'syabru-besi');
  assert.equal(syabru.name, 'Syabru Besi');
  assert.equal(syabru.elevationM, 1417);
  assert.ok(Number.isFinite(syabru.lat) && Number.isFinite(syabru.lon));
  assert.equal(bhoteKoshiPlaceRecords(INCIDENT_OVERVIEW_PLACES, 2).length, 2);
});

test('the locator lists no places while it is off', () => {
  const layer = createBhoteKoshiLocatorLayer({
    boundaryResolver: async () => null,
    requestRender() {},
  });
  assert.deepEqual(layer.getAnalystRecords(), []);
});
