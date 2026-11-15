import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MapStackController,
  photorealUnavailableReason,
} from './mapStackController.js';

test('missing photoreal credentials explain both supported setup routes', () => {
  assert.match(
    photorealUnavailableReason(false),
    /Needs GOOGLE_MAPS_API_KEY.*Provider Settings/,
  );
  assert.match(photorealUnavailableReason(false), /Cesium ion token/);
});

test('a configured but failed photoreal route does not ask for another key', () => {
  const reason = photorealUnavailableReason(true);
  assert.match(reason, /unavailable.*restrictions, quota, or network/);
  assert.doesNotMatch(reason, /Needs|add it/);
});

test('controller credential detection accepts opted-in ion without a browser global', () => {
  const hasCredentials = MapStackController.prototype._hasPhotorealCredentials;
  assert.equal(
    hasCredentials.call({ cesiumToken: 'configured', allowIonPhotoreal: true }),
    true,
  );
  assert.equal(
    hasCredentials.call({ cesiumToken: '   ', allowIonPhotoreal: true }),
    false,
  );
  // Ion-hosted Google 3D is off by default, so a token alone is not enough.
  assert.equal(hasCredentials.call({ cesiumToken: 'configured' }), false);
});

test('an ion token with the ion route off says how to opt in', () => {
  const reason = photorealUnavailableReason(false, { ionPhotorealOff: true });
  assert.match(reason, /GEV_ENABLE_CESIUM_ION_3D=1/);
  assert.match(reason, /GOOGLE_MAPS_API_KEY/);
});
