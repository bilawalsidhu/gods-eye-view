import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mapillaryPublicImageId,
  mapillaryPublicEmbedUrl,
} from './mapillaryEmbed.js';
test('public image URLs resolve only their numeric ID, discarding other query data', () => {
  assert.equal(mapillaryPublicImageId('123456789012345'), '123456789012345');
  assert.equal(
    mapillaryPublicImageId(
      'https://www.mapillary.com/app/?pKey=123456789012345&lat=33&lng=-84&focus=photo',
    ),
    '123456789012345',
  );
  assert.equal(
    mapillaryPublicEmbedUrl('123456789012345'),
    'https://www.mapillary.com/embed?image_key=123456789012345&style=photo',
  );
});
test('external destinations, credentials and scripted URLs cannot become frames', () => {
  for (const value of [
    'https://evil.test/app/?pKey=123456789012345',
    'https://www.mapillary.com.evil.test/app/?pKey=123456789012345',
    'https://user:password@www.mapillary.com/app/?pKey=123456789012345',
    'https://www.mapillary.com/app/?pKey=123456789012345&access_token=secret',
    'http://www.mapillary.com/app/?pKey=123456789012345',
    'javascript:alert(1)',
    '../private',
    '<iframe>',
    '123',
    'https://www.mapillary.com/private?pKey=123456789012345',
  ])
    assert.equal(mapillaryPublicImageId(value), null);
  assert.equal(mapillaryPublicEmbedUrl('" onload="alert(1)'), null);
});
