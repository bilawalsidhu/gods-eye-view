import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMontgomeryIncidents,
  parseMontgomeryUnits,
  createMontgomeryCountyFeed,
  createMontgomeryCountyDetails,
  MONTGOMERY_PAGE,
} from './countyEms/montgomery.js';
import { countySnapshot, countyEmsProxy } from './countyEms.js';
import { easternTime } from './chesterCountyEms/parser.js';
const clock = easternTime('11/3/2026 12:00:00 PM');
const report = (category = 'ems', num = 'E2600001', eid = '123') =>
  '<button class="inc" data-cat="' +
  category +
  '" data-eid="' +
  eid +
  '" data-num="' +
  num +
  '"><span class="inc-type">SYNTHETIC ' +
  category +
  '</span><span class="inc-loc">EXAMPLE RD &amp; TEST ST</span><span class="inc-meta"><span>EXAMPLE TOWNSHIP</span><span>Station 001</span><span>Dispatched 2026-11-03 @ 11:59:00</span></span></button>';
const html = (rows = [report()]) =>
  '<div>Last updated <strong>11/3/2026 12:00:00 PM</strong></div><h2>Active Fire, EMS &amp; Traffic Incidents <span class="count">' +
  rows.length +
  '</span></h2>' +
  rows.join('');
const geo = (
  features = [
    {
      properties: {
        incidentno: 'E2600001',
        location: 'EXAMPLE RD & TEST ST',
        mun: 'EXAMPLE TOWNSHIP',
        updated_dt: 0,
      },
      geometry: { type: 'Point', coordinates: [-75.3, 40.2] },
    },
  ],
) => ({ type: 'FeatureCollection', features });
const units =
  '<table class="u-table"><tr><th>Unit</th><th>Status</th><th>Time</th></tr><tr><td>001-1</td><td><span>Enroute</span></td><td>11:59:45 AM</td></tr></table>';

test('Montgomery parses complete public categories, qualified IDs and Eastern dispatch time; rejects silent truncation', () => {
  const snapshot = parseMontgomeryIncidents(
    html([
      report(),
      report('fire', 'F2600001'),
      report('traffic', 'P26000001'),
    ]),
  );
  assert.equal(snapshot.rows.length, 3);
  assert.equal(snapshot.rows[0].id, 'montgomery-pa:ems:E2600001');
  assert.equal(snapshot.rows[0].location, 'EXAMPLE RD & TEST ST');
  assert.equal(snapshot.rows[0].station, '001');
  assert.equal(snapshot.rows[0].dispatchedAt, clock - 60000);
  assert.throws(() =>
    parseMontgomeryIncidents(
      html().replace('class="count">1', 'class="count">2'),
    ),
  );
  assert.throws(() => parseMontgomeryIncidents(html([report(), report()])));
  assert.throws(() => parseMontgomeryIncidents(html([report('other')])));
  assert.equal(parseMontgomeryIncidents(html([])).rows.length, 0);
});
test('Montgomery joins county coordinates by active identity and reported location, shares cache, retains stale reports and recovers empty', async () => {
  let requests = 0,
    failed = false,
    empty = false,
    now = clock;
  const feed = createMontgomeryCountyFeed({
    now: () => now,
    fetchImpl: async (url) => {
      requests++;
      if (failed) throw new Error('offline');
      return new Response(
        url === MONTGOMERY_PAGE
          ? html(empty ? [] : undefined).replace(
              'SYNTHETIC ems',
              'SYNTHETIC EMS — TEST',
            )
          : JSON.stringify(geo(empty ? [] : undefined)),
      );
    },
  });
  const [a, b] = await Promise.all([feed(), feed()]);
  assert.equal(a.rows[0].mapPosition.kind, 'county-published');
  assert.equal(a.rows[0].type, 'SYNTHETIC EMS — TEST');
  assert.deepEqual(a, b);
  assert.equal(requests, 2);
  assert.equal((await feed()).stale, false);
  assert.equal(requests, 2);
  now += 120000;
  failed = true;
  assert.equal((await feed()).stale, true);
  assert.equal((await feed()).rows.length, 1);
  now += 120000;
  failed = false;
  empty = true;
  assert.equal((await feed()).rows.length, 0);
});
test('Montgomery GIS failure or location mismatch retains complete reports without guessed coordinates', async () => {
  for (const response of [
    null,
    geo([
      {
        properties: {
          incidentno: 'E2600001',
          location: 'WRONG ROAD',
          mun: 'EXAMPLE TOWNSHIP',
        },
        geometry: { type: 'Point', coordinates: [-75.3, 40.2] },
      },
    ]),
  ]) {
    const feed = createMontgomeryCountyFeed({
      now: () => clock,
      fetchImpl: async (url) => {
        if (url === MONTGOMERY_PAGE) return new Response(html());
        if (response === null) throw new Error('offline');
        return Response.json(response);
      },
    });
    const s = await feed();
    assert.equal(s.rows.length, 1);
    assert.equal(s.rows[0].mapPosition, null);
    assert.equal(s.stale, false);
    assert.equal(
      s.rows[0].locationStatus,
      response === null ? 'unavailable' : 'unmatched',
    );
  }
});
test('Montgomery units preserve undated times, cache details, fail closed for inactive IDs and retain stale units', async () => {
  assert.equal(
    parseMontgomeryUnits(units, 'E2600001', clock).units[0].enteredAt,
    null,
  );
  assert.throws(() =>
    parseMontgomeryUnits('<html>error</html>', 'E2600001', clock),
  );
  let now = clock,
    requests = 0,
    failed = false;
  const snapshot = { ...parseMontgomeryIncidents(html()), stale: false };
  const details = createMontgomeryCountyDetails({
    now: () => now,
    getSnapshot: async () => snapshot,
    fetchImpl: async (url) => {
      requests++;
      assert.equal(new URL(url).origin, 'https://webapp07.montcopa.org');
      assert.equal(new URL(url).searchParams.get('eid'), '123');
      if (failed) throw new Error('offline');
      return new Response(units);
    },
  });
  const id = snapshot.rows[0].id;
  const a = await details(id);
  assert.equal(a.timestampBasis, 'retrieved');
  assert.equal(a.units[0].entered, '11:59:45 AM');
  await details(id);
  assert.equal(requests, 1);
  now += 60000;
  failed = true;
  assert.equal((await details(id)).stale, true);
  await assert.rejects(details('montgomery-pa:ems:E2699999'));
  assert.equal(requests, 2);
});
test('combined feed reports each county independently and keeps working sources through partial outages', async () => {
  const snapshot = {
    ...parseMontgomeryIncidents(html()),
    fetchedAt: clock,
    stale: false,
  };
  const feeds = [
    {
      id: 'chester-pa',
      name: 'Chester County, PA',
      getSnapshot: async () => {
        throw new Error('offline');
      },
    },
    {
      id: 'montgomery-pa',
      name: 'Montgomery County, PA',
      getSnapshot: async () => snapshot,
    },
  ];
  const s = await countySnapshot(feeds, () => clock);
  assert.equal(s.rows.length, 1);
  assert.equal(s.rows[0].countyId, 'montgomery-pa');
  assert.equal(s.countyFeeds[0].unavailable, true);
  assert.equal(s.countyFeeds[1].stale, false);
  assert.equal(s.stale, true);
  await assert.rejects(countySnapshot(feeds.slice(0, 1)));
});
test('combined route admits only bounded incident IDs and leaves the legacy endpoint Chester-scoped', async () => {
  let reads = 0;
  const feeds = [
    {
      id: 'chester-pa',
      name: 'Chester County, PA',
      getSnapshot: async () => ({
        rows: [],
        observedAt: clock,
        fetchedAt: clock,
        stale: false,
      }),
      getDetails: async () => ({ units: [] }),
    },
    {
      id: 'montgomery-pa',
      name: 'Montgomery County, PA',
      getSnapshot: async () => ({
        ...parseMontgomeryIncidents(html()),
        fetchedAt: clock,
        stale: false,
      }),
      getDetails: async (id) => {
        reads++;
        return { id };
      },
    },
  ];
  const routes = new Map();
  countyEmsProxy({ feeds, now: () => clock }).configureServer({
    middlewares: { use: (path, handler) => routes.set(path, handler) },
  });
  async function request(path, url) {
    let data;
    const res = {
      statusCode: 200,
      setHeader() {},
      end(body) {
        data = JSON.parse(body);
      },
    };
    await routes.get(path)({ url, method: 'GET' }, res, () => {
      throw new Error('unexpected next');
    });
    return { status: res.statusCode, data };
  }
  assert.equal(
    (await request('/api/chester-county-ems', '/')).data.rows.length,
    0,
  );
  assert.equal(
    (await request('/api/county-ems', '/')).data.rows[0].countyId,
    'montgomery-pa',
  );
  assert.equal(
    (
      await request(
        '/api/county-ems',
        '/details?incident=montgomery-pa%3Aems%3AE2600001',
      )
    ).status,
    200,
  );
  assert.equal(
    (await request('/api/county-ems', '/details?incident=https://evil.test'))
      .status,
    400,
  );
  assert.equal(
    (
      await request(
        '/api/county-ems',
        '/details?incident=ems%3AF26000001&url=https://evil.test',
      )
    ).status,
    400,
  );
  assert.equal(reads, 1);
});
