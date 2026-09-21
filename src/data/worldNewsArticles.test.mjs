import assert from 'node:assert/strict';
import test from 'node:test';
import {
  estimateWorldNewsPoints,
  mergeBatchArticles,
  normalizeWorldNewsArticle,
  normalizeWorldNewsArticles,
  parseWorldNewsQuota,
  retainWithinWindow,
  topLocationEntity,
  worldNewsPublishedIso,
} from './worldNewsArticles.js';

const london = {
  type: 'LOC',
  name: 'London',
  full_name: 'London, United Kingdom',
  latitude: 51.5074,
  longitude: -0.1278,
  found_in: 'title',
  mentions: 2,
  image: 'https://example.com/london.jpg',
  description: 'Capital of the UK',
};

function article(id, overrides = {}) {
  return {
    id,
    title: `  Headline   ${id}  `,
    text: 'FULL ARTICLE BODY THAT MUST NEVER REACH THE BROWSER',
    summary: 'A summary',
    url: `https://www.example.com/story/${id}`,
    image: 'https://example.com/hero.jpg',
    video: null,
    publish_date: `2026-09-15 0${id % 10}:15:00`,
    authors: ['Jane Doe'],
    category: 'politics',
    language: 'en',
    source_country: 'us',
    sentiment: -0.55,
    entities: [
      london,
      { type: 'PER', name: 'Some Person', found_in: 'title', mentions: 5 },
      { type: 'ORG', name: 'Some Org', found_in: 'text', mentions: 1 },
    ],
    ...overrides,
  };
}

test('records carry only the compact place-bearing fields', () => {
  const [record] = normalizeWorldNewsArticles([article(7)]);
  assert.deepEqual(Object.keys(record).sort(), [
    'category',
    'domain',
    'id',
    'language',
    'lat',
    'lon',
    'place',
    'placeFoundIn',
    'placeMentions',
    'publishedAt',
    'sentiment',
    'sourceCountry',
    'title',
    'url',
  ]);
  assert.equal(record.id, 'wn-7');
  assert.equal(record.title, 'Headline 7');
  assert.equal(record.domain, 'example.com');
  assert.equal(record.url, 'https://www.example.com/story/7');
  assert.equal(record.publishedAt, '2026-09-15T07:15:00.000Z');
  assert.equal(record.sentiment, -0.55);
  assert.equal(record.lat, 51.5074);
  assert.equal(record.lon, -0.1278);
  assert.equal(record.place, 'London');
  assert.equal(record.placeFoundIn, 'title');
  assert.equal(record.placeMentions, 2);
  const serialized = JSON.stringify(record);
  for (const leaked of [
    'BODY',
    'Jane Doe',
    'hero.jpg',
    'Some Person',
    'Some Org',
  ])
    assert.equal(serialized.includes(leaked), false, leaked);
});

test('articles without a title-mentioned place are dropped; body mentions never pin', () => {
  const bodyOnly = article(2, {
    entities: [{ ...london, found_in: 'text', mentions: 9 }],
  });
  const noPlace = article(3, {
    entities: [
      { type: 'PER', name: 'Someone', found_in: 'title', mentions: 1 },
    ],
  });
  const noEntities = article(4, { entities: undefined });
  const records = normalizeWorldNewsArticles([
    article(1),
    bodyOnly,
    noPlace,
    noEntities,
  ]);
  assert.deepEqual(
    records.map((record) => record.id),
    ['wn-1'],
  );
  assert.equal(normalizeWorldNewsArticle(bodyOnly), null);
  assert.deepEqual(normalizeWorldNewsArticles(null), []);
  assert.deepEqual(normalizeWorldNewsArticles('nope'), []);
});

test('top location prefers the most-mentioned title place with a deterministic tie-break', () => {
  const paris = {
    type: 'location',
    name: 'Paris',
    latitude: 48.85,
    longitude: 2.35,
    found_in: 'title,text',
    mentions: 2,
  };
  const berlin = {
    type: 'LOC',
    name: 'Berlin',
    latitude: 52.52,
    longitude: 13.4,
    found_in: 'title',
    mentions: 2,
  };
  assert.equal(topLocationEntity([london, paris, berlin]).name, 'Berlin');
  assert.equal(
    topLocationEntity([{ ...paris, mentions: 3 }, london, berlin]).name,
    'Paris',
  );
  assert.equal(
    topLocationEntity([
      { ...london, latitude: 91 },
      { ...berlin, longitude: 'east' },
      { ...paris, latitude: NaN },
    ]),
    null,
  );
  assert.equal(topLocationEntity(undefined), null);
  assert.equal(topLocationEntity([null, 4, 'x']), null);
});

test('malformed ids, titles and links are rejected; duplicates collapse; newest first', () => {
  const records = normalizeWorldNewsArticles([
    article(1, { publish_date: '2026-09-15 01:00:00' }),
    article(2, { publish_date: '2026-09-15 09:00:00' }),
    article(2, { publish_date: '2026-09-15 09:00:00' }),
    article(3, { url: 'javascript:alert(1)' }),
    article(4, { url: 'ftp://example.com/x' }),
    article(5, { title: '   ' }),
    article(-1),
    article(1.5),
    article('id with spaces'),
    article({ nested: true }),
    article(6, { publish_date: 'yesterday', sentiment: 'warm' }),
  ]);
  assert.deepEqual(
    records.map((record) => record.id),
    ['wn-2', 'wn-1', 'wn-6'],
  );
  assert.equal(records[2].publishedAt, null);
  assert.equal(records[2].sentiment, null);
});

test('sentiment is clamped, text fields trimmed and capped', () => {
  const [record] = normalizeWorldNewsArticles([
    article(9, {
      sentiment: 7,
      title: 'x'.repeat(500),
      category: 'y'.repeat(100),
      entities: [{ ...london, name: 'z'.repeat(300), mentions: '4' }],
    }),
  ]);
  assert.equal(record.sentiment, 1);
  assert.equal(record.title.length, 200);
  assert.equal(record.category.length, 40);
  assert.equal(record.place.length, 120);
  assert.equal(record.placeMentions, 4);
});

test('publish dates: provider UTC form, explicit offsets, junk', () => {
  assert.equal(
    worldNewsPublishedIso('2024-04-06 22:44:18'),
    '2024-04-06T22:44:18.000Z',
  );
  assert.equal(
    worldNewsPublishedIso('2024-04-06T22:44:18+02:00'),
    '2024-04-06T20:44:18.000Z',
  );
  assert.equal(
    worldNewsPublishedIso('2024-04-06 22:44:18-0500'),
    '2024-04-07T03:44:18.000Z',
  );
  assert.equal(worldNewsPublishedIso('06/04/2024'), null);
  assert.equal(worldNewsPublishedIso(1712443458000), null);
  assert.equal(worldNewsPublishedIso('2024-13-45 99:99:99'), null);
});

test('quota headers parse from Headers objects and plain records; missing → null', () => {
  const headers = new Headers({
    'X-API-Quota-Request': '2.5',
    'X-API-Quota-Used': '12',
  });
  assert.deepEqual(parseWorldNewsQuota(headers), {
    request: 2.5,
    used: 12,
    left: null,
  });
  assert.deepEqual(
    parseWorldNewsQuota({
      'x-api-quota-left': '48',
      'X-API-Quota-Used': 'n/a',
    }),
    { request: null, used: null, left: 48 },
  );
  assert.deepEqual(parseWorldNewsQuota(null), {
    request: null,
    used: null,
    left: null,
  });
});

test('cost estimate charges the entity surcharge this proxy actually pays', () => {
  // Measured against the live provider on 2026-09-20 via X-API-Quota-Request.
  // Every search sets add-entities=true (the location entities ARE the place
  // tags), so the entity rate is the default: estimating at the entity-free
  // rate understated a full page 6x and let the budget guard overspend.
  assert.equal(estimateWorldNewsPoints(100), 12); // measured 12.0
  assert.equal(estimateWorldNewsPoints(2), 1.22); // measured 1.22
  assert.equal(estimateWorldNewsPoints(0), 1);
  assert.equal(estimateWorldNewsPoints(-4), 1);
  assert.equal(estimateWorldNewsPoints('12'), 2.32);
  // The entity-free rate remains the documented 1 + 0.01 per result.
  assert.equal(estimateWorldNewsPoints(100, false), 2); // measured 2.0
  assert.equal(estimateWorldNewsPoints(0, false), 1);
});

test('retention keeps only batches inside the window; merge lets the newest fetch win', () => {
  const now = Date.UTC(2026, 8, 15, 12);
  const hour = 3_600_000;
  const old = {
    at: now - hour - 1,
    articles: [{ id: 'wn-1', publishedAt: '2026-09-15T01:00:00.000Z' }],
  };
  const older = {
    at: now - 20 * 60_000,
    articles: [
      { id: 'wn-1', publishedAt: '2026-09-15T01:00:00.000Z', title: 'a' },
      { id: 'wn-2', publishedAt: '2026-09-15T03:00:00.000Z' },
    ],
  };
  const newest = {
    at: now,
    articles: [
      { id: 'wn-1', publishedAt: '2026-09-15T01:00:00.000Z', title: 'b' },
    ],
  };
  const future = { at: now + 1, articles: [] };
  const retained = retainWithinWindow(
    [old, older, newest, future, null, { at: 'x', articles: [] }],
    now,
    hour,
  );
  assert.deepEqual(retained, [older, newest]);
  const merged = mergeBatchArticles([newest, older]);
  assert.deepEqual(
    merged.map((article) => [article.id, article.title]),
    [
      ['wn-2', undefined],
      ['wn-1', 'b'],
    ],
  );
  assert.deepEqual(retainWithinWindow(undefined, now, hour), []);
});

test('publisher image is opt-in, https-only, and never on by default', () => {
  const raw = {
    id: 7,
    title: 'Flood warning in Hanover',
    url: 'https://example.com/7',
    image: 'https://cdn.example.com/hero.jpg',
    publish_date: '2026-09-15 10:00:00',
    entities: [
      {
        type: 'LOC',
        name: 'Hanover',
        latitude: 18.4,
        longitude: -78.1,
        found_in: 'title',
        mentions: 2,
      },
    ],
  };
  // Default: the record is exactly the no-thumbnail contract.
  assert.equal('image' in normalizeWorldNewsArticle(raw), false);
  assert.equal('image' in normalizeWorldNewsArticles([raw])[0], false);

  const opted = normalizeWorldNewsArticle(raw, { thumbnails: true });
  assert.equal(opted.image, 'https://cdn.example.com/hero.jpg');
  assert.equal(
    normalizeWorldNewsArticles([raw], { thumbnails: true })[0].image,
    'https://cdn.example.com/hero.jpg',
  );

  // http would be blocked as mixed content, so it never enters the record.
  for (const image of [
    'http://cdn.example.com/hero.jpg',
    'javascript:alert(1)',
    'not a url',
    '',
    null,
    undefined,
    42,
  ]) {
    assert.equal(
      'image' in
        normalizeWorldNewsArticle({ ...raw, image }, { thumbnails: true }),
      false,
      String(image),
    );
  }
});
