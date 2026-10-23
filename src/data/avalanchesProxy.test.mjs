import test from 'node:test';
import assert from 'node:assert/strict';
import {
  avalancheProxy,
  avalancheWindow,
  seasonWeeks,
} from '../../server/providers/avalanches.js';

const NOW = Date.parse('2026-03-08T12:00:00Z');

const varsomRegion = (id, type = 'A') => ({
  Id: id,
  Name: `Region ${id}`,
  TypeName: type,
  AvalancheWarningList: [
    { ValidFrom: '2026-03-07T00:00:00', DangerLevel: '3', MainText: 'Big.' },
  ],
});
const regobsRow = (id) => ({
  RegId: id,
  DtObsTime: '2026-03-07T10:00:00+01:00',
  ObsLocation: { Latitude: 69.4, Longitude: 20.1, ForecastRegionTID: 3010 },
  AvalancheObs: {
    StartLat: 69.45,
    StartLong: 20.13,
    StopLat: 69.44,
    StopLong: 20.14,
  },
  Observer: { NickName: 'observer' },
});

const slfBulletins = (level = 'considerable') => ({
  bulletins: [
    {
      regions: [{ regionID: 'CH-1111', name: 'Vaud Prealps' }],
      dangerRatings: [
        { mainValue: level, customData: { CH: { subdivision: 'minus' } } },
      ],
      avalancheProblems: [
        {
          dangerRatingValue: level,
          customData: { CH: { coreZoneText: 'Above 2200m.' } },
        },
      ],
    },
  ],
});

/**
 * A fake upstream that answers each service with its own shape, so a test
 * exercises the country it means to. `down` names services that fail.
 */
function upstreams({ down = [], calls = [] } = {}) {
  return async (url, options) => {
    const href = String(url);
    calls.push(href);
    const service = href.includes('api01.nve.no')
      ? 'varsom'
      : href.includes('aws.slf.ch/api/bulletin')
        ? 'slf'
        : href.includes('aws.slf.ch/api/warningregion')
          ? 'slf-regions'
          : href.includes('regions.avalanches.org')
            ? 'eaws'
            : href.includes('/Search/Count')
              ? 'count'
              : 'regobs';
    if (down.includes(service)) throw new Error(`${service} down`);
    if (service === 'varsom')
      return Response.json([varsomRegion(3010), varsomRegion(3001, 'B')]);
    if (service === 'slf') return Response.json(slfBulletins());
    if (service === 'count') return Response.json({ TotalMatches: 5 });
    if (service === 'regobs') {
      options.seen?.push(JSON.parse(options.body));
      return Response.json([regobsRow(7), regobsRow(8)]);
    }
    const ring = [
      [7, 46],
      [7.1, 46],
      [7.1, 46.1],
      [7, 46],
    ];
    return Response.json({
      features: [
        service === 'eaws'
          ? {
              properties: { id: 'NO-3010' },
              geometry: { type: 'Polygon', coordinates: [ring] },
            }
          : {
              properties: {
                sector_id: '1111',
                sector_names: { en: 'Vaud Prealps' },
              },
              geometry: { type: 'Polygon', coordinates: [ring] },
            },
      ],
    });
  };
}

function install(fetchImpl) {
  let handler;
  const plugin = avalancheProxy({ fetchImpl, now: () => NOW });
  plugin.configureServer({
    middlewares: {
      use(path, callback) {
        assert.equal(path, '/api/avalanches');
        handler = callback;
      },
    },
  });
  return async (url, method = 'GET') => {
    const res = {
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
      },
      end(body) {
        this.body = JSON.parse(body);
      },
    };
    await handler({ url, method, socket: { remoteAddress: 'peer' } }, res);
    return res;
  };
}

test('construction acquires nothing and mounts dev and preview routes', () => {
  const plugin = avalancheProxy({
    fetchImpl: () => {
      throw new Error('construction must not fetch');
    },
  });
  assert.equal(plugin.name, 'avalanches');
  assert.equal(typeof plugin.configurePreviewServer, 'function');
});

test('windows are validated before any upstream request', () => {
  const query = (from, to) => new URLSearchParams({ from, to });
  assert.deepEqual(avalancheWindow(query('2026-03-01', '2026-03-10'), NOW), {
    from: '2026-03-01',
    to: '2026-03-10',
  });
  assert.equal(
    avalancheWindow(query('x', '2026-03-10'), NOW).error,
    'invalid_date',
  );
  assert.equal(
    avalancheWindow(query('2026-02-30', '2026-03-01'), NOW).error,
    'invalid_date',
  );
  assert.equal(
    avalancheWindow(query('2026-03-10', '2026-03-01'), NOW).error,
    'invalid_range',
  );
  assert.equal(
    avalancheWindow(query('2026-01-01', '2026-03-01'), NOW).error,
    'range_too_wide',
  );
  assert.equal(
    avalancheWindow(query('2026-03-08', '2026-03-15'), NOW).error,
    'out_of_range',
  );
});

test('a season is counted Monday to Sunday from early December to the end of May', () => {
  const weeks = seasonWeeks(2025);
  assert.equal(weeks[0].from, '2025-12-01');
  assert.equal(weeks[0].to, '2025-12-07');
  assert.ok(
    weeks.at(-1).from <= '2026-05-31' && weeks.at(-1).to >= '2026-05-31',
  );
});

test('forecasts merge Norway and Switzerland and are cached per window', async () => {
  const calls = [];
  const request = install(upstreams({ calls }));
  const first = await request('/forecast?from=2026-03-01&to=2026-03-10');
  assert.equal(first.status, 200);
  assert.deepEqual(
    first.body.regions.map((region) => `${region.provider}:${region.id}`),
    ['varsom:NO-3010', 'slf:CH-1111'],
  );
  assert.deepEqual(first.body.unavailable, []);
  const swiss = first.body.regions[1];
  assert.equal(swiss.days.length, 10, 'one SLF bulletin read per day');
  assert.deepEqual(swiss.days[0], {
    date: '2026-03-01',
    level: 3,
    text: 'Above 2200m.',
    sub: '−',
  });
  assert.ok(
    calls.some((url) =>
      /RegionSummary\/Simple\/2\/2026-03-01\/2026-03-10$/.test(url),
    ),
  );
  assert.ok(
    calls.includes(
      'https://aws.slf.ch/api/bulletin/caaml/en/json?activeAt=2026-03-01T12%3A00%3A00Z',
    ),
  );
  const count = calls.length;
  await request('/forecast?from=2026-03-01&to=2026-03-10');
  assert.equal(calls.length, count, 'a repeated window is served from cache');
});

test('a country that is down drops out without blanking the others', async () => {
  const request = install(upstreams({ down: ['slf', 'slf-regions'] }));
  const forecast = await request('/forecast?from=2026-03-01&to=2026-03-02');
  assert.equal(forecast.status, 200);
  assert.deepEqual(forecast.body.unavailable, ['slf']);
  assert.deepEqual(
    forecast.body.regions.map((region) => region.id),
    ['NO-3010'],
  );
  const regions = await request('/regions');
  assert.deepEqual(
    regions.body.regions.map((region) => region.id),
    ['NO-3010'],
  );
  assert.deepEqual(regions.body.unavailable, ['slf']);
  const none = install(upstreams({ down: ['slf', 'varsom'] }));
  assert.equal(
    (await none('/forecast?from=2026-03-01&to=2026-03-02')).status,
    502,
  );
});

test('region outlines come from EAWS for Norway and SLF for Switzerland', async () => {
  const request = install(upstreams());
  const res = await request('/regions');
  assert.deepEqual(
    res.body.regions.map((region) => [
      region.provider,
      region.id,
      region.name ?? null,
    ]),
    [
      ['varsom', 'NO-3010', null],
      ['slf', 'CH-1111', 'Vaud Prealps'],
    ],
  );
});

test('observations are trimmed to what the layer draws, with the observer named', async () => {
  const seen = [];
  const fake = upstreams();
  const request = install((url, options) => fake(url, { ...options, seen }));
  const res = await request('/observations?from=2026-03-01&to=2026-03-07');
  const [body] = seen;
  assert.equal(res.status, 200);
  assert.deepEqual(body.SelectedGeoHazards, [10]);
  assert.deepEqual(body.SelectedRegistrationTypes, [{ Id: 26 }]);
  assert.equal(body.FromDtObsTime, '2026-03-01T00:00:00');
  assert.equal(res.body.observations.length, 2);
  assert.equal(res.body.observations[0].observer, 'observer');
  assert.ok(res.body.observations[0].stop);
});

test('an upstream failure is a 502, and cached data is served stale', async () => {
  let clock = NOW;
  let fail = false;
  let handler;
  avalancheProxy({
    now: () => clock,
    fetchImpl: async (url, options) => {
      if (fail) throw new Error('down');
      return upstreams()(url, options);
    },
  }).configureServer({
    middlewares: { use: (_path, callback) => (handler = callback) },
  });
  const request = async (url) => {
    const res = {
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
      },
      end(body) {
        this.body = JSON.parse(body);
      },
    };
    await handler(
      { url, method: 'GET', socket: { remoteAddress: 'peer' } },
      res,
    );
    return res;
  };
  const url = '/forecast?from=2026-03-07&to=2026-03-10';
  assert.equal((await request(url)).status, 200);
  fail = true;
  clock += 60 * 60_000; // past the live TTL
  const stale = await request(url);
  assert.equal(stale.status, 200);
  assert.equal(stale.body.stale, true);
  assert.equal(stale.headers['X-Data-Stale'], 'true');
  assert.equal(
    stale.body.fetchedAt,
    NOW,
    "the age is the data's, not the request's",
  );
  const unseen = await request('/forecast?from=2026-03-01&to=2026-03-02');
  assert.equal(unseen.status, 502);
  assert.equal(unseen.body.error, 'avalanche_data_unavailable');
});

test('unknown routes, methods and seasons are refused', async () => {
  const request = install(async () => Response.json([]));
  assert.equal((await request('/nope')).status, 404);
  assert.equal((await request('/regions', 'POST')).status, 405);
  assert.equal((await request('/season?season=1999')).status, 400);
  assert.equal((await request('/season?season=abc')).status, 400);
});

test('a season reports a count per week', async () => {
  const request = install(async () => Response.json({ TotalMatches: 5 }));
  const res = await request('/season?season=2025');
  assert.equal(res.status, 200);
  assert.ok(res.body.weeks.length > 10);
  assert.ok(res.body.weeks.every((week) => week.count === 5));
  // Weeks after "now" are not requested.
  assert.ok(res.body.weeks.every((week) => week.from <= '2026-03-08'));
});
