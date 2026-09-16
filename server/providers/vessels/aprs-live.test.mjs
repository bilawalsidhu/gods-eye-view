import assert from 'node:assert/strict';
import test from 'node:test';
import {
  aprsAreaFilters,
  aprsLiveHandler,
  aprsTelemetry,
  aprsTrack,
  currentFilter,
  ingestAprsLine,
  resetAprsStateForTest,
  updateViewportFilter,
} from './aprs-live.js';

const POSITION = 'SHIP>APRS:!4903.50N/07201.75Ws';
const TELEMETRY = 'SHIP>APRS:T#001,100,200,50,0,255,10101010';

function fakeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(key, value) {
      this.headers[key] = value;
    },
    end(value) {
      this.body = value;
    },
  };
}

function withEnv(values, run) {
  const saved = {};
  for (const [key, value] of Object.entries(values)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('aprsAreaFilters builds a bounding box and falls back safely', () => {
  withEnv({ APRS_IS_FILTER: undefined }, () => {
    assert.deepEqual(aprsAreaFilters(null), ['r/0/0/180']);
    assert.deepEqual(
      aprsAreaFilters({ west: -10, south: -20, east: 10, north: 20 }),
      ['a/20.000/-10.000/-20.000/10.000'],
    );
    assert.deepEqual(
      aprsAreaFilters({ west: 0, south: 10, east: 10, north: 10 }),
      ['r/0/0/180'],
    );
    assert.deepEqual(
      aprsAreaFilters({ west: 'x', south: 0, east: 1, north: 2 }),
      ['r/0/0/180'],
    );
  });
});

test('aprsAreaFilters splits a viewport that crosses the antimeridian', () => {
  withEnv({ APRS_IS_FILTER: undefined }, () => {
    assert.deepEqual(
      aprsAreaFilters({ west: 170, south: -10, east: -170, north: 10 }),
      [
        'a/10.000/170.000/-10.000/180.000',
        'a/10.000/-180.000/-10.000/-170.000',
      ],
    );
  });
});

test('updateViewportFilter changes once and then coalesces', () => {
  withEnv({ APRS_IS_FILTER: undefined }, () => {
    resetAprsStateForTest();
    const viewport = { west: -10, south: -20, east: 10, north: 20 };
    assert.equal(updateViewportFilter(viewport, 1_000_000), true);
    assert.equal(currentFilter(), 'a/20.000/-10.000/-20.000/10.000');
    assert.equal(updateViewportFilter(viewport, 1_000_100), false);
    assert.equal(
      updateViewportFilter(
        { west: -30, south: -20, east: 10, north: 20 },
        1_000_200,
      ),
      false,
      'a change inside the coalescing window is deferred, not lost',
    );
    assert.equal(
      updateViewportFilter(
        { west: -30, south: -20, east: 10, north: 20 },
        1_010_000,
      ),
      true,
    );
  });
});

test('ingestAprsLine stores positions, bounded history and telemetry', () => {
  withEnv({ APRS_IS_FILTER: undefined }, () => {
    resetAprsStateForTest();
    ingestAprsLine(POSITION, 1_700_000_000_000);
    ingestAprsLine(POSITION, 1_700_000_060_000);
    const track = aprsTrack('aprs:SHIP');
    assert.equal(track.length, 2);
    assert.ok(track[0].t <= track[1].t, 'samples are chronological');
    assert.equal(track[0].lat.toFixed(4), '49.0583');

    for (let i = 0; i < 100; i += 1)
      ingestAprsLine(
        `SHIP>APRS:!${String(4903 + i).padStart(4, '0')}.50N/07201.75Ws`,
        1_700_000_100_000 + i,
      );
    assert.ok(aprsTrack('aprs:SHIP').length <= 64, 'history is capped');

    ingestAprsLine(TELEMETRY, 1_700_000_200_000);
    const telemetry = aprsTelemetry('aprs:SHIP');
    assert.deepEqual(telemetry.latest.analog, [100, 200, 50, 0, 255]);
    assert.equal(telemetry.latest.digitalBits, '10101010');
    assert.equal(telemetry.latest.sequence, 1);
  });
});

test('aprsLiveHandler reports configuration and validates the track reference', () => {
  withEnv({ APRS_IS_ENABLED: undefined, APRS_IS_HOST: undefined }, () => {
    resetAprsStateForTest();
    const snapshot = fakeRes();
    aprsLiveHandler({ url: '/' }, snapshot);
    assert.equal(snapshot.statusCode, 503);
    assert.equal(JSON.parse(snapshot.body).configured, false);

    const invalid = fakeRes();
    aprsLiveHandler({ url: '/track?reference=%20%20' }, invalid);
    assert.equal(invalid.statusCode, 400);

    const missing = fakeRes();
    aprsLiveHandler({ url: '/track' }, missing);
    assert.equal(missing.statusCode, 400);

    ingestAprsLine(POSITION, 1_700_000_000_000);
    const track = fakeRes();
    aprsLiveHandler({ url: '/track?reference=aprs:SHIP' }, track);
    assert.equal(track.statusCode, 200);
    const body = JSON.parse(track.body);
    assert.equal(body.samples.length, 1);
    assert.equal(body.source, 'APRS-IS');
  });
});

test('aprsLiveHandler adopts a viewport filter and echoes it', () => {
  withEnv({ APRS_IS_FILTER: undefined }, () => {
    resetAprsStateForTest();
    const res = fakeRes();
    aprsLiveHandler(
      { url: '/?west=-10&south=-20&east=10&north=20&maxRows=10' },
      res,
    );
    const body = JSON.parse(res.body);
    assert.equal(body.filter, 'a/20.000/-10.000/-20.000/10.000');
    assert.equal(body.source, 'APRS-IS');
  });
});
