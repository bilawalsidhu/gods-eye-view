import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ALERTS_MAX_HEADER_CHARS,
  activeAlertsByRoute,
  alertCardLines,
  alertKind,
  boundedText,
  decodePolyline,
  hasDisruption,
  isAlertActive,
  isDisruption,
  networkRouteDisplayName,
  normalizeGtfsRtAlertsJson,
  normalizeMbtaRoutePatterns,
  validNetworkId,
} from './transitNetwork.js';
import { getTransitFeed, publicTransitCatalog } from './transitFeeds.js';

/** Google's documented example: (38.5,-120.2) (40.7,-120.95) (43.252,-126.453). */
const GOOGLE_EXAMPLE = '_p~iF~ps|U_ulLnnqC_mqNvxq`@';

test('decodePolyline reads the reference example exactly', () => {
  assert.deepEqual(decodePolyline(GOOGLE_EXAMPLE), [
    [38.5, -120.2],
    [40.7, -120.95],
    [43.252, -126.453],
  ]);
});

test('decodePolyline refuses malformed input instead of drawing part of it', () => {
  assert.equal(decodePolyline(''), null);
  assert.equal(decodePolyline(null), null);
  // A character outside the encoding alphabet.
  assert.equal(decodePolyline('_p~iF ~ps|U'), null);
  // Truncated mid-number: the last group still has its continuation bit set.
  assert.equal(decodePolyline(GOOGLE_EXAMPLE.slice(0, -1)), null);
  // One point is not a line.
  assert.equal(decodePolyline('_p~iF~ps|U'), null);
  // A run of continuation characters longer than any real coordinate.
  assert.equal(decodePolyline('~~~~~~~~~~~~~~?'), null);
  // A point limit is a refusal, not a truncation.
  assert.equal(decodePolyline(GOOGLE_EXAMPLE, 2), null);
});

test('decodePolyline rejects coordinates off the globe', () => {
  // Encode latitude +95 as a single delta: 9_500_000 → zigzag 19_000_000.
  const encodeValue = (value) => {
    let v = value < 0 ? ~(value << 1) : value << 1;
    let out = '';
    while (v >= 0x20) {
      out += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
      v >>= 5;
    }
    return out + String.fromCharCode(v + 63);
  };
  const line =
    encodeValue(9_500_000) + encodeValue(0) + encodeValue(0) + encodeValue(0);
  assert.equal(decodePolyline(line), null);
  const ok =
    encodeValue(4_236_000) +
    encodeValue(-7_105_000) +
    encodeValue(100) +
    encodeValue(100);
  assert.deepEqual(decodePolyline(ok), [
    [42.36, -71.05],
    [42.361, -71.049],
  ]);
});

test('boundedText strips control characters and shortens at a word', () => {
  assert.equal(
    boundedText('Red Line:\r\nshuttle\u0007buses', 100),
    'Red Line: shuttle buses',
  );
  assert.equal(boundedText('   ', 10), null);
  assert.equal(boundedText(42, 10), null);
  const long = 'word '.repeat(200);
  const cut = boundedText(long, 50);
  assert.ok(cut.length <= 50, cut);
  assert.ok(cut.endsWith('…'));
  assert.ok(!cut.includes('  '));
});

test('validNetworkId accepts real GTFS ids and refuses odd ones', () => {
  for (const id of [
    'Red',
    'Green-B',
    'CR-Fitchburg',
    'Boat-F4',
    '70',
    'place-rbmnl',
    'canonical-Red-C1-0',
  ]) {
    assert.equal(validNetworkId(id), id);
  }
  for (const id of ['', ' Red', '<script>', 'a'.repeat(129), 'x\ny', null, 7]) {
    assert.equal(validNetworkId(id), null, String(id));
  }
});

/** A minimal JSON:API route-pattern catalog. */
function catalog({ patterns, routes, shapes }) {
  const trips = patterns.map((p) => ({
    type: 'trip',
    id: `trip-${p.id}`,
    relationships: { shape: { data: { type: 'shape', id: p.shape } } },
  }));
  return {
    data: patterns.map((p) => ({
      type: 'route_pattern',
      id: p.id,
      attributes: {
        typicality: p.typicality ?? 1,
        direction_id: p.direction ?? 0,
        sort_order: p.sort ?? 0,
      },
      relationships: {
        route: { data: { type: 'route', id: p.route } },
        representative_trip: { data: { type: 'trip', id: `trip-${p.id}` } },
      },
    })),
    included: [
      ...routes.map((r) => ({ type: 'route', id: r.id, attributes: r })),
      ...trips,
      ...Object.entries(shapes).map(([id, polyline]) => ({
        type: 'shape',
        id,
        attributes: { polyline },
      })),
    ],
  };
}

test('route catalog keeps one typical pattern per route and direction', () => {
  const result = normalizeMbtaRoutePatterns(
    catalog({
      routes: [
        {
          id: 'Red',
          type: 1,
          color: 'da291c',
          long_name: 'Red Line',
          sort_order: 10,
        },
        {
          id: '70',
          type: 3,
          color: 'FFC72C',
          short_name: '70',
          long_name: 'Waltham - University Park',
          sort_order: 50,
        },
        {
          id: 'Shuttle-JFKKendall',
          type: 3,
          color: 'FFC72C',
          long_name: 'JFK - Kendall',
          sort_order: 60,
        },
      ],
      patterns: [
        { id: 'Red-0', route: 'Red', shape: 's1', direction: 0, sort: 2 },
        { id: 'Red-0-alt', route: 'Red', shape: 's2', direction: 0, sort: 1 },
        { id: 'Red-1', route: 'Red', shape: 's1', direction: 1 },
        { id: 'Red-div', route: 'Red', shape: 's3', typicality: 3 },
        { id: '70-0', route: '70', shape: 's4' },
        {
          id: 'Shuttle-0',
          route: 'Shuttle-JFKKendall',
          shape: 's5',
          typicality: 5,
        },
      ],
      shapes: {
        s1: GOOGLE_EXAMPLE,
        s2: GOOGLE_EXAMPLE,
        s3: GOOGLE_EXAMPLE,
        s4: GOOGLE_EXAMPLE,
        s5: GOOGLE_EXAMPLE,
      },
    }),
    getTransitFeed('mbta'),
  );
  assert.deepEqual(
    result.routes.map((r) => r.id),
    ['Red', '70'],
    'diversions and the shuttle catalog are not permanent routes',
  );
  const red = result.routes[0];
  // Lowest sort_order wins direction 0 (s2); direction 1 contributes s1.
  assert.deepEqual(red.shapes.length, 2);
  assert.equal(red.color, '#DA291C');
  assert.equal(red.mode, 'subway');
  assert.equal(red.name, 'Red Line');
  const bus = result.routes[1];
  assert.equal(bus.mode, 'bus');
  assert.equal(bus.name, 'Route 70');
  assert.equal(bus.longName, 'Waltham - University Park');
  assert.equal(result.shapeCount, 3);
  assert.equal(result.droppedShapes, 0);
});

test('route catalog drops broken shapes and colours, and refuses non-catalogs', () => {
  const result = normalizeMbtaRoutePatterns(
    catalog({
      routes: [{ id: 'Blue', type: 1, color: 'blue', long_name: 'Blue Line' }],
      patterns: [
        { id: 'Blue-0', route: 'Blue', shape: 'bad' },
        { id: 'Blue-1', route: 'Blue', shape: 'good', direction: 1 },
      ],
      shapes: { bad: 'not a polyline', good: GOOGLE_EXAMPLE },
    }),
  );
  assert.equal(result.routes.length, 1);
  assert.equal(result.routes[0].color, null);
  assert.equal(result.routes[0].shapes.length, 1);
  assert.equal(result.droppedShapes, 1);
  assert.throws(() => normalizeMbtaRoutePatterns(null), TypeError);
  assert.throws(() => normalizeMbtaRoutePatterns({ data: [] }), TypeError);
});

test('route display names follow how riders say them', () => {
  assert.equal(
    networkRouteDisplayName({
      mode: 'subway',
      longName: 'Orange Line',
      shortName: null,
      id: 'Orange',
    }),
    'Orange Line',
  );
  assert.equal(
    networkRouteDisplayName({
      mode: 'bus',
      longName: 'Harvard - Dudley',
      shortName: '1',
      id: '1',
    }),
    'Route 1',
  );
  assert.equal(
    networkRouteDisplayName({
      mode: 'bus',
      longName: null,
      shortName: null,
      id: 'SL1',
    }),
    'Route SL1',
  );
  assert.equal(
    networkRouteDisplayName({
      mode: 'rail',
      longName: null,
      shortName: null,
      id: 'CR-X',
    }),
    'Route CR-X',
  );
});

const text = (value) => ({ translation: [{ text: value, language: 'en' }] });

function alertsFeed(alerts, header = {}) {
  return {
    header: {
      gtfs_realtime_version: '2.0',
      incrementality: 'FULL_DATASET',
      timestamp: 1_790_000_000,
      ...header,
    },
    entity: alerts.map((alert, i) => ({ id: String(1000 + i), alert })),
  };
}

test('alerts normalize to bounded text, known enums and route ids', () => {
  const result = normalizeGtfsRtAlertsJson(
    alertsFeed([
      {
        effect: 'NO_SERVICE',
        effect_detail: 'SHUTTLE',
        cause: 'MAINTENANCE',
        severity: 7,
        severity_level: 'SEVERE',
        alert_lifecycle: 'NEW',
        header_text: text(
          'Red Line: Shuttle buses replace service between JFK/UMass and Kendall.\r\n',
        ),
        service_effect_text: text('Red Line shuttle'),
        timeframe_text: text('through Sunday'),
        active_period: [{ start: 1_789_990_000, end: 1_790_100_000 }],
        informed_entity: [
          { route_id: 'Red', route_type: 1, stop_id: 'place-jfk' },
          { route_id: 'Red', route_type: 1, stop_id: 'place-knncl' },
          { route_id: '<img src=x>', route_type: 1 },
        ],
        url: text('javascript:alert(1)'),
      },
      {
        effect: 'ACCESSIBILITY_ISSUE',
        effect_detail: 'ELEVATOR_CLOSURE',
        header_text: text('Elevator closed'),
        informed_entity: [{ route_id: 'Orange', stop_id: 'place-dwnxg' }],
        severity: 99,
        cause: 'lower-case-not-an-enum',
      },
      { header_text: text('   ') },
      {
        effect: 'OTHER_EFFECT',
        header_text: {
          translation: [
            { text: 'Aviso', language: 'es' },
            { text: 'Notice', language: 'en' },
          ],
        },
      },
    ]),
  );
  assert.equal(
    result.alerts.length,
    3,
    'an alert with nothing to say is dropped',
  );
  const [shuttle, elevator, notice] = result.alerts;
  assert.equal(shuttle.kind, 'service');
  assert.equal(
    shuttle.header,
    'Red Line: Shuttle buses replace service between JFK/UMass and Kendall.',
  );
  assert.deepEqual(
    shuttle.routeIds,
    ['Red'],
    'odd ids are dropped, duplicates collapsed',
  );
  assert.equal(shuttle.stopCount, 2);
  assert.equal(shuttle.severity, 7);
  assert.equal(
    'url' in shuttle,
    false,
    'links are never carried to the browser',
  );
  assert.equal(elevator.kind, 'facility');
  assert.equal(elevator.severity, null);
  assert.equal(elevator.cause, null);
  assert.equal(notice.header, 'Notice', 'English is preferred when offered');
  assert.equal(notice.kind, 'other');
  assert.equal(result.feedTimestamp, 1_790_000_000);
});

test('alerts refuse differential feeds and non-feeds', () => {
  assert.throws(
    () =>
      normalizeGtfsRtAlertsJson(
        alertsFeed([], { incrementality: 'DIFFERENTIAL' }),
      ),
    /differential/,
  );
  assert.throws(() => normalizeGtfsRtAlertsJson({ entity: [] }), TypeError);
  assert.throws(() => normalizeGtfsRtAlertsJson({ header: {} }), TypeError);
  const long = normalizeGtfsRtAlertsJson(
    alertsFeed([{ header_text: text('x '.repeat(1000)) }]),
  );
  assert.ok(long.alerts[0].header.length <= ALERTS_MAX_HEADER_CHARS);
});

test('alert activity follows its periods, and no period means in force', () => {
  assert.equal(isAlertActive({ activePeriods: [] }, 100), true);
  assert.equal(
    isAlertActive({ activePeriods: [{ start: 50, end: 150 }] }, 100),
    true,
  );
  assert.equal(
    isAlertActive({ activePeriods: [{ start: 50, end: 100 }] }, 100),
    false,
    'end is exclusive',
  );
  assert.equal(
    isAlertActive({ activePeriods: [{ start: 200, end: null }] }, 100),
    false,
    'upcoming',
  );
  assert.equal(
    isAlertActive(
      {
        activePeriods: [
          { start: 10, end: 20 },
          { start: 90, end: null },
        ],
      },
      100,
    ),
    true,
  );
});

test('classification separates disruptions from details and facilities', () => {
  assert.equal(alertKind({ effectDetail: 'DELAY' }), 'service');
  assert.equal(alertKind({ effectDetail: 'ESCALATOR_CLOSURE' }), 'facility');
  assert.equal(alertKind({ effect: 'SIGNIFICANT_DELAYS' }), 'service');
  assert.equal(alertKind({ effect: 'ACCESSIBILITY_ISSUE' }), 'facility');
  assert.equal(alertKind({ effect: 'UNKNOWN_EFFECT' }), 'other');
  assert.equal(
    isDisruption({ kind: 'service', effectDetail: 'SUSPENSION' }),
    true,
  );
  assert.equal(
    isDisruption({ kind: 'service', effectDetail: 'STOP_MOVE' }),
    false,
    'a moved stop does not outline a route',
  );
  assert.equal(isDisruption({ kind: 'service', effect: 'STOP_MOVED' }), false);
  assert.equal(
    isDisruption({ kind: 'service', effectDetail: 'STOP_CLOSURE' }),
    false,
    'one closed stop is not a disrupted route',
  );
  assert.equal(
    isDisruption({ kind: 'service', effectDetail: 'STATION_CLOSURE' }),
    false,
  );
  assert.equal(isDisruption({ kind: 'service', effectDetail: 'DETOUR' }), true);
  assert.equal(
    isDisruption({ kind: 'facility', effectDetail: 'ELEVATOR_CLOSURE' }),
    false,
  );
  assert.equal(hasDisruption(undefined), false);
});

test('alerts index by route in card order and render as short lines', () => {
  const now = 1_000;
  const alerts = [
    {
      id: 'a',
      kind: 'facility',
      severity: 9,
      routeIds: ['Red'],
      activePeriods: [],
      header: 'Elevator out',
    },
    {
      id: 'b',
      kind: 'service',
      severity: 3,
      routeIds: ['Red', '1'],
      activePeriods: [],
      serviceEffect: 'Minor delays',
      timeframe: 'ongoing',
    },
    {
      id: 'c',
      kind: 'service',
      severity: 7,
      routeIds: ['Red'],
      activePeriods: [],
      serviceEffect: 'Shuttle buses',
      timeframe: 'this weekend',
    },
    {
      id: 'd',
      kind: 'service',
      severity: 9,
      routeIds: ['Red'],
      activePeriods: [{ start: 2_000, end: null }],
      serviceEffect: 'Future',
    },
    {
      id: 'e',
      kind: 'other',
      severity: 1,
      routeIds: ['Red'],
      activePeriods: [],
      header: 'Notice',
    },
  ];
  const byRoute = activeAlertsByRoute(alerts, now);
  assert.deepEqual(
    byRoute.get('Red').map((a) => a.id),
    ['c', 'b', 'a', 'e'],
  );
  assert.deepEqual(
    byRoute.get('1').map((a) => a.id),
    ['b'],
  );
  assert.deepEqual(alertCardLines(byRoute.get('Red')), [
    '⚠ Shuttle buses (this weekend)',
    '⚠ Minor delays',
    '+ 1 station access alert · 1 notice',
  ]);
  assert.deepEqual(alertCardLines(byRoute.get('Red'), 1), [
    '⚠ Shuttle buses (this weekend)',
    '+ 1 more service alert · 1 station access alert · 1 notice',
  ]);
  assert.deepEqual(alertCardLines([]), []);
});

test('only MBTA advertises routes and alerts in the public catalog', () => {
  const catalogRows = publicTransitCatalog();
  const mbta = catalogRows.find((row) => row.id === 'mbta');
  assert.equal(mbta.routes, true);
  assert.equal(mbta.alerts, true);
  assert.equal(
    'network' in mbta,
    false,
    'upstream URLs never reach the browser',
  );
  for (const row of catalogRows.filter((r) => r.id !== 'mbta')) {
    assert.equal(row.routes, false, row.id);
    assert.equal(row.alerts, false, row.id);
  }
  const network = getTransitFeed('mbta').network;
  assert.match(
    network.routesUrl,
    /^https:\/\/api-v3\.mbta\.com\/route_patterns\?/,
  );
  assert.match(
    network.alertsUrl,
    /^https:\/\/cdn\.mbta\.com\/realtime\/Alerts_enhanced\.json$/,
  );
});
