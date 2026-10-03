import test from 'node:test';
import assert from 'node:assert/strict';

import {
  greatCircleMeters,
  queryRadius,
  nearest,
} from './spatialQuery.js';

const ORIGIN = { lat: 0, lon: 0 };
test('greatCircleMeters calibrates one degree of latitude', () => {
  const distanceM = greatCircleMeters(
    { lat: 0, lon: 0 },
    { lat: 1, lon: 0 },
  );

  assert.ok(
    Math.abs(distanceM - 111_195) < 100,
    `1° latitude ≈ 111.195 km, got ${distanceM}`,
  );
});

test('greatCircleMeters handles antipodal points', () => {
  const distanceM = greatCircleMeters(
    { lat: 0, lon: 0 },
    { lat: 0, lon: 180 },
  );

  assert.ok(
    Math.abs(distanceM - Math.PI * 6_371_000) < 1,
    `antipodal distance ≈ πR, got ${distanceM}`,
  );
});

test('greatCircleMeters accepts lon and lng coordinate spellings', () => {
  const lonDistance = greatCircleMeters(
    { lat: 0, lon: 0 },
    { lat: 1, lon: 0 },
  );
  const lngDistance = greatCircleMeters(
    { lat: 0, lon: 0 },
    { lat: 1, lng: 0 },
  );

  assert.equal(lngDistance, lonDistance);
});

test('queryRadius honors a zero-radius exact match', () => {
  const result = queryRadius(
    [
      { id: 'same', position: ORIGIN },
      { id: 'other', position: { lat: 0, lon: 0.0001 } },
    ],
    ORIGIN,
    0,
    (entity) => entity.position,
  );

  assert.deepEqual(
    result.map((item) => item.entity.id),
    ['same'],
  );
});

test('queryRadius includes the exact great-circle radius boundary', () => {
  const boundary = { lat: 1, lon: 0 };
  const radiusM = greatCircleMeters(ORIGIN, boundary);

  const result = queryRadius(
    [{ id: 'boundary', position: boundary }],
    ORIGIN,
    radiusM,
    (entity) => entity.position,
  );

  assert.deepEqual(
    result.map((item) => item.entity.id),
    ['boundary'],
  );
});

test('queryRadius returns coincident points at zero distance', () => {
  const result = queryRadius(
    [
      { id: 'same', position: ORIGIN },
      {
        id: 'far',
        position: { lat: 1, lon: 0 },
      },
    ],
    ORIGIN,
    1,
    (entity) => entity.position,
  );

  assert.equal(result.length, 1);
  assert.equal(result[0].entity.id, 'same');
  assert.equal(result[0].distanceM, 0);
});

test('queryRadius returns results nearest-first', () => {
  const result = queryRadius(
    [
      {
        id: 'far',
        position: { lat: 3, lon: 0 },
      },
      {
        id: 'near',
        position: { lat: 1, lon: 0 },
      },
      {
        id: 'middle',
        position: { lat: 2, lon: 0 },
      },
    ],
    ORIGIN,
    500_000,
    (entity) => entity.position,
  );

  assert.deepEqual(
    result.map((item) => item.entity.id),
    ['near', 'middle', 'far'],
  );
});

test('queryRadius includes the exact radius boundary', () => {
  const first = {
    lat: 0,
    lon: 0,
  };

  const second = {
    lat: 1,
    lon: 0,
  };

  const calibration = queryRadius(
    [{ id: 'second', position: second }],
    first,
    112_000,
    (entity) => entity.position,
  );

  assert.equal(
    calibration.length,
    1,
  );
});

test('queryRadius handles dateline crossing', () => {
  const result = queryRadius(
    [
      {
        id: 'across-dateline',
        position: {
          lat: 0,
          lon: -179.9,
        },
      },
    ],
    {
      lat: 0,
      lon: 179.9,
    },
    25_000,
    (entity) => entity.position,
  );

  assert.deepEqual(
    result.map((item) => item.entity.id),
    ['across-dateline'],
  );
});

test('queryRadius skips invalid entity positions', () => {
  const result = queryRadius(
    [
      {
        id: 'invalid-lat',
        position: {
          lat: 999,
          lon: 0,
        },
      },
      {
        id: 'invalid-lon',
        position: {
          lat: 0,
          lon: 999,
        },
      },
      {
        id: 'missing',
        position: null,
      },
      {
        id: 'valid',
        position: ORIGIN,
      },
    ],
    ORIGIN,
    100,
    (entity) => entity.position,
  );

  assert.deepEqual(
    result.map((item) => item.entity.id),
    ['valid'],
  );
});

test('queryRadius preserves deterministic order for equal distances', () => {
  const result = queryRadius(
    [
      {
        id: 'north',
        position: {
          lat: 1,
          lon: 0,
        },
      },
      {
        id: 'south',
        position: {
          lat: -1,
          lon: 0,
        },
      },
      {
        id: 'east',
        position: {
          lat: 0,
          lon: 1,
        },
      },
    ],
    ORIGIN,
    200_000,
    (entity) => entity.position,
  );

  assert.deepEqual(
    result.map((item) => item.entity.id),
    ['north', 'south', 'east'],
  );
});

test('queryRadius passes entity and index to the accessor', () => {
  const calls = [];

  queryRadius(
    ['a', 'b', 'c'],
    ORIGIN,
    1,
    (entity, index) => {
      calls.push([entity, index]);
      return ORIGIN;
    },
  );

  assert.deepEqual(calls, [
    ['a', 0],
    ['b', 1],
    ['c', 2],
  ]);
});

test('queryRadius does not mutate the source collection', () => {
  const entities = [
    {
      id: 'far',
      position: { lat: 2, lon: 0 },
    },
    {
      id: 'near',
      position: { lat: 1, lon: 0 },
    },
  ];

  const original = [...entities];

  queryRadius(
    entities,
    ORIGIN,
    500_000,
    (entity) => entity.position,
  );

  assert.deepEqual(
    entities,
    original,
  );
});

test('nearest returns the closest valid entity', () => {
  const result = nearest(
    [
      {
        id: 'far',
        position: { lat: 3, lon: 0 },
      },
      {
        id: 'near',
        position: { lat: 0.5, lon: 0 },
      },
    ],
    ORIGIN,
    (entity) => entity.position,
  );

  assert.equal(
    result?.entity.id,
    'near',
  );

  assert.ok(
    result.distanceM > 50_000,
  );
});

test('nearest preserves first entity on an exact distance tie', () => {
  const result = nearest(
    [
      {
        id: 'first',
        position: { lat: 1, lon: 0 },
      },
      {
        id: 'second',
        position: { lat: -1, lon: 0 },
      },
    ],
    ORIGIN,
    (entity) => entity.position,
  );

  assert.equal(
    result?.entity.id,
    'first',
  );
});

test('nearest skips invalid entities', () => {
  const result = nearest(
    [
      {
        id: 'bad',
        position: {
          lat: 200,
          lon: 0,
        },
      },
      {
        id: 'good',
        position: ORIGIN,
      },
    ],
    ORIGIN,
    (entity) => entity.position,
  );

  assert.equal(
    result?.entity.id,
    'good',
  );
});

test('nearest returns null when no valid entity exists', () => {
  assert.equal(
    nearest(
      [
        {
          id: 'bad',
          position: null,
        },
      ],
      ORIGIN,
      (entity) => entity.position,
    ),
    null,
  );
});

test('invalid query arguments are rejected', () => {
  assert.throws(
    () =>
      queryRadius(
        [],
        ORIGIN,
        -1,
        (entity) => entity,
      ),
    /radiusM/,
  );

  assert.throws(
    () =>
      queryRadius(
        [],
        { lat: 100, lon: 0 },
        100,
        (entity) => entity,
      ),
    /center/,
  );

  assert.throws(
    () =>
      queryRadius(
        [],
        ORIGIN,
        100,
        null,
      ),
    /getPosition/,
  );

  assert.throws(
    () =>
      nearest(
        [],
        { lat: 0, lon: 1000 },
        (entity) => entity,
      ),
    /point/,
  );
});
