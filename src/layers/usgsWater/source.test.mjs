import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createUsgsWaterSource,
  waterRetryAfter,
} from 'gods-eye-view/layers/usgs-water/source';
import { USGS_OBSERVATION_TTL_MS, USGS_METADATA_TTL_MS } from './config.js';
import { normalizeUsgsWaterSnapshot } from './records.js';
import {
  usgsWaterFixturePage,
  usgsWaterFixtures,
} from '../../../scripts/qa-usgs-water-fixtures.mjs';

const NOW = Date.UTC(2026, 9, 11, 18);
function harness({ intercept, limits, fixtures, matched = false } = {}) {
  let now = NOW;
  const calls = [];
  const source = createUsgsWaterSource({
    now: () => now,
    limits,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      const page = usgsWaterFixturePage(url, now, { fixtures, matched });
      const response = await intercept?.({
        url: new URL(url),
        options,
        page,
        now,
      });
      return response ?? Response.json(page);
    },
  });
  return {
    source,
    calls,
    setNow: (value) => {
      now = value;
    },
  };
}

test('package source is lazy, scoped to the current 24-hour bbox and joins all site/series identities without numberMatched', async () => {
  const h = harness();
  assert.equal(h.calls.length, 0);
  const raw = await h.source.getSnapshot();
  assert.equal(raw.observations.length, 7);
  assert.equal(raw.stations.length, 2);
  assert.equal(raw.series.length, 7);
  const request = new URL(h.calls[0].url);
  assert.equal(request.origin, 'https://api.waterdata.usgs.gov');
  assert.equal(request.searchParams.get('bbox'), '-98.85,29.05,-98.08,29.85');
  assert.equal(
    request.searchParams.get('datetime'),
    new Date(NOW - 86400000).toISOString() + '/..',
  );
  assert.equal(request.searchParams.get('limit'), '500');
  assert.equal(h.calls.length, 9);
  for (const { options } of h.calls) {
    assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.headers['X-Api-Key'], undefined);
  }
  const n = normalizeUsgsWaterSnapshot(raw);
  assert.equal(n.records.length, 2);
  assert.equal(n.numericReadingCount, 3);
  assert.equal(n.readingCount, 7);
});

test('observation cache is defensive and expires; metadata stays cached until its longer TTL', async () => {
  const h = harness();
  const first = await h.source.getSnapshot();
  first.observations[0].value = '999';
  assert.equal((await h.source.getSnapshot()).observations[0].value, '-0.75');
  assert.equal(h.calls.length, 9);
  h.setNow(NOW + USGS_OBSERVATION_TTL_MS);
  await h.source.getSnapshot();
  assert.equal(h.calls.length, 13, 'only observation pages refetch');
  h.setNow(NOW + USGS_METADATA_TTL_MS);
  await h.source.getSnapshot();
  assert.equal(h.calls.length, 22);
});

test('a recent database modification does not revive an old measurement', async () => {
  const fixtures = usgsWaterFixtures(NOW);
  fixtures.observations[0].properties.time = new Date(
    NOW - 2 * 86400000,
  ).toISOString();
  const result = await harness({ fixtures }).source.getSnapshot();
  assert.equal(result.observations.length, 6);
  assert.equal(result.excludedOldCount, 1);
  assert.equal(result.series.length, 6);
});

test('429 honors Retry-After, suppresses repeated calls and retries after cooldown', async () => {
  let fail = true;
  const h = harness({
    intercept: () =>
      fail
        ? new Response('', { status: 429, headers: { 'Retry-After': '60' } })
        : undefined,
  });
  await assert.rejects(
    h.source.getSnapshot(),
    (e) => e.rateLimited && e.retryAt === NOW + 60000,
  );
  await assert.rejects(h.source.getSnapshot(), /retry held/);
  assert.equal(h.calls.length, 1);
  fail = false;
  h.setNow(NOW + 60000);
  assert.equal((await h.source.getSnapshot()).observations.length, 7);
  assert.equal(
    waterRetryAfter(new Date(NOW + 90000).toUTCString(), NOW),
    90000,
  );
  assert.equal(waterRetryAfter('invalid', NOW), 0);
});

test('a failed forced refresh retains no newly published metadata and never returns expired observations as fresh', async () => {
  let fail = false;
  const h = harness({
    intercept: () => (fail ? new Response('', { status: 503 }) : undefined),
  });
  await h.source.getSnapshot();
  fail = true;
  h.setNow(NOW + USGS_OBSERVATION_TTL_MS);
  await assert.rejects(h.source.getSnapshot(), /HTTP 503/);
  await assert.rejects(h.source.getSnapshot(), /retry held/);
  assert.equal(h.calls.length, 10);
});

for (const [label, mutate, pattern] of [
  [
    'numberReturned',
    (p) => {
      p.numberReturned = 99;
    },
    /numberReturned/,
  ],
  [
    'incomplete matched pagination',
    (p) => {
      p.numberMatched = 7;
      p.links = [];
    },
    /incomplete pagination/,
  ],
  [
    'cross-origin next',
    (p) => {
      p.links[0].href = 'https://evil.example/items';
    },
    /unsafe pagination/,
  ],
  [
    'changed collection next',
    (p) => {
      p.links[0].href = p.links[0].href.replace('latest-continuous', 'daily');
    },
    /unsafe pagination/,
  ],
  [
    'changed scope next',
    (p) => {
      const u = new URL(p.links[0].href);
      u.searchParams.set('bbox', '0,0,1,1');
      p.links[0].href = u.href;
    },
    /scope changed/,
  ],
  [
    'repeated next link',
    (p, u) => {
      p.links[0].href = u.href;
    },
    /repeated pagination/,
  ],
  [
    'empty page with next',
    (p) => {
      p.features = [];
      p.numberReturned = 0;
    },
    /stalled pagination/,
  ],
])
  test(`rejects ${label} instead of caching partial data`, async () => {
    const h = harness({
      intercept: ({ page, url }) => {
        if (url.pathname.includes('latest-continuous')) mutate(page, url);
        return Response.json(page);
      },
    });
    await assert.rejects(h.source.getSnapshot(), pattern);
  });

test('conflicting duplicate feature identities and duplicate latest series are rejected', async () => {
  for (const sameFeature of [true, false]) {
    const fixtures = usgsWaterFixtures(NOW);
    const row = structuredClone(fixtures.observations[0]);
    if (!sameFeature) row.id = 'different-observation';
    row.properties.value = '123';
    fixtures.observations.push(row);
    await assert.rejects(
      harness({ fixtures }).source.getSnapshot(),
      /conflicting duplicate|conflicting latest/,
    );
  }
});

test('missing or conflicting station/series metadata never manufactures labels or meaning', async () => {
  for (const change of [
    (f) => f.stations.pop(),
    (f) => f.series.pop(),
    (f) => {
      f.series[0].properties.monitoring_location_id = 'USGS-08199999';
    },
    (f) => {
      f.series[0].properties.parameter_code = '00060';
    },
  ]) {
    const fixtures = usgsWaterFixtures(NOW);
    change(fixtures);
    await assert.rejects(
      harness({ fixtures }).source.getSnapshot(),
      /incomplete|conflicting/,
    );
  }
});

test('page, record, per-response and total byte bounds apply before cache publication', async () => {
  for (const [limits, pattern] of [
    [{ maxPages: 1 }, /page limit/],
    [{ maxObservations: 1 }, /record limit/],
    [{ maxLocations: 1 }, /join limit/],
    [{ maxSeries: 1 }, /join limit/],
    [{ maxResponseBytes: 16 }, /too large/],
    [{ maxTotalBytes: 200 }, /too large/],
  ])
    await assert.rejects(harness({ limits }).source.getSnapshot(), pattern);
  assert.throws(
    () => createUsgsWaterSource({ limits: { maxPages: 65 } }),
    /Invalid USGS/,
  );
  assert.throws(
    () => createUsgsWaterSource({ limits: { unknown: 1 } }),
    /Invalid USGS/,
  );
});

test('caller cancellation settles an uncooperative fetch and does not establish failure backoff', async () => {
  let requestSignal;
  let fail = true;
  const h = harness({
    intercept: ({ options }) => {
      requestSignal = options.signal;
      if (fail) return new Promise(() => {});
    },
  });
  const controller = new AbortController();
  const pending = h.source.getSnapshot({ signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(requestSignal.aborted, true);
  fail = false;
  assert.equal((await h.source.getSnapshot()).observations.length, 7);
  controller.abort();
  await assert.rejects(h.source.getSnapshot({ signal: controller.signal }), {
    name: 'AbortError',
  });
});

test('whole acquisition deadline includes an uncooperative body', async () => {
  const h = harness({
    limits: { timeoutMs: 20 },
    intercept: () =>
      new Response(new ReadableStream({ start() {}, cancel() {} })),
  });
  await assert.rejects(h.source.getSnapshot(), { name: 'TimeoutError' });
});

test('empty observations are a verified empty snapshot with no metadata traffic', async () => {
  const fixtures = usgsWaterFixtures(NOW);
  fixtures.observations = [];
  const h = harness({ fixtures });
  const result = await h.source.getSnapshot();
  assert.equal(result.observations.length, 0);
  assert.equal(result.stations.length, 0);
  assert.equal(h.calls.length, 1);
});

test('a failed explicit refresh invalidates a still-young cache rather than hiding the failure on re-enable', async () => {
  let fail = false;
  const h = harness({
    intercept: () => (fail ? new Response('', { status: 503 }) : undefined),
  });
  await h.source.getSnapshot();
  fail = true;
  await assert.rejects(h.source.getSnapshot({ force: true }), /HTTP 503/);
  await assert.rejects(h.source.getSnapshot(), /retry held/);
  assert.equal(h.calls.length, 10);
});
