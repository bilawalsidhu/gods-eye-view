import test from 'node:test';
import assert from 'node:assert/strict';
import {
  boundedArea,
  newsRequest,
  normalizeNews,
  safeArticleUrl,
} from './areaNews.js';
const now = Date.parse('2026-10-12T12:00Z'),
  input = {
    area: { west: -98, south: 30, east: -97, north: 31 },
    place: 'Austin',
    topic: 'flood',
    start: '2026-10-10T00:00:00Z',
    end: '2026-10-12T12:00:00Z',
  };
test('area and date/query limits reject unbounded/injected search requests', () => {
  const r = newsRequest(input, now);
  assert.equal(r.query, '"Austin" "flood"');
  for (const patch of [
    { place: 'Austin domain:evil.test' },
    { topic: '" OR *' },
    { start: '2020-01-01' },
    { end: '2027-01-01' },
    { area: { west: -180, east: 180, south: -90, north: 90 } },
  ])
    assert.throws(() => newsRequest({ ...input, ...patch }, now));
  assert.throws(() =>
    boundedArea({ west: 179, east: -179, south: 0, north: 1 }),
  );
});
test('source-linked dated rows are deduped and unverified, never executable HTML', () => {
  const r = newsRequest(input, now),
    a = {
      url: 'https://publisher.example/news',
      title: '<script>Headline</script>',
      seendate: '20261011T120000Z',
    };
  const rows = normalizeNews(
    {
      articles: [
        a,
        a,
        { ...a, url: 'javascript:alert(1)' },
        { ...a, url: 'https://other.example', seendate: '20260101T000000Z' },
      ],
    },
    r,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].placement, 'unverified-place-name-match');
  assert.equal(rows[0].seenAt, '2026-10-11T12:00:00.000Z');
  assert.equal(rows[0].title, a.title);
  assert.equal(safeArticleUrl('https://user:pass@publisher.example'), null);
  assert.equal(safeArticleUrl('http://127.0.0.1/'), null);
  assert.equal(safeArticleUrl('http://192.168.1.2/'), null);
  assert.throws(() => normalizeNews({}, r));
  assert.deepEqual(normalizeNews({ articles: [] }, r), []);
});
