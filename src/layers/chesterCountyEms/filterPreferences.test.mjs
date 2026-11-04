import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCountyFilterPreferences,
  COUNTY_FILTER_STORAGE_KEY,
} from './filterPreferences.js';

const disk = () => {
  const values = new Map();
  return {
    values,
    storage: () => ({
      getItem: (key) => values.get(key),
      setItem: (key, value) => values.set(key, value),
    }),
  };
};
test('filter choices survive fresh instances, including all unchecked, without saving incident state', () => {
  const storage = disk();
  const first = createCountyFilterPreferences(storage);
  assert.equal(first.get().counties.includes('pike-pa'), false);
  first.set({
    categories: ['traffic', 'ems'],
    counties: ['pike-pa', 'montgomery-pa'],
    selectedIncident: 'ems:F26000001',
    rows: [{ patient: 'not a preference' }],
  });
  const restarted = createCountyFilterPreferences(storage);
  assert.deepEqual(restarted.get(), {
    categories: ['ems', 'traffic'],
    counties: ['montgomery-pa', 'pike-pa'],
  });
  restarted.set({ categories: [] });
  assert.deepEqual(createCountyFilterPreferences(storage).get(), {
    categories: [],
    counties: ['montgomery-pa', 'pike-pa'],
  });
  restarted.set({ counties: [] });
  assert.deepEqual(createCountyFilterPreferences(storage).get(), {
    categories: [],
    counties: [],
  });
  assert.deepEqual(JSON.parse(storage.values.get(COUNTY_FILTER_STORAGE_KEY)), {
    v: 1,
    categories: [],
    counties: [],
  });
  const copy = restarted.get();
  copy.categories.push('fire');
  assert.deepEqual(restarted.get().categories, []);
});
test('invalid, oversized and unknown-version preferences safely fall back; valid groups remain intact', () => {
  const storage = disk();
  const normal = createCountyFilterPreferences().get();
  for (const raw of [
    '{',
    'null',
    'x'.repeat(4097),
    '{"v":2,"categories":[],"counties":[]}',
  ]) {
    storage.values.set(COUNTY_FILTER_STORAGE_KEY, raw);
    assert.deepEqual(createCountyFilterPreferences(storage).get(), normal);
  }
  storage.values.set(
    COUNTY_FILTER_STORAGE_KEY,
    JSON.stringify({ v: 1, categories: ['unknown'], counties: [] }),
  );
  const restored = createCountyFilterPreferences(storage);
  assert.deepEqual(restored.get(), {
    categories: normal.categories,
    counties: [],
  });
  restored.set({ categories: ['ems'], counties: ['unknown'] });
  assert.deepEqual(restored.get(), { categories: ['ems'], counties: [] });
});
test('blocked reads and quota errors leave filters usable in the current session', () => {
  for (const storage of [
    () => {
      throw new Error('blocked');
    },
    () => ({
      getItem: () => null,
      setItem: () => {
        throw new Error('quota');
      },
    }),
  ]) {
    const preferences = createCountyFilterPreferences({ storage });
    preferences.set({ categories: [], counties: ['chester-pa'] });
    assert.deepEqual(preferences.get(), {
      categories: [],
      counties: ['chester-pa'],
    });
  }
});
