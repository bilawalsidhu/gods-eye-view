import test from 'node:test';
import assert from 'node:assert/strict';
import { setLocale } from './index.js';
import { hudQuantity, LOCALIZED_LOCALITY } from '../hudLocalityFormat.js';
import { formatCockpitDistance } from '../ui/cockpitPresentation.js';

// revmain-opus-ja-i1-1: ja has no case, so HUD units keep the catalog case
// (km), as the cockpit already does and docs/translations/ja.md requires.
test('Japanese HUD units keep their case, like the cockpit', () => {
  try {
    setLocale('ja');
    assert.equal(formatCockpitDistance(14000), '14 km');
    assert.equal(hudQuantity(13, 'km'), '13 km');
    assert.equal(hudQuantity(1.5, 'km', 1), '1.5 km');
    assert.equal(
      LOCALIZED_LOCALITY.near({ poi: 'Shibuya', city: 'Tokyo', distKm: 13 }),
      'SHIBUYA（東京）付近 13 km',
    );
  } finally {
    setLocale('en');
  }
});
