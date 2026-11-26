import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  BHOTE_KOSHI_LAYER_ID,
  bhoteKoshiEvidenceRecords,
} from './bhoteKoshiEvent.js';
import { describeEntity } from './entityContext.js';
import { setLocale } from '../i18n/index.js';
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
  assert.equal(first.source, pack.evidenceSpine[0].media.publisher);
  assert.equal(first.website, pack.evidenceSpine[0].media.sourceUrl);
  assert.equal(
    new Set(records.map((record) => record.id)).size,
    records.length,
  );
});

test('a Syabru Besi card credits its own media and the geolocation map', () => {
  const id = 'syabru-besi';
  const observation = pack.evidenceSpine.find((item) => item.id === id);
  const layer = {
    id: BHOTE_KOSHI_LAYER_ID,
    name: 'Bhote Koshi Flood',
    source: 'Vantor + GeoPera',
    module: {
      getAnalystRecords: () => bhoteKoshiEvidenceRecords(pack.evidenceSpine),
    },
  };
  const dataManager = { layers: new Map([[layer.id, layer]]) };
  const card = describeEntity(dataManager, { layerId: layer.id, id });
  assert.equal(card.source, observation.media.publisher);
  assert.equal(
    card.links.find(({ kind }) => kind === 'website')?.href,
    observation.media.sourceUrl,
  );
  const geolocation = card.links.find(({ kind }) => kind === 'geolocation');
  assert.equal(geolocation?.label, observation.provenance.via);
  assert.equal(geolocation?.href, observation.provenance.viaUrl);
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
  assert.equal(syabru.pinHeightM, 1417);
  assert.equal(syabru.elevationM, undefined);
  const [withElevation] = bhoteKoshiPlaceRecords([
    { ...INCIDENT_OVERVIEW_PLACES[0], heightM: 3600, elevationM: 2900 },
  ]);
  assert.equal(withElevation.pinHeightM, 3600);
  assert.equal(withElevation.elevationM, 2900);
  assert.ok(Number.isFinite(syabru.lat) && Number.isFinite(syabru.lon));
  assert.equal(bhoteKoshiPlaceRecords(INCIDENT_OVERVIEW_PLACES, 2).length, 2);
});

test('locator record names translate descriptive marks and preserve place names', (t) => {
  t.after(() => setLocale('en'));
  setLocale('fr');
  const records = bhoteKoshiPlaceRecords(INCIDENT_OVERVIEW_PLACES);
  const names = new Map(records.map(({ id, name }) => [id, name]));
  assert.equal(names.get('debris-dammed-lake'), 'Lac de barrage');
  assert.equal(names.get('syabru-besi'), 'Syabru Besi');
});

test('the locator lists no places while it is off', () => {
  const layer = createBhoteKoshiLocatorLayer({
    boundaryResolver: async () => null,
    requestRender() {},
  });
  assert.deepEqual(layer.getAnalystRecords(), []);
});
