import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hkoIconToWmo,
  isNearHongKong,
  normalizeHkoWeather,
  normalizeRegionalArticles,
  normalizeRegionalPlace,
  normalizeRegionalWeather,
  regionalDistanceM,
  weatherCodeLabel,
} from './regionalBrief.js';

test('normalizes a regional place with stable locality fallback', () => {
  assert.deepEqual(normalizeRegionalPlace({ address: {
    town: 'Davis', state: 'California', country: 'United States', country_code: 'us',
  } }), {
    label: 'Davis, California', locality: 'Davis', region: 'California',
    country: 'United States', countryCode: 'US',
  });
  assert.equal(normalizeRegionalPlace({ address: {} }), null);
});

test('normalizes, deduplicates, and rejects unsafe regional-news rows', () => {
  const articles = normalizeRegionalArticles({ articles: [
    { title: 'Regional update', url: 'https://news.example/one', domain: 'news.example', seendate: '20260722T081500Z' },
    { title: 'Regional   update', url: 'https://news.example/two' },
    { title: 'Unsafe', url: 'javascript:alert(1)' },
    { title: 'Second story', url: 'https://other.example/story', seendate: '2026-07-22T07:00:00Z' },
  ] });
  assert.equal(articles.length, 2);
  assert.equal(articles[0].publishedAt, '2026-07-22T08:15:00Z');
  assert.equal(articles[1].domain, 'other.example');
});

test('normalizes weather values and labels WMO conditions', () => {
  const weather = normalizeRegionalWeather({ current: {
    time: '2026-07-22T08:15:00Z', temperature_2m: 21.4, apparent_temperature: 20.8,
    precipitation: 0, cloud_cover: 42, wind_speed_10m: 18.2, wind_direction_10m: 270,
    visibility: 18000, weather_code: 2,
  } });
  assert.equal(weather.temperatureC, 21.4);
  assert.equal(weather.visibilityM, 18000);
  assert.equal(weather.source, 'open-meteo');
  assert.equal(weatherCodeLabel(weather.weatherCode), 'PARTLY CLOUDY');
  assert.equal(normalizeRegionalWeather({ current: {} }), null);
});

test('HKO current weather prefers the nearest station and maps icons', () => {
  assert.equal(isNearHongKong({ latitude: 22.3, longitude: 114.17 }), true);
  assert.equal(isNearHongKong({ latitude: 37.77, longitude: -122.42 }), false);
  assert.equal(hkoIconToWmo(65), 95);
  assert.equal(weatherCodeLabel(hkoIconToWmo(62)), 'RAIN');
  const weather = normalizeHkoWeather(
    {
      updateTime: '2026-10-11T01:02:00+08:00',
      icon: [62],
      temperature: {
        recordTime: '2026-10-11T01:00:00+08:00',
        data: [
          { place: 'Hong Kong Observatory', value: 27, unit: 'C' },
          { place: 'Sha Tin', value: 24, unit: 'C' },
        ],
      },
      rainfall: {
        data: [
          { place: 'Yau Tsim Mong', max: 0, unit: 'mm' },
          { place: 'Sha Tin', max: 1.2, unit: 'mm' },
        ],
      },
    },
    { latitude: 22.38, longitude: 114.19 },
  );
  assert.equal(weather.source, 'hko');
  assert.equal(weather.temperatureC, 24);
  assert.equal(weather.precipitationMm, 1.2);
  assert.equal(weather.weatherCode, 61);
  assert.equal(weather.windKph, null);
  assert.equal(weather.observedAt, '2026-10-10T17:00:00.000Z');
  assert.equal(normalizeHkoWeather({ temperature: { data: [] } }, { latitude: 22.3, longitude: 114.17 }), null);
});

test('zone-naive Open-Meteo timestamps are pinned to UTC, zoned ones pass through', () => {
  // Open-Meteo's default payload carries no zone designator; JS would parse it
  // as host-local time, skewing observedAt by the UTC offset.
  const naive = normalizeRegionalWeather({ current: { time: '2026-08-17T00:15', temperature_2m: 20 } });
  assert.equal(naive.observedAt, '2026-08-17T00:15:00.000Z');
  const zoned = normalizeRegionalWeather({ current: { time: '2026-08-17T00:15:00+02:00', temperature_2m: 20 } });
  assert.equal(zoned.observedAt, '2026-08-16T22:15:00.000Z');
  const invalid = normalizeRegionalWeather({ current: { time: 'not-a-time', temperature_2m: 20 } });
  assert.equal(invalid.observedAt, null);
});

test('regional distance handles nearby movement and missing positions', () => {
  const distance = regionalDistanceM(
    { latitude: 38.5, longitude: -121.7 },
    { latitude: 38.6, longitude: -121.7 },
  );
  assert.ok(distance > 11000 && distance < 11200);
  assert.equal(regionalDistanceM(null, null), Infinity);
});
