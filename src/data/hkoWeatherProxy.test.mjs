import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  HKO_RHRREAD_URL,
  fetchHkoWeather,
  fetchRegionalWeather,
} from '../../server/providers/regional/weather.js';
import { weatherCodeLabel } from './regionalModel.js';

test('fetchHkoWeather normalizes a live-shaped rhrread payload', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(String(url), HKO_RHRREAD_URL);
    assert.equal(init.redirect, 'error');
    return Response.json({
      updateTime: '2026-10-11T01:02:00+08:00',
      icon: [50],
      temperature: {
        recordTime: '2026-10-11T01:00:00+08:00',
        data: [{ place: 'Hong Kong Observatory', value: 27, unit: 'C' }],
      },
      rainfall: {
        data: [{ place: 'Yau Tsim Mong', max: 0, unit: 'mm' }],
      },
    });
  });
  const weather = await fetchHkoWeather({
    latitude: 22.3,
    longitude: 114.17,
  });
  assert.equal(weather.source, 'hko');
  assert.equal(weather.temperatureC, 27);
  assert.equal(weatherCodeLabel(weather.weatherCode), 'CLEAR');
});

test('fetchRegionalWeather prefers HKO over Hong Kong and falls back outside', async (t) => {
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    const href = String(url);
    requested.push(href);
    if (href === HKO_RHRREAD_URL) {
      return Response.json({
        icon: [60],
        temperature: {
          recordTime: '2026-10-11T01:00:00+08:00',
          data: [{ place: 'Hong Kong Observatory', value: 26, unit: 'C' }],
        },
        rainfall: { data: [{ place: 'Wan Chai', max: 0, unit: 'mm' }] },
      });
    }
    return Response.json({
      current: {
        time: '2026-10-10T17:00',
        temperature_2m: 18.5,
        weather_code: 1,
        cloud_cover: 20,
        wind_speed_10m: 10,
        wind_direction_10m: 90,
        precipitation: 0,
        visibility: 20000,
      },
    });
  });

  const hk = await fetchRegionalWeather({
    latitude: 22.3,
    longitude: 114.17,
  });
  assert.equal(hk.source, 'hko');
  assert.equal(hk.temperatureC, 26);
  assert.ok(requested.includes(HKO_RHRREAD_URL));

  requested.length = 0;
  const elsewhere = await fetchRegionalWeather({
    latitude: 51.5,
    longitude: -0.12,
  });
  assert.equal(elsewhere.source, 'open-meteo');
  assert.equal(elsewhere.temperatureC, 18.5);
  assert.equal(requested.includes(HKO_RHRREAD_URL), false);
});

test('fetchRegionalWeather falls back to Open-Meteo when HKO fails over HK', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url) === HKO_RHRREAD_URL) {
      return new Response('unavailable', { status: 503 });
    }
    return Response.json({
      current: {
        time: '2026-10-10T17:00',
        temperature_2m: 25.1,
        weather_code: 3,
        cloud_cover: 80,
        wind_speed_10m: 12,
        wind_direction_10m: 180,
        precipitation: 0.2,
        visibility: 8000,
      },
    });
  });
  const weather = await fetchRegionalWeather({
    latitude: 22.3,
    longitude: 114.17,
  });
  assert.equal(weather.source, 'open-meteo');
  assert.equal(weather.temperatureC, 25.1);
});
