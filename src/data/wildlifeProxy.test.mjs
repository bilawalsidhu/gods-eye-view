import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WILDLIFE_MAX_STALE_MS,
  WILDLIFE_TTL_MS,
  wildlifeProxy,
} from '../../server/providers/wildlife.js';
import {
  WILDLIFE_STUDIES,
  movebankStudyUrl,
} from '../layers/wildlife/records.js';

const [GULLS, STORKS] = WILDLIFE_STUDIES.map(({ id }) => id).filter((id) =>
  [1258895879, 21231406].includes(id),
);
const STUDIES = WILDLIFE_STUDIES.filter(({ id }) =>
  [GULLS, STORKS].includes(id),
);
const NOW = Date.parse('2026-09-30T10:00:00Z');

const body = (study, name, lon = 4, lat = 51.6) =>
  JSON.stringify({
    individuals: [
      {
        study_id: study,
        individual_local_identifier: name,
        individual_taxon_canonical_name: 'Larus argentatus',
        locations: [
          { timestamp: NOW - 7_200_000, location_long: lon, location_lat: lat },
          {
            timestamp: NOW - 3_600_000,
            location_long: lon + 0.1,
            location_lat: lat,
          },
        ],
      },
    ],
  });

/**
 * A fake Movebank that answers from a per-study script and records how many
 * requests were in flight at once.
 */
function movebank(script) {
  const calls = [];
  let active = 0;
  let peak = 0;
  const fetchImpl = async (url, init) => {
    const study = Number(new URL(url).searchParams.get('study_id'));
    calls.push({ url, init, study });
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setImmediate(resolve));
    active--;
    const next = script[study]?.shift();
    if (next === undefined) throw new Error('no more answers');
    if (typeof next === 'number') return new Response('boom', { status: next });
    return new Response(next, {
      status: 200,
      headers: { 'Content-Type': 'text/javascript' },
    });
  };
  return { calls, fetchImpl, peak: () => peak };
}

function install(
  { script = {}, clock = { t: NOW } } = {},
  hook = 'configureServer',
) {
  let handler;
  const fake = movebank(script);
  const plugin = wildlifeProxy({
    fetchImpl: fake.fetchImpl,
    now: () => clock.t,
    wait: async () => {},
    studies: STUDIES,
  });
  assert.equal(plugin.name, 'wildlife');
  plugin[hook]({
    middlewares: {
      use(path, callback) {
        assert.equal(path, '/api/wildlife');
        handler = callback;
      },
    },
  });
  const request = async (url = '/', method = 'GET', peer = 'local') => {
    const res = {
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
      },
      end(value) {
        this.body = JSON.parse(value);
      },
    };
    await handler({ url, method, socket: { remoteAddress: peer } }, res);
    return res;
  };
  return { request, plugin, fake, clock };
}

test('the first request answers at once and walks the studies one at a time', async () => {
  const { request, plugin, fake } = install({
    script: {
      [GULLS]: [body(GULLS, 'H1')],
      [STORKS]: [body(STORKS, 'S1', 8, 48)],
    },
  });
  const first = await request();
  assert.equal(first.status, 200);
  assert.equal(first.headers['Cache-Control'], 'no-store');
  assert.deepEqual(first.body.animals, []);
  assert.deepEqual(first.body.pending, [GULLS, STORKS]);
  assert.deepEqual(
    first.body.studies.map(({ id, status }) => [id, status]),
    [
      [GULLS, 'pending'],
      [STORKS, 'pending'],
    ],
  );
  const walk = plugin.refreshing;
  assert.ok(walk, 'a walk is running');
  const again = await request();
  assert.equal(plugin.refreshing, walk, 'a second request joins the walk');
  assert.equal(again.status, 200);
  await walk;
  assert.equal(fake.peak(), 1, 'never more than one request to Movebank');
  assert.deepEqual(
    fake.calls.map(({ url }) => url),
    [movebankStudyUrl(GULLS), movebankStudyUrl(STORKS)],
  );
  assert.equal(fake.calls[0].init.redirect, 'error');
  const done = await request();
  assert.deepEqual(done.body.pending, []);
  assert.deepEqual(
    done.body.animals.map(({ id }) => id),
    [`${GULLS}:H1`, `${STORKS}:S1`],
  );
  assert.equal(done.body.fetchedAt, NOW);
  assert.equal(plugin.refreshing, null, 'a fresh cache starts no walk');
  assert.equal(fake.calls.length, 2);
});

test('a single retry clears a Movebank 500; two failures back off', async () => {
  const clock = { t: NOW };
  const { request, plugin, fake } = install({
    clock,
    script: {
      [GULLS]: [500, body(GULLS, 'H1')],
      [STORKS]: [500, 500, body(STORKS, 'S1')],
    },
  });
  await request();
  await plugin.refreshing;
  const after = await request();
  assert.deepEqual(
    after.body.studies.map(({ id, status }) => [id, status]),
    [
      [GULLS, 'fresh'],
      [STORKS, 'unavailable'],
    ],
  );
  assert.equal(fake.calls.length, 4);
  assert.equal(plugin.refreshing, null, 'the failed study is backing off');
  clock.t += 16 * 60_000;
  await request();
  await plugin.refreshing;
  const recovered = await request();
  assert.deepEqual(
    recovered.body.animals.map(({ id }) => id),
    [`${GULLS}:H1`, `${STORKS}:S1`],
  );
  assert.equal(fake.calls.length, 5, 'only the due study is asked again');
});

test('a study that stops being public is dropped with its cached tracks', async () => {
  const clock = { t: NOW };
  const { request, plugin } = install({
    clock,
    script: {
      [GULLS]: [body(GULLS, 'H1'), '', ''],
      [STORKS]: [body(STORKS, 'S1'), body(STORKS, 'S2')],
    },
  });
  await request();
  await plugin.refreshing;
  clock.t += WILDLIFE_TTL_MS;
  const refreshing = await request();
  assert.deepEqual(
    refreshing.body.animals.map(({ id }) => id),
    [`${GULLS}:H1`, `${STORKS}:S1`],
    'the old copy is served while the walk runs',
  );
  assert.deepEqual(refreshing.body.pending, []);
  await plugin.refreshing;
  const after = await request();
  assert.deepEqual(
    after.body.studies.map(({ id, status, withdrawn }) => [
      id,
      status,
      withdrawn,
    ]),
    [
      [GULLS, 'withdrawn', true],
      [STORKS, 'fresh', undefined],
    ],
  );
  assert.deepEqual(
    after.body.animals.map(({ id }) => id),
    [`${STORKS}:S2`],
  );
});

test('malformed answers count as failures, not data', async () => {
  const { request, plugin } = install({
    script: {
      [GULLS]: ['{"nope":1}', 'not json'],
      [STORKS]: [body(STORKS, 'S1')],
    },
  });
  await request();
  await plugin.refreshing;
  const after = await request();
  assert.deepEqual(
    after.body.studies.map(({ status }) => status),
    ['unavailable', 'fresh'],
  );
});

test('routes, methods and the per-client rate limit', async () => {
  for (const hook of ['configureServer', 'configurePreviewServer']) {
    const { request } = install({}, hook);
    assert.equal((await request('/', 'POST')).status, 405);
    assert.equal((await request('/study/1')).status, 404);
  }
  const { request, plugin } = install({
    script: { [GULLS]: [body(GULLS, 'H1')], [STORKS]: [body(STORKS, 'S1')] },
  });
  for (let i = 0; i < 30; i++)
    assert.equal((await request('/?x=1')).status, 200);
  const limited = await request();
  assert.equal(limited.status, 429);
  assert.equal(limited.headers['Retry-After'], '60');
  assert.equal((await request('/', 'GET', 'other')).status, 200);
  await plugin.refreshing;
});

const statuses = (snapshot) =>
  snapshot.body.studies.map(({ id, status }) => [id, status]);
const animalIds = (snapshot) => snapshot.body.animals.map(({ id }) => id);
const MINUTE = 60_000;

test('the hard maximum stale age outlives the TTL and is bounded', () => {
  assert.ok(WILDLIFE_MAX_STALE_MS > WILDLIFE_TTL_MS);
  assert.ok(WILDLIFE_MAX_STALE_MS <= 24 * 60 * MINUTE);
});

test('a study is fresh within the TTL and asks Movebank nothing', async () => {
  const clock = { t: NOW };
  const { request, plugin, fake } = install({
    clock,
    script: { [GULLS]: [body(GULLS, 'H1')], [STORKS]: [body(STORKS, 'S1')] },
  });
  await request();
  await plugin.refreshing;
  clock.t += WILDLIFE_TTL_MS - 1;
  const within = await request();
  assert.equal(plugin.refreshing, null);
  assert.deepEqual(statuses(within), [
    [GULLS, 'fresh'],
    [STORKS, 'fresh'],
  ]);
  assert.deepEqual(animalIds(within), [`${GULLS}:H1`, `${STORKS}:S1`]);
  assert.equal(fake.calls.length, 2);
});

test('failing refreshes serve a stale copy, then stop serving coordinates', async () => {
  const clock = { t: NOW };
  // Gulls answer once, then Movebank fails for this study for good (5xx and
  // network errors alike); storks keep answering.
  const failures = Array.from({ length: 200 }, (_, i) => (i % 2 ? 503 : 500));
  const storks = Array.from({ length: 200 }, () => body(STORKS, 'S1', 8, 48));
  const { request, plugin } = install({
    clock,
    script: { [GULLS]: [body(GULLS, 'H1'), ...failures], [STORKS]: storks },
  });
  await request();
  await plugin.refreshing;
  assert.deepEqual(statuses(await request()), [
    [GULLS, 'fresh'],
    [STORKS, 'fresh'],
  ]);
  // Past the TTL, refresh after refresh fails.
  clock.t = NOW + WILDLIFE_TTL_MS;
  let rounds = 0;
  while (clock.t < NOW + WILDLIFE_MAX_STALE_MS - 16 * MINUTE) {
    // A fresh client each round keeps the per-client rate limit out of it.
    const peer = `round-${rounds}`;
    await request('/', 'GET', peer);
    await plugin.refreshing;
    const now = await request('/', 'GET', peer);
    assert.deepEqual(
      statuses(now)[0],
      [GULLS, 'stale'],
      `stale ${clock.t - NOW} ms after the fetch`,
    );
    assert.ok(animalIds(now).includes(`${GULLS}:H1`), 'stale copy served');
    assert.equal(now.body.studies[0].fetchedAt, NOW);
    rounds++;
    clock.t += 16 * MINUTE;
  }
  assert.ok(rounds >= 10, `the refresh failed ${rounds} times`);
  // Past the hard maximum: the coordinates are gone, failing or not.
  clock.t = NOW + WILDLIFE_MAX_STALE_MS;
  const expired = await request();
  assert.notEqual(statuses(expired)[0][1], 'stale');
  assert.notEqual(statuses(expired)[0][1], 'fresh');
  assert.deepEqual(animalIds(expired), [`${STORKS}:S1`]);
  await plugin.refreshing;
  const after = await request();
  assert.deepEqual(statuses(after), [
    [GULLS, 'unavailable'],
    [STORKS, 'fresh'],
  ]);
  assert.deepEqual(animalIds(after), [`${STORKS}:S1`]);
  assert.equal(after.body.studies[0].fetchedAt, null);
  assert.ok(
    after.body.fetchedAt > NOW,
    'the payload age no longer counts the dropped copy',
  );
});

test('the max stale age holds even when no refresh runs', async () => {
  const clock = { t: NOW };
  const { request, plugin } = install({
    clock,
    script: {
      [GULLS]: [body(GULLS, 'H1')],
      [STORKS]: [body(STORKS, 'S1')],
    },
  });
  await request();
  await plugin.refreshing;
  // The next walk throws on its first request (no more scripted answers) and
  // backs off; nothing refreshes again before the copy expires.
  clock.t += WILDLIFE_MAX_STALE_MS;
  const expired = await request();
  assert.deepEqual(animalIds(expired), []);
  await plugin.refreshing;
  assert.deepEqual(animalIds(await request()), []);
});

for (const status of [401, 403, 404, 410])
  test(`HTTP ${status} withdraws a study at once, without a retry`, async () => {
    const clock = { t: NOW };
    const { request, plugin, fake } = install({
      clock,
      script: {
        [GULLS]: [body(GULLS, 'H1'), status, body(GULLS, 'H2')],
        [STORKS]: [body(STORKS, 'S1'), body(STORKS, 'S2')],
      },
    });
    await request();
    await plugin.refreshing;
    clock.t += WILDLIFE_TTL_MS;
    await request();
    await plugin.refreshing;
    const after = await request();
    assert.deepEqual(statuses(after), [
      [GULLS, 'withdrawn'],
      [STORKS, 'fresh'],
    ]);
    assert.equal(after.body.studies[0].withdrawn, true);
    assert.equal(after.body.studies[0].fetchedAt, null);
    assert.deepEqual(animalIds(after), [`${STORKS}:S2`]);
    assert.equal(
      fake.calls.filter(({ study }) => study === GULLS).length,
      2,
      'one request, no retry',
    );
    // Republished: the next good answer after the back-off restores it.
    clock.t += 16 * MINUTE;
    await request();
    await plugin.refreshing;
    const back = await request();
    assert.equal(statuses(back)[0][1], 'fresh');
    assert.equal(back.body.studies[0].withdrawn, undefined);
    assert.ok(animalIds(back).includes(`${GULLS}:H2`));
  });
