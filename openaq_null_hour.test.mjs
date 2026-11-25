import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeOpenAqHours } from './src/layers/airQuality/openAq.js';

const H = 3600_000;
const station = {
  stationId: '7',
  name: 'S',
  lat: 1,
  lon: 1,
  sensors: [{ id: 1, parameter: 'PM2.5', units: 'µg/m³' }],
};
const row = (toMs, value) => ({
  value,
  period: {
    interval: '01:00:00',
    datetimeFrom: { utc: new Date(toMs - H).toISOString() },
    datetimeTo: { utc: new Date(toMs).toISOString() },
  },
  parameter: { name: 'pm25', units: 'µg/m³' },
  coverage: { percentCoverage: 100 },
  flagInfo: { hasFlags: false },
});

test('a null newest hour does not hide the valid hour before it', () => {
  const now = Date.now();
  const top = Math.floor(now / H) * H;
  for (const rows of [
    [row(top, null), row(top - H, 22)],
    [row(top - H, 22), row(top, null)],
  ]) {
    const out = normalizeOpenAqHours(station, station.sensors[0], rows, now);
    // Now: [] in both orders.
    assert.equal(out.length, 1);
    assert.equal(out[0].value, 22);
    assert.equal(out[0].periodEnd, new Date(top - H).toISOString());
  }
});
