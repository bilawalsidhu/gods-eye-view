import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  SA_ROAD_EVENTS_POLICY,
  SA_ROAD_EVENTS_UPSTREAMS,
  saRoadEventsProxy,
} from '../../server/providers/saRoadEvents.js';

const fixture = (name) =>
  JSON.parse(
    readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'),
  );
const roadworksSample = fixture('trafficsa-points-sample.json').features;
const sampleFeature = roadworksSample[1]; // a "24HR ROADWORKS" row
const legacyIncident = roadworksSample[0]; // a stale INCIDENT row
const incidentFeatures = fixture('trafficsa-geohub-incidents.json').features;
const closureFeatures = fixture('trafficsa-geohub-closures.json').features;

const MAPS = 'https://maps.sa.gov.au';
const GEOHUB = 'https://dit-cms-prod.geohub.sa.gov.au';

const pointFeature = (n) => ({
  ...sampleFeature,
  id: n,
  properties: {
    ...sampleFeature.properties,
    ROADWORKS_AND_INCIDENTS_ID: String(1000 + n),
    ESRI_OID: n,
  },
});
const pointFeatures = (count) =>
  Array.from({ length: count }, (_, i) => pointFeature(i + 1));
const incidentFeature = (n) => ({
  ...incidentFeatures[0],
  id: n,
  properties: { ...incidentFeatures[0].properties, incident_id: n },
});
const incidentFeaturesOf = (count) =>
  Array.from({ length: count }, (_, i) => incidentFeature(i + 1));

/** The order field each layer genuinely accepts; anything else is an error. */
const VALID_ORDER = {
  roadworks: 'ESRI_OID',
  incidents: 'incident_id',
  closures: 'ESRI_OID',
};

/** Parse an ArcGIS query URL the proxy requested. */
function parse(url) {
  const parsed = new URL(url);
  const [, service, layer] =
    parsed.pathname.match(
      /\/(TrafficSAOpenData2?|TrafficSATime_OpenData)\/MapServer\/(\d)\/query$/,
    ) || [];
  const group =
    service === 'TrafficSATime_OpenData'
      ? { 0: 'incidents', 2: 'closures' }[layer]
      : layer === '0'
        ? 'roadworks'
        : undefined;
  return {
    origin: parsed.origin,
    service,
    layer: Number(layer),
    group,
    offset: Number(parsed.searchParams.get('resultOffset')),
    params: parsed.searchParams,
  };
}

/**
 * A fake Traffic SA estate: the roadworks service (`roadworks` rows, upper-case
 * fields, with a mirror) and the geohub service (`incidents` and `closures`).
 * Each list is paged 1000 at a time like the real maxRecordCount. A request for
 * a layer or order field the real services do not have answers the way ArcGIS
 * does (an error object), and a request for a legacy layer 1 is recorded as a
 * forbidden call. `fail(request, n)` may return a Response to replace a normal
 * answer.
 */
function upstream({
  roadworks = pointFeatures(3),
  incidents = incidentFeatures,
  closures = closureFeatures,
  fail,
  flag = 'top',
} = {}) {
  const calls = [];
  const lists = { roadworks, incidents, closures };
  const fetchImpl = async (url, options) => {
    const request = parse(url);
    calls.push({ ...request, url, options });
    const failure = fail?.(request, calls.length);
    if (failure) return failure;
    if (
      !request.group ||
      request.params.get('orderByFields') !== VALID_ORDER[request.group]
    )
      return Response.json(
        {
          error: { code: 400, message: 'Invalid or missing input parameters.' },
        },
        { headers: { 'content-type': 'application/geo+json;charset=UTF-8' } },
      );
    const all = lists[request.group];
    const page = all.slice(request.offset, request.offset + 1000);
    const truncated = request.offset + 1000 < all.length;
    const body =
      flag === 'properties'
        ? {
            type: 'FeatureCollection',
            features: page,
            ...(truncated
              ? { properties: { exceededTransferLimit: true } }
              : {}),
          }
        : {
            type: 'FeatureCollection',
            features: page,
            ...(truncated ? { exceededTransferLimit: true } : {}),
          };
    return Response.json(body, {
      headers: { 'content-type': 'application/geo+json;charset=UTF-8' },
    });
  };
  return { calls, fetchImpl };
}

const down = () => new Response('down', { status: 503 });
const onlyGeohub = (request) => request.service === 'TrafficSATime_OpenData';
const groupCalls = (service, group) =>
  service.calls.filter((call) => call.group === group);

function install(options = {}, hook = 'configureServer') {
  let handler;
  const plugin = saRoadEventsProxy(options);
  assert.equal(plugin.name, 'sa-road-events');
  assert.equal(typeof plugin.configurePreviewServer, 'function');
  plugin[hook]({
    middlewares: {
      use(path, callback) {
        assert.equal(path, '/api/sa-road-events');
        handler = callback;
      },
    },
  });
  return async (url = '/', method = 'GET', peer = 'local') => {
    const res = {
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
      },
      end(body) {
        this.body = JSON.parse(body);
      },
    };
    await handler({ url, method, socket: { remoteAddress: peer } }, res);
    return res;
  };
}

const statuses = (res) =>
  Object.fromEntries(
    Object.entries(res.body.sources).map(([group, { status }]) => [
      group,
      status,
    ]),
  );
const incidentClassPoints = (res) =>
  res.body.points.filter((p) => /^inc-/.test(p.id));
const roadworksPoints = (res) =>
  res.body.points.filter((p) => !/^inc-/.test(p.id));

for (const hook of ['configureServer', 'configurePreviewServer']) {
  test(`${hook}: fixed upstreams, normalized body, no browser-chosen URL`, async () => {
    const service = upstream();
    const request = install(
      { now: () => 5000, fetchImpl: service.fetchImpl },
      hook,
    );
    const res = await request('/?url=https://evil.example/x&f=html');
    assert.equal(res.status, 200);
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assert.equal(res.headers['X-Data-Stale'], undefined);
    assert.equal(res.body.stale, false);
    assert.equal(res.body.mirror, false);
    assert.equal(res.body.fetchedAt, 5000);
    assert.equal(roadworksPoints(res).length, 3);
    assert.equal(incidentClassPoints(res).length, incidentFeatures.length);
    assert.equal(res.body.lines.length, closureFeatures.length);
    assert.deepEqual(Object.keys(res.body).sort(), [
      'fetchedAt',
      'lines',
      'mirror',
      'points',
      'sources',
      'stale',
    ]);
    assert.deepEqual(res.body.sources, {
      roadworks: { status: 'live', fetchedAt: 5000, mirror: false },
      incidents: { status: 'live', fetchedAt: 5000, mirror: false },
      closures: { status: 'live', fetchedAt: 5000, mirror: false },
    });
    assert.equal(service.calls.length, 3, 'one page per group');
    for (const call of service.calls) {
      assert.equal(call.params.get('f'), 'geojson');
      assert.equal(call.params.get('outSR'), '4326');
      assert.equal(call.params.get('outFields'), '*');
      assert.equal(call.params.get('resultRecordCount'), '1000');
      assert.equal(call.params.get('url'), null);
      assert.ok(call.options.signal instanceof AbortSignal);
      assert.equal(call.options.redirect, 'error');
      assert.match(
        call.options.headers['User-Agent'],
        /^gods-eye-view-sa-road-events-proxy\/1\.0 /,
      );
    }
    assert.deepEqual(
      Object.fromEntries(
        service.calls.map((call) => [
          call.group,
          [call.origin, call.service, call.layer],
        ]),
      ),
      {
        roadworks: [MAPS, 'TrafficSAOpenData', 0],
        incidents: [GEOHUB, 'TrafficSATime_OpenData', 0],
        closures: [GEOHUB, 'TrafficSATime_OpenData', 2],
      },
    );
  });
}

test('each layer pages on an order field it really has', async () => {
  const service = upstream();
  const request = install({ now: () => 0, fetchImpl: service.fetchImpl });
  const res = await request();
  assert.deepEqual(
    Object.fromEntries(
      service.calls.map((call) => [
        call.group,
        call.params.get('orderByFields'),
      ]),
    ),
    { roadworks: 'ESRI_OID', incidents: 'incident_id', closures: 'ESRI_OID' },
  );
  // The geohub incidents layer has no ESRI_OID: asking for it is an upstream
  // error, so a served incidents group proves it is never requested.
  assert.equal(statuses(res).incidents, 'live');
  assert.equal(incidentClassPoints(res).length, incidentFeatures.length);
  assert.equal(SA_ROAD_EVENTS_UPSTREAMS.incidents.layer.orderBy, 'incident_id');
});

test('an upstream rejecting the order field fails that group only', async () => {
  const service = upstream({
    fail: (request) =>
      request.group === 'incidents' &&
      request.params.get('orderByFields') === 'incident_id'
        ? Response.json(
            {
              error: {
                code: 400,
                message: 'Invalid or missing input parameters.',
              },
            },
            { headers: { 'content-type': 'application/geo+json' } },
          )
        : null,
  });
  const request = install({ now: () => 0, fetchImpl: service.fetchImpl });
  const res = await request();
  assert.equal(res.status, 200);
  assert.deepEqual(statuses(res), {
    roadworks: 'live',
    incidents: 'unavailable',
    closures: 'live',
  });
});

for (const flag of ['top', 'properties']) {
  test(`pages are followed while exceededTransferLimit is set (${flag} flag) and joined whole`, async () => {
    const service = upstream({
      roadworks: pointFeatures(2300),
      incidents: incidentFeaturesOf(1500),
      flag,
    });
    const request = install({ now: () => 0, fetchImpl: service.fetchImpl });
    const res = await request();
    assert.equal(res.status, 200);
    assert.equal(roadworksPoints(res).length, 2300);
    assert.equal(incidentClassPoints(res).length, 1500);
    assert.deepEqual(
      groupCalls(service, 'roadworks').map((call) => call.offset),
      [0, 1000, 2000],
    );
    assert.deepEqual(
      groupCalls(service, 'incidents').map((call) => call.offset),
      [0, 1000],
    );
    assert.equal(new Set(res.body.points.map((p) => p.id)).size, 3800);
  });
}

test('a failing page fails its whole group: last good is served, never a partial set', async () => {
  for (const group of ['roadworks', 'incidents']) {
    let clock = 0;
    let breakSecondPage = false;
    const service = upstream({
      roadworks: pointFeatures(1500),
      incidents: incidentFeaturesOf(1500),
      fail: (request) =>
        breakSecondPage && request.group === group && request.offset === 1000
          ? new Response('boom', { status: 500 })
          : null,
    });
    const request = install({ now: () => clock, fetchImpl: service.fetchImpl });
    const first = await request();
    assert.equal(first.body.points.length, 3000);
    breakSecondPage = true;
    clock = SA_ROAD_EVENTS_POLICY.freshMs;
    const second = await request();
    assert.equal(second.status, 200, group);
    assert.equal(second.body.stale, true);
    assert.equal(second.headers['X-Data-Stale'], 'true');
    assert.equal(second.body.points.length, 3000, 'previous complete groups');
    assert.equal(statuses(second)[group], 'stale');
    assert.equal(
      second.body.sources[group].fetchedAt,
      0,
      'the failed group keeps its own time',
    );
    assert.equal(
      statuses(second)[group === 'roadworks' ? 'incidents' : 'roadworks'],
      'live',
      'the other group refreshed normally',
    );
    assert.equal(second.body.fetchedAt, clock);
  }
});

test('a first failure on the second page leaves that group unavailable, not partial', async () => {
  const service = upstream({
    incidents: incidentFeaturesOf(1500),
    fail: (request) =>
      request.group === 'incidents' && request.offset === 1000
        ? new Response('boom', { status: 500 })
        : null,
  });
  const request = install({ now: () => 0, fetchImpl: service.fetchImpl });
  const res = await request();
  assert.equal(res.status, 200);
  assert.equal(incidentClassPoints(res).length, 0, 'no half an incident list');
  assert.equal(statuses(res).incidents, 'unavailable');
  assert.equal(statuses(res).roadworks, 'live');
});

test('geohub unreachable: roadworks are served, incidents and closures are unavailable', async () => {
  const service = upstream({
    fail: (request) => (onlyGeohub(request) ? down() : null),
  });
  const request = install({ now: () => 9000, fetchImpl: service.fetchImpl });
  const res = await request();
  assert.equal(res.status, 200);
  assert.equal(res.headers['X-Data-Stale'], undefined, 'nothing is stale');
  assert.equal(res.body.points.length, 3);
  assert.equal(incidentClassPoints(res).length, 0);
  assert.deepEqual(res.body.lines, []);
  assert.deepEqual(res.body.sources, {
    roadworks: { status: 'live', fetchedAt: 9000, mirror: false },
    incidents: { status: 'unavailable', fetchedAt: null, mirror: false },
    closures: { status: 'unavailable', fetchedAt: null, mirror: false },
  });
  assert.equal(res.body.fetchedAt, 9000);
});

test('roadworks down while geohub is up: incidents and closures are still served', async () => {
  const service = upstream({
    fail: (request) => (!onlyGeohub(request) ? down() : null),
  });
  const request = install({ now: () => 0, fetchImpl: service.fetchImpl });
  const res = await request();
  assert.equal(res.status, 200);
  assert.deepEqual(statuses(res), {
    roadworks: 'unavailable',
    incidents: 'live',
    closures: 'live',
  });
  assert.equal(roadworksPoints(res).length, 0);
  assert.equal(res.body.lines.length, closureFeatures.length);
});

test('legacy INCIDENT rows from the roadworks service are excluded', async () => {
  const service = upstream({
    roadworks: [legacyIncident, ...pointFeatures(2)],
    incidents: [],
  });
  const request = install({ now: () => 0, fetchImpl: service.fetchImpl });
  const res = await request();
  assert.equal(res.status, 200);
  assert.equal(res.body.points.length, 2, 'only the two roadworks rows');
  assert.ok(res.body.points.every((p) => p.kind === 'works24'));
  assert.equal(statuses(res).roadworks, 'live');
  assert.equal(
    statuses(res).incidents,
    'live',
    'no incidents is a valid state',
  );

  // A roadworks feed of nothing but stale incidents is empty, not an outage.
  const onlyStale = upstream({ roadworks: [legacyIncident] });
  const staleRequest = install({
    now: () => 0,
    fetchImpl: onlyStale.fetchImpl,
  });
  const staleRes = await staleRequest();
  assert.equal(statuses(staleRes).roadworks, 'live');
  assert.equal(roadworksPoints(staleRes).length, 0);
});

test('the frozen legacy closure layers are never requested, whatever fails', async () => {
  const scenarios = {
    healthy: () => null,
    'geohub down': (request) => (onlyGeohub(request) ? down() : null),
    'maps down': (request) => (!onlyGeohub(request) ? down() : null),
    'everything down': () => down(),
    'rate limited': () =>
      new Response('', { status: 429, headers: { 'retry-after': '120' } }),
  };
  for (const [name, fail] of Object.entries(scenarios)) {
    let clock = 0;
    const service = upstream({ fail });
    const request = install({ now: () => clock, fetchImpl: service.fetchImpl });
    for (let i = 0; i < 4; i++) {
      await request();
      clock += SA_ROAD_EVENTS_POLICY.freshMs;
    }
    assert.ok(service.calls.length > 0, name);
    assert.ok(
      service.calls.every((call) => call.layer !== 1),
      `${name}: no request to layer 1 (maps or mirror)`,
    );
    assert.ok(
      service.calls.every((call) => call.group),
      `${name}: every request is for a known group`,
    );
    for (const call of service.calls) {
      if (call.group === 'roadworks') assert.equal(call.origin, MAPS);
      else assert.equal(call.origin, GEOHUB, name);
      if (call.group !== 'roadworks')
        assert.equal(call.service, 'TrafficSATime_OpenData', name);
    }
  }
  const configured = JSON.stringify(SA_ROAD_EVENTS_UPSTREAMS);
  assert.ok(!/MapServer\/1\b/.test(configured));
  assert.deepEqual(
    Object.values(SA_ROAD_EVENTS_UPSTREAMS).map(({ layer }) => layer.index),
    [0, 0, 2],
  );
});

test('the roadworks mirror answers only after the primary fails, and is flagged', async () => {
  const service = upstream({
    fail: (request) =>
      request.service === 'TrafficSAOpenData' ? down() : null,
  });
  const request = install({ now: () => 7, fetchImpl: service.fetchImpl });
  const res = await request();
  assert.equal(res.status, 200);
  assert.equal(res.body.mirror, true);
  assert.equal(res.body.stale, false);
  assert.equal(roadworksPoints(res).length, 3);
  assert.deepEqual(res.body.sources.roadworks, {
    status: 'live',
    fetchedAt: 7,
    mirror: true,
  });
  assert.equal(res.body.sources.incidents.mirror, false);
  assert.deepEqual(
    groupCalls(service, 'roadworks').map((call) => call.service),
    ['TrafficSAOpenData', 'TrafficSAOpenData2'],
  );
  assert.ok(
    groupCalls(service, 'roadworks').every((call) => call.origin === MAPS),
  );
  assert.equal(
    groupCalls(service, 'incidents').length +
      groupCalls(service, 'closures').length,
    2,
    'geohub groups have no mirror and are asked once each',
  );
});

test('a healthy primary never touches the mirror', async () => {
  const service = upstream();
  const request = install({ now: () => 0, fetchImpl: service.fetchImpl });
  await request();
  assert.ok(
    service.calls.every((call) => call.service !== 'TrafficSAOpenData2'),
  );
});

test('a geohub failure never falls back to the roadworks service or the mirror', async () => {
  const service = upstream({
    fail: (request) => (onlyGeohub(request) ? down() : null),
  });
  const request = install({ now: () => 0, fetchImpl: service.fetchImpl });
  await request();
  assert.equal(groupCalls(service, 'incidents').length, 1);
  assert.equal(groupCalls(service, 'closures').length, 1);
  assert.ok(
    service.calls
      .filter((call) => call.group !== 'roadworks')
      .every((call) => call.origin === GEOHUB),
  );
});

test('the mirror is not a partial answer either: a mirror page failure falls back to last good', async () => {
  let clock = 0;
  let degraded = false;
  const service = upstream({
    roadworks: pointFeatures(1200),
    fail: (request) => {
      if (!degraded || request.group !== 'roadworks') return null;
      if (request.service === 'TrafficSAOpenData') return down();
      return request.offset === 1000 ? down() : null;
    },
  });
  const request = install({ now: () => clock, fetchImpl: service.fetchImpl });
  await request();
  degraded = true;
  clock = SA_ROAD_EVENTS_POLICY.freshMs;
  const res = await request();
  assert.equal(res.body.stale, true);
  assert.equal(res.body.mirror, false);
  assert.equal(statuses(res).roadworks, 'stale');
  assert.equal(roadworksPoints(res).length, 1200);
});

test('unusable upstream answers are failures, not empty data', async () => {
  const cases = {
    'HTML error page': () =>
      new Response('<html>File Unavailable</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    'JSON content-type with a non-JSON body': () =>
      new Response('File Unavailable', {
        headers: { 'content-type': 'application/json' },
      }),
    'ArcGIS error object': () =>
      Response.json({
        error: { code: 400, message: 'Failed to execute query.' },
      }),
    'non-collection JSON': () => Response.json([]),
    'collection of unusable rows': () =>
      Response.json({
        type: 'FeatureCollection',
        features: [{ type: 'Feature', geometry: null, properties: {} }],
      }),
  };
  for (const [name, answer] of Object.entries(cases)) {
    const everywhere = upstream({ fail: () => answer() });
    const all = install({ now: () => 0, fetchImpl: everywhere.fetchImpl });
    assert.equal((await all()).status, 502, name);

    // Only the geohub groups misbehave: roadworks keep flowing.
    const geohub = upstream({
      fail: (request) => (onlyGeohub(request) ? answer() : null),
    });
    const partial = install({ now: () => 0, fetchImpl: geohub.fetchImpl });
    const res = await partial();
    assert.equal(res.status, 200, name);
    assert.deepEqual(
      statuses(res),
      { roadworks: 'live', incidents: 'unavailable', closures: 'unavailable' },
      name,
    );
  }
});

test('a feed that never stops claiming more pages is a failure, not a truncation', async () => {
  for (const group of ['roadworks', 'incidents', 'closures']) {
    const service = upstream({
      fail: (request) =>
        request.group === group
          ? Response.json({
              type: 'FeatureCollection',
              features: pointFeatures(1),
              exceededTransferLimit: true,
            })
          : null,
    });
    const request = install({ now: () => 0, fetchImpl: service.fetchImpl });
    const res = await request();
    assert.equal(res.status, 200, group);
    assert.equal(statuses(res)[group], 'unavailable', group);
    assert.equal(
      groupCalls(service, group).filter(
        (call) => call.service !== 'TrafficSAOpenData2',
      ).length,
      10,
      'bounded by MAX_PAGES',
    );
  }
});

test('an empty page that still claims truncation fails instead of looping', async () => {
  const service = upstream({
    fail: (request) =>
      request.group === 'incidents'
        ? Response.json({
            type: 'FeatureCollection',
            features: [],
            exceededTransferLimit: true,
          })
        : null,
  });
  const request = install({ now: () => 0, fetchImpl: service.fetchImpl });
  const res = await request();
  assert.equal(statuses(res).incidents, 'unavailable');
  assert.equal(groupCalls(service, 'incidents').length, 1);
});

test('snapshots are cached for the fresh window and shared by concurrent callers', async () => {
  let clock = 0;
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const service = upstream();
  const request = install({
    now: () => clock,
    fetchImpl: async (...args) => {
      await gate;
      return service.fetchImpl(...args);
    },
  });
  const pending = [request('/', 'GET', 'a'), request('/', 'GET', 'b')];
  release();
  const [a, b] = await Promise.all(pending);
  assert.equal(service.calls.length, 3, 'three groups, once, for both callers');
  assert.deepEqual(a.body, b.body);
  clock = SA_ROAD_EVENTS_POLICY.freshMs - 1;
  const cached = await request();
  assert.equal(service.calls.length, 3, 'fresh cache is reused');
  assert.equal(cached.body.fetchedAt, 0);
  clock = SA_ROAD_EVENTS_POLICY.freshMs;
  const refreshed = await request();
  assert.equal(service.calls.length, 6);
  assert.equal(refreshed.body.fetchedAt, SA_ROAD_EVENTS_POLICY.freshMs);
});

test('failures serve stale data, back off, then recover', async () => {
  let clock = 0;
  let broken = false;
  const service = upstream({ fail: () => (broken ? down() : null) });
  const request = install({ now: () => clock, fetchImpl: service.fetchImpl });
  await request();
  broken = true;
  clock = SA_ROAD_EVENTS_POLICY.freshMs;
  const stale = await request();
  assert.equal(stale.status, 200);
  assert.equal(stale.body.stale, true);
  assert.equal(stale.headers['X-Data-Stale'], 'true');
  assert.deepEqual(statuses(stale), {
    roadworks: 'stale',
    incidents: 'stale',
    closures: 'stale',
  });
  assert.equal(stale.body.sources.incidents.fetchedAt, 0);
  assert.equal(stale.body.points.length, 3 + incidentFeatures.length);
  assert.equal(stale.body.lines.length, closureFeatures.length);
  const callsAfterFailure = service.calls.length;
  clock += SA_ROAD_EVENTS_POLICY.retryAfterFailureMs - 1;
  const backedOff = await request();
  assert.equal(backedOff.body.stale, true);
  assert.equal(
    service.calls.length,
    callsAfterFailure,
    'no retry inside the backoff',
  );
  broken = false;
  clock += 1;
  const recovered = await request();
  assert.equal(recovered.body.stale, false);
  assert.equal(recovered.headers['X-Data-Stale'], undefined);
  assert.equal(recovered.body.fetchedAt, clock);
  assert.deepEqual(statuses(recovered), {
    roadworks: 'live',
    incidents: 'live',
    closures: 'live',
  });
});

test('geohub fails after a success: its groups go stale while roadworks stay live', async () => {
  let clock = 0;
  let geohubDown = false;
  const service = upstream({
    fail: (request) => (geohubDown && onlyGeohub(request) ? down() : null),
  });
  const request = install({ now: () => clock, fetchImpl: service.fetchImpl });
  await request();
  geohubDown = true;
  clock = SA_ROAD_EVENTS_POLICY.freshMs;
  const res = await request();
  assert.equal(res.status, 200);
  assert.deepEqual(statuses(res), {
    roadworks: 'live',
    incidents: 'stale',
    closures: 'stale',
  });
  assert.equal(res.body.stale, true);
  assert.equal(res.body.sources.roadworks.fetchedAt, clock);
  assert.equal(res.body.sources.incidents.fetchedAt, 0);
  assert.equal(
    res.body.fetchedAt,
    clock,
    'the newest group sets the feed time',
  );
  assert.equal(incidentClassPoints(res).length, incidentFeatures.length);
});

test('one group backing off never holds back the others', async () => {
  let clock = 0;
  let limited = false;
  const service = upstream({
    fail: (request) =>
      limited && request.group === 'incidents'
        ? new Response('slow', {
            status: 429,
            headers: { 'retry-after': '300' },
          })
        : null,
  });
  const request = install({ now: () => clock, fetchImpl: service.fetchImpl });
  await request();
  limited = true;
  clock = SA_ROAD_EVENTS_POLICY.freshMs;
  await request();
  assert.equal(groupCalls(service, 'incidents').length, 2);
  clock = 2 * SA_ROAD_EVENTS_POLICY.freshMs;
  const res = await request();
  assert.equal(
    groupCalls(service, 'incidents').length,
    2,
    'incidents wait out their Retry-After',
  );
  assert.equal(
    groupCalls(service, 'roadworks').length,
    3,
    'roadworks refresh on schedule',
  );
  assert.equal(groupCalls(service, 'closures').length, 3);
  assert.deepEqual(statuses(res), {
    roadworks: 'live',
    incidents: 'stale',
    closures: 'live',
  });
});

test('last good older than the stale limit is withdrawn, group by group', async () => {
  let clock = 0;
  let broken = false;
  const service = upstream({ fail: () => (broken ? down() : null) });
  const request = install({ now: () => clock, fetchImpl: service.fetchImpl });
  await request();
  broken = true;
  clock = SA_ROAD_EVENTS_POLICY.staleLimitMs;
  assert.equal((await request()).status, 200, 'still inside the limit');
  clock = SA_ROAD_EVENTS_POLICY.staleLimitMs + 1;
  const expired = await request();
  assert.equal(expired.status, 502);
  assert.deepEqual(expired.body, { error: 'sa_road_events_unavailable' });
  assert.equal(SA_ROAD_EVENTS_POLICY.staleLimitMs, 6 * 3_600_000);
});

test('an expired incidents/closures cache is withdrawn while fresh roadworks still serve', async () => {
  let clock = 0;
  let geohubDown = false;
  const service = upstream({
    fail: (request) => (geohubDown && onlyGeohub(request) ? down() : null),
  });
  const request = install({ now: () => clock, fetchImpl: service.fetchImpl });
  await request();
  geohubDown = true;
  clock = SA_ROAD_EVENTS_POLICY.staleLimitMs;
  assert.deepEqual(statuses(await request()), {
    roadworks: 'live',
    incidents: 'stale',
    closures: 'stale',
  });
  clock = SA_ROAD_EVENTS_POLICY.staleLimitMs + 1;
  const res = await request();
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.sources.incidents, {
    status: 'unavailable',
    fetchedAt: null,
    mirror: false,
  });
  assert.equal(statuses(res).closures, 'unavailable');
  assert.equal(
    incidentClassPoints(res).length,
    0,
    'nothing old is shown as current',
  );
  assert.deepEqual(res.body.lines, []);
  assert.equal(roadworksPoints(res).length, 3);
  assert.equal(res.body.stale, false);
});

test('a cold failure is a sanitized 502 and backs off', async () => {
  let clock = 0;
  const service = upstream({
    fail: () => new Response('down', { status: 500 }),
  });
  const request = install({ now: () => clock, fetchImpl: service.fetchImpl });
  const first = await request();
  assert.equal(first.status, 502);
  assert.deepEqual(first.body, { error: 'sa_road_events_unavailable' });
  const calls = service.calls.length;
  clock = SA_ROAD_EVENTS_POLICY.retryAfterFailureMs - 1;
  assert.equal((await request()).status, 502);
  assert.equal(service.calls.length, calls, 'backed off');
  clock = SA_ROAD_EVENTS_POLICY.retryAfterFailureMs;
  await request();
  assert.ok(service.calls.length > calls, 'retries after the backoff');
});

test('a 429 is honoured: bounded Retry-After backoff and no mirror shopping', async () => {
  let clock = 0;
  const service = upstream({
    fail: () =>
      new Response('slow down', {
        status: 429,
        headers: { 'retry-after': '300' },
      }),
  });
  const request = install({ now: () => clock, fetchImpl: service.fetchImpl });
  assert.equal((await request()).status, 502);
  assert.equal(
    service.calls.length,
    3,
    'one request per group; the mirror is not tried on a rate limit',
  );
  assert.ok(
    service.calls.every((call) => call.service !== 'TrafficSAOpenData2'),
  );
  clock = 299_999;
  await request();
  assert.equal(service.calls.length, 3, 'waits out Retry-After');
  clock = 300_000;
  await request();
  assert.equal(service.calls.length, 6);

  const huge = upstream({
    fail: () =>
      new Response('', { status: 429, headers: { 'retry-after': '999999' } }),
  });
  clock = 0;
  const bounded = install({ now: () => clock, fetchImpl: huge.fetchImpl });
  await bounded();
  clock = SA_ROAD_EVENTS_POLICY.maxRetryAfterMs;
  await bounded();
  assert.equal(huge.calls.length, 6, 'Retry-After is capped');
});

test('a non-OK upstream body is cancelled and an oversized one is refused', async () => {
  let cancelled = 0;
  const service = upstream({
    fail: (request) =>
      request.service === 'TrafficSAOpenData'
        ? {
            ok: false,
            status: 500,
            headers: new Headers(),
            body: {
              cancel: async () => {
                cancelled++;
              },
            },
          }
        : null,
  });
  const request = install({ now: () => 0, fetchImpl: service.fetchImpl });
  const res = await request();
  assert.equal(res.body.mirror, true, 'the mirror covers the failed primary');
  assert.equal(cancelled, 1);

  const big = upstream({
    roadworks: pointFeatures(200),
    incidents: incidentFeaturesOf(200),
    closures: closureFeatures,
  });
  const small = install({
    now: () => 0,
    policy: { ...SA_ROAD_EVENTS_POLICY, maxPageBytes: 1024 },
    fetchImpl: big.fetchImpl,
  });
  assert.equal((await small()).status, 502);
});

test('methods, routes and per-client rate limits are enforced', async () => {
  const service = upstream();
  const request = install({ now: () => 0, fetchImpl: service.fetchImpl });
  const post = await request('/', 'POST');
  assert.equal(post.status, 405);
  assert.equal(post.headers.Allow, 'GET');
  assert.equal((await request('/other')).status, 404);
  assert.deepEqual((await request('/other')).body, { error: 'unknown_route' });
  assert.equal(
    service.calls.length,
    0,
    'rejected requests never reach the upstream',
  );
  for (let i = 0; i < 30; i++)
    assert.equal((await request('/', 'GET', 'busy')).status, 200);
  const limited = await request('/', 'GET', 'busy');
  assert.equal(limited.status, 429);
  assert.equal(limited.headers['Retry-After'], '60');
  assert.equal((await request('/', 'GET', 'other')).status, 200);
});
