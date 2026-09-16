import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_SAVED_LOCATIONS,
  SAVED_LOCATIONS_STORAGE_KEY,
  loadSavedLocations,
  normalizeSavedLocation,
  persistSavedLocations,
  removeSavedLocation,
  upsertSavedLocation,
} from './savedLocations.js';

function storage(values = {}) {
  const data = new Map(Object.entries(values));
  return {
    getItem(key) { return data.get(key) ?? null; },
    setItem(key, value) { data.set(key, value); },
    read(key) { return data.get(key); },
  };
}

const camera = { lat: 30, lon: -97, alt: 900, heading: 20, pitch: -30, roll: 0 };

 test('normalizes a saved location and applies camera defaults', () => {
  const result = normalizeSavedLocation({ name: '  Austin  ', camera: { lat: 30, lon: -97, alt: 0 } });
  assert.deepEqual(result.camera, { lat: 30, lon: -97, alt: 1, heading: 0, pitch: -35, roll: 0 });
  assert.equal(result.name, 'Austin');
});

test('rejects saved locations without a valid name or camera', () => {
  assert.equal(normalizeSavedLocation({ name: 'Austin' }), null);
  assert.equal(normalizeSavedLocation({ name: '', camera }), null);
  assert.equal(normalizeSavedLocation({ name: 'Austin', camera: { ...camera, lat: NaN } }), null);
});

test('persists, loads, updates, removes, and caps saved locations', () => {
  const store = storage();
  let locations = [];
  locations = upsertSavedLocation(locations, { id: 'a', name: 'Austin', camera });
  locations = upsertSavedLocation(locations, { id: 'b', name: 'Tokyo', camera });
  assert.equal(persistSavedLocations(locations, store), true);
  assert.equal(store.read(SAVED_LOCATIONS_STORAGE_KEY) != null, true);
  assert.deepEqual(loadSavedLocations(store).map((item) => item.id), ['b', 'a']);

  locations = upsertSavedLocation(locations, { id: 'a', name: 'Austin Updated', camera });
  assert.deepEqual(locations.map((item) => item.id), ['a', 'b']);
  assert.deepEqual(removeSavedLocation(locations, 'b').map((item) => item.id), ['a']);

  const many = Array.from({ length: MAX_SAVED_LOCATIONS + 2 }, (_, index) => ({
    id: String(index), name: `Place ${index}`, camera,
  }));
  assert.equal(many.reduce(upsertSavedLocation, []).length, MAX_SAVED_LOCATIONS);
});
