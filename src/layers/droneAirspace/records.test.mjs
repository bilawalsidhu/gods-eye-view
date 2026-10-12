import test from 'node:test';
import assert from 'node:assert/strict';
import {
  droneAirspaceTypeLabel,
  normalizeDroneAirspaceSnapshot,
} from './records.js';

const ring = [
  [-77.04, 38.89],
  [-77.03, 38.89],
  [-77.03, 38.9],
  [-77.04, 38.89],
];

function feature(overrides = {}) {
  return {
    id: 310,
    geometry: { type: 'Polygon', coordinates: [ring] },
    properties: {
      NAME: 'P-56',
      TYPE_CODE: 'P',
      UPPER_DESC: 'TNI',
      LOWER_DESC: 'SFC',
      TIMESOFUSE: 'CONTINUOUS',
      CONT_AGENT: 'WASHINGTON CENTER',
      CITY: 'WASHINGTON',
      STATE: 'DC',
      OBJECTID: 310,
      ...overrides.properties,
    },
    ...overrides,
  };
}

test('a valid snapshot yields one row per prohibited or restricted zone', () => {
  const rows = normalizeDroneAirspaceSnapshot({
    features: [
      feature(),
      feature({
        id: 400,
        properties: {
          NAME: 'R-2508',
          TYPE_CODE: 'R',
          OBJECTID: 400,
        },
      }),
    ],
  });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    stableId: '310',
    name: 'P-56',
    typeCode: 'P',
    type: 'Prohibited',
    lowerDesc: 'SFC',
    upperDesc: 'TNI',
    timesOfUse: 'CONTINUOUS',
    agency: 'WASHINGTON CENTER',
    city: 'WASHINGTON',
    state: 'DC',
    polygons: [[ring]],
  });
  assert.equal(rows[1].type, 'Restricted');
  assert.equal(rows[1].typeCode, 'R');
});

test('MOA, warning and advisory codes are dropped, as are bad geometries', () => {
  const rows = normalizeDroneAirspaceSnapshot({
    features: [
      feature({ properties: { TYPE_CODE: 'MOA', OBJECTID: 1 } }),
      feature({ properties: { TYPE_CODE: 'W', OBJECTID: 2 } }),
      feature({ properties: { TYPE_CODE: 'A', OBJECTID: 3 } }),
      feature({ geometry: null, properties: { OBJECTID: 4 } }),
      feature({
        geometry: { type: 'Point', coordinates: [-77, 38] },
        properties: { OBJECTID: 5 },
      }),
      feature(),
    ],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'P-56');
});

test('duplicate ids and a missing collection reject or skip as documented', () => {
  const dup = normalizeDroneAirspaceSnapshot({
    features: [feature(), feature({ id: 311 })],
  });
  assert.equal(dup.length, 1);
  assert.equal(normalizeDroneAirspaceSnapshot({}), null);
  assert.equal(normalizeDroneAirspaceSnapshot(null), null);
  assert.equal(droneAirspaceTypeLabel('P'), 'Prohibited');
  assert.equal(droneAirspaceTypeLabel('R'), 'Restricted');
  assert.equal(droneAirspaceTypeLabel('MOA'), null);
});
