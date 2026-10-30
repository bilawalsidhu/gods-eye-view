// USGS water cards must show the gauge readings, not just the name.
import test from 'node:test';
import assert from 'node:assert/strict';
import { localInfrastructureOverlayCopy } from '../../data/localGeojsonCore.js';
import {
  formatReadingValue,
  usgsObservedLine,
  usgsReadingLine,
  usgsWaterCardDetails,
} from './copy.js';

// Real 2026-10-04 export values for USGS-08019500 (schema 2 shape).
const BIG_SANDY = {
  name: 'Big Sandy Ck nr Big Sandy, TX',
  usgs_site_id: 'USGS-08019500',
  site_type_code: 'ST',
  observed_time: '2026-10-04T10:00:00+00:00',
  readings: [
    {
      parameter_code: '00065',
      parameter_name: 'Gage height',
      value: 3.97,
      unit: 'ft',
      observed_time: '2026-10-04T10:00:00+00:00',
    },
    {
      parameter_code: '00060',
      parameter_name: 'Discharge',
      value: 19.6,
      unit: 'ft^3/s',
      observed_time: '2026-10-04T10:00:00+00:00',
    },
  ],
};

test('a river gauge card shows its readings and observation time', () => {
  const copy = localInfrastructureOverlayCopy(BIG_SANDY, 'local-usgs-water');
  assert.equal(copy.title, 'Big Sandy Ck nr Big Sandy, TX');
  assert.deepEqual(copy.details.slice(0, 2), [
    'Gage height 3.97 ft',
    'Discharge 19.6 ft³/s',
  ]);
  assert.match(copy.details[2], /^as of Oct 4, /);
  assert.equal(copy.details.length, 3);
});

test('the observation time is shown in the viewer time zone', () => {
  assert.equal(
    usgsObservedLine('2026-10-04T10:00:00+00:00', {
      timeZone: 'America/Chicago',
    }),
    'as of Oct 4, 5:00 AM CDT',
  );
  assert.equal(usgsObservedLine('not a time'), '');
});

test('cards cap readings at two and keep the newest time', () => {
  const lake = {
    name: 'Lake 1',
    readings: [
      {
        parameter_name: 'Lake/reservoir stage',
        value: 38.74,
        unit: 'ft',
        observed_time: '2026-10-03T12:00:00Z',
      },
      {
        parameter_name: 'Lake elevation above NAVD88',
        value: 1132.02,
        unit: 'ft',
        observed_time: '2026-10-04T12:00:00Z',
      },
      {
        parameter_name: 'Lake elevation above NGVD29',
        value: 1131.1,
        unit: 'ft',
        observed_time: '2026-10-02T12:00:00Z',
      },
    ],
  };
  const lines = usgsWaterCardDetails(lake, { timeZone: 'UTC' });
  assert.deepEqual(lines, [
    'Lake/reservoir stage 38.74 ft',
    'Lake elevation above NAVD88 1,132.02 ft',
    'as of Oct 4, 12:00 PM UTC',
  ]);
});

test('schema-1 single-reading features still show their reading', () => {
  const copy = localInfrastructureOverlayCopy(
    {
      name: 'Old format site',
      parameter_name: 'Discharge',
      value: 63800,
      unit: 'ft^3/s',
      observed_time: '2026-10-04T10:45:00+00:00',
    },
    'local-usgs-lakes',
  );
  assert.equal(copy.details[0], 'Discharge 63,800 ft³/s');
});

test('a gauge without a numeric reading says so', () => {
  assert.deepEqual(
    usgsWaterCardDetails({
      name: 'x',
      readings: [{ parameter_name: 'Gage height', value: null }],
    }),
    ['No current reading'],
  );
  assert.equal(
    usgsReadingLine({ parameter_name: 'Gage height', value: 'n/a' }),
    '',
  );
  assert.equal(formatReadingValue(0), '0');
});

test('datacenter and dam cards are unchanged', () => {
  const copy = localInfrastructureOverlayCopy(
    { name: 'DC', value: 5, readings: [{ parameter_name: 'x', value: 1 }] },
    'local-datacenters',
  );
  assert.deepEqual(copy.details, []);
});
