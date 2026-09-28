import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CITY_POIS } from '../locations.js';
import {
  hydrateCustomLocations,
  addCustomLocation,
  removeLocation,
  renameLocation,
  addLocationPoi,
  renameLocationPoi,
  removeLocationPoi,
  resetLocation,
  isLocationOverridden,
  listHiddenBundledLocations,
  restoreHiddenBundledLocations,
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

test('removeLocation deletes a custom pin outright from storage and the live registry', () => {
  withStorage((storage) => {
    const id = addCustomLocation({
      name: 'Temp Pin',
      lat: 0,
      lon: 0,
      alt: 500,
      pitch: -20,
      heading: 0,
    });
    removeLocation(id);
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

test('renameLocation overrides a bundled city locally without touching its shipped default', () => {
  withStorage(() => {
    renameLocation('austin', 'My Home Base');
    assert.equal(CITY_POIS.austin.name, 'My Home Base');
    assert.equal(CITY_POIS.austin.custom, undefined); // still a bundled city, not a new pin
    assert.equal(isLocationOverridden('austin'), true);
  });
});

test('renameLocation also works on a custom pin', () => {
  withStorage(() => {
    const id = addCustomLocation({
      name: 'Original',
      lat: 0,
      lon: 0,
      alt: 500,
      pitch: -20,
      heading: 0,
    });
    renameLocation(id, 'Renamed');
    assert.equal(CITY_POIS[id].name, 'Renamed');
    assert.equal(CITY_POIS[id].custom, true);
  });
});

test('renameLocation with a blank name is a no-op', () => {
  withStorage(() => {
    renameLocation('austin', '   ');
    assert.equal(CITY_POIS.austin.name, 'Austin');
    assert.equal(isLocationOverridden('austin'), false);
  });
});

test('removeLocation hides a bundled city rather than deleting its data, and lists it as hidden', () => {
  withStorage(() => {
    removeLocation('dubai');
    assert.equal(CITY_POIS.dubai, undefined);
    const hidden = listHiddenBundledLocations();
    assert.deepEqual(hidden, [{ id: 'dubai', name: 'Dubai' }]);
  });
});

test('resetLocation restores a hidden or edited bundled city to its shipped default', () => {
  withStorage(() => {
    const originalPoiCount = CITY_POIS.austin.pois.length;
    renameLocation('austin', 'Renamed');
    addLocationPoi('austin', {
      name: 'Extra',
      lat: 1,
      lon: 1,
      alt: 500,
      pitch: -20,
      heading: 0,
    });
    resetLocation('austin');
    assert.equal(CITY_POIS.austin.name, 'Austin');
    assert.equal(CITY_POIS.austin.pois.length, originalPoiCount);
    assert.equal(isLocationOverridden('austin'), false);
  });
});

test('resetLocation on a custom pin (not bundled) is a no-op', () => {
  withStorage(() => {
    const id = addCustomLocation({
      name: 'Pin',
      lat: 0,
      lon: 0,
      alt: 500,
      pitch: -20,
      heading: 0,
    });
    resetLocation(id);
    assert.equal(CITY_POIS[id].name, 'Pin'); // still there, untouched
  });
});

test('restoreHiddenBundledLocations brings back every hidden bundled city', () => {
  withStorage(() => {
    removeLocation('dubai');
    removeLocation('tallinn');
    assert.equal(listHiddenBundledLocations().length, 2);
    restoreHiddenBundledLocations();
    assert.equal(listHiddenBundledLocations().length, 0);
    assert.equal(CITY_POIS.dubai.name, 'Dubai');
    assert.equal(CITY_POIS.tallinn.name, 'Tallinn');
  });
});

test('addLocationPoi appends a landmark to a bundled city as a local override', () => {
  withStorage(() => {
    const before = CITY_POIS.austin.pois.length;
    addLocationPoi('austin', {
      name: 'My Spot',
      lat: 30.1,
      lon: -97.1,
      alt: 400,
      pitch: -25,
      heading: 90,
    });
    assert.equal(CITY_POIS.austin.pois.length, before + 1);
    assert.equal(CITY_POIS.austin.pois.at(-1).name, 'My Spot');
    assert.equal(isLocationOverridden('austin'), true);
  });
});

test('renameLocationPoi renames one landmark without touching the others', () => {
  withStorage(() => {
    const secondPoiName = CITY_POIS.austin.pois[1].name;
    renameLocationPoi('austin', 0, 'New Name');
    assert.equal(CITY_POIS.austin.pois[0].name, 'New Name');
    assert.equal(CITY_POIS.austin.pois[1].name, secondPoiName);
  });
});

test('removeLocationPoi removes one landmark, keeping the rest', () => {
  withStorage(() => {
    const before = CITY_POIS.austin.pois.map((poi) => poi.name);
    removeLocationPoi('austin', 0);
    assert.equal(CITY_POIS.austin.pois.length, before.length - 1);
    assert.deepEqual(
      CITY_POIS.austin.pois.map((poi) => poi.name),
      before.slice(1),
    );
  });
});

test('removeLocationPoi refuses to remove a city’s last landmark', () => {
  withStorage(() => {
    const id = addCustomLocation({
      name: 'Solo Pin',
      lat: 0,
      lon: 0,
      alt: 500,
      pitch: -20,
      heading: 0,
    });
    removeLocationPoi(id, 0);
    assert.equal(CITY_POIS[id].pois.length, 1); // unchanged — refused
  });
});
