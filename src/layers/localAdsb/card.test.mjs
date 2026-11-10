import test from 'node:test';
import assert from 'node:assert/strict';
import { setLocale } from '../../i18n/index.js';
import { localAdsbCardModel } from './card.js';

test('a track of 359.7° reads TRK 0°, not TRK 360°', () => {
  setLocale('en');
  const { details } = localAdsbCardModel(
    {
      icao: 'abc123',
      altitudeFt: 12500,
      groundSpeedKt: 240,
      trackDeg: 359.7,
      lastPositionAt: 1000,
    },
    5000,
  );
  assert.equal(details[1], 'ALT 12,500 FT · GS 240 KT · TRK 0°');
});
