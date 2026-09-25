import test from 'node:test';
import assert from 'node:assert/strict';
import { formatWindReading, windReadingResult } from './presentation.js';

const sample = {
  speed: 5,
  from: 'SW',
  coordinates: '41.9°N · 87.6°W',
  model: 'NOAA GFS',
  validTime: '2026-09-21 12:00 UTC',
  scalarLabel: 'Air temperature · 2 m',
  scalarValue: '12 °C',
  explanation: 'Interpolated model forecast.',
};
test('captured reading reformats without changing its sample and produces a portable result block', () => {
  const reading = formatWindReading(sample, 'mph');
  assert.equal(reading.wind, '11.2 mph from SW');
  assert.equal(reading.speed, sample.speed);
  assert.equal(reading.coordinates, sample.coordinates);
  assert.equal(sample.units, undefined);
  const section = windReadingResult(reading);
  assert.equal(section.id, 'reading');
  assert.equal(
    section.lines.find(({ id }) => id === 'scalar').text,
    'Air temperature · 2 m · 12 °C',
  );
  assert.equal(
    section.lines.find(({ id }) => id === 'wind').text,
    '11.2 mph from SW',
  );
  assert.equal(
    section.lines.find(({ id }) => id === 'meta').text,
    'NOAA GFS · valid 09-21 12:00 UTC',
  );
  assert.equal(section.label, 'WIND AT 41.9°N 87.6°W');
  assert.deepEqual(section.clear.params, { inspect: false });
  assert.equal(
    formatWindReading({ ...sample, from: 'Calm' }, 'm/s').wind,
    '5.0 m/s · calm',
  );
  assert.equal(formatWindReading(null, 'km/h'), null);
  assert.equal(
    windReadingResult({
      coordinates: 'No surface reading',
      wind: 'Unavailable',
    }).lines.some(({ id }) => id === 'scalar'),
    false,
  );
});
