import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRegionalWeather, weatherCodeLabel } from './regionalModel.js';
test('missing weather observations never assert clear conditions', () => {
  for (const value of [null, undefined, '', ' ', false, true]) {
    assert.equal(weatherCodeLabel(value), 'CONDITIONS UNKNOWN');
    assert.equal(
      normalizeRegionalWeather({ current: { temperature_2m: value } }),
      null,
    );
  }
  assert.equal(weatherCodeLabel(0), 'CLEAR');
  assert.equal(weatherCodeLabel('0'), 'CLEAR');
  const record = normalizeRegionalWeather({
    current: { temperature_2m: 0, weather_code: null, wind_speed_10m: false },
  });
  assert.equal(record.temperatureC, 0);
  assert.equal(record.weatherCode, null);
  assert.equal(record.windKph, null);
});
