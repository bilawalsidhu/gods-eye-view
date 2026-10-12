import test from 'node:test';
import assert from 'node:assert/strict';
import { endpointSet, joinApi, resolveApiBase } from './runtimeConfig.js';

test('resolveApiBase returns empty string for same-origin', () => {
  assert.equal(resolveApiBase(''), '');
  assert.equal(resolveApiBase(undefined), '');
});

test('resolveApiBase trims the host base with no trailing slash', () => {
  assert.equal(resolveApiBase('https://home:4173/'), 'https://home:4173');
});

test('joinApi prefixes service paths with the base', () => {
  assert.equal(joinApi('', '/api/terrain/heights'), '/api/terrain/heights');
  assert.equal(
    joinApi('https://home:4173', '/api/terrain/heights'),
    'https://home:4173/api/terrain/heights',
  );
});

test('endpointSet returns all five service keys prefixed', () => {
  assert.deepEqual(endpointSet('https://home:4173'), {
    boundaries: 'https://home:4173/api/overpass',
    terrain: 'https://home:4173/api/terrain/heights',
    regional: 'https://home:4173/api/regional-brief',
    weather: 'https://home:4173/api/weather-effects',
    summary: 'https://home:4173/api/openai/hud-summary',
  });
});
