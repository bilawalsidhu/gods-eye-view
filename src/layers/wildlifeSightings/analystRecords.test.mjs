import test from 'node:test';
import assert from 'node:assert/strict';
import { createControls } from './controls.js';

const NOW = 1_700_000_000_000;

function controlsWith(rows, enabled = true) {
  const state = {
    enabled,
    rows: new Map(rows.map((row) => [row.stableId, row])),
  };
  return createControls({ state, services: { now: () => NOW }, parts: {} })
    .methods;
}

const owl = {
  stableId: 'inat:1',
  origin: 'inaturalist',
  lat: 30.3,
  lon: -97.7,
  obscured: false,
  observedAt: 1_700_000_000_000,
  observedOn: '2023-11-14',
  quality: 'research',
  commonName: 'Barred Owl',
  scientificName: 'Strix varia',
  iconic: 'Aves',
  threatened: false,
  link: 'https://www.inaturalist.org/observations/1',
};
const orca = {
  stableId: 'acartia:9',
  origin: 'acartia',
  lat: 48.5,
  lon: -123.1,
  obscured: false,
  observedAt: null,
  observedOn: '2023-11-14',
  commonName: 'Orca',
  scientificName: null,
  iconic: 'Mammalia',
};

test('wildlife sightings list loaded rows with positions and a source', () => {
  const records = controlsWith([owl, orca]).getAnalystRecords();
  assert.equal(records.length, 2);
  assert.deepEqual(
    {
      id: records[0].id,
      name: records[0].name,
      lat: records[0].lat,
      lon: records[0].lon,
      source: records[0].source,
      taxonGroup: records[0].taxonGroup,
    },
    {
      id: 'inat:1',
      name: 'Barred Owl',
      lat: 30.3,
      lon: -97.7,
      source: 'iNaturalist',
      taxonGroup: 'Aves',
    },
  );
  assert.equal(records[1].source, 'Acartia');
  assert.equal(records[1].observedAtMs, null);
});

test('wildlife sightings honour the cap, skip positionless rows, and are empty while off', () => {
  const controls = controlsWith([owl, { ...orca, lat: null }]);
  assert.equal(controls.getAnalystRecords().length, 1);
  assert.equal(controlsWith([owl, orca]).getAnalystRecords(1).length, 1);
  assert.deepEqual(controlsWith([owl], false).getAnalystRecords(), []);
});

test('expired sightings retained by the layer are absent from its current records', () => {
  const expired = {
    ...owl,
    stableId: 'inat:2',
    observedAt: NOW - 3 * 86_400_000,
  };
  assert.deepEqual(
    controlsWith([expired, owl])
      .getAnalystRecords(1)
      .map(({ id }) => id),
    ['inat:1'],
  );
});
