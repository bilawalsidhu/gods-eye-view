import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GOES_STAR_PRODUCTS,
  starImageUrl,
} from '../../server/providers/goes/catalog.js';

test('GOES STAR catalog records endpoint and native dimensions truthfully', () => {
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(GOES_STAR_PRODUCTS).map(([id, spec]) => [
        id,
        [spec.endpointSize, spec.nativeWidth, spec.nativeHeight],
      ]),
    ),
    {
      GEOCOLOR: [5424, 5424, 5424],
      ABI13: [5424, 5424, 5424],
      ABI2: [5424, 21696, 21696],
    },
  );
  assert.equal(GOES_STAR_PRODUCTS.ABI2.resolutionState, 'fallback');
  assert.match(
    starImageUrl({ starCode: 'GOES19' }, { product: 'ABI2' }),
    /ABI2\/5424x5424\.jpg$/,
  );
  assert.equal(GOES_STAR_PRODUCTS.ABI2.fallbackResolutionKm, 2);
  assert.match(
    GOES_STAR_PRODUCTS.ABI2.nativeZipNote,
    /21696x21696 native C02 ZIP/,
  );
  assert.match(
    starImageUrl({ starCode: 'GOES19' }, { product: 'ABI13' }),
    /ABI13\/5424x5424\.jpg$/,
  );
});
