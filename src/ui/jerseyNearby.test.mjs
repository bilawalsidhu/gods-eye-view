import test from 'node:test';
import assert from 'node:assert/strict';
import { jerseyNearbyDistance, currentBuoyValue } from './jerseyNearby.js';
import { JERSEY_PARISHES } from '../sources/jerseyParishes.js';
import {
  jerseyLocalPlugin,
  jerseyGridToDegrees,
  normalizeJerseyRoadworks,
  parseParishHeadlines,
} from '../../server/providers/jersey.js';

function harness(fetchImpl, now = Date.now) {
  let middleware;
  jerseyLocalPlugin({ fetchImpl, now }).configureServer({
    middlewares: {
      use: (fn) => {
        middleware = fn;
      },
    },
  });
  return async (url, method = 'GET') => {
    let body,
      passed = false;
    const response = {
      statusCode: 200,
      setHeader() {},
      end: (text) => {
        body = text;
      },
    };
    await middleware({ url, method }, response, () => {
      passed = true;
    });
    return {
      status: response.statusCode,
      body: body && JSON.parse(body),
      passed,
    };
  };
}

test('fixed-source route rejects URL injection, duplicates, invalid stop ids and writes', async () => {
  let requests = 0;
  const run = harness(async () => {
    requests++;
    return Response.json({ results: [] });
  });
  for (const query of [
    'type=unknown',
    'type=buses&url=https://example.org',
    'type=buses&type=stops',
    'type=departures&stop=../1',
    'type=departures',
    'type=buses&stop=1',
  ])
    assert.equal((await run('/api/transit/jersey-local?' + query)).status, 400);
  assert.equal((await run('/api/transit/jersey-local', 'POST')).status, 400);
  assert.equal(requests, 0);
  assert.equal((await run('/api/transit/vehicles/mbta')).passed, true);
});

test('coalesces requests, caches briefly, excludes invalid locations and refetches after expiry', async () => {
  let clock = 100000,
    requests = 0;
  const run = harness(
    async (url, options) => {
      requests++;
      assert.equal(
        url,
        'https://api.opendata.je/v1/bus/live-updates?secondsAgo=300',
      );
      assert.equal(options.redirect, 'error');
      await new Promise((resolve) => setTimeout(resolve, 10));
      return Response.json({
        results: [
          { latitude: 49.18, longitude: -2.1 },
          { latitude: 51, longitude: 0 },
          { latitude: '49.18', longitude: -2.1 },
        ],
      });
    },
    () => clock,
  );
  const replies = await Promise.all([
    run('/api/transit/jersey-local'),
    run('/api/transit/jersey-local'),
  ]);
  assert.equal(requests, 1);
  assert.equal(replies[0].body.results.length, 1);
  assert.equal(replies[0].body.fetchedAt, clock);
  await run('/api/transit/jersey-local');
  assert.equal(requests, 1);
  clock += 60001;
  await run('/api/transit/jersey-local');
  assert.equal(requests, 2);
});

test('failed, oversized or malformed upstreams never masquerade as empty healthy data', async () => {
  for (const reply of [
    new Response('oops', { status: 500 }),
    Response.json({ bad: [] }),
    new Response('{}', {
      headers: { 'content-length': String(5 * 1024 * 1024) },
    }),
  ]) {
    const result = await harness(async () => reply)(
      '/api/transit/jersey-local?type=parking',
    );
    assert.equal(result.status, 503);
    assert.equal(result.body.error, 'Jersey feed temporarily unavailable');
  }
});

test('road coordinates convert the published NewJTM origin and retain paths without duplicates', () => {
  const origin = jerseyGridToDegrees(40000, 70000);
  assert.ok(Math.abs(origin[0] + 2.135) < 1e-8);
  assert.ok(Math.abs(origin[1] - 49.225) < 1e-7);
  assert.equal(jerseyGridToDegrees(-2.1, 49.18), null);
  const feature = {
    attributes: {
      FID: 2,
      NAME: 'job',
      Location: 'Esplanade',
      S_DATE: '20261010 0900',
      E_DATE: '20261012 1000',
      STATUS: 'In Progress',
    },
    geometry: {
      paths: [
        [
          [40000, 70000],
          [40010, 70010],
        ],
      ],
    },
  };
  const rows = normalizeJerseyRoadworks({
    features: [
      feature,
      feature,
      {
        ...feature,
        attributes: { ...feature.attributes, STATUS: 'Cancelled' },
      },
    ],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].paths[0].length, 2);
  assert.ok(rows[0].latitude > 49);
  assert.throws(() =>
    normalizeJerseyRoadworks({ features: [], exceededTransferLimit: true }),
  );
});

test('road query selects current/upcoming date strings without requesting historical dataset', async () => {
  let requested;
  const run = harness(
    async (url) => {
      requested = new URL(url);
      return Response.json({ features: [] });
    },
    () => Date.UTC(2026, 9, 11),
  );
  assert.equal(
    (await run('/api/transit/jersey-local?type=roadworks')).status,
    200,
  );
  assert.equal(
    requested.searchParams.get('where'),
    "E_DATE >= '20261011' AND S_DATE <= '20261110'",
  );
});

test('parish parser exposes headlines, dates and safe same-provider links only', () => {
  const xml =
    '<rss><channel><item><title><![CDATA[Notice &amp; meeting]]></title><link>https://sthelier.je/news/meeting/</link><pubDate>Sun, 11 Oct 2026 08:00:00 +0000</pubDate><description>Do not copy the article</description></item><item><title>Unsafe</title><link>javascript:alert(1)</link><pubDate>Sun, 11 Oct 2026 08:00:00 +0000</pubDate></item></channel></rss>';
  const rows = parseParishHeadlines(xml, 'St Helier', 'sthelier.je');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'Notice & meeting');
  assert.equal(rows[0].publishedAt, '2026-10-11T08:00:00.000Z');
  assert.equal(rows[0].description, undefined);
  assert.throws(() =>
    parseParishHeadlines('<!DOCTYPE rss><rss/>', 'St Helier', 'sthelier.je'),
  );
  assert.equal(JERSEY_PARISHES.length, 12);
  assert.equal(new Set(JERSEY_PARISHES.map((p) => p[3])).size, 12);
});

test('parish aggregation isolates failures and limits fetch concurrency to three', async () => {
  let active = 0,
    peak = 0,
    calls = 0;
  const run = harness(async (url) => {
    calls++;
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    if (url.includes('stmary.je')) return new Response('', { status: 503 });
    const domain = new URL(url).hostname;
    return new Response(
      '<rss><channel><item><title>Notice</title><link>https://' +
        domain +
        '/notice/</link><pubDate>Sun, 11 Oct 2026 08:00:00 +0000</pubDate></item></channel></rss>',
    );
  });
  const result = await run('/api/transit/jersey-local?type=parish-news');
  assert.equal(result.status, 200);
  assert.equal(result.body.results.length, 11);
  assert.deepEqual(result.body.unavailable, ['St Mary']);
  assert.equal(peak, 3);
  assert.equal(calls, 12);
  await run('/api/transit/jersey-local?type=parish-news');
  assert.equal(calls, 12);
});

test('stale, flagged and impossible buoy observations are suppressed', () => {
  const now = 1791718400000;
  assert.equal(
    currentBuoyValue(
      {
        timestamp: now / 1000 - 20,
        value: 5.2,
        text: '5.2',
        units: 'm/s',
        timeout: 900,
      },
      now,
    ),
    '5.2 m/s',
  );
  for (const v of [
    { timestamp: now / 1000 - 901, value: 5 },
    { timestamp: now / 1000 + 121, value: 5 },
    { timestamp: now / 1000, value: NaN },
    { timestamp: now / 1000, value: 5, alert: true },
  ])
    assert.equal(currentBuoyValue(v, now), null);
});

test('distance behaves at the antimeridian and nearby Jersey points', () => {
  assert.equal(
    jerseyNearbyDistance({ lat: 49.18, lon: -2.1 }, { lat: 49.18, lon: -2.1 }),
    0,
  );
  assert.ok(
    jerseyNearbyDistance({ lat: 0, lon: 179.99 }, { lat: 0, lon: -179.99 }) <
      2300,
  );
});

test('map hold ignores drags and pinches, toggles a stationary press and removes listeners', async () => {
  const { bindMapDashboardHold } = await import('./mobileNearby.js');
  const doc = new EventTarget(),
    win = new EventTarget();
  let timer,
    toggles = 0,
    clock = 0;
  const stop = bindMapDashboardHold({
    documentRef: doc,
    windowRef: win,
    isMapTarget: (t) => t === 'map',
    toggle: () => toggles++,
    setTimer: (fn) => {
      timer = fn;
      return 1;
    },
    clearTimer: () => {
      timer = null;
    },
    now: () => clock,
  });
  const event = (name, id, x = 0) => {
    const e = new Event(name);
    Object.defineProperties(e, {
      pointerId: { value: id },
      target: { value: 'map' },
      button: { value: 0 },
      clientX: { value: x },
      clientY: { value: 0 },
    });
    doc.dispatchEvent(e);
  };
  event('pointerdown', 1);
  event('pointermove', 1, 20);
  assert.equal(timer, null);
  event('pointerup', 1);
  event('pointerdown', 1);
  event('pointerdown', 2);
  assert.equal(timer, null);
  event('pointerup', 1);
  event('pointerup', 2);
  event('pointerdown', 1);
  clock = 650;
  const fire = timer;
  timer = null;
  fire();
  assert.equal(toggles, 1);
  event('pointerup', 1);
  stop();
  event('pointerdown', 1);
  assert.equal(timer, null);
  assert.equal(toggles, 1);
});
