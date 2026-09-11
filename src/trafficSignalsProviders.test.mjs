import test from 'node:test';
import assert from 'node:assert/strict';
import { publicSignalProvidersForBounds, hamburgSignalQuery, parseHamburgSignals, fetchPublicSignalSnapshot } from './trafficSignalsProviders.js';
import { parseSignalSnapshot, signalPresentation } from './data/trafficSignalsModel.js';

const box = { south: 53.55, west: 9.90, north: 53.59, east: 9.94 };
const epoch = 1789100000000;
function stream(overrides = {}) {
  return { '@iot.id': 6, name: 'Signal K5', properties: { layerName: 'primary_signal', signalGroupID: 'K5' },
    Thing: { properties: { ingressLaneID: '18', egressLaneID: '12', laneType: 'KFZ' } },
    Observations: [{ result: 1, phenomenonTime: new Date(epoch - 2000).toISOString(), resultTime: new Date(epoch - 1000).toISOString(),
      FeatureOfInterest: { feature: { type: 'Feature', geometry: { type: 'Point', coordinates: [9.9196, 53.5638] } } }, ...overrides }] };
}
test('automatic provider selection is geographic, with no global coverage claim', () => {
  assert.equal(publicSignalProvidersForBounds(box)[0].id, 'hamburg');
  for (const other of [{ south: 49, north: 49.01, west: -123, east: -122.99 },
    { south: 31, north: 31.01, west: 121, east: 121.01 }, { south: -34, north: -33.99, west: 18, east: 18.01 }]) {
    assert.deepEqual(publicSignalProvidersForBounds(other), []);
  }
  const url = hamburgSignalQuery(box);
  assert.equal(url.hostname, 'tld.iot.hamburg.de');
  assert.match(url.searchParams.get('$filter'), /geo.intersects/);
  assert.equal(url.searchParams.get('$top'), '64');
});
test('real provider schema preserves reported colors, lane identities and stop-line coordinates', () => {
  for (const [result, state] of [[0, 'off'], [1, 'red'], [2, 'yellow'], [3, 'green'], [4, 'red-yellow'],
    [5, 'flashing-yellow'], [6, 'flashing-green'], [9, 'unknown']]) {
    const signal = parseHamburgSignals({ value: [stream({ result })] }, box, epoch).signals[0];
    assert.equal(signal.state, state);
    assert.equal(signal.id, 'hamburg:6');
    assert.match(signal.movement, /18 → 12/);
    assert.equal(signal.lat, 53.5638);
    assert.equal(signal.observationOnly, true);
    assert.equal(signal.validUntilEpochMs, undefined);
    assert.equal(signal.changeAtEpochMs, undefined);
    assert.equal(signal.uncertaintyMs, undefined);
  }
});
test('malformed, misplaced, detector and future-dated values are never promoted to signal states', () => {
  for (const overrides of [{ result: '1' }, { result: 8 }, { phenomenonTime: new Date(epoch + 5000).toISOString() },
    { resultTime: 'bad' }, { FeatureOfInterest: { feature: { type: 'Point', coordinates: [-123, 49] } } }]) {
    assert.equal(parseHamburgSignals({ value: [stream(overrides)] }, box, epoch).signals.length, 0);
  }
  const detector = stream(); detector.properties.layerName = 'detector_car';
  assert.equal(parseHamburgSignals({ value: [detector] }, box, epoch).signals.length, 0);
  assert.throws(() => parseHamburgSignals({}, box, epoch));
  assert.equal(parseHamburgSignals({ value: [], '@iot.nextLink': 'next' }, box, epoch).truncated, true);
});
test('reported observations have no invented phase deadline or millisecond countdown and expire locally', () => {
  const parsed = parseHamburgSignals({ value: [stream()] }, box, epoch);
  const snapshot = parseSignalSnapshot({ ...parsed, serverTimeEpochMs: epoch, clockUncertaintyMs: 1000 }, 100, 200);
  const signal = snapshot.signals.get('hamburg:6');
  const recent = signalPresentation(signal, snapshot, 200);
  assert.equal(recent.state, 'red');
  assert.equal(recent.observationOnly, true);
  assert.equal(recent.remainingMs, null);
  assert.equal(recent.uncertaintyMs, null);
  assert.match(recent.countdown, /Reported ~2.0 s ago/);
  const expired = signalPresentation(signal, snapshot, 3200);
  assert.equal(expired.state, 'unknown');
  assert.match(expired.countdown, /Last report: RED.*current state unknown/);
  assert.equal(parseSignalSnapshot({ signals: [{ ...signal, observedAtEpochMs: 1e100 }],
    serverTimeEpochMs: epoch, clockUncertaintyMs: 1000 }, 100, 200).signals.size, 0);
});
test('public feed requests are bounded and an uncovered area makes no external request', async () => {
  const result = await fetchPublicSignalSnapshot({ south: 49, north: 49.01, west: -123, east: -122.99 }, () => { throw new Error('must not fetch'); });
  assert.deepEqual(result.signals, []);
  assert.equal(result.pollAfterMs, 30000);
  const data = await fetchPublicSignalSnapshot(box, async (url, options) => {
    assert.equal(options.redirect, 'error');
    assert.equal(options.cache, 'no-store');
    return Response.json({ value: [] }, { headers: { Date: new Date().toUTCString() } });
  });
  assert.match(data.coverage, /Hamburg/);
  for (const headers of [{}, { Date: new Date(0).toUTCString() }, { Date: new Date().toUTCString(), Age: '600' }]) {
    await assert.rejects(fetchPublicSignalSnapshot(box, async () => Response.json({ value: [] }, { headers })), /clock/);
  }
});
