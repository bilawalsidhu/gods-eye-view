import test from 'node:test';
import assert from 'node:assert/strict';
import { MapStackController, photorealUnavailableReason } from './mapStackController.js';

test('missing photoreal credentials explain both supported setup routes', () => {
  assert.match(photorealUnavailableReason(false), /Needs GOOGLE_MAPS_API_KEY.*Provider Settings/);
  assert.match(photorealUnavailableReason(false), /Cesium ion token/);
});

test('a configured but failed photoreal route does not ask for another key', () => {
  const reason = photorealUnavailableReason(true);
  assert.match(reason, /unavailable.*restrictions, quota, or network/);
  assert.doesNotMatch(reason, /Needs|add it/);
});

test('controller credential detection accepts ion without a browser global', () => {
  const hasCredentials = MapStackController.prototype._hasPhotorealCredentials;
  assert.equal(hasCredentials.call({ cesiumToken: 'configured' }), true);
  assert.equal(hasCredentials.call({ cesiumToken: '   ' }), false);
});
