import test from 'node:test';
import assert from 'node:assert/strict';
import { perfBudgetTestOptions } from '../../scripts/run-perf-tests.mjs';
import { trafficAnalystRecords } from '../layers/traffic/records.js';
import { nearbyForLayer } from './entityContext.js';
import { CONTEXT_LINES } from './contextGeometry.js';

function roads(n, seed = 1) {
  let state = seed;
  const random = () => {
    state = (state * 16807) % 2147483647;
    return state / 2147483647;
  };
  const out = [];
  for (let i = 0; i < n; i++) {
    let lat = 48.85 + (random() - 0.5) * 0.5;
    let lon = 2.35 + (random() - 0.5) * 0.7;
    const coords = [];
    const dlat = (random() - 0.5) * 0.002;
    const dlon = (random() - 0.5) * 0.002;
    for (let k = 0; k < 20; k++) {
      coords.push([lon, lat]);
      lat += dlat + (random() - 0.5) * 0.0005;
      lon += dlon + (random() - 0.5) * 0.0005;
    }
    out.push({ coords, type: 'residential', directFlow: 0 });
  }
  return out;
}

function scan(records, limit = 3) {
  const manager = {
    isEnabled: () => true,
    layers: new Map([
      ['traffic', { module: { getAnalystRecords: () => records } }],
    ]),
  };
  return nearbyForLayer(
    manager,
    { id: 'traffic', enabled: true },
    { lat: 48.8566, lon: 2.3522 },
    { radiusKm: 250, limit },
  );
}

test('a radius scan reads the paths of only the roads that can be nearest', () => {
  const full = trafficAnalystRecords({
    _enabled: true,
    _roads: roads(2000),
    _liveMode: false,
  });
  const read = new Set();
  const counted = full.map((record) => {
    const copy = { ...record };
    Object.defineProperty(copy, CONTEXT_LINES, {
      value: record[CONTEXT_LINES].map((path) => ({
        bounds: path.bounds,
        points: () => {
          read.add(copy);
          return path.points();
        },
      })),
    });
    return copy;
  });
  const result = scan(counted);
  assert.ok(
    read.size < counted.length / 4,
    `read paths for ${read.size} roads`,
  );
  const all = scan(full, full.length);
  const keyDistance = ({ key, distanceKm }) => [key, distanceKm];
  assert.equal(result.count, all.count);
  assert.deepEqual(
    result.items.map(keyDistance),
    all.items.slice(0, 3).map(keyDistance),
  );
});

function medianScanMs(records) {
  scan(records);
  const times = [];
  for (let i = 0; i < 7; i++) {
    const start = performance.now();
    scan(records);
    times.push(performance.now() - start);
  }
  return times.sort((a, b) => a - b)[3];
}

test('traffic radius scan cost', perfBudgetTestOptions(), () => {
  for (const n of [2000, 10000]) {
    const full = trafficAnalystRecords({
      _enabled: true,
      _roads: roads(n),
      _liveMode: false,
    });
    const stripped = full.map((record) => ({ ...record }));
    const fullMs = medianScanMs(full);
    const strippedMs = medianScanMs(stripped);
    assert.ok(
      fullMs <= 5 * strippedMs + 10,
      `${n} roads: ${fullMs.toFixed(1)} ms with paths vs ${strippedMs.toFixed(1)} ms without`,
    );
  }
});
