import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DURBAN,
  PLACES,
  distanceKm,
  findPlaces,
  readSaved,
  writeSaved,
} from './places.js';

test('distance is symmetric, zero at origin, and uses kilometres', () => {
  assert.equal(distanceKm(DURBAN, DURBAN), 0);
  const airport = PLACES.find((p) => p.id === 'king-shaka');
  const distance = distanceKm(DURBAN, airport);
  assert.ok(distance > 27 && distance < 31);
  assert.ok(Math.abs(distance - distanceKm(airport, DURBAN)) < 1e-8);
  assert.ok(
    Math.abs(
      distanceKm({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 1 }) -
        111.195,
    ) < 0.01,
  );
});
test('search composes category, radius and favourites without mutating data', () => {
  assert.equal(findPlaces({ radius: 2 }).length, 2);
  assert.equal(
    findPlaces({ query: ' AIRPORT ', radius: 50 })[0].id,
    'king-shaka',
  );
  assert.equal(findPlaces({ query: 'airport', radius: 10 }).length, 0);
  assert.equal(
    findPlaces({ category: 'Venues', savedOnly: true, saved: ['king-shaka'] })
      .length,
    0,
  );
  assert.equal(
    findPlaces({ savedOnly: true, saved: ['durban-icc'] })[0].id,
    'durban-icc',
  );
  assert.equal(
    findPlaces({ centre: PLACES[2], radius: 2 })[0].id,
    'king-shaka',
  );
  assert.equal(PLACES[0].distance, undefined);
});
test('malformed and unavailable browser storage never block exploration', () => {
  assert.deepEqual(readSaved(undefined), []);
  assert.deepEqual(readSaved({ getItem: () => '{broken' }), []);
  assert.deepEqual(readSaved({ getItem: () => '{}' }), []);
  assert.deepEqual(
    readSaved({ getItem: () => '["durban-icc","unknown","durban-icc"]' }),
    ['durban-icc'],
  );
  assert.equal(
    writeSaved(
      {
        setItem: () => {
          throw new Error('QuotaExceeded');
        },
      },
      [],
    ),
    false,
  );
  let value;
  assert.equal(
    writeSaved(
      {
        setItem: (_key, v) => {
          value = v;
        },
      },
      ['durban-icc'],
    ),
    true,
  );
  assert.deepEqual(JSON.parse(value), ['durban-icc']);
});
