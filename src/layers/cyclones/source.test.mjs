import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCycloneSource,
  validateCycloneSnapshot,
  CYCLONE_RESPONSE_LIMIT,
} from './source.js';

const issuedAt = '2026-09-16T03:00:00.000Z';
function fixture() {
  return {
    schemaVersion: 1,
    source: 'NOAA NHC / CPHC',
    attribution: 'NOAA/NWS',
    coverage: 'Atlantic and eastern/central North Pacific',
    partial: false,
    providers: { nhc: 'available', cwa: 'not_configured' },
    fetchedAt: Date.parse(issuedAt),
    stale: false,
    unavailable: false,
    reason: null,
    storms: [
      {
        id: 'ep152026',
        provider: 'nhc',
        source: 'NOAA NHC / CPHC',
        sourceUrl: 'https://www.nhc.noaa.gov/text/MIATCMEP5.shtml',
        name: 'Fifteen-E',
        classification: 'PTC',
        basin: 'EP',
        position: { longitude: -125.8, latitude: 15.5 },
        positionAt: issuedAt,
        issuedAt,
        advisoryNumber: '10',
        advisoryId: 'ep152026-10',
        cycleId: 'ep152026-10',
        windKt: 25,
        windMs: null,
        windAveragingMinutes: 1,
        pressureHpa: 1006,
        movement: {
          directionDegrees: null,
          speedKt: null,
          speedKmh: null,
          direction: null,
        },
        advisoryUrl: 'https://www.nhc.noaa.gov/text/MIATCMEP5.shtml',
        outlookUrl: 'https://www.nhc.noaa.gov/gtwo.php?basin=epac&fdays=7',
        geometryStatus: 'pending',
        geometryAdvisoryNumber: null,
        geometryCycleId: null,
        coneStatus: 'pending',
        forecastPoints: [],
        track: null,
        cone: null,
      },
    ],
  };
}
function current() {
  const value = fixture(),
    storm = value.storms[0];
  storm.geometryStatus = 'current';
  storm.geometryAdvisoryNumber = '10';
  storm.geometryCycleId = 'ep152026-10';
  storm.coneStatus = 'provided';
  storm.forecastPoints = [
    {
      position: { longitude: 179, latitude: 15 },
      tauHours: 12,
      windKt: 30,
      gustKt: 40,
      validAt: null,
      windMs: null,
      gustMs: null,
      pressureHpa: null,
      probabilityRadiusKm: null,
    },
  ];
  storm.track = {
    type: 'MultiLineString',
    coordinates: [
      [
        [179, 15],
        [-179, 16],
      ],
      [
        [170, 14],
        [179, 15],
      ],
    ],
  };
  storm.cone = {
    type: 'MultiPolygon',
    coordinates: [
      [
        [
          [178, 10],
          [-178, 10],
          [-178, 20],
          [178, 10],
        ],
        [
          [179, 12],
          [-179, 12],
          [-179, 14],
          [179, 12],
        ],
      ],
      [
        [
          [170, 1],
          [171, 1],
          [171, 2],
          [170, 1],
        ],
      ],
    ],
  };
  return value;
}
function cwaCurrent() {
  const value = fixture();
  value.source = 'NOAA NHC / CPHC + Taiwan CWA';
  value.attribution = 'NOAA/NWS; Taiwan CWA';
  value.providers.cwa = 'available';
  const currentTime = '2026-09-16T03:30:00.000Z';
  const cycleId = 'cwa-2026-td1:2026-09-16T03:00:00.000Z';
  value.storms = [
    {
      id: 'cwa-2026-td1',
      provider: 'cwa',
      source: 'Taiwan Central Weather Administration (CWA)',
      sourceUrl: 'https://opendata.cwa.gov.tw/dataset/forecast/W-C0034-005',
      name: 'CHAMPI',
      classification: 'Tropical cyclone',
      basin: 'WP',
      position: { longitude: 121.5, latitude: 20 },
      positionAt: currentTime,
      issuedAt: currentTime,
      advisoryNumber: null,
      advisoryId: 'CWA-TropicalCyclone_20260916113000:cwa-2026-td1',
      cycleId,
      windKt: null,
      windMs: 30,
      windAveragingMinutes: null,
      pressureHpa: 990,
      movement: {
        directionDegrees: null,
        speedKt: null,
        speedKmh: 20,
        direction: 'NNE',
      },
      advisoryUrl: 'https://opendata.cwa.gov.tw/dataset/forecast/W-C0034-005',
      outlookUrl: null,
      geometryStatus: 'current',
      geometryAdvisoryNumber: null,
      geometryCycleId: cycleId,
      coneStatus: 'not_provided',
      forecastPoints: [
        {
          position: { longitude: 123, latitude: 22 },
          tauHours: 12,
          windKt: null,
          gustKt: null,
          validAt: '2026-09-16T15:00:00.000Z',
          windMs: 32,
          gustMs: 40,
          pressureHpa: 985,
          probabilityRadiusKm: 150,
        },
      ],
      track: {
        type: 'LineString',
        coordinates: [
          [121.5, 20],
          [123, 22],
        ],
      },
      cone: null,
    },
  ];
  return value;
}
test('cyclone projection preserves MultiPolygon holes/dateline and separates advisory from position time', () => {
  const value = current();
  value.storms[0].positionAt = '2026-09-16T03:30:00.000Z';
  value.storms[0].cone.properties = {
    html: '<script>',
    href: 'https://example.invalid',
  };
  const result = validateCycloneSnapshot(value);
  assert.deepEqual(
    result.storms[0].cone.coordinates,
    value.storms[0].cone.coordinates,
  );
  assert.notEqual(result.storms[0].positionAt, result.storms[0].issuedAt);
  assert.equal(result.storms[0].cone.properties, undefined);
  assert.notEqual(
    result.storms[0].cone.coordinates,
    value.storms[0].cone.coordinates,
  );
});
test('successful empty coverage is distinct from unavailable', () => {
  const value = fixture();
  value.storms = [];
  assert.equal(validateCycloneSnapshot(value).unavailable, false);
  assert.equal(
    validateCycloneSnapshot({
      ...value,
      unavailable: true,
      stale: true,
      fetchedAt: null,
      reason: 'Unavailable',
    }).unavailable,
    true,
  );
  assert.throws(
    () => validateCycloneSnapshot({ ...fixture(), unavailable: true }),
    /Malformed/,
  );
});
test('CWA forecast projection preserves agency, cycle, valid time, units, and supplied radius without a cone', () => {
  const result = validateCycloneSnapshot(cwaCurrent());
  const storm = result.storms[0];
  assert.equal(storm.source, 'Taiwan Central Weather Administration (CWA)');
  assert.equal(storm.advisoryNumber, null);
  assert.equal(storm.windKt, null, 'CWA m/s is not converted to knots');
  assert.equal(storm.windMs, 30);
  assert.equal(storm.windAveragingMinutes, null);
  assert.equal(storm.forecastPoints[0].validAt, '2026-09-16T15:00:00.000Z');
  assert.equal(storm.forecastPoints[0].probabilityRadiusKm, 150);
  assert.equal(storm.cone, null);
  assert.equal(storm.coneStatus, 'not_provided');

  for (const mutate of [
    (value) => {
      value.storms[0].geometryCycleId = 'a-different-cycle';
    },
    (value) => {
      value.storms[0].forecastPoints[0].validAt = '2026-09-16T03:00:00.000Z';
    },
    (value) => {
      value.storms[0].windKt = 58;
    },
    (value) => {
      value.storms[0].coneStatus = 'provided';
    },
    (value) => {
      value.storms[0].forecastPoints[0].probabilityRadiusKm = 3001;
    },
  ]) {
    const invalid = cwaCurrent();
    mutate(invalid);
    assert.throws(() => validateCycloneSnapshot(invalid), /Malformed/);
  }
});
test('mismatched, malformed or unbounded cyclone geometry is rejected whole', () => {
  const changes = [
    (storm) => {
      storm.geometryAdvisoryNumber = '9';
    },
    (storm) => {
      storm.geometryStatus = 'pending';
    },
    (storm) => {
      storm.position.longitude = 181;
    },
    (storm) => {
      storm.track.coordinates[0][0][0] = NaN;
    },
    (storm) => {
      storm.cone.coordinates[0][0].pop();
    },
    (storm) => {
      storm.forecastPoints.push(storm.forecastPoints[0]);
    },
    (storm) => {
      storm.advisoryUrl = 'https://example.invalid/text/TEST.shtml';
    },
    (storm) => {
      storm.issuedAt = '2026-02-31T00:00:00.000Z';
    },
    (storm) => {
      storm.windKt = 9999;
    },
  ];
  for (const change of changes) {
    const value = current();
    change(value.storms[0]);
    assert.throws(() => validateCycloneSnapshot(value));
  }
  const oversized = current();
  oversized.storms[0].track = {
    type: 'MultiLineString',
    coordinates: Array.from({ length: 3 }, () =>
      Array.from({ length: 9000 }, () => [1, 2]),
    ),
  };
  assert.throws(() => validateCycloneSnapshot(oversized), /Malformed/);
  assert.throws(
    () =>
      validateCycloneSnapshot({
        ...fixture(),
        storms: Array(33).fill(fixture().storms[0]),
      }),
    /Malformed/,
  );
});
test('source is lazy and fixed-origin, caps bytes, and honors pre-abort', async () => {
  const calls = [];
  const source = createCycloneSource({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return Response.json(fixture());
    },
  });
  assert.equal(calls.length, 0);
  await source.getSnapshot();
  assert.equal(calls[0].url, '/api/cyclones');
  assert.equal(calls[0].options.redirect, 'error');
  await assert.rejects(source.getSnapshot({ signal: AbortSignal.abort() }), {
    name: 'AbortError',
  });
  assert.equal(calls.length, 1);
  const oversized = createCycloneSource({
    fetchImpl: async () =>
      new Response('{}', {
        headers: { 'content-length': String(CYCLONE_RESPONSE_LIMIT + 1) },
      }),
  });
  await assert.rejects(oversized.getSnapshot(), /too large/);
});
test('source deadline cancels request and removes timer on completion', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  const source = createCycloneSource({
    timeoutMs: 10,
    fetchImpl: async (_url, options) => {
      signal = options.signal;
      return new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        }),
      );
    },
  });
  const pending = source.getSnapshot();
  const rejected = assert.rejects(pending, /timed out/);
  t.mock.timers.tick(11);
  await rejected;
  assert.equal(signal.aborted, true);
});
