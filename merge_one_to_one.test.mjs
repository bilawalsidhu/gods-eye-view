import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeObservations } from './src/layers/airQuality/merge.js';

const at = (provider, id, lon) => ({
  provider,
  id,
  stationId: id,
  lat: 0,
  lon,
  observedMs: Date.now(),
  assessment: { label: 'Good' },
});
const m = (metres) => metres / 111_320;

test('a direct station suppresses only its own aggregator copy, not a second monitor 120 m away', () => {
  const kept = mergeObservations(
    [
      {
        provider: 'national',
        direct: true,
        readings: [at('national', 'direct', 0)],
      },
      {
        provider: 'openaq',
        direct: false,
        readings: [at('openaq', 'copy', m(5)), at('openaq', 'other', m(120))],
      },
    ],
    { view: 'PM2.5' },
  );
  // Now: only 'direct' survives.
  assert.deepEqual(kept.map((r) => r.id).sort(), ['direct', 'other']);
});
