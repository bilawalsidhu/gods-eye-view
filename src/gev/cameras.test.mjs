import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createStore } from '../../server/providers/store/store.js';
import { sqliteDriver } from '../../server/providers/store/drivers.js';
import { cameraFootprint, coverageGrid, rle, unrle, footprintPolygon } from '../sources/cameraCoverage.js';
import { createCameraService } from '../../server/providers/cameras/index.js';
import { onCameraHealth, reportCameraHealth } from '../../server/providers/common/cameraHooks.js';

const T0 = Date.UTC(2026, 8, 30, 12);
const box = { minLat: 30.26, minLon: -97.75, maxLat: 30.27, maxLon: -97.74 };
const cam = (id, lat, lon, headingDeg, extra = {}) => ({ id, lat, lon, headingDeg, fovDeg: 60, rangeM: 200, pitchDeg: -10, headingConfidence: 'high', ...extra });

test('footprint normalization and polygon', () => {
  assert.equal(cameraFootprint({ id: 'x', lat: 0, lon: 0 }), null, 'null island rejected');
  const fp = cameraFootprint(cam('a', 30.265, -97.745, 450));
  assert.equal(fp.headingDeg, 90);
  assert.ok(Math.abs(fp.rangeM - 200 * Math.cos((10 * Math.PI) / 180)) < 1e-6);
  const poly = footprintPolygon(fp);
  assert.deepEqual(poly[0], poly.at(-1));
  const noHeading = cameraFootprint({ id: 'b', lat: 1, lon: 1 });
  assert.equal(noHeading.oriented, false);
  assert.equal(noHeading.lowConfidence, true);
  assert.equal(footprintPolygon(noHeading), null);
});

test('run-length round trip', () => {
  const a = Uint8Array.from([0, 0, 0, 1, 1, 2, 0]);
  assert.deepEqual(rle(a), [0, 3, 1, 2, 2, 1, 0, 1]);
  assert.deepEqual([...unrle(rle(a), a.length)], [...a]);
});

test('coverage grid counts overlaps and respects heading and confidence', () => {
  const east = cam('east', 30.265, -97.746, 90);
  const west = cam('west', 30.265, -97.744, 270);
  const lowConf = cam('low', 30.262, -97.748, 0, { headingConfidence: 'fallback' });
  const far = cam('far', 31, -98, 0);
  const g = coverageGrid([east, west, lowConf, far, { id: 'bad' }], box, { cellM: 10 });
  assert.equal(g.summary.cameras, 3);
  assert.equal(g.summary.lowConfidence, 1);
  assert.equal(g.summary.maxOverlap, 2, 'facing cameras overlap between them');
  assert.ok(g.summary.multiKm2 > 0 && g.summary.coveredKm2 > g.summary.multiKm2);
  const counts = unrle(g.counts, g.rows * g.cols);
  const cellAt = (lat, lon) => counts[Math.floor((lat - box.minLat) / g.dLat) * g.cols + Math.floor((lon - box.minLon) / g.dLon)];
  assert.equal(cellAt(30.265, -97.745), 2, 'midpoint seen by both');
  assert.equal(cellAt(30.265, -97.7475), 0, 'behind the east-facing camera');
  const strict = coverageGrid([east, west, lowConf], box, { cellM: 10, includeLowConfidence: false });
  assert.ok(strict.summary.coveredKm2 < g.summary.coveredKm2);
});

test('grid coarsens instead of exceeding the cell cap', () => {
  const g = coverageGrid([], { minLat: 30, minLon: -98, maxLat: 31, maxLon: -97 }, { cellM: 10 });
  assert.ok(g.rows * g.cols <= 400_000);
  assert.ok(g.cellM > 10);
});

test('camera service records thinned health and serves coverage', async () => {
  const store = createStore(await sqliteDriver(':memory:'));
  await store.init();
  let t = T0;
  const svc = createCameraService({
    getStore: async () => store,
    catalog: async () => [cam('east', 30.265, -97.746, 90, { name: 'Congress Ave' }), cam('west', 30.265, -97.744, 270)],
    now: () => t,
  });
  svc.record({ camera: 'east', t: T0, ok: true });
  svc.record({ camera: 'east', t: T0 + 1000, ok: true });
  svc.record({ camera: 'east', t: T0 + 2000, ok: false });
  svc.record({ camera: 'west', t: T0, ok: true });
  assert.equal(await svc.flush(), 3, 'same-state repeats thinned, state change kept');

  const off = onCameraHealth((s) => svc.record(s));
  reportCameraHealth('west', { status: 'degraded', sourceKind: 'fallback' });
  off();
  assert.equal(await svc.flush(), 1);

  const server = http.createServer((req, res) => {
    req.url = req.url.replace(/^\/api\/cameras/, '') || '/';
    svc.handler(req, res, () => ((res.statusCode = 404), res.end('{}')));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/api/cameras`;
  try {
    let r = await fetch(`${base}/coverage?bbox=${box.minLat},${box.minLon},${box.maxLat},${box.maxLon}&cell=10`);
    const cov = await r.json();
    assert.equal(cov.summary.maxOverlap, 2);
    assert.equal(cov.catalogSize, 2);
    r = await fetch(`${base}/coverage?bbox=30,-99,32,-97`);
    assert.equal(r.status, 400, 'box size capped');
    r = await fetch(`${base}/health?from=${T0 - 1}&to=${Date.now() + 1}`);
    const health = await r.json();
    const east = health.cameras.find((c) => c.camera === 'east');
    assert.equal(east.uptime, 0.5);
    assert.equal(east.name, 'Congress Ave');
    r = await fetch(`${base}/health/series?camera=east&from=${T0 - 1}&to=${T0 + 3_600_000}`);
    assert.equal((await r.json()).series.length, 1);
  } finally {
    server.close();
  }
});
