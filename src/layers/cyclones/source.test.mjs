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
    fetchedAt: Date.parse(issuedAt),
    stale: false,
    unavailable: false,
    reason: null,
    storms: [
      {
        id: 'ep152026',
        provider: 'nhc',
        name: 'Fifteen-E',
        classification: 'PTC',
        basin: 'EP',
        position: { longitude: -125.8, latitude: 15.5 },
        positionAt: issuedAt,
        issuedAt,
        advisoryNumber: '10',
        windKt: 25,
        pressureHpa: 1006,
        movement: { directionDegrees: null, speedKt: null },
        advisoryUrl: 'https://www.nhc.noaa.gov/text/MIATCMEP5.shtml',
        outlookUrl: 'https://www.nhc.noaa.gov/gtwo.php?basin=epac&fdays=7',
        geometryStatus: 'pending',
        geometryAdvisoryNumber: null,
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
  storm.forecastPoints = [
    {
      position: { longitude: 179, latitude: 15 },
      tauHours: 12,
      windKt: 30,
      gustKt: 40,
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
function gdacs() {
  const value = current(),
    storm = value.storms[0];
  Object.assign(storm, {
    id: 'gdacs-1001346',
    provider: 'gdacs',
    name: 'Murasu',
    classification: 'CY',
    basin: 'IO',
    advisoryNumber: '6',
    geometryAdvisoryNumber: '6',
    advisoryUrl:
      'https://www.gdacs.org/report.aspx?eventid=1001346&episodeid=6&eventtype=TC',
    outlookUrl: null,
  });
  return value;
}
test('GDACS storms keep their provider and may carry a track without a cone', () => {
  const value = gdacs();
  value.storms[0].cone = null;
  value.providers = { nhc: 'available', gdacs: 'available' };
  const result = validateCycloneSnapshot(value);
  assert.equal(result.storms[0].provider, 'gdacs');
  assert.equal(result.storms[0].cone, null);
  assert.equal(result.storms[0].advisoryUrl, value.storms[0].advisoryUrl);
  assert.deepEqual(result.providers, value.providers);
  // An NHC storm still needs its cone.
  const nhc = current();
  nhc.storms[0].cone = null;
  assert.throws(() => validateCycloneSnapshot(nhc), /Malformed/);
});
test('GDACS ids, links, basins and provider states are checked', () => {
  const changes = [
    (storm) => {
      storm.id = 'ep152026';
    },
    (storm) => {
      storm.provider = 'cwa';
    },
    (storm) => {
      delete storm.provider;
    },
    (storm) => {
      storm.basin = 'EP';
    },
    (storm) => {
      storm.advisoryUrl =
        'https://www.gdacs.org/report.aspx?eventid=1&episodeid=6&eventtype=TC&next=https://evil';
    },
    (storm) => {
      storm.advisoryUrl = 'https://www.nhc.noaa.gov/text/MIATCMEP5.shtml';
    },
    (storm) => {
      storm.outlookUrl = 'https://www.nhc.noaa.gov/gtwo.php?basin=epac&fdays=7';
    },
    (storm) => {
      storm.windsPending = 'yes';
    },
  ];
  for (const change of changes) {
    const value = gdacs();
    change(value.storms[0]);
    assert.throws(() => validateCycloneSnapshot(value), /Malformed/);
  }
  assert.throws(
    () =>
      validateCycloneSnapshot({
        ...gdacs(),
        providers: { nhc: 'available', gdacs: 'down' },
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
