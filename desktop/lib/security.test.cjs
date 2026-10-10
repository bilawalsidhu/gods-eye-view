'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isExternalWebUrl,
  isSameOrigin,
  permissionAllowed,
} = require('./security.cjs');

test('same-origin checks compare the full origin and reject garbage', () => {
  const origin = 'http://127.0.0.1:47831/';
  assert.equal(isSameOrigin('http://127.0.0.1:47831/api/x?y=1', origin), true);
  assert.equal(isSameOrigin('http://127.0.0.1:47832/', origin), false);
  assert.equal(isSameOrigin('https://127.0.0.1:47831/', origin), false);
  assert.equal(isSameOrigin('http://localhost:47831/', origin), false);
  assert.equal(isSameOrigin('not a url', origin), false);
});

test('only http(s) URLs may reach the system browser', () => {
  assert.equal(isExternalWebUrl('https://example.com/a'), true);
  assert.equal(isExternalWebUrl('http://example.com'), true);
  for (const bad of [
    'file:///etc/passwd',
    'javascript:alert(1)',
    'smb://x/y',
    '',
  ]) {
    assert.equal(isExternalWebUrl(bad), false, bad);
  }
});

test('the permission policy allows audio capture and fullscreen only', () => {
  assert.equal(permissionAllowed('media', { mediaTypes: ['audio'] }), true);
  assert.equal(permissionAllowed('media', { mediaTypes: ['video'] }), false);
  assert.equal(
    permissionAllowed('media', { mediaTypes: ['audio', 'video'] }),
    false,
  );
  assert.equal(permissionAllowed('media', {}), false);
  assert.equal(permissionAllowed('fullscreen'), true);
  for (const denied of [
    'geolocation',
    'notifications',
    'openExternal',
    'hid',
    'usb',
  ]) {
    assert.equal(permissionAllowed(denied), false, denied);
  }
});
