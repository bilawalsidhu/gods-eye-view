import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GOOGLE_API_KEY_PLACEHOLDER,
  resolveGoogleApiKey,
  resolveServerGoogleApiKey,
} from './googlePlacesPolicy.js';

/**
 * Server-side Google key resolution (issue #33): the server-proxied Google
 * calls (Places search, Street View fallback) prefer a dedicated
 * GOOGLE_MAPS_SERVER_API_KEY and fall back to the client-exposed
 * GOOGLE_MAPS_API_KEY so a single-key setup keeps working.
 */

test('resolveGoogleApiKey treats unset, blank, and placeholder alike as absent', () => {
  assert.equal(resolveGoogleApiKey('real-key'), 'real-key');
  assert.equal(resolveGoogleApiKey('  real-key  '), 'real-key');
  assert.equal(resolveGoogleApiKey(null), null);
  assert.equal(resolveGoogleApiKey(undefined), null);
  assert.equal(resolveGoogleApiKey(''), null);
  assert.equal(resolveGoogleApiKey('   '), null);
  assert.equal(resolveGoogleApiKey(GOOGLE_API_KEY_PLACEHOLDER), null);
  assert.equal(resolveGoogleApiKey(42), null);
});

test('resolveServerGoogleApiKey prefers the server-restricted key', () => {
  assert.equal(
    resolveServerGoogleApiKey({ GOOGLE_MAPS_SERVER_API_KEY: 'server-key', GOOGLE_MAPS_API_KEY: 'browser-key' }),
    'server-key',
  );
});

test('resolveServerGoogleApiKey falls back to the browser key', () => {
  assert.equal(resolveServerGoogleApiKey({ GOOGLE_MAPS_API_KEY: 'browser-key' }), 'browser-key');
  assert.equal(resolveServerGoogleApiKey({}), null);
  assert.equal(resolveServerGoogleApiKey(null), null);
});

test('the fallback path applies the same placeholder discipline', () => {
  // A scaffolded placeholder must not sneak through just because the
  // server key is absent — keyless stays keyless.
  assert.equal(
    resolveServerGoogleApiKey({ GOOGLE_MAPS_API_KEY: GOOGLE_API_KEY_PLACEHOLDER }),
    null,
  );
  assert.equal(
    resolveServerGoogleApiKey({ GOOGLE_MAPS_SERVER_API_KEY: '  ', GOOGLE_MAPS_API_KEY: GOOGLE_API_KEY_PLACEHOLDER }),
    null,
  );
});
