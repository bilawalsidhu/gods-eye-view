import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRegionalArticles } from './regionalModel.js';
test('compact source dates must denote an actual calendar instant', () => {
  for (const date of [
    '20260230T120000Z',
    '20260431T120000Z',
    '20261301T120000Z',
    '20260716T240000Z',
    '20260716T126000Z',
    '20260716T120060Z',
  ]) {
    const [article] = normalizeRegionalArticles({
      articles: [
        {
          title: 'Fixture',
          url: 'https://fixture.example/news',
          seendate: date,
        },
      ],
    });
    assert.equal(article.publishedAt, null, date);
    assert.equal(article.title, 'Fixture');
  }
  for (const [input, expected] of [
    ['20240229T004500Z', '2024-02-29T00:45:00Z'],
    ['20260716T000000Z', '2026-07-16T00:00:00Z'],
    ['2026-07-16T12:00:00Z', '2026-07-16T12:00:00.000Z'],
  ]) {
    assert.equal(
      normalizeRegionalArticles({
        articles: [
          {
            title: 'Fixture',
            url: 'https://fixture.example/news',
            seendate: input,
          },
        ],
      })[0].publishedAt,
      expected,
    );
  }
});
