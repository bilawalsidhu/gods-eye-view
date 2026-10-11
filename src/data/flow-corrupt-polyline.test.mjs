import test from 'node:test';
import assert from 'node:assert/strict';
import { matchFlowToRoads } from './flowMatch.js';
test('one bad flow polyline cannot poison healthy nearby matches', () => {
  const coords = [
    [-97.74, 30.26],
    [-97.74, 30.264],
  ];
  const road = { coords, type: 'primary' };
  const healthy = { coords, trafficLevel: 0.42, closure: false };
  for (const bad of [
    [null, coords[1]],
    [[NaN, 30.26], coords[1]],
    [[181, 30.26], coords[1]],
  ]) {
    const result = matchFlowToRoads(
      [road],
      [{ coords: bad, trafficLevel: 0.9 }, healthy],
    );
    assert.equal(result.matchedCount, 1);
    assert.equal(result.matches[0].level, 0.42);
  }
  assert.equal(
    matchFlowToRoads([road], [{ coords: [null, null], trafficLevel: 0.9 }])
      .matchedCount,
    0,
  );
});
