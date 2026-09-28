import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CITY_POIS } from '../locations.js';
import {
  hydrateCustomLocations,
  addCustomLocation,
  removeCustomLocation,
} from './customLocations.js';

function fakeStorage() {
  const data = new Map();
  return {
    data,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
}

/** Each test gets a fresh fake storage and a clean slice of CITY_POIS to restore after. */
function withStorage(fn) {
  const previousStorage = globalThis.localStorage;
  const previousCityPois = { ...CITY_POIS };
  globalThis.localStorage = fakeStorage();
  try {
    fn(globalThis.localStorage);
  } finally {
    globalThis.localStorage = previousStorage;
    for (const key of Object.keys(CITY_POIS)) delete CITY_POIS[key];
    Object.assign(CITY_POIS, previousCityPois);
  }
}

test('addCustomLocation persists a pin and registers it as a single-POI city', () => {
  withStorage((storage) => {
    const id = addCustomLocation({
      name: 'Waterloo Intl Airport',
      lat: 43.4608,
      lon: -80.3784,
      alt: 500,
      pitch: -20,
      heading: 80,
    });
    assert.match(id, /^pin:/);
    assert.equal(CITY_POIS[id].name, 'Waterloo Intl Airport');
    assert.equal(CITY_POIS[id].custom, true);
    assert.equal(CITY_POIS[id].pois.length, 1);
    assert.equal(CITY_POIS[id].pois[0].lat, 43.4608);

    const stored = JSON.parse(storage.getItem('gev.customLocations.v1'));
    assert.equal(stored[id].name, 'Waterloo Intl Airport');
  });
});

test('removeCustomLocation deletes the pin from storage and the live registry', () => {
  withStorage((storage) => {
    const id = addCustomLocation({
      name: 'Temp Pin',
      lat: 0,
      lon: 0,
      alt: 500,
      pitch: -20,
      heading: 0,
    });
    removeCustomLocation(id);
    assert.equal(CITY_POIS[id], undefined);
    const stored = JSON.parse(storage.getItem('gev.customLocations.v1'));
    assert.equal(stored[id], undefined);
  });
});

test('hydrateCustomLocations loads previously saved pins without duplicating bundled cities', () => {
  withStorage(() => {
    const id = addCustomLocation({
      name: 'Saved Elsewhere',
      lat: 1,
      lon: 2,
      alt: 500,
      pitch: -20,
      heading: 0,
    });
    delete CITY_POIS[id]; // simulate a fresh page load: registry not yet hydrated
    assert.equal(CITY_POIS[id], undefined);

    hydrateCustomLocations();
    assert.equal(CITY_POIS[id].name, 'Saved Elsewhere');
    assert.equal(CITY_POIS.austin.name, 'Austin'); // bundled cities untouched
  });
});

test('a missing or throwing localStorage is a silent no-op, never a crash', () => {
  const previousStorage = globalThis.localStorage;
  const previousCityPois = { ...CITY_POIS };
  globalThis.localStorage = undefined;
  try {
    assert.doesNotThrow(() => hydrateCustomLocations());
    assert.doesNotThrow(() =>
      addCustomLocation({
        name: 'No Storage',
        lat: 0,
        lon: 0,
        alt: 500,
        pitch: -20,
        heading: 0,
      }),
    );
  } finally {
    globalThis.localStorage = previousStorage;
    for (const key of Object.keys(CITY_POIS)) delete CITY_POIS[key];
    Object.assign(CITY_POIS, previousCityPois);
  }
});
