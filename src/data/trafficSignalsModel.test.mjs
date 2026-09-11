import test from 'node:test';
import assert from 'node:assert/strict';
import { signalBounds, signalQuery, parseSignalLocations, parseSignalSnapshot, signalPresentation } from './trafficSignalsModel.js';

const epoch = 1789000000000;
function payload(overrides = {}) {
  return { serverTimeEpochMs: epoch, clockUncertaintyMs: 10, signals: [{
    id: 'city:1:north:left', lat: 49, lon: -123, name: 'Test', source: 'City', movement: 'North left', state: 'red',
    observedAtEpochMs: epoch - 500, validUntilEpochMs: epoch + 3000,
    changeAtEpochMs: epoch + 2500, uncertaintyMs: 20, resolutionMs: 1, ...overrides,
  }] };
}
function present(overrides = {}, now = 200) {
  const snapshot = parseSignalSnapshot(payload(overrides), 100, 200);
  return signalPresentation(snapshot.signals.get('city:1:north:left'), snapshot, now);
}

test('OSM keeps actual signal nodes and controlled crossings, deduplicates, rejects invalid coordinates', () => {
  const node = (id, tags, extra = {}) => ({ type: 'node', id, lat: 49, lon: -123, tags, ...extra });
  const result = parseSignalLocations({ elements: [node(1, { highway: 'traffic_signals' }), node(1, { highway: 'traffic_signals' }),
    node(2, { highway: 'crossing', 'crossing:signals': 'yes' }), node(3, { highway: 'crossing', crossing: 'traffic_signals' }),
    node(4, { highway: 'street_lamp' }), node(5, { highway: 'traffic_signals' }, { lon: 181 })] });
  assert.deepEqual(result.signals.map((s) => s.id), ['osm:1', 'osm:2', 'osm:3']);
  assert.equal(result.signals[0].state, undefined);
  assert.throws(() => parseSignalLocations({ elements: [], remark: 'runtime error' }));
  assert.throws(() => parseSignalLocations({}));
});

test('date-line bounds split instead of querying almost the whole planet', () => {
  for (const lon of [-180, -179.99, 179.99, 180]) {
    const boxes = signalBounds(49, lon);
    assert.equal(boxes.length, 2);
    for (const box of boxes) {
      assert.ok(box.west >= -180 && box.east <= 180 && box.east > box.west && box.east - box.west < 0.051);
    }
    assert.match(signalQuery(boxes), /node\[highway=traffic_signals\]/);
  }
  assert.equal(signalBounds(90, 0)[0].north, 90);
  assert.deepEqual(signalBounds(NaN, 0), []);
});

test('millisecond display is monotonic and includes network, source and quantization uncertainty', () => {
  const result = present();
  assert.equal(result.state, 'red');
  assert.equal(result.remainingMs, 2450);
  assert.equal(result.countdown, '2.450 s ±81 ms (estimate)');
  assert.equal(present({}, 1200).remainingMs, 1450);
  assert.equal(present({}, 2600).state, 'unknown');
  assert.equal(present({}, 199).state, 'unknown');
});

test('second-resolution feeds do not acquire fake millisecond precision', () => {
  const result = present({ resolutionMs: 1000, observedAtEpochMs: epoch - 1000 });
  assert.equal(result.countdown, '2 s ±580 ms (estimate)');
});

test('missing timing stays unknown; missing transition can still show a fresh state', () => {
  assert.equal(signalPresentation(null, null, 0).state, 'unknown');
  const stateOnly = present({ changeAtEpochMs: null });
  assert.equal(stateOnly.state, 'red');
  assert.equal(stateOnly.countdown, 'Countdown unavailable');
  assert.equal(stateOnly.remainingMs, null);
  assert.equal(present({ state: 'unknown' }).state, 'unknown');
  assert.equal(present({ state: 'off' }).state, 'off');
});

test('stale, future and uncertain observations never keep a green light visible', () => {
  assert.equal(present({ state: 'green', observedAtEpochMs: epoch - 6000 }).state, 'unknown');
  assert.equal(present({ state: 'green', observedAtEpochMs: epoch + 1000 }).state, 'unknown');
  assert.equal(present({ state: 'green', uncertaintyMs: 5000 }).state, 'unknown');
  assert.equal(present({ state: 'green', validUntilEpochMs: epoch + 100 }).state, 'unknown');
  assert.equal(present({ state: 'green', changeAtEpochMs: epoch + 60000, validUntilEpochMs: epoch + 60000 }, 5200).state, 'unknown');
});

test('unknown resolution, invalid deadlines, malformed records and duplicate identities are rejected', () => {
  for (const override of [{ resolutionMs: 0 }, { uncertaintyMs: -1 }, { movement: '' }, { source: '' },
    { lat: '49' }, { state: 'GREEN' }, { validUntilEpochMs: epoch - 1000 }, { changeAtEpochMs: NaN }]) {
    assert.equal(parseSignalSnapshot(payload(override), 100, 200).signals.size, 0);
  }
  const duplicate = payload();
  duplicate.signals.push({ ...duplicate.signals[0], state: 'green' });
  assert.equal(parseSignalSnapshot(duplicate, 100, 200).signals.size, 0);
  assert.throws(() => parseSignalSnapshot({ ...payload(), clockUncertaintyMs: undefined }, 100, 200));
  assert.throws(() => parseSignalSnapshot(payload(), 200, 100));
});
