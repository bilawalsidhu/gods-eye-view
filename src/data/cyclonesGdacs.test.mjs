import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  createGdacsCyclones,
  fetchGdacsCyclones,
  gdacsBasin,
  parseGdacsCycloneGeometry,
  parseGdacsCycloneList,
  parseGdacsTimeline,
  parseGdacsTimelineId,
} from '../../server/providers/cyclonesGdacs.js';
import { cycloneProxy } from '../../server/providers/cyclones.js';

// Shaped like GDACS responses, with made-up storms.
const ISSUED = '2026-11-02T06:00:00';
const NOW = Date.UTC(2026, 10, 2, 8, 30);
const EVENT = { eventId: 1001346, episodeId: 6 };
const FIXES = [
  { label: '01/11 18:00 UTC', at: [82.6, 13.6] },
  { label: '02/11 00:00 UTC', at: [81.8, 13.5] },
  { label: '02/11 06:00 UTC', at: [80.9, 14.3] },
  { label: '02/11 18:00 UTC', at: [80.2, 15.3] },
  { label: '03/11 06:00 UTC', at: [79.9, 16] },
];
const CATEGORIES = ['TS', 'HU', 'HU', 'TS'];

function centroid(overrides = {}) {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [80.9, 14.3] },
    properties: {
      eventtype: 'TC',
      eventid: EVENT.eventId,
      episodeid: EVENT.episodeId,
      eventname: 'MURASU-26',
      iscurrent: 'true',
      todate: ISSUED,
      ...overrides,
    },
  };
}
function list(...features) {
  return { type: 'FeatureCollection', features };
}
function circle([lon, lat], radius = 0.1) {
  const ring = Array.from({ length: 16 }, (_, i) => {
    const angle = (i / 16) * 2 * Math.PI;
    let x = lon + radius * Math.cos(angle);
    if (x > 180) x -= 360;
    if (x < -180) x += 360;
    return [x, lat + radius * Math.sin(angle)];
  });
  return [...ring, ring[0]];
}
function properties(Class, extra = {}) {
  return {
    eventtype: 'TC',
    eventid: EVENT.eventId,
    episodeid: EVENT.episodeId,
    Class,
    polygondate: ISSUED,
    ...extra,
  };
}
function geometry({ fixes = FIXES, current = 2, cone = true } = {}) {
  const features = [
    {
      type: 'Feature',
      geometry: centroid().geometry,
      properties: properties('Point_Centroid'),
    },
  ];
  fixes.forEach((fix, i) =>
    features.push({
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [circle(fix.at)] },
      properties: properties(`Point_Polygon_Point_${i}`, {
        polygonlabel: fix.label,
      }),
    }),
  );
  // GDACS lists segments out of order; the parser must chain them.
  const segments = fixes.slice(1).map((fix, i) => ({
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: [fixes[i].at, fix.at] },
    properties: properties(`Line_Line_${i}`, {
      polygonlabel: CATEGORIES[i] ?? 'TS',
      forecast: i >= current,
    }),
  }));
  features.push(...segments.reverse());
  if (cone)
    features.push({
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [80.9, 14],
            [81.5, 16.5],
            [79, 16.5],
            [80.9, 14],
          ],
        ],
      },
      properties: properties('Poly_Cones', {
        polygonlabel: 'Uncertainty Cones',
      }),
    });
  features.push({
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [circle([81, 14], 2)] },
    properties: properties('Poly_Red', { polygonlabel: '120 km/h' }),
  });
  return { type: 'FeatureCollection', features };
}
function details(
  timeline = 'https://www.gdacs.org/gdacsapi/api/export/gettimeline?id=818147',
) {
  return {
    type: 'Feature',
    properties: {
      eventtype: 'TC',
      eventid: EVENT.eventId,
      impacts: [{ source: 'JTWC', resource: { timeline } }],
    },
  };
}
function item(fix, extra = {}) {
  return {
    storm_id: String(EVENT.eventId),
    advisory_number: '6',
    actual: 'False',
    current: 'false',
    longitude: String(fix[0]),
    latitude: String(fix[1]),
    wind_speed: '25.72',
    wind_gusts: '33.436',
    pressure: '0',
    ...extra,
  };
}
function timeline() {
  return {
    channel: {
      item: [
        item([81.8, 13.5], {
          advisory_number: '5',
          actual: 'True',
          wind_speed: '28.292',
        }),
        item([80.9, 14.3], {
          actual: 'True',
          current: 'true',
          wind_speed: '33.436',
          wind_gusts: '41.152',
          pressure: '985',
        }),
        item([80.2, 15.3], { wind_speed: '33.436' }),
        item([79.9, 16]),
      ],
    },
  };
}
const json = (value) => Response.json(value);
function fetcher(calls = [], overrides = {}) {
  return async (url, options) => {
    calls.push({ url: new URL(url), options });
    const path = new URL(url).pathname;
    for (const [part, answer] of Object.entries(overrides))
      if (path.includes(part)) return answer(url, options);
    if (path.endsWith('/SEARCH')) return json(list(centroid()));
    if (path.endsWith('/getgeometry')) return json(geometry());
    if (path.endsWith('/geteventdata')) return json(details());
    if (path.endsWith('/gettimeline')) return json(timeline());
    throw new Error(`unexpected ${url}`);
  };
}
const signal = () => new AbortController().signal;

test('basins: NHC/CPHC water is left to NOAA, the rest is split by JTWC basin', () => {
  assert.equal(gdacsBasin({ longitude: -60, latitude: 15 }), null);
  assert.equal(gdacsBasin({ longitude: -170, latitude: 15 }), null);
  assert.equal(gdacsBasin({ longitude: 80.9, latitude: 14.3 }), 'IO');
  assert.equal(gdacsBasin({ longitude: 130, latitude: 20 }), 'WP');
  assert.equal(gdacsBasin({ longitude: 180, latitude: 20 }), 'WP');
  assert.equal(gdacsBasin({ longitude: -150, latitude: -15 }), 'SH');
  assert.equal(gdacsBasin({ longitude: 60, latitude: -15 }), 'SH');
});

test('event list keeps current storms outside NOAA water and cleans GDACS names', () => {
  const events = parseGdacsCycloneList(
    list(
      centroid(),
      centroid({ eventid: 2, eventname: 'OLD-26', iscurrent: 'false' }),
      {
        ...centroid({ eventid: 3, eventname: 'ATLANTIC-26' }),
        geometry: { type: 'Point', coordinates: [-60, 20] },
      },
      {
        ...centroid({ eventid: 4, eventname: 'TWENTY-ONE-26' }),
        geometry: { type: 'Point', coordinates: [150, -15] },
      },
    ),
  );
  assert.deepEqual(
    events.map(({ eventId, name, basin }) => ({ eventId, name, basin })),
    [
      { eventId: EVENT.eventId, name: 'Murasu', basin: 'IO' },
      { eventId: 4, name: 'Twenty-One', basin: 'SH' },
    ],
  );
  assert.equal(events[0].issuedAt, Date.parse(`${ISSUED}Z`));
  for (const bad of [
    list(centroid(), centroid()),
    list(centroid({ eventtype: 'EQ' })),
    list(centroid({ eventname: '<script>' })),
    list(centroid({ todate: '2026-11-02T06:00:00Z' })),
    list(centroid({ eventid: 1.5 })),
    { type: 'FeatureCollection', features: Array(201).fill(centroid()) },
  ])
    assert.throws(() => parseGdacsCycloneList(bad), /invalid_gdacs/);
});

test('geometry chains out-of-order segments into a forecast track with lead hours and a cone', () => {
  const result = parseGdacsCycloneGeometry(geometry(), EVENT);
  assert.equal(result.issuedAt, Date.parse(`${ISSUED}Z`));
  assert.deepEqual(result.position, { longitude: 80.9, latitude: 14.3 });
  assert.equal(result.classification, 'HU');
  assert.deepEqual(
    result.forecastPoints.map((point) => point.tauHours),
    [0, 12, 24],
  );
  assert.deepEqual(result.track.coordinates, [
    [80.9, 14.3],
    [80.2, 15.3],
    [79.9, 16],
  ]);
  assert.equal(result.cone.type, 'Polygon');
  const coneless = parseGdacsCycloneGeometry(geometry({ cone: false }), EVENT);
  assert.equal(coneless.cone, null);
  assert.ok(coneless.track);
});

test('geometry dates labels across the new year and centres markers across the antimeridian', () => {
  const issued = '2027-01-01T00:00:00';
  const fixes = [
    { label: '31/12 12:00 UTC', at: [179.9, 15] },
    { label: '01/01 00:00 UTC', at: [-179.8, 15.5] },
    { label: '01/01 12:00 UTC', at: [-179.5, 16] },
  ];
  const payload = geometry({ fixes, current: 1, cone: false });
  for (const feature of payload.features)
    if (feature.properties.polygondate) feature.properties.polygondate = issued;
  const result = parseGdacsCycloneGeometry(payload, EVENT);
  assert.equal(result.issuedAt, Date.parse(`${issued}Z`));
  assert.deepEqual(
    result.forecastPoints.map((point) => point.tauHours),
    [0, 12],
  );
});

test('geometry from another episode, a broken chain or mislabelled forecasts is rejected whole', () => {
  const changes = [
    (payload) => {
      payload.features[3].properties.episodeid = 5;
    },
    (payload) => {
      payload.features.find(
        (f) => f.properties.Class === 'Line_Line_1',
      ).properties.polygondate = '2026-11-02T00:00:00';
    },
    (payload) => {
      payload.features.find(
        (f) => f.properties.Class === 'Line_Line_0',
      ).properties.forecast = true;
    },
    (payload) => {
      payload.features.find(
        (f) => f.properties.Class === 'Line_Line_1',
      ).geometry.coordinates[1] = [70, 10];
    },
    (payload) => {
      payload.features.find(
        (f) => f.properties.Class === 'Point_Polygon_Point_3',
      ).geometry.coordinates = [circle([75, 15])];
    },
    (payload) => {
      payload.features.find(
        (f) => f.properties.Class === 'Point_Polygon_Point_3',
      ).properties.polygonlabel = '31/02 06:00 UTC';
    },
    (payload) => {
      payload.features
        .find((f) => f.properties.Class === 'Poly_Cones')
        .geometry.coordinates[0].pop();
    },
    (payload) => {
      payload.features.push(
        payload.features.find((f) => f.properties.Class === 'Poly_Cones'),
      );
    },
  ];
  for (const change of changes) {
    const payload = geometry();
    change(payload);
    assert.throws(
      () => parseGdacsCycloneGeometry(payload, EVENT),
      /invalid_gdacs/,
    );
  }
});

test('timeline winds come only from the latest advisory and must match the current position', () => {
  const winds = parseGdacsTimeline(timeline(), {
    eventId: EVENT.eventId,
    position: { longitude: 80.9, latitude: 14.3 },
  });
  assert.deepEqual(winds.get('80.9,14.3'), {
    windKt: 65,
    gustKt: 80,
    pressureHpa: 985,
  });
  assert.equal(winds.get('80.2,15.3').pressureHpa, null);
  assert.equal(winds.has('81.8,13.5'), false, 'past fixes are not forecasts');
  assert.throws(
    () =>
      parseGdacsTimeline(timeline(), {
        eventId: EVENT.eventId,
        position: { longitude: 80.2, latitude: 15.3 },
      }),
    /invalid_gdacs/,
  );
  assert.throws(
    () =>
      parseGdacsTimeline(timeline(), {
        eventId: 7,
        position: { longitude: 80.9, latitude: 14.3 },
      }),
    /invalid_gdacs/,
  );
  assert.equal(parseGdacsTimelineId(details(), EVENT.eventId), '818147');
  assert.equal(
    parseGdacsTimelineId(
      details('https://evil.example/gettimeline?id=1'),
      EVENT.eventId,
    ),
    null,
  );
});

test('fetch builds one storm record from fixed GDACS endpoints', async () => {
  const calls = [];
  const storms = await fetchGdacsCyclones({
    fetchImpl: fetcher(calls),
    now: NOW,
    signal: signal(),
  });
  assert.equal(storms.length, 1);
  const [storm] = storms;
  assert.equal(storm.id, 'gdacs-1001346');
  assert.equal(storm.provider, 'gdacs');
  assert.equal(storm.name, 'Murasu');
  assert.equal(storm.classification, 'CY');
  assert.equal(storm.basin, 'IO');
  assert.equal(storm.windKt, 65);
  assert.equal(storm.pressureHpa, 985);
  assert.equal(storm.issuedAt, `${ISSUED}.000Z`);
  assert.equal(storm.geometryStatus, 'current');
  assert.equal(storm.geometryAdvisoryNumber, storm.advisoryNumber);
  assert.equal(storm.windsPending, false);
  assert.deepEqual(
    storm.forecastPoints.map((point) => [point.tauHours, point.windKt]),
    [
      [0, 65],
      [12, 65],
      [24, 50],
    ],
  );
  assert.equal(
    storm.advisoryUrl,
    'https://www.gdacs.org/report.aspx?eventid=1001346&episodeid=6&eventtype=TC',
  );
  assert.equal(calls.length, 4);
  for (const call of calls) {
    assert.equal(call.url.origin, 'https://www.gdacs.org');
    assert.equal(call.options.redirect, 'error');
  }
  assert.equal(calls[0].url.searchParams.get('eventlist'), 'TC');
  assert.equal(calls[0].url.searchParams.get('fromDate'), '2026-10-26');
});

test('no events, broken geometry, broken timeline and expired episodes degrade honestly', async () => {
  const none = await fetchGdacsCyclones({
    fetchImpl: fetcher([], {
      SEARCH: () =>
        new Response('{"status":404}', {
          status: 404,
          headers: { 'content-type': 'application/problem+json' },
        }),
    }),
    now: NOW,
    signal: signal(),
  });
  assert.deepEqual(none, []);
  await assert.rejects(
    fetchGdacsCyclones({
      fetchImpl: fetcher([], {
        SEARCH: () => new Response('down', { status: 404 }),
      }),
      now: NOW,
      signal: signal(),
    }),
  );
  const [centroidOnly] = await fetchGdacsCyclones({
    fetchImpl: fetcher([], {
      getgeometry: () => new Response('secret', { status: 503 }),
    }),
    now: NOW,
    signal: signal(),
  });
  assert.equal(centroidOnly.geometryStatus, 'unavailable');
  assert.equal(centroidOnly.track, null);
  assert.equal(centroidOnly.classification, 'TC');
  assert.deepEqual(centroidOnly.position, { longitude: 80.9, latitude: 14.3 });
  const [windless] = await fetchGdacsCyclones({
    fetchImpl: fetcher([], {
      gettimeline: () => new Response('', { status: 500 }),
    }),
    now: NOW,
    signal: signal(),
  });
  assert.equal(windless.geometryStatus, 'current');
  assert.equal(windless.windKt, null);
  assert.equal(
    windless.windsPending,
    false,
    'a failed timeline is not pending',
  );
  assert.equal(
    windless.classification,
    'CY',
    'the track category still names it',
  );
  const expired = await fetchGdacsCyclones({
    fetchImpl: fetcher(),
    now: NOW + 13 * 3600_000,
    signal: signal(),
  });
  assert.deepEqual(expired, []);
});

test('a newer episode in the list keeps geometry pending rather than relabelling', async () => {
  const [storm] = await fetchGdacsCyclones({
    fetchImpl: fetcher([], {
      SEARCH: () => json(list(centroid({ todate: '2026-11-02T12:00:00' }))),
    }),
    now: Date.UTC(2026, 10, 2, 12, 30),
    signal: signal(),
  });
  assert.equal(storm.geometryStatus, 'pending');
  assert.equal(storm.track, null);
  assert.deepEqual(storm.forecastPoints, []);
});

test('GDACS has its own deadline, and the caller can still cancel it', async () => {
  const stalled = (url, options) =>
    new Promise((_, reject) =>
      options.signal.addEventListener(
        'abort',
        () => reject(new Error('aborted')),
        {
          once: true,
        },
      ),
    );
  await assert.rejects(
    fetchGdacsCyclones({
      fetchImpl: fetcher([], { SEARCH: stalled }),
      now: NOW,
      signal: signal(),
      timeoutMs: 10,
    }),
  );
  const [slowTimeline] = await fetchGdacsCyclones({
    fetchImpl: fetcher([], { gettimeline: stalled }),
    now: NOW,
    signal: signal(),
    timeoutMs: 30,
  });
  assert.equal(slowTimeline.geometryStatus, 'current');
  assert.equal(slowTimeline.windKt, null);
  assert.equal(slowTimeline.windsPending, true);
  const outer = new AbortController();
  const pending = fetchGdacsCyclones({
    fetchImpl: fetcher([], { getgeometry: stalled }),
    now: NOW,
    signal: outer.signal,
  });
  setImmediate(() => outer.abort());
  await assert.rejects(pending);
});

function install(options) {
  let handler;
  cycloneProxy({ now: () => NOW, ...options }).configureServer({
    middlewares: {
      use(_path, callback) {
        handler = callback;
      },
    },
  });
  return async () => {
    const res = new EventEmitter();
    res.writeHead = () => {};
    res.end = (text) => {
      res.body = JSON.parse(text);
    };
    await handler({ url: '/', method: 'GET' }, res);
    return res.body;
  };
}
const noaa = async (url) =>
  Response.json(url.includes('CurrentStorms') ? { activeStorms: [] } : {});

test('the proxy merges providers and reports one provider outage without hiding the other', async () => {
  const storms = await fetchGdacsCyclones({
    fetchImpl: fetcher(),
    now: NOW,
    signal: signal(),
  });
  const merged = await install({
    fetchImpl: noaa,
    fetchGdacs: async () => storms,
  })();
  assert.equal(merged.unavailable, false);
  assert.equal(merged.reason, null);
  assert.deepEqual(merged.providers, { nhc: 'available', gdacs: 'available' });
  assert.deepEqual(
    merged.storms.map((storm) => storm.id),
    ['gdacs-1001346'],
  );
  assert.match(merged.attribution, /GDACS .*CC BY 4\.0/);
  const outage = await install({
    fetchImpl: noaa,
    fetchGdacs: async () => {
      throw new Error('private');
    },
  })();
  assert.equal(outage.unavailable, false);
  assert.equal(outage.stale, false);
  assert.deepEqual(outage.providers, {
    nhc: 'available',
    gdacs: 'unavailable',
  });
  assert.equal(outage.reason, 'Some cyclone sources unavailable');
  assert.doesNotMatch(JSON.stringify(outage), /private/);
});

test('a provider outage serves that provider from its last good copy, dated by its fetch', async () => {
  let clock = NOW;
  let fail = false;
  const storms = await fetchGdacsCyclones({
    fetchImpl: fetcher(),
    now: NOW,
    signal: signal(),
  });
  let handler;
  cycloneProxy({
    now: () => clock,
    fetchImpl: noaa,
    fetchGdacs: async () => {
      if (fail) throw new Error('private');
      return storms;
    },
  }).configureServer({
    middlewares: {
      use(_path, callback) {
        handler = callback;
      },
    },
  });
  const request = async () => {
    const res = new EventEmitter();
    res.writeHead = () => {};
    res.end = (text) => {
      res.body = JSON.parse(text);
    };
    await handler({ url: '/', method: 'GET' }, res);
    return res.body;
  };
  await request();
  fail = true;
  clock += 301_000;
  const stale = await request();
  assert.equal(stale.stale, true);
  assert.equal(stale.fetchedAt, NOW);
  assert.deepEqual(stale.providers, { nhc: 'available', gdacs: 'stale' });
  assert.deepEqual(
    stale.storms.map((storm) => storm.id),
    ['gdacs-1001346'],
  );
});

test('an episode downloads once; a slow one finishes for the next refresh', async () => {
  const calls = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const base = fetcher(calls);
  const source = createGdacsCyclones({
    fetchImpl: async (url, options) => {
      if (url.includes('getgeometry')) await gate;
      return base(url, options);
    },
  });
  const [first] = await source({ now: NOW, signal: signal(), timeoutMs: 20 });
  assert.equal(first.geometryStatus, 'pending');
  assert.deepEqual(first.position, { longitude: 80.9, latitude: 14.3 });
  release();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const [second] = await source({ now: NOW, signal: signal() });
  assert.equal(second.geometryStatus, 'current');
  assert.equal(second.windKt, 65);
  await source({ now: NOW, signal: signal() });
  const count = (part) =>
    calls.filter((call) => call.url.pathname.endsWith(part)).length;
  assert.equal(count('/SEARCH'), 3);
  assert.equal(count('/getgeometry'), 1);
  assert.equal(count('/geteventdata'), 1);
  assert.equal(count('/gettimeline'), 1);
});

test('a failed episode download is tried again on the next refresh', async () => {
  let failures = 1;
  const base = fetcher();
  const source = createGdacsCyclones({
    fetchImpl: async (url, options) =>
      url.includes('getgeometry') && failures-- > 0
        ? new Response('down', { status: 503 })
        : base(url, options),
  });
  const [first] = await source({ now: NOW, signal: signal() });
  assert.equal(first.geometryStatus, 'unavailable');
  await new Promise((resolve) => setImmediate(resolve));
  const [second] = await source({ now: NOW, signal: signal() });
  assert.equal(second.geometryStatus, 'current');
});

test('the proxy asks again after a minute while a GDACS episode is pending', async () => {
  let clock = NOW;
  let refreshes = 0;
  let status = 'pending';
  const [storm] = await fetchGdacsCyclones({
    fetchImpl: fetcher(),
    now: NOW,
    signal: signal(),
  });
  let handler;
  cycloneProxy({
    now: () => clock,
    fetchImpl: noaa,
    fetchGdacs: async () => {
      refreshes++;
      return [{ ...storm, geometryStatus: status }];
    },
  }).configureServer({
    middlewares: {
      use(_path, callback) {
        handler = callback;
      },
    },
  });
  const request = async () => {
    const res = new EventEmitter();
    res.writeHead = () => {};
    res.end = (text) => {
      res.body = JSON.parse(text);
    };
    await handler({ url: '/', method: 'GET' }, res);
    return res.body;
  };
  await request();
  clock += 59_000;
  await request();
  assert.equal(refreshes, 1);
  status = 'current';
  clock += 2_000;
  assert.equal((await request()).storms[0].geometryStatus, 'current');
  assert.equal(refreshes, 2);
  clock += 120_000;
  await request();
  assert.equal(refreshes, 2, 'a current snapshot keeps five minutes');
});
