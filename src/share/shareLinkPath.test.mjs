import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appRootUrl, parseSharePath, shareLinkUrl } from './shareLinkPath.js';

test('a share path names its code and the app base path', () => {
  assert.deepEqual(parseSharePath('/share/AQc'), {
    code: 'AQc',
    basePath: '/',
  });
  assert.deepEqual(parseSharePath('/gev/share/AQc/'), {
    code: 'AQc',
    basePath: '/gev/',
  });
  // A mangled code is still a share link, so the app refuses it out loud.
  assert.equal(parseSharePath('/share/AQ.c').code, 'AQ.c');
  for (const path of ['/', '/share', '/share/', '/share/a/b', '/sharex/AQc'])
    assert.equal(parseSharePath(path), null, path);
  assert.equal(parseSharePath(undefined), null);
});

test('the app root drops a share path and the hash, and keeps the query', () => {
  assert.equal(
    appRootUrl('https://gev.example/share/AQc?qa=1#v=2').href,
    'https://gev.example/?qa=1',
  );
  assert.equal(
    appRootUrl('http://localhost:4173/gev/share/AQc').href,
    'http://localhost:4173/gev/',
  );
  assert.equal(
    appRootUrl('https://gev.example/index.html#v=2&lat=1').href,
    'https://gev.example/',
  );
});

test('a share link sits under the app root without the sender ?lang', () => {
  assert.equal(
    shareLinkUrl('AQc', 'https://gev.example/?lang=ru#v=2&lat=1'),
    'https://gev.example/share/AQc',
  );
  assert.equal(
    shareLinkUrl('AQc', 'https://gev.example/gev/share/old?qa=1&lang=es'),
    'https://gev.example/gev/share/AQc?qa=1',
  );
});
