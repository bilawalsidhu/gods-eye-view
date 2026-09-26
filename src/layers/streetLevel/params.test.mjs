import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeParams, encodeParams } from './params.js';

test('encodeParams writes one boolean per provider plus the filter', () => {
  assert.deepEqual(
    encodeParams({
      providers: [
        ['mapillary', true],
        ['panoramax', false],
      ],
      filter: { pano: 'flat', sinceDays: 365 },
    }),
    { mapillary: true, panoramax: false, pano: 'flat', sinceDays: 365 },
  );
});

test('decodeParams round-trips and ignores unknown or malformed keys', () => {
  const current = { pano: 'all', sinceDays: 0 };
  const decoded = decodeParams(
    { mapillary: false, kartaview: true, pano: 'pano', sinceDays: 730, x: 1 },
    { providerIds: ['mapillary'], filter: current },
  );
  assert.deepEqual([...decoded.providers], [['mapillary', false]]);
  assert.deepEqual(decoded.filter, { pano: 'pano', sinceDays: 730 });

  const partial = decodeParams(
    { mapillary: '1', pano: 'weird' },
    { providerIds: ['mapillary'], filter: { pano: 'flat', sinceDays: 5 } },
  );
  assert.equal(partial.providers.size, 0, 'a string is not a switch');
  assert.deepEqual(partial.filter, { pano: 'flat', sinceDays: 5 });

  const empty = decodeParams(null, {
    providerIds: ['mapillary'],
    filter: current,
  });
  assert.equal(empty.providers.size, 0);
  assert.deepEqual(empty.filter, current);
});
