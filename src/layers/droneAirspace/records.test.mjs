import test from 'node:test';
import assert from 'node:assert/strict';
import {
  droneAirspaceAltitude,
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
      UPPER_VAL: '18000',
      UPPER_UOM: 'FT',
      UPPER_CODE: 'MSL',
      LOWER_DESC: null,
      LOWER_VAL: '0',
      LOWER_UOM: 'FT',
      LOWER_CODE: 'SFC',
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
    lowerAltitude: 'SFC',
    upperAltitude: '18,000 ft MSL',
    timesOfUse: 'CONTINUOUS',
    agency: 'WASHINGTON CENTER',
    city: 'WASHINGTON',
    state: 'DC',
    polygons: [[ring]],
  });
  assert.equal(rows[1].type, 'Restricted');
  assert.equal(rows[1].typeCode, 'R');
});

test('altitudes come from VAL/UOM/CODE, not the TI/TNI/ANI qualifiers', () => {
  // P-40 and R-2508 as the FAA service publishes them.
  assert.equal(droneAirspaceAltitude('0', 'FT', 'SFC'), 'SFC');
  assert.equal(droneAirspaceAltitude('5000', 'FT', 'MSL'), '5,000 ft MSL');
  assert.equal(droneAirspaceAltitude('20000', 'FT', 'MSL'), '20,000 ft MSL');
  assert.equal(droneAirspaceAltitude('-9998', null, 'UNLTD'), 'Unlimited');
  assert.equal(droneAirspaceAltitude('1500', 'FT', 'SFC'), '1,500 ft AGL');
  assert.equal(droneAirspaceAltitude('180', 'FL', 'STD'), 'FL180');
  assert.equal(droneAirspaceAltitude('10000', 'FT', null), '10,000 ft');
  assert.equal(droneAirspaceAltitude(null, null, null), null);
  assert.equal(droneAirspaceAltitude('-9998', 'FT', 'MSL'), null);
  const [row] = normalizeDroneAirspaceSnapshot({
    features: [
      feature({
        properties: {
          NAME: 'R-2508',
          TYPE_CODE: 'R',
          OBJECTID: 400,
          UPPER_DESC: null,
          UPPER_VAL: '-9998',
          UPPER_UOM: null,
          UPPER_CODE: 'UNLTD',
          LOWER_VAL: '20000',
          LOWER_UOM: 'FT',
          LOWER_CODE: 'MSL',
        },
      }),
    ],
  });
  assert.equal(row.lowerAltitude, '20,000 ft MSL');
  assert.equal(row.upperAltitude, 'Unlimited');
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
