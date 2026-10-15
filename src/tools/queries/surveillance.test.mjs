import assert from 'node:assert/strict';
import test from 'node:test';
import { composeCatalog, coreTools } from '../index.js';

const camera = (id, latitude, longitude, extra = {}) => ({
  id,
  osmId: id,
  latitude,
  longitude,
  operator: 'City PD',
  manufacturer: 'Flock Safety',
  cameraType: 'fixed',
  zone: 'traffic',
  directionDeg: 270,
  ref: null,
  lastVerified: '2026-05-01',
  source: null,
  ...extra,
});
const alpr = (result) => ({
  label: 'OpenStreetMap · community mapped',
  attribution: { text: 'OpenStreetMap contributors' },
  boxes: [],
  async fetch(box) {
    this.boxes.push(box);
    return result;
  },
});

test('mapped cameras are listed nearest first with their details', async () => {
  const source = alpr({
    records: [
      camera('alpr:1', 30.3, -97.7),
      camera('alpr:2', 30.27, -97.74, { directionDeg: null }),
      camera('alpr:far', 31.5, -97.7),
    ],
    stale: false,
  });
  const catalog = composeCatalog({
    tools: coreTools,
    services: { alpr: source },
  });
  const result = await catalog.call('find_alpr_cameras', {
    area: { lat: 30.27, lon: -97.74, radius_km: 10 },
  });
  assert.equal(
    result.summary,
    '2 license plate reader cameras mapped in 10 km around 30.270, -97.740.',
  );
  assert.deepEqual(
    result.data.rows.map((row) => row.id),
    ['alpr:2', 'alpr:1'],
  );
  assert.deepEqual(result.data.rows[1], {
    id: 'alpr:1',
    lat: 30.3,
    lon: -97.7,
    operator: 'City PD',
    manufacturer: 'Flock Safety',
    camera_type: 'fixed',
    zone: 'traffic',
    direction_deg: 270,
    last_verified: '2026-05-01',
    distance_km: 5.09,
  });
  assert.equal(result.data.source, 'OpenStreetMap · community mapped');
  assert.ok(source.boxes[0].north - source.boxes[0].south < 1);
});

test('coverage, size and zoom limits are reported', async () => {
  const outside = composeCatalog({
    tools: coreTools,
    services: { alpr: alpr({ records: [], noCoverage: true }) },
  });
  assert.equal(
    (
      await outside.call('find_alpr_cameras', {
        area: { lat: 51.5, lon: -0.1, radius_km: 5 },
      })
    ).summary,
    '5 km around 51.500, -0.100 is outside the US and Canadian camera coverage.',
  );
  await assert.rejects(
    outside.call('find_alpr_cameras', { area: { bbox: [-100, 30, -95, 35] } }),
    /at most 3° on each side/,
  );
  const zoom = composeCatalog({
    tools: coreTools,
    services: { alpr: alpr({ records: [], zoomIn: true }) },
  });
  await assert.rejects(
    zoom.call('find_alpr_cameras', {
      area: { lat: 30, lon: -97, radius_km: 100 },
    }),
    /smaller, city-sized area/,
  );
});

test('a saturated camera fetch is reported as partial', async () => {
  const catalog = composeCatalog({
    tools: coreTools,
    services: {
      alpr: alpr({
        records: [camera('alpr:1', 30.3, -97.7)],
        stale: false,
        saturated: true,
      }),
    },
  });
  const result = await catalog.call('find_alpr_cameras', {
    area: { lat: 30.3, lon: -97.7, radius_km: 5 },
  });
  assert.equal(result.data.complete, false);
  assert.match(result.summary, /partial: some cameras were not loaded/);
});
