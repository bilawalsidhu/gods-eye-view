import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchRegionalBrief,
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
  assert.equal(weatherCodeLabel(weather.weatherCode), 'PARTLY CLOUDY');
  assert.equal(normalizeRegionalWeather({ current: {} }), null);
  // The rest of the WMO ladder, including both "unknown code" tails.
  assert.equal(weatherCodeLabel(3), 'OVERCAST');
  assert.equal(weatherCodeLabel(45), 'FOG');
  assert.equal(weatherCodeLabel(48), 'FOG');
  assert.equal(weatherCodeLabel(95), 'THUNDERSTORM');
  assert.equal(weatherCodeLabel(96), 'THUNDERSTORM');
  assert.equal(weatherCodeLabel(90), 'MIXED CONDITIONS');
  assert.equal(weatherCodeLabel('nonsense'), 'CONDITIONS UNKNOWN');
});

test('an unparseable article href is dropped, not rendered as a link', () => {
  // 'javascript:' is a valid URL with a non-http protocol (covered elsewhere);
  // these strings cannot be parsed as URLs at all → safeHttpUrl's catch.
  const articles = normalizeRegionalArticles({ articles: [
    { title: 'No scheme', url: 'example.press/story' },
    { title: 'Bare authority', url: 'http://' },
    { title: 'Real story', url: 'https://example.press/ok' },
  ] });
  assert.equal(articles.length, 1);
  assert.equal(articles[0].title, 'Real story');
  assert.equal(articles[0].domain, 'example.press');
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

test('fetchRegionalBrief builds the same-origin proxy URL and rejects bad input', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ place: { label: 'Duluth' } }), { status: 200 });
  };
  try {
    const payload = await fetchRegionalBrief(46.78671, -92.10053);
    assert.deepEqual(payload, { place: { label: 'Duluth' } });
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/api\/regional-brief\?latitude=46\.78671&longitude=-92\.10053$/);
    assert.deepEqual(calls[0].init, { signal: undefined }, 'only an (absent) signal is forwarded');

    // Abort signals must reach the proxy for camera-follow callers.
    const controller = new AbortController();
    await fetchRegionalBrief(46.78671, -92.10053, { signal: controller.signal });
    assert.equal(calls[1].init.signal, controller.signal);
  } finally {
    globalThis.fetch = originalFetch;
  }

  await assert.rejects(fetchRegionalBrief(Number.NaN, -92.1), /Valid coordinates are required/);
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('boom', { status: 503 });
  try {
    await assert.rejects(fetchRegionalBrief(46.78671, -92.1), /Regional brief unavailable \(503\)/);
  } finally {
    globalThis.fetch = original;
  }
});

// ── wave-6b: the WMO ladder arms, dedupe fallbacks, and distance guards ─────

test('weatherCodeLabel: the full WMO ladder, band by band', () => {
  assert.equal(weatherCodeLabel(0), 'CLEAR');
  assert.equal(weatherCodeLabel(1), 'PARTLY CLOUDY');
  assert.equal(weatherCodeLabel(2), 'PARTLY CLOUDY');
  assert.equal(weatherCodeLabel(51), 'DRIZZLE');
  assert.equal(weatherCodeLabel(57), 'DRIZZLE');
  assert.equal(weatherCodeLabel(61), 'RAIN');
  assert.equal(weatherCodeLabel(67), 'RAIN');
  assert.equal(weatherCodeLabel(71), 'SNOW');
  assert.equal(weatherCodeLabel(77), 'SNOW');
  assert.equal(weatherCodeLabel(80), 'RAIN SHOWERS');
  assert.equal(weatherCodeLabel(82), 'RAIN SHOWERS');
  assert.equal(weatherCodeLabel(85), 'SNOW SHOWERS');
  assert.equal(weatherCodeLabel(86), 'SNOW SHOWERS');
  assert.equal(weatherCodeLabel(150), 'THUNDERSTORM', '>=95 ladder tail');
  assert.equal(weatherCodeLabel(4), 'MIXED CONDITIONS', 'below drizzle band');
  assert.equal(weatherCodeLabel(90), 'MIXED CONDITIONS', 'between snow and showers');
});

test('normalizeRegionalPlace: dedupe in label, county fallbacks, and code casing', () => {
  // locality === region collapses in the LABEL (indexOf dedupe); region keeps
  // its raw value — state wins the region ladder over county.
  assert.deepEqual(normalizeRegionalPlace({ address: {
    city: 'Springfield', county: 'Sangamon', state: 'Springfield', country: 'USA', country_code: 'USA',
  } }), {
    label: 'Springfield', locality: 'Springfield', region: 'Springfield',
    country: 'USA', countryCode: 'USA',
  });
  // No locality at all: label falls back to region then country.
  const countyOnly = normalizeRegionalPlace({ address: { county: 'Sangamon' } });
  assert.equal(countyOnly.label, 'Sangamon');
  assert.equal(countyOnly.region, 'Sangamon');
  // Nothing names a place except the display_name blob.
  const displayOnly = normalizeRegionalPlace({ display_name: 'Nowhere, Tennessee, USA' });
  assert.equal(displayOnly.label, 'Nowhere, Tennessee, USA');
});

test('normalizeRegionalArticles: url_mobile fallback, hostname derivation, limit clamp', () => {
  const articles = normalizeRegionalArticles({ articles: [
    { title: 'Mobile only', url_mobile: 'https://mobile.example/story' }, // url missing → url_mobile
    { title: 'www strip', url: 'https://www2.news.example/none' }, // no domain → hostname minus www.
    { title: 'No url at all' },
    { url: 'https://silent.example/x' }, // no title → dropped
  ] }, 10);
  assert.equal(articles.length, 2);
  assert.equal(articles[0].domain, 'mobile.example');
  assert.equal(articles[1].domain, 'www2.news.example', 'only the leading www. is stripped');
  // Limit clamps to MAX_ARTICLES and never returns fewer than 1.
  const one = normalizeRegionalArticles({ articles: [
    { title: 'a', url: 'https://a.example/1' }, { title: 'b', url: 'https://b.example/2' },
  ] }, 1);
  assert.equal(one.length, 1);
  assert.deepEqual(normalizeRegionalArticles({ articles: 'nope' }), []);
});

test('regionalDistanceM: non-finite coordinates answer Infinity', () => {
  assert.equal(regionalDistanceM(
    { latitude: Number.NaN, longitude: -97.7 },
    { latitude: 30.2, longitude: -97.7 },
  ), Infinity);
  assert.equal(regionalDistanceM(null, { latitude: 30.2, longitude: -97.7 }), Infinity);
  // Same point → 0; Austin→Davis-ish sanity bound.
  assert.equal(regionalDistanceM(
    { latitude: 30.2, longitude: -97.7 },
    { latitude: 30.2, longitude: -97.7 },
  ), 0);
});
