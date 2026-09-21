import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregatePlaces,
  formatAge,
  formatAgoMinutes,
  mapAnalystRecord,
  normalizeWorldNewsSnapshot,
  placeKey,
  placePixelSize,
  toneBand,
  truncateHeadline,
} from './records.js';

function article(overrides = {}) {
  return {
    id: 'wn-1',
    title: 'Flood warnings issued for Valencia',
    url: 'https://news.example.com/valencia-floods',
    domain: 'news.example.com',
    publishedAt: '2026-09-15T06:00:00Z',
    sentiment: -0.62,
    category: 'environment',
    language: 'en',
    sourceCountry: 'es',
    lat: 39.4699,
    lon: -0.3763,
    place: 'Valencia',
    placeFoundIn: 'title',
    placeMentions: 1,
    ...overrides,
  };
}

test('a well-formed payload becomes rows that keep only the contract fields', () => {
  const rows = normalizeWorldNewsSnapshot({
    articles: [article(), article({ id: 'wn-2', title: '  Second  ' })],
  });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    id: 'wn-1',
    title: 'Flood warnings issued for Valencia',
    url: 'https://news.example.com/valencia-floods',
    domain: 'news.example.com',
    publishedAt: '2026-09-15T06:00:00Z',
    publishedMs: Date.parse('2026-09-15T06:00:00Z'),
    sentiment: -0.62,
    category: 'environment',
    language: 'en',
    sourceCountry: 'es',
    // Absent from the payload unless the proxy runs with thumbnails on.
    image: null,
    lat: 39.4699,
    lon: -0.3763,
    place: 'Valencia',
    placeFoundIn: 'title',
    placeMentions: 1,
  });
  assert.equal(rows[1].title, 'Second');
  assert.deepEqual(normalizeWorldNewsSnapshot({ articles: [] }), []);
});

test('one malformed article rejects the whole snapshot', () => {
  for (const [label, payload] of [
    ['no articles array', { articles: null }],
    ['not an object', { articles: [null] }],
    ['array article', { articles: [[]] }],
    ['empty id', { articles: [article({ id: '' })] }],
    ['numeric id', { articles: [article({ id: 7 })] }],
    ['empty title', { articles: [article({ title: '   ' })] }],
    ['non-http url', { articles: [article({ url: 'ftp://x.example/a' })] }],
    ['script url', { articles: [article({ url: 'javascript:alert(1)' })] }],
    ['missing url', { articles: [article({ url: undefined })] }],
    ['lat out of range', { articles: [article({ lat: 90.5 })] }],
    ['lon out of range', { articles: [article({ lon: -180.5 })] }],
    ['lat NaN', { articles: [article({ lat: NaN })] }],
    ['lon string', { articles: [article({ lon: '4.5' })] }],
    ['sentiment above 1', { articles: [article({ sentiment: 1.5 })] }],
    ['sentiment text', { articles: [article({ sentiment: 'sad' })] }],
    ['unparseable date', { articles: [article({ publishedAt: 'yesterday' })] }],
    ['numeric date', { articles: [article({ publishedAt: 1_700_000_000 })] }],
    ['duplicate ids', { articles: [article(), article()] }],
  ]) {
    assert.equal(normalizeWorldNewsSnapshot(payload), null, label);
  }
});

test('optional provider fields degrade to null rather than rejecting the batch', () => {
  const [row] = normalizeWorldNewsSnapshot({
    articles: [
      article({
        domain: undefined,
        publishedAt: null,
        sentiment: undefined,
        category: 42,
        language: null,
        sourceCountry: '',
        place: undefined,
        placeFoundIn: null,
        placeMentions: -3,
      }),
    ],
  });
  assert.equal(
    row.domain,
    'news.example.com',
    'domain falls back to the URL host',
  );
  assert.equal(row.publishedAt, null);
  assert.equal(row.publishedMs, null);
  assert.equal(row.sentiment, null);
  assert.equal(row.category, null);
  assert.equal(row.language, null);
  assert.equal(row.sourceCountry, null);
  assert.equal(row.place, null);
  assert.equal(row.placeFoundIn, null);
  assert.equal(row.placeMentions, 0);
});

test('tone bands split at the policy thresholds and unknown never reads as neutral', () => {
  assert.equal(toneBand(-1), 'negative');
  assert.equal(toneBand(-0.3), 'negative');
  assert.equal(toneBand(-0.29), 'neutral');
  assert.equal(toneBand(0), 'neutral');
  assert.equal(toneBand(0.29), 'neutral');
  assert.equal(toneBand(0.3), 'positive');
  assert.equal(toneBand(1), 'positive');
  for (const value of [null, undefined, NaN, '0.5', Infinity])
    assert.equal(toneBand(value), 'unknown');
});

test('place keys round to three decimals without a signed zero', () => {
  assert.equal(placeKey(39.4699, -0.3763), 'wn-place:39.470:-0.376');
  assert.equal(placeKey(-0.0001, 0.0004), 'wn-place:0.000:0.000');
  assert.equal(placeKey(-0.0001, 0.0004), placeKey(0.0001, -0.0004));
  assert.notEqual(placeKey(51.92, 4.48), placeKey(51.921, 4.48));
});

test('aggregatePlaces groups nearby headlines, votes on the name and orders newest first', () => {
  const rows = normalizeWorldNewsSnapshot({
    articles: [
      article({
        id: 'wn-old',
        publishedAt: '2026-09-15T01:00:00Z',
        sentiment: -0.8,
        lat: 51.92,
        lon: 4.48,
        place: 'Rotterdam',
      }),
      article({
        id: 'wn-new',
        publishedAt: '2026-09-15T07:00:00Z',
        sentiment: 0.4,
        lat: 51.9201,
        lon: 4.4801,
        place: 'Rotterdam',
      }),
      article({
        id: 'wn-mid',
        publishedAt: '2026-09-15T04:00:00Z',
        sentiment: null,
        lat: 51.9199,
        lon: 4.4799,
        place: 'Rotterdam Port',
      }),
      article({
        id: 'wn-tokyo',
        publishedAt: '2026-09-15T06:00:00Z',
        sentiment: null,
        lat: 35.68,
        lon: 139.69,
        place: 'Tokyo',
      }),
      article({
        id: 'wn-undated',
        publishedAt: null,
        sentiment: 0.9,
        lat: -33.87,
        lon: 151.21,
        place: undefined,
      }),
    ],
  });
  const groups = aggregatePlaces(rows);
  assert.deepEqual(
    groups.map((group) => group.id),
    [
      'wn-place:51.920:4.480',
      'wn-place:35.680:139.690',
      'wn-place:-33.870:151.210',
    ],
    'newest place first, undated last',
  );
  const [rotterdam, tokyo, undated] = groups;
  assert.equal(rotterdam.count, 3);
  assert.equal(rotterdam.place, 'Rotterdam');
  assert.ok(
    Math.abs(rotterdam.meanSentiment - -0.2) < 1e-9,
    'mean of the scored stories only',
  );
  assert.equal(rotterdam.band, 'neutral');
  assert.equal(rotterdam.newestMs, Date.parse('2026-09-15T07:00:00Z'));
  assert.deepEqual(
    rotterdam.articles.map((row) => row.id),
    ['wn-new', 'wn-mid', 'wn-old'],
  );
  assert.ok(
    Math.abs(rotterdam.lat - 51.92) < 1e-3 &&
      Math.abs(rotterdam.lon - 4.48) < 1e-3,
  );
  assert.equal(tokyo.count, 1);
  assert.equal(tokyo.meanSentiment, null);
  assert.equal(tokyo.band, 'unknown');
  assert.equal(undated.newestMs, null);
  assert.equal(
    undated.place,
    '-33.87°, 151.21°',
    'a nameless place is labelled by coordinate',
  );
  assert.deepEqual(aggregatePlaces([]), []);
  assert.deepEqual(aggregatePlaces(null), []);
});

test('pin size grows with the square root of the story count and caps', () => {
  assert.equal(placePixelSize(1), 10);
  assert.equal(placePixelSize(4), 12);
  assert.equal(placePixelSize(49), 22);
  assert.equal(placePixelSize(400), 22);
  assert.equal(placePixelSize(0), 10);
  assert.equal(placePixelSize(NaN), 10);
});

test('analyst records are JSON-safe with null for every unknown field', () => {
  const [row] = normalizeWorldNewsSnapshot({ articles: [article()] });
  assert.deepEqual(mapAnalystRecord(row, 0), {
    id: 'wn-1',
    title: 'Flood warnings issued for Valencia',
    domain: 'news.example.com',
    url: 'https://news.example.com/valencia-floods',
    publishedAt: '2026-09-15T06:00:00Z',
    sentiment: -0.62,
    category: 'environment',
    place: 'Valencia',
    sourceCountry: 'es',
    lat: 39.4699,
    lon: -0.3763,
  });
  const sparse = mapAnalystRecord(
    { sentiment: NaN, lat: '1', lon: undefined },
    7,
  );
  assert.equal(sparse.id, 'NEWS-0007');
  for (const [key, value] of Object.entries(sparse)) {
    if (key === 'id') continue;
    assert.equal(value, null, `${key} must be null`);
  }
  assert.deepEqual(JSON.parse(JSON.stringify(sparse)), sparse);
  assert.equal(mapAnalystRecord(null, 2).id, 'NEWS-0002');
});

test('headline truncation and age formatting follow the shared shapes', () => {
  assert.equal(truncateHeadline('Short headline'), 'Short headline');
  const long = truncateHeadline('x'.repeat(60) + ' tail', 48);
  assert.equal(long.length, 48);
  assert.ok(long.endsWith('…'));
  assert.equal(truncateHeadline(null), '');
  assert.equal(formatAge(-1), '<1h', 'a future-dated headline reads recent');
  assert.equal(formatAge(NaN), '');
  assert.equal(formatAge(30 * 60_000), '<1h');
  assert.equal(formatAge(5 * 3_600_000), '5h');
  assert.equal(formatAge(3 * 86_400_000), '3d');
  assert.equal(formatAgoMinutes(NaN), 'just now');
  assert.equal(formatAgoMinutes(30_000), '<1m ago');
  assert.equal(formatAgoMinutes(7 * 60_000), '7m ago');
  assert.equal(formatAgoMinutes(3 * 3_600_000), '3h ago');
});
