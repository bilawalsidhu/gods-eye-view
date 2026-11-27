import test from 'node:test';
import assert from 'node:assert/strict';
import { satelliteSwath, visibleSwathKm } from './satelliteSwath.js';

test('an imaging satellite uses its sensor’s swath', () => {
  assert.deepEqual(
    satelliteSwath({ sensor: { label: 'MSI', swathKm: 290 } }, 786_000),
    { km: 290, sensor: 'MSI' },
  );
});

test('any other satellite uses the ground it sees above 45°, wider the higher it flies', () => {
  const iss = satelliteSwath({ sensor: null }, 418_000);
  assert.equal(iss.sensor, null);
  assert.ok(iss.km > 700 && iss.km < 830, `ISS: ${iss.km}`);
  assert.ok(visibleSwathKm(786_000) > iss.km);
  assert.equal(visibleSwathKm(0), null);
  assert.equal(satelliteSwath(null, Number.NaN), null);
});
