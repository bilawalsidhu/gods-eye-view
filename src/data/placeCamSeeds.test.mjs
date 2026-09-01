import assert from 'node:assert/strict';
import test from 'node:test';
import { PLACE_CAM_SEEDS, placeCamById, placeCamIds } from './placeCamSeeds.js';

test('every place-cam seed is well formed', () => {
  for (const seed of PLACE_CAM_SEEDS) {
    assert.match(seed.id, /^place-[a-z0-9-]+$/, `${seed.id} id shape`);
    assert.ok(seed.label && seed.city && seed.country, `${seed.id} has label/city/country`);
    assert.ok(Number.isFinite(seed.lat) && seed.lat >= -90 && seed.lat <= 90, `${seed.id} lat`);
    assert.ok(Number.isFinite(seed.lon) && seed.lon >= -180 && seed.lon <= 180, `${seed.id} lon`);
    assert.ok(Array.isArray(seed.videoIds), `${seed.id} videoIds is an array`);
    for (const vid of seed.videoIds) assert.match(vid, /^[\w-]{11}$/, `${seed.id} candidate "${vid}"`);
    assert.match(seed.watchUrl, /^https:\/\/www\.youtube\.com\//, `${seed.id} watchUrl`);
  }
});

test('ids are unique', () => {
  const ids = PLACE_CAM_SEEDS.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('the registry is a meaningful size', () => {
  assert.ok(PLACE_CAM_SEEDS.length >= 40, `expected 40+, got ${PLACE_CAM_SEEDS.length}`);
});

test('placeCamById / placeCamIds round-trip', () => {
  assert.deepEqual(placeCamIds().sort(), PLACE_CAM_SEEDS.map((s) => s.id).sort());
  const first = PLACE_CAM_SEEDS[0];
  assert.equal(placeCamById(first.id), first);
  assert.equal(placeCamById('place-does-not-exist'), null);
});

test('the registry is frozen', () => {
  assert.throws(() => { PLACE_CAM_SEEDS.push({}); }, TypeError);
});
