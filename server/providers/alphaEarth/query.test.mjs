import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ALPHA_EARTH_DETAIL_BUDGET_MB,
  alphaEarthChangeKey,
  parseAlphaEarthChangeQuery,
} from './query.js';

const parse = (query) =>
  parseAlphaEarthChangeQuery(new URLSearchParams(query));
const BOX = 'west=-97.64&south=30.21&east=-97.6&north=30.24';

test('a complete query parses with defaults', () => {
  const result = parse(`${BOX}&from=2018&to=2024`);
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.box, {
    west: -97.64,
    south: 30.21,
    east: -97.6,
    north: 30.24,
  });
  assert.equal(result.value.from, 2018);
  assert.equal(result.value.to, 2024);
  assert.equal(result.value.detail, 'standard');
  assert.equal(
    result.value.budgetBytes,
    ALPHA_EARTH_DETAIL_BUDGET_MB.standard * 1024 * 1024,
  );
});

test('years are ordered, integral and distinct', () => {
  assert.equal(parse(`${BOX}&from=2024&to=2018`).value.from, 2018);
  assert.equal(parse(`${BOX}&from=2016&to=2018`).ok, false);
  assert.equal(parse(`${BOX}&from=2018.5&to=2020`).ok, false);
  assert.equal(parse(`${BOX}&from=2020&to=2020`).ok, false);
  assert.equal(parse(`${BOX}&to=2020`).ok, false);
});

test('boxes must be complete, valid and at most 100 km a side', () => {
  assert.equal(parse('west=1&south=1&east=2&from=2018&to=2024').ok, false);
  assert.equal(parse('west=2&south=1&east=1&north=2&from=2018&to=2024').ok, false);
  assert.equal(parse('west=0&south=0&east=2&north=0.1&from=2018&to=2024').ok, false);
  assert.equal(parse('west=0&south=0&east=0.8&north=0.8&from=2018&to=2024').ok, true);
});

test('threshold and detail are validated', () => {
  assert.equal(parse(`${BOX}&from=2018&to=2024&threshold=0.2`).value.threshold, 0.2);
  assert.equal(parse(`${BOX}&from=2018&to=2024&threshold=0`).ok, false);
  assert.equal(parse(`${BOX}&from=2018&to=2024&threshold=abc`).ok, false);
  assert.equal(parse(`${BOX}&from=2018&to=2024&detail=high`).value.detail, 'high');
  assert.equal(parse(`${BOX}&from=2018&to=2024&detail=ultra`).ok, false);
});

test('nearby boxes snap onto one cache key', () => {
  const a = parse('west=-97.64001&south=30.21&east=-97.6&north=30.24&from=2018&to=2024');
  const b = parse('west=-97.63999&south=30.21&east=-97.6&north=30.24&from=2024&to=2018');
  assert.equal(alphaEarthChangeKey(a.value), alphaEarthChangeKey(b.value));
});
