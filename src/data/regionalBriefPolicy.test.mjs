// src/data/regionalBriefPolicy.test.mjs
//
// Drives the shared regional-brief resolution core with injected
// fetch/clock/pacing so every contract branch (405/400/MISS/HIT/INFLIGHT/
// STALE/503, the GDELT fallback, RSS normalization) is exercised with no
// network. The dev middleware and the Pages Function are thin adapters over
// this core; their own tests cover the adapter shells.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  REGIONAL_BRIEF_CACHE_MS,
  REGIONAL_BRIEF_STALE_MS,
  buildRegionalBriefPayload,
  createNominatimPacing,
  decodeRssText,
  fetchRegionalNews,
  fetchRegionalWeather,
  normalizeRssArticles,
  readRegionalTextCapped,
  regionalBriefHasAnySource,
  resolveRegionalBriefRequest,
  rssTag,
} from './regionalBriefPolicy.js';

const SP = (query = '') => new URLSearchParams(query);

/** A place payload shaped like a Nominatim /reverse jsonv2 response. */
const NOMINATIM_BODY = {
  address: { city: 'Duluth', state: 'Minnesota', country: 'United States' },
  display_name: 'Duluth, Minnesota, United States',
};

const OPEN_METEO_BODY = { current: { weather_code: 3, temperature_2m: 9.4 } };

const RSS_BODY = `<?xml version="1.0"?><rss><channel>
<item><title>Duluth harbor reroutes ferries</title><link>https://example.press/1</link><source>Example Press</source><pubDate>Mon, 14 Sep 2026 10:00:00 GMT</pubDate></item>
<item><title><![CDATA[Storm front &lt;pushes&gt; into Duluth]]></title><link>https://example.press/2</link><pubDate>Mon, 14 Sep 2026 11:00:00 GMT</pubDate></item>
<item><title>Duluth harbor reroutes ferries</title><link>https://other.press/3</link><source>Other Press</source></item>
<item><title>Not a link</title><link>javascript:alert(1)</link></item>
</channel></rss>`;

/**
 * Mock fetch keyed by upstream substring. Every branch that matters is
 * represented: Nominatim (place), Open-Meteo (weather), Google News RSS
 * (primary news), GDELT (fallback news).
 */
function mockFetch(bySubstring = {}, { defaultStatus = 404 } = {}) {
  const calls = [];
  const impl = (url) => {
    calls.push(String(url));
    const entry = Object.entries(bySubstring).find(([needle]) => String(url).includes(needle));
    if (!entry) return new Response('nope', { status: defaultStatus });
    const [_, body] = entry;
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': typeof body === 'string' ? 'application/rss+xml' : 'application/json' },
    });
  };
  return { impl, calls };
}

/** A resolve call wired to a fresh cache/inFlight/pacing per test. */
function resolveDeps(overrides = {}) {
  return {
    searchParams: SP('latitude=46.7867&longitude=-92.1005'),
    cache: new Map(),
    inFlight: new Map(),
    pacing: createNominatimPacing(),
    ...overrides,
  };
}

const HAPPY_FETCH = mockFetch({
  'nominatim.openstreetmap.org': NOMINATIM_BODY,
  'open-meteo.com': OPEN_METEO_BODY,
  'news.google.com': RSS_BODY,
});

test('resolveRegionalBriefRequest: full refresh assembles the client contract', async () => {
  const outcome = await resolveRegionalBriefRequest({ ...resolveDeps(), fetchImpl: HAPPY_FETCH.impl });
  assert.equal(outcome.status, 200);
  assert.equal(outcome.cacheState, 'MISS');
  assert.equal(outcome.cacheControl, 'public, max-age=60');
  const { payload } = outcome;
  assert.equal(payload.status, 'ready');
  assert.equal(payload.placeStatus, 'ready');
  assert.equal(payload.weatherStatus, 'ready');
  assert.equal(payload.newsStatus, 'ready');
  assert.equal(payload.newsSource, 'Google News RSS');
  assert.equal(payload.place.locality, 'Duluth');
  assert.ok(Array.isArray(payload.articles) && payload.articles.length >= 2);
  assert.deepEqual(payload.coordinates, { latitude: 46.7867, longitude: -92.1005 });
  assert.match(payload.retrievedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('resolveRegionalBriefRequest: 405 and 400 branches', async () => {
  const methodOutcome = await resolveRegionalBriefRequest({
    ...resolveDeps({ method: 'POST' }),
    fetchImpl: HAPPY_FETCH.impl,
  });
  assert.equal(methodOutcome.status, 405);
  assert.deepEqual(methodOutcome.payload, { error: 'Method Not Allowed' });
  assert.equal(methodOutcome.cacheState, 'NONE');

  for (const bad of ['', 'latitude=91&longitude=0', 'latitude=46&longitude=-181', 'latitude=46']) {
    const outcome = await resolveRegionalBriefRequest({
      ...resolveDeps({ searchParams: SP(bad) }),
      fetchImpl: HAPPY_FETCH.impl,
    });
    assert.equal(outcome.status, 400, `bad query "${bad}"`);
    assert.deepEqual(outcome.payload, { error: 'Valid latitude and longitude are required' });
  }
  // Zero coordinates are valid (the Gulf of Guinea deserves news too).
  const zero = await resolveRegionalBriefRequest({
    ...resolveDeps({ searchParams: SP('latitude=0&longitude=0') }),
    fetchImpl: HAPPY_FETCH.impl,
  });
  assert.equal(zero.status, 200);
});

test('resolveRegionalBriefRequest: cache hit serves status cached inside the TTL', async () => {
  let at = 1_000_000;
  const deps = resolveDeps({ now: () => at, fetchImpl: HAPPY_FETCH.impl });
  await resolveRegionalBriefRequest(deps);
  at += REGIONAL_BRIEF_CACHE_MS - 1;
  const hit = await resolveRegionalBriefRequest(deps);
  assert.equal(hit.cacheState, 'HIT');
  assert.equal(hit.payload.status, 'cached');
  assert.equal(hit.cacheControl, 'public, max-age=60');
});

test('resolveRegionalBriefRequest: failed refresh serves stale inside the revalidate window', async () => {
  let at = 1_000_000;
  const deps = resolveDeps({ now: () => at, fetchImpl: HAPPY_FETCH.impl });
  await resolveRegionalBriefRequest(deps);

  at = 1_000_000 + REGIONAL_BRIEF_CACHE_MS + 500; // outside TTL, inside stale window
  const failing = mockFetch({}); // every upstream fails now
  const stale = await resolveRegionalBriefRequest({ ...deps, fetchImpl: failing.impl });
  assert.equal(stale.cacheState, 'STALE');
  assert.equal(stale.status, 200);
  assert.equal(stale.payload.status, 'stale');
  assert.equal(stale.cacheControl, 'no-store');

  // And past the stale window the same failure becomes a 503.
  at += REGIONAL_BRIEF_STALE_MS + 1;
  const gone = await resolveRegionalBriefRequest({ ...deps, fetchImpl: failing.impl });
  assert.equal(gone.status, 503);
});

test('resolveRegionalBriefRequest: total source failure with no cache is a 503', async () => {
  const failing = mockFetch({});
  const outcome = await resolveRegionalBriefRequest({ ...resolveDeps(), fetchImpl: failing.impl });
  assert.equal(outcome.status, 503);
  assert.deepEqual(outcome.payload, { error: 'Regional briefing is temporarily unavailable' });
  assert.equal(outcome.cacheControl, 'no-store');
});

test('resolveRegionalBriefRequest: concurrent requests coalesce into one refresh', async () => {
  const own = mockFetch({
    'nominatim.openstreetmap.org': NOMINATIM_BODY,
    'open-meteo.com': OPEN_METEO_BODY,
    'news.google.com': RSS_BODY,
  });
  const deps = resolveDeps({ fetchImpl: own.impl });
  const [first, second] = await Promise.all([
    resolveRegionalBriefRequest(deps),
    resolveRegionalBriefRequest(deps),
  ]);
  assert.equal(first.cacheState, 'MISS');
  assert.equal(second.cacheState, 'INFLIGHT');
  assert.deepEqual(first.payload.articles, second.payload.articles);
  const nominatimCalls = own.calls.filter((url) => url.includes('nominatim')).length;
  assert.equal(nominatimCalls, 1, 'the second request joined the in-flight refresh');
});

test('resolveRegionalBriefRequest: partial status when news is unavailable', async () => {
  const noNews = mockFetch({
    'nominatim.openstreetmap.org': NOMINATIM_BODY,
    'open-meteo.com': OPEN_METEO_BODY,
    // neither news upstream answers
  });
  const outcome = await resolveRegionalBriefRequest({ ...resolveDeps(), fetchImpl: noNews.impl });
  assert.equal(outcome.status, 200);
  assert.equal(outcome.payload.status, 'partial');
  assert.equal(outcome.payload.newsStatus, 'unavailable');
  assert.deepEqual(outcome.payload.articles, []);
});

test('fetchRegionalNews: GDELT fallback serves articles when RSS fails', async () => {
  const gdeltOnly = mockFetch({
    'api.gdeltproject.org': { articles: [{ title: 'GDELT story', url: 'https://example.press/g', domain: 'Example' }] },
  });
  const news = await fetchRegionalNews({ locality: 'Duluth' }, { fetchImpl: gdeltOnly.impl });
  assert.equal(news.status, 'ready');
  assert.equal(news.source, 'GDELT fallback');
  assert.equal(news.articles.length, 1);
});

test('fetchRegionalNews: no queryable place is unavailable without any upstream call', async () => {
  const { impl, calls } = mockFetch({});
  const news = await fetchRegionalNews(null, { fetchImpl: impl });
  assert.deepEqual(news, { status: 'unavailable', query: null, articles: [], source: null });
  assert.equal(calls.length, 0);
});

test('normalizeRssArticles: dedupes, decodes CDATA/entities, drops non-http links', () => {
  const articles = normalizeRssArticles(RSS_BODY, 5);
  // Same title from a DIFFERENT source is a distinct row (signature is
  // title+source); the javascript: link row is dropped.
  assert.equal(articles.length, 3);
  assert.equal(articles[0].title, 'Duluth harbor reroutes ferries');
  // Entities decode, then tags strip — markup never survives into a title.
  assert.equal(articles[1].title, 'Storm front into Duluth');
  assert.equal(articles[0].publishedAt, '2026-09-14T10:00:00.000Z');
  // Identical title+source collapses to one row.
  const duped = normalizeRssArticles(
    `<rss><channel>
     <item><title>T</title><link>https://a.example/1</link><source>S</source></item>
     <item><title>T</title><link>https://a.example/2</link><source>S</source></item>
     </channel></rss>`, 5);
  assert.equal(duped.length, 1);
  // Limit clamps.
  assert.equal(normalizeRssArticles(RSS_BODY, 1).length, 1);
});

test('rss helpers decode entities and read tags', () => {
  assert.equal(decodeRssText('<b>A &amp; B</b>'), 'A & B');
  assert.equal(rssTag('<item><title>Hello</title></item>', 'title'), 'Hello');
});

test('regionalBriefHasAnySource treats each source independently', () => {
  assert.equal(regionalBriefHasAnySource({}), false);
  assert.equal(regionalBriefHasAnySource({ place: {} }), true);
  assert.equal(regionalBriefHasAnySource({ weather: {} }), true);
  assert.equal(regionalBriefHasAnySource({ news: { status: 'empty' } }), true);
  assert.equal(regionalBriefHasAnySource({ news: { status: 'unavailable' } }), false);
});

test('readRegionalTextCapped enforces the byte cap on streaming bodies', async () => {
  const big = new Response('x'.repeat(64));
  await assert.rejects(readRegionalTextCapped(big, 32), (error) => error?.code === 'RESPONSE_TOO_LARGE');
  const small = new Response('ok');
  assert.equal(await readRegionalTextCapped(small, 32), 'ok');
  const declared = new Response('x', { headers: { 'Content-Length': '9999' } });
  await assert.rejects(readRegionalTextCapped(declared, 32), (error) => error?.code === 'RESPONSE_TOO_LARGE');
});

test('fetchRegionalWeather collapses upstream failure to null', async () => {
  const dead = mockFetch({});
  assert.equal(await fetchRegionalWeather({ latitude: 1, longitude: 2 }, { fetchImpl: dead.impl }), null);
});

test('buildRegionalBriefPayload keeps ready vs partial and per-source statuses honest', () => {
  const point = { latitude: 1, longitude: 2 };
  const news = { status: 'ready', query: 'x', articles: [], source: 'Google News RSS' };
  const ready = buildRegionalBriefPayload(point, {}, {}, news, () => 0);
  assert.equal(ready.status, 'ready');
  const partial = buildRegionalBriefPayload(point, null, {}, news, () => 0);
  assert.equal(partial.status, 'partial');
  assert.equal(partial.placeStatus, 'unavailable');
});
