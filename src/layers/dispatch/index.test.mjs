import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dispatchCategory,
  epochToSeattleLocal,
  normalizeDispatchSnapshot,
  normalizeEverettPoliceSnapshot,
  normalizeReportingAreas,
  normalizeSheriffReports,
  reportingAreaCode,
  seattleLocalToEpoch,
} from './records.js';
import {
  createEmergencyServicesSource,
  everettPoliceUrl,
  seattleFireDispatchUrl,
  sheriffAreasUrl,
  sheriffReportsUrl,
} from './source.js';
import {
  callAlpha,
  createDispatchLayer,
  DISPATCH_OVERLAY_SOURCE_ID,
  formatCallAge,
  formatWindow,
  summarizeAgencies,
  summarizeCategories,
} from './index.js';

const ROW = Object.freeze({
  address: '9001 Lake City Way Ne',
  type: 'Aid Response',
  datetime: '2026-10-12T14:13:00.000',
  latitude: '47.693931',
  longitude: '-122.30552',
  incident_number: 'F260146074',
});

test('Seattle wall times convert across daylight and standard time', () => {
  // PDT (UTC-7) in October, PST (UTC-8) in January.
  assert.equal(
    seattleLocalToEpoch('2026-10-12T14:13:00.000'),
    Date.UTC(2026, 9, 12, 21, 13),
  );
  assert.equal(
    seattleLocalToEpoch('2026-01-05T08:00:00'),
    Date.UTC(2026, 0, 5, 16, 0),
  );
  assert.equal(seattleLocalToEpoch('yesterday'), null);
  assert.equal(
    epochToSeattleLocal(Date.UTC(2026, 9, 12, 21, 13)),
    '2026-10-12T14:13:00',
  );
});

test('call types map to categories, with alarms before fires', () => {
  assert.equal(dispatchCategory('Aid Response').id, 'medical');
  assert.equal(dispatchCategory('Medic Response- Overdose').id, 'medical');
  assert.equal(dispatchCategory('Auto Fire Alarm').id, 'alarm');
  assert.equal(dispatchCategory('Car Fire').id, 'fire');
  assert.equal(dispatchCategory('MVI - Motor Vehicle Incident').id, 'vehicle');
  assert.equal(dispatchCategory('Rescue Elevator').id, 'rescue');
  assert.equal(dispatchCategory('Natural Gas Odor').id, 'hazard');
  assert.equal(dispatchCategory('Investigate Out Of Service').id, 'other');
});

test('the normalizer drops invalid, duplicate and test calls', () => {
  assert.equal(normalizeDispatchSnapshot({ error: true }), null);
  const calls = normalizeDispatchSnapshot([
    ROW,
    { ...ROW },
    { ...ROW, incident_number: 'F2', latitude: '' },
    { ...ROW, incident_number: 'F3', datetime: 'soon' },
    { ...ROW, incident_number: 'F4', type: 'TEST - MIS TEST' },
    { ...ROW, incident_number: 'F5', longitude: 'east' },
    null,
    { ...ROW, incident_number: 'F6', type: 'Brush Fire' },
  ]);
  assert.deepEqual(
    calls.map((call) => [call.id, call.category]),
    [
      ['sfd:F260146074', 'medical'],
      ['sfd:F6', 'fire'],
    ],
  );
  assert.equal(calls[0].lat, 47.693931);
  assert.equal(calls[0].time, Date.UTC(2026, 9, 12, 21, 13));
});

const EVERETT_ROW = Object.freeze({
  eventnumber: 'EP26-0101',
  incidenttype: 'MALICIOUS MISCHIEF/VANDALISM',
  datetimereceived: '2026-10-12T00:00:36',
  eventaddressby100block: '6XX W CASINO RD C, EVERETT, WA, 98204',
  geomcoordinate: { type: 'Point', coordinates: [-122.244785, 47.916398] },
});

const SHERIFF_ROW = Object.freeze({
  case_number: 'C26-1',
  nibrs_code_name: 'Destruction/Damage/Vandalism of Property',
  incident_datetime: '2026-10-11T19:24:00',
  block_address: '26400 Block 180TH AVE SE',
  city: 'KENT',
  reporting_area: 'Reporting Area H03024',
});

const AREAS = normalizeReportingAreas([
  { area: 'H03024', x_coord: '-122.1', y_coord: '47.36' },
  { area: 'BAD', x_coord: '', y_coord: '47' },
]);

test('Everett police calls validate positions and drop future-stamped rows', () => {
  const now = Date.UTC(2026, 9, 12, 22, 0);
  assert.equal(normalizeEverettPoliceSnapshot({}), null);
  const calls = normalizeEverettPoliceSnapshot(
    [
      EVERETT_ROW,
      { ...EVERETT_ROW },
      {
        ...EVERETT_ROW,
        eventnumber: 'EP2',
        datetimereceived: '2026-12-20T10:16:00',
      },
      { ...EVERETT_ROW, eventnumber: 'EP3', geomcoordinate: null },
    ],
    { now },
  );
  assert.deepEqual(
    calls.map((call) => [call.id, call.category, call.agency]),
    [['epd:EP26-0101', 'police', 'epd']],
  );
  assert.equal(calls[0].lat, 47.916398);
  assert.equal(calls[0].address, '6XX W CASINO RD C, EVERETT, WA, 98204');
});

test('sheriff reports sit at their reporting area, one entry per case', () => {
  const now = Date.UTC(2026, 9, 12, 22, 0);
  assert.equal(reportingAreaCode('Reporting Area H03024'), 'H03024');
  assert.equal(AREAS.size, 1);
  const calls = normalizeSheriffReports(
    [
      SHERIFF_ROW,
      { ...SHERIFF_ROW, nibrs_code_name: 'Simple Assault' },
      { ...SHERIFF_ROW, case_number: 'C26-2' },
      {
        ...SHERIFF_ROW,
        case_number: 'C26-3',
        reporting_area: 'Reporting Area Z99999',
      },
    ],
    AREAS,
    { now },
  );
  assert.deepEqual(
    calls.map((call) => [call.id, call.type]),
    [
      ['kcso:C26-1', 'Destruction/Damage/Vandalism of Property (+1)'],
      ['kcso:C26-2', 'Destruction/Damage/Vandalism of Property'],
    ],
  );
  assert.equal(calls[0].approximate, true);
  assert.equal(calls[0].lat, 47.36);
  assert.equal(calls[0].address, '26400 Block 180TH AVE SE, KENT');
  const metres = Math.hypot(
    (calls[1].lat - calls[0].lat) * 111_320,
    (calls[1].lon - calls[0].lon) * 111_320 * Math.cos((47.36 * Math.PI) / 180),
  );
  assert.ok(
    metres > 30 && metres < 60,
    'cases sharing an area are spread apart',
  );
  assert.equal(normalizeSheriffReports([SHERIFF_ROW], null), null);
});

test('feed queries ask Socrata for each window', () => {
  const now = Date.UTC(2026, 9, 12, 21, 0);
  const fire = new URL(seattleFireDispatchUrl(now - 6 * 3_600_000));
  assert.equal(fire.host, 'data.seattle.gov');
  assert.equal(
    fire.searchParams.get('$where'),
    "datetime > '2026-10-12T08:00:00'",
  );
  assert.equal(fire.searchParams.get('$order'), 'datetime DESC');
  const everett = new URL(everettPoliceUrl(now - 48 * 3_600_000));
  assert.equal(everett.host, 'data.everettwa.gov');
  assert.equal(
    everett.searchParams.get('$where'),
    "datetimereceived > '2026-10-10T14:00:00'",
  );
  const sheriff = new URL(sheriffReportsUrl(now - 72 * 3_600_000));
  assert.equal(sheriff.host, 'data.kingcounty.gov');
  assert.equal(sheriff.searchParams.get('$limit'), '2000');
  assert.equal(
    new URL(sheriffAreasUrl()).searchParams.get('$select'),
    'area,x_coord,y_coord',
  );
});

function routedFetch(routes, requests) {
  return async (href) => {
    requests.push(href);
    const url = new URL(href);
    const route = routes[url.host + url.pathname];
    if (!route) throw new Error(`unexpected ${href}`);
    return route();
  };
}

const ok = (rows) => ({ ok: true, text: async () => JSON.stringify(rows) });

test('the source merges feeds, refreshes each on its own interval and keeps the last good calls', async () => {
  let now = Date.UTC(2026, 9, 12, 21, 30);
  let everettDown = false;
  const requests = [];
  const routes = {
    'data.seattle.gov/resource/kzjm-xkqj.json': () => ok([ROW]),
    'data.everettwa.gov/resource/f6vp-3svh.json': () =>
      everettDown ? { ok: false, status: 503 } : ok([EVERETT_ROW]),
    'data.kingcounty.gov/resource/wab8-9yes.json': () =>
      ok([{ area: 'H03024', x_coord: '-122.1', y_coord: '47.36' }]),
    'data.kingcounty.gov/resource/4kmt-kfqf.json': () => ok([SHERIFF_ROW]),
  };
  const source = createEmergencyServicesSource({
    now: () => now,
    fetchImpl: routedFetch(routes, requests),
  });
  const first = await source.getSnapshot();
  assert.deepEqual(first.calls.map((call) => call.agency).sort(), [
    'epd',
    'kcso',
    'sfd',
  ]);
  assert.deepEqual(first.failures, []);
  assert.equal(first.windows.epd, 48 * 3_600_000);
  assert.equal(requests.length, 4);

  // Two minutes on, only Seattle Fire is due.
  now += 2 * 60_000;
  requests.length = 0;
  await source.getSnapshot();
  assert.deepEqual(
    requests.map((href) => new URL(href).host),
    ['data.seattle.gov'],
  );

  // Everett fails at its next refresh; its last calls stay, and the failure is named.
  now += 15 * 60_000;
  everettDown = true;
  const partial = await source.getSnapshot();
  assert.deepEqual(
    partial.failures.map((failure) => failure.name),
    ['Everett Police'],
  );
  assert.ok(partial.calls.some((call) => call.agency === 'epd'));
  assert.equal(
    requests.filter((href) => href.includes('wab8-9yes')).length,
    0,
    'reporting areas are fetched once',
  );

  const down = createEmergencyServicesSource({
    fetchImpl: async () => ({ ok: false, status: 503 }),
  });
  await assert.rejects(down.getSnapshot(), /HTTP 503/);
  const malformed = createEmergencyServicesSource({
    fetchImpl: async () => ({ ok: true, text: async () => '{"code":"x"}' }),
  });
  await assert.rejects(malformed.getSnapshot(), /Malformed/);
});

test('presentation helpers format age, fade and legend counts', () => {
  assert.equal(formatCallAge(20_000), 'just now');
  assert.equal(formatCallAge(12 * 60_000), '12 min ago');
  assert.equal(formatCallAge(185 * 60_000), '3 h 5 min ago');
  assert.equal(formatCallAge(50 * 60 * 60_000), '2 d 2 h ago');
  assert.equal(formatWindow(6 * 3_600_000), '6 h');
  assert.equal(formatWindow(72 * 3_600_000), '3 d');
  assert.deepEqual(
    summarizeAgencies(
      [{ agency: 'kcso' }, { agency: 'sfd' }, { agency: 'kcso' }],
      {
        kcso: 72 * 3_600_000,
      },
    ).map(({ name, count, windowMs }) => [name, count, windowMs]),
    [
      ['Seattle Fire', 1, 6 * 3_600_000],
      ['King County Sheriff', 2, 72 * 3_600_000],
    ],
  );
  assert.equal(callAlpha(0), 1);
  assert.ok(Math.abs(callAlpha(6 * 3_600_000) - 0.4) < 1e-9);
  assert.deepEqual(
    summarizeCategories([
      { category: 'medical' },
      { category: 'fire' },
      { category: 'medical' },
    ]).map(({ id, count }) => [id, count]),
    [
      ['fire', 1],
      ['medical', 2],
    ],
  );
});

function fakeCesium() {
  class PointPrimitiveCollection {
    constructor() {
      this.items = new Set();
      this.show = true;
    }
    add(options) {
      const point = { ...options };
      this.items.add(point);
      return point;
    }
    remove(point) {
      return this.items.delete(point);
    }
  }
  const color = (css) => ({ css, withAlpha: (alpha) => ({ css, alpha }) });
  return {
    PointPrimitiveCollection,
    NearFarScalar: class {},
    Cartographic: { fromDegrees: (lon, lat) => ({ lon, lat }) },
    Cartesian3: {
      fromDegrees: (lon, lat) => ({ x: lon * 111_000, y: lat * 111_000, z: 0 }),
      distance: (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z),
    },
    Color: {
      fromCssColorString: color,
      YELLOW: color('yellow'),
      BLACK: color('black'),
    },
  };
}

function fakeViewer() {
  const primitives = new Set();
  return {
    primitives,
    scene: {
      primitives: {
        add: (p) => primitives.add(p),
        remove: (p) => primitives.delete(p),
      },
    },
    camera: {
      positionWC: { x: -122.3 * 111_000, y: 47.69 * 111_000, z: 3000 },
      moveEnd: { addEventListener: () => () => {} },
    },
  };
}

function fakeTimers() {
  const pending = new Map();
  let next = 1;
  return {
    pending,
    setTimer(fn, ms) {
      const id = next++;
      pending.set(id, { fn, ms });
      return id;
    },
    clearTimer(id) {
      pending.delete(id);
    },
  };
}

test('the layer draws calls, refreshes on its own timer and stops when disabled', async () => {
  const now = Date.UTC(2026, 9, 12, 21, 30);
  const snapshots = [
    normalizeDispatchSnapshot([ROW]),
    normalizeDispatchSnapshot([
      ROW,
      { ...ROW, incident_number: 'F7', type: 'Car Fire' },
    ]),
  ];
  let requests = 0;
  const source = {
    getSnapshot: async () => snapshots[Math.min(requests++, 1)],
  };
  const overlay = {
    entries: [],
    setEntries(id, entries) {
      assert.equal(id, DISPATCH_OVERLAY_SOURCE_ID);
      this.entries = entries;
    },
    clearSource() {
      this.entries = [];
    },
    setVisible() {},
  };
  const timers = fakeTimers();
  const layer = createDispatchLayer({
    source,
    overlayHost: overlay,
    cesium: fakeCesium(),
    now: () => now,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  const viewer = fakeViewer();
  layer.init(viewer);
  layer.enable(viewer);
  const [first] = timers.pending.values();
  assert.equal(first.ms, 0, 'enable schedules the first fetch itself');
  timers.pending.clear();
  assert.equal(await first.fn(), undefined);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(layer.getStats().count, 1);
  assert.equal(layer.getStats().countLabel, '1 call');
  assert.equal(overlay.entries[0].title, 'Aid Response');
  assert.equal(timers.pending.size, 1, 'next refresh is scheduled');

  const [{ fn }] = timers.pending.values();
  timers.pending.clear();
  await fn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(layer.getStats().count, 2);
  const controls = layer.getRowControls();
  assert.deepEqual(
    controls.legend.map(({ label, count }) => [label, count]),
    [
      ['Fire', 1],
      ['Medical', 1],
    ],
  );
  assert.equal(controls.info, 'Seattle Fire · 2 calls in the last 6 h');

  layer.disable(viewer);
  assert.equal(timers.pending.size, 0, 'disable cancels the refresh');
  assert.equal(layer.getStats().count, 0);
  assert.equal(layer.getRowControls(), null);
  layer.destroy(viewer);
  assert.equal(viewer.primitives.size, 0);
});

test('a failed refresh keeps the last good calls and reports the error', async () => {
  let fail = false;
  const source = {
    getSnapshot: async () => {
      if (fail) throw new Error('offline');
      return normalizeDispatchSnapshot([ROW]);
    },
  };
  const timers = fakeTimers();
  const layer = createDispatchLayer({
    source,
    cesium: fakeCesium(),
    now: () => Date.UTC(2026, 9, 12, 21, 30),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  const viewer = fakeViewer();
  layer.init(viewer);
  layer.enable(viewer);
  await layer.update();
  fail = true;
  assert.equal(await layer.update(), false);
  assert.equal(layer.getStats().count, 1);
  assert.equal(layer.getStats().error, 'offline');
  assert.equal(timers.pending.size, 1, 'keeps polling after a failure');
  layer.destroy(viewer);
});

test('partial feed failures keep other calls and name the failed feed', async () => {
  const timers = fakeTimers();
  const layer = createDispatchLayer({
    source: {
      getSnapshot: async () => ({
        calls: normalizeDispatchSnapshot([ROW]),
        failures: [
          { agency: 'epd', name: 'Everett Police', message: 'HTTP 503' },
        ],
        windows: { sfd: 6 * 3_600_000 },
      }),
    },
    cesium: fakeCesium(),
    now: () => Date.UTC(2026, 9, 12, 21, 30),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  const viewer = fakeViewer();
  layer.init(viewer);
  layer.enable(viewer);
  await layer.update();
  assert.equal(layer.getStats().count, 1);
  assert.equal(layer.getStats().error, 'Everett Police unavailable');
  layer.destroy(viewer);
});
