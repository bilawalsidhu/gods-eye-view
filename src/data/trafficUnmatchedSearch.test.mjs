import test from 'node:test';
import assert from 'node:assert/strict';
import { trafficAnalystRecords } from '../layers/traffic/records.js';
import { nearbyByKind, nearbyForLayer } from './entityContext.js';
import { CONTEXT_LINES } from './contextGeometry.js';

function roads(n, seed = 1) {
  let state = seed;
  const random = () => { state = (state * 16807) % 2147483647; return state / 2147483647; };
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
const here = { lat: 48.8566, lon: 2.3522 };
function counted(full) {
  const read = new Set();
  const records = full.map((record) => {
    const copy = { ...record };
    Object.defineProperty(copy, CONTEXT_LINES, {
      value: record[CONTEXT_LINES].map((path) => ({
        bounds: path.bounds,
        points: () => { read.add(copy); return path.points(); },
      })),
    });
    return copy;
  });
  return { records, read };
}
const managerOf = (records) => ({
  isEnabled: () => true,
  getAll: () => [{ id: 'traffic', enabled: true, name: 'Street Traffic' }],
  layers: new Map([['traffic', { module: { getAnalystRecords: () => records } }]]),
});

test('unmatched traffic search skips road paths', () => {
  const full = trafficAnalystRecords({ _enabled: true, _roads: roads(10000), _liveMode: false });
  const a = counted(full);
  const m = managerOf(a.records);
  const layerRes = nearbyForLayer(m, { id: 'traffic', enabled: true }, here, { radiusKm: 250, limit: 3, query: 'zzqq-absent' });
  const layerReads = a.read.size;
  a.read.clear();
  const kindRes = nearbyByKind(m, here, { radiusKm: 250, limit: 3, query: 'zzqq-absent' });
  const kindReads = a.read.size;
  a.read.clear();
  nearbyForLayer(m, { id: 'traffic', enabled: true }, here, { radiusKm: 250, limit: 3 });
  const emptyReads = a.read.size;
  assert.equal(layerRes?.count, 0);
  assert.equal(kindRes.other.length, 0);
  assert.ok(emptyReads < 10000 / 4, `an empty query reads ${emptyReads} roads`);
  assert.equal(layerReads, 0, `nearbyForLayer read ${layerReads} roads`);
  assert.equal(kindReads, 0, `nearbyByKind read ${kindReads} roads`);
});
