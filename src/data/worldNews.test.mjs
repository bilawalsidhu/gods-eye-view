import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  WORLD_NEWS_DISCLAIMER,
  WORLD_NEWS_OVERLAY_COHORT_LIMIT,
  clusterWorldNewsPoints,
  countryCentroid,
  createWorldNewsLayer,
  createWorldNewsOverlayEntry,
  createWorldNewsSelectedOverlayEntry,
  mapAnalystRecord,
  normalizeWorldNewsArticles,
  normalizeWorldNewsSnapshot,
  selectWorldNewsOverlayCohort,
} from './worldNews.js';

const ARTICLES = {
  articles: [
    {
      url: 'https://www.reuters.com/world/ukraine-story',
      title: 'Ukraine coverage from London',
      seendate: '20260911T120000Z',
      domain: 'reuters.com',
      sourcecountry: 'United Kingdom',
    },
    {
      url: 'https://www.bbc.com/news/world-europe-123',
      title: 'Second UK outlet',
      seendate: '20260911T110000Z',
      domain: 'bbc.com',
      sourcecountry: 'United Kingdom',
    },
    {
      url: 'javascript:alert(1)',
      title: 'Hostile URL',
      domain: 'evil.test',
      sourcecountry: 'United States',
    },
    {
      url: 'https://www.example.com/no-country',
      title: 'Missing country',
      domain: 'example.com',
    },
  ],
};

test('country centroids resolve GDELT source-country labels and aliases', () => {
  assert.deepEqual(countryCentroid('United States'), { lon: -95.71, lat: 37.09 });
  assert.deepEqual(countryCentroid('USA'), { lon: -95.71, lat: 37.09 });
  assert.equal(countryCentroid('Atlantis'), null);
});

test('article normalization drops hostile URLs and caps fields', () => {
  const articles = normalizeWorldNewsArticles(ARTICLES, 10);
  assert.equal(articles.length, 3);
  assert.equal(articles[0].domain, 'reuters.com');
  assert.equal(articles[0].publishedAt, '2026-09-11T12:00:00Z');
  assert.ok(articles.every((row) => row.url.startsWith('http')));
});

test('clustering groups by outlet country and keeps a headline sample', () => {
  const points = clusterWorldNewsPoints(normalizeWorldNewsArticles(ARTICLES, 10));
  assert.equal(points.length, 1);
  assert.equal(points[0].place, 'United Kingdom');
  assert.equal(points[0].count, 2);
  assert.equal(points[0].articles.length, 2);
  assert.equal(points[0].id, 'united kingdom');
  assert.ok(Number.isFinite(points[0].lat) && Number.isFinite(points[0].lon));
});

test('snapshot validation rejects malformed coordinates and duplicate ids', () => {
  assert.equal(normalizeWorldNewsSnapshot(null), null);
  assert.equal(normalizeWorldNewsSnapshot({ points: [{ id: 'a', place: 'UK', lat: 91, lon: 0, count: 1, articles: [] }] }), null);
  const ok = normalizeWorldNewsSnapshot({
    source: 'GDELT DOC 2.0',
    geometry: 'outlet-country',
    disclaimer: WORLD_NEWS_DISCLAIMER,
    points: clusterWorldNewsPoints(normalizeWorldNewsArticles(ARTICLES, 10)),
  });
  assert.equal(ok.status, 'ready');
  assert.equal(ok.points.length, 1);
  assert.equal(ok.geometry, 'outlet-country');
});

test('analyst records stay JSON-safe and never emit NaN', () => {
  const r = mapAnalystRecord({ id: 'united kingdom', place: 'United Kingdom', count: 2, lat: 55.38, lon: -3.44, articles: [{ title: 'Headline', domain: 'bbc.com', url: 'https://www.bbc.com/x' }] }, 0);
  assert.equal(r.title, 'Headline');
  assert.deepEqual(JSON.parse(JSON.stringify(r)), r);
  const empty = mapAnalystRecord({ count: NaN, lat: undefined }, 4);
  assert.equal(empty.id, 'NEWS-0004');
  assert.equal(empty.count, null);
  assert.equal(empty.lat, null);
});

test('overlay copy uses outlet-country wording on the selected card', () => {
  const position = Cesium.Cartesian3.fromDegrees(-3.44, 55.38);
  const label = createWorldNewsOverlayEntry({ id: 'united kingdom', position, place: 'United Kingdom', count: 4 });
  assert.equal(label.title, 'United Kingdom');
  assert.equal(label.variant, 'label');
  const selected = createWorldNewsSelectedOverlayEntry({
    id: 'united kingdom',
    place: 'United Kingdom',
    count: 4,
    articles: [{ domain: 'bbc.com', title: 'Second UK outlet' }],
  }, position);
  assert.equal(selected.variant, 'selected');
  assert.equal(selected.details[0], '4 headlines · outlet country');
  assert.match(selected.details[1], /bbc.com/);
});

test('overlay cohort keeps the busiest pins', () => {
  const position = Cesium.Cartesian3.fromDegrees(0, 0);
  const entries = [
    createWorldNewsOverlayEntry({ id: 'a', position, place: 'A', count: 1 }),
    createWorldNewsOverlayEntry({ id: 'b', position, place: 'B', count: 9 }),
    createWorldNewsOverlayEntry({ id: 'c', position, place: 'C', count: 3 }),
  ];
  const cohort = selectWorldNewsOverlayCohort(entries, 2);
  assert.deepEqual(cohort.map((entry) => entry.id), ['b', 'c']);
  assert.ok(cohort.length <= WORLD_NEWS_OVERLAY_COHORT_LIMIT);
});

test('layer update replaces the snapshot from /api/world-news and reports outlet-country coverage', async () => {
  const published = [];
  const snapshot = normalizeWorldNewsSnapshot({
    source: 'GDELT DOC 2.0',
    geometry: 'outlet-country',
    points: clusterWorldNewsPoints(normalizeWorldNewsArticles(ARTICLES, 10)),
  });
  const layer = createWorldNewsLayer({
    overlayHost: {
      setEntries: (id, entries) => published.push([id, entries.length]),
      setVisible() {},
      clearSource() {},
    },
    fetchImpl: async (url) => {
      assert.equal(url, '/api/world-news');
      return new Response(JSON.stringify(snapshot), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });
  const viewer = { dataSources: { add() {}, remove() {} }, scene: { canvas: {} } };
  layer.init(viewer);
  layer.enable();
  assert.equal(await layer.update(), true);
  assert.equal(layer.getStats().count, 1);
  assert.equal(layer.getStats().coverage, 'outlet-country');
  assert.equal(layer.getAnalystRecords()[0].place, 'United Kingdom');
  assert.equal(layer.getRowControls().legend[0].label, 'Outlet country');
  layer.destroy(viewer);
});
