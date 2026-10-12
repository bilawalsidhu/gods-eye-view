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

test('forecasts keep rated regions and are cached per window', async () => {
  const calls = [];
  const request = install(async (url) => {
    calls.push(String(url));
    return Response.json([varsomRegion(3010), varsomRegion(3001, 'B')]);
  });
  const first = await request('/forecast?from=2026-03-01&to=2026-03-10');
  assert.equal(first.status, 200);
  assert.deepEqual(
    first.body.regions.map((region) => region.id),
    ['NO-3010'],
  );
  assert.match(calls[0], /RegionSummary\/Simple\/2\/2026-03-01\/2026-03-10$/);
  await request('/forecast?from=2026-03-01&to=2026-03-10');
  assert.equal(calls.length, 1, 'a repeated window is served from cache');
});

test('observations are trimmed to what the layer draws, with the observer named', async () => {
  let body;
  const request = install(async (url, options) => {
    body = JSON.parse(options.body);
    return Response.json([regobsRow(7), regobsRow(8)]);
  });
  const res = await request('/observations?from=2026-03-01&to=2026-03-07');
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
    fetchImpl: async () => {
      if (fail) throw new Error('down');
      return Response.json([varsomRegion(3010)]);
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
