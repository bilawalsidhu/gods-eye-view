import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePinokioSharing } from '../scripts/pinokio-preflight.mjs';

test('Pinokio stays local by default', () => {
  assert.deepEqual(
    validatePinokioSharing({ PINOKIO_SHARE_VAR: '__gev_sharing_disabled__' }),
    { cloudflare: false, local: false, protected: false },
  );
});

test('Pinokio refuses Cloudflare sharing on the current supported release', () => {
  assert.throws(
    () => validatePinokioSharing({ PINOKIO_SHARE_CLOUDFLARE: 'true' }),
    /logs successful tunnel-login passcodes/,
  );
});

test('Pinokio refuses its post-ready LAN sharing path too', () => {
  assert.throws(
    () => validatePinokioSharing({
      PINOKIO_SHARE_LOCAL: 'true',
      PINOKIO_SHARE_VAR: '__gev_sharing_disabled__',
    }),
    /PINOKIO_SHARE_LOCAL=false/,
  );
});

test('Pinokio requires its share-trigger variable to remain isolated from the Open URL', () => {
  assert.throws(
    () => validatePinokioSharing({ PINOKIO_SHARE_VAR: 'url' }),
    /PINOKIO_SHARE_VAR=__gev_sharing_disabled__/,
  );
});

test('Pinokio matches the platform truthiness contract after trimming', () => {
  assert.throws(
    () => validatePinokioSharing({ PINOKIO_SHARE_CLOUDFLARE: ' true ' }),
    /logs successful tunnel-login passcodes/,
  );
  assert.deepEqual(
    validatePinokioSharing({
      PINOKIO_SHARE_CLOUDFLARE: 'yes',
      PINOKIO_SHARE_VAR: '__gev_sharing_disabled__',
    }),
    { cloudflare: false, local: false, protected: false },
  );
});

test('a strong passcode cannot bypass the current sharing refusal', () => {
  assert.throws(
    () => validatePinokioSharing({
      PINOKIO_SHARE_CLOUDFLARE: 'true',
      PINOKIO_SHARE_PASSCODE: 'correct-horse-battery',
    }),
    /logs successful tunnel-login passcodes/,
  );
});
