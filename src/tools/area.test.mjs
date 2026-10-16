import assert from 'node:assert/strict';
import test from 'node:test';
import {
  areaCenter,
  areaContains,
  areaRadiusKm,
  distanceKm,
  lineTouchesArea,
  polygonsTouchArea,
  resolveArea,
} from './area.js';
import { placeFromGeocodeResult } from './places.js';

test('an area needs exactly one form', async () => {
  for (const area of [
    {},
    { place: 'Oslo', bbox: [0, 0, 1, 1] },
    { lat: 1, lon: 2 },
  ]) {
    await assert.rejects(
      resolveArea(area),
      (error) => error.code === 'invalid_arguments',
    );
  }
  await assert.rejects(
    resolveArea({ bbox: [0, 10, 1, 5] }),
    /south below north/,
  );
});

test('boxes, including antimeridian boxes, contain the expected points', async () => {
  const box = await resolveArea({ bbox: [-10, 40, 10, 50] });
  assert.equal(areaContains(box, { lat: 45, lon: 0 }), true);
  assert.equal(areaContains(box, { lat: 45, lon: 20 }), false);
  const pacific = await resolveArea({ bbox: [170, -20, -170, 0] });
  assert.equal(areaContains(pacific, { lat: -10, lon: 179 }), true);
  assert.equal(areaContains(pacific, { lat: -10, lon: -175 }), true);
  assert.equal(areaContains(pacific, { lat: -10, lon: 0 }), false);
  assert.equal(areaContains(box, { lat: Number.NaN, lon: 0 }), false);
});

test('radius areas use great-circle distance', async () => {
  const circle = await resolveArea({ lat: 37.77, lon: -122.42, radius_km: 50 });
  assert.equal(circle.center.radiusKm, 50);
  assert.equal(areaContains(circle, { lat: 37.8, lon: -122.27 }), true);
  assert.equal(areaContains(circle, { lat: 38.58, lon: -121.49 }), false);
  assert.ok(
    Math.abs(distanceKm({ lat: 0, lon: 0 }, { lat: 0, lon: 1 }) - 111.2) < 0.1,
  );
  // A circle across the antimeridian wraps its box.
  const dateline = await resolveArea({ lat: 0, lon: 179.9, radius_km: 100 });
  assert.ok(dateline.west > dateline.east);
  assert.equal(areaContains(dateline, { lat: 0, lon: -179.9 }), true);
});

test('place names resolve through the places service', async () => {
  const places = {
    resolve: async (name) =>
      name === 'Taiwan'
        ? {
            name: 'Taiwan',
            bounds: { west: 119, south: 21, east: 123, north: 26 },
          }
        : null,
  };
  const taiwan = await resolveArea(
    { place: 'Taiwan' },
    { services: { places } },
  );
  assert.deepEqual(taiwan, {
    label: 'Taiwan',
    west: 119,
    south: 21,
    east: 123,
    north: 26,
  });
  await assert.rejects(
    resolveArea({ place: 'Nowhere' }, { services: { places } }),
    /No place matched "Nowhere"/,
  );
  await assert.rejects(
    resolveArea({ place: 'Taiwan' }),
    (error) => error.code === 'unsupported',
  );
});

test('geocode results become bounded places', () => {
  assert.deepEqual(
    placeFromGeocodeResult({
      formatted_address: 'Oslo, Norway',
      geometry: {
        location: { lat: 59.9, lng: 10.7 },
        viewport: {
          southwest: { lat: 59.8, lng: 10.5 },
          northeast: { lat: 60, lng: 10.9 },
        },
      },
    }),
    {
      name: 'Oslo, Norway',
      bounds: { west: 10.5, south: 59.8, east: 10.9, north: 60 },
      point: { lat: 59.9, lon: 10.7 },
    },
  );
  assert.deepEqual(
    placeFromGeocodeResult({ geometry: { location: { lat: 0, lng: 179.9 } } })
      .bounds,
    { west: 179.65, south: -0.25, east: 180, north: 0.25 },
  );
  assert.equal(placeFromGeocodeResult({ geometry: {} }), null);
});

test('a named place centers on its own point, not the middle of its bounds', async () => {
  // Tokyo's prefecture bounds reach remote Pacific islands.
  const places = {
    resolve: async () => ({
      name: 'Tokyo, Japan',
      bounds: { west: 136.07, south: 20.21, east: 153.99, north: 35.9 },
      point: { lat: 35.6769, lon: 139.7639 },
    }),
  };
  const tokyo = await resolveArea({ place: 'Tokyo' }, { services: { places } });
  assert.deepEqual(areaCenter(tokyo), { lat: 35.6769, lon: 139.7639 });
  assert.equal(areaContains(tokyo, { lat: 27.09, lon: 142.19 }), true);
  const box = await resolveArea({ bbox: [0, 0, 10, 10] });
  assert.deepEqual(areaCenter(box), { lat: 5, lon: 5 });
});

test('radius areas include every point within the radius, near the poles too', async () => {
  const polar = await resolveArea({ lat: 80, lon: 0, radius_km: 1500 });
  const across = { lat: 89, lon: 180 };
  assert.ok(distanceKm({ lat: 80, lon: 0 }, across) < 1500);
  assert.ok(areaContains(polar, across));
  assert.equal(polar.west, -180);
  assert.equal(polar.east, 180);
  assert.equal(polar.north, 90);
  // Away from the poles, sample the circle's edge and check each point is kept.
  const center = { lat: 60, lon: 20 };
  const wide = await resolveArea({ ...center, radius_km: 2000 });
  assert.ok(wide.east - wide.west < 360);
  for (let bearing = 0; bearing < 360; bearing += 5) {
    const d = 1999 / 6371.0088;
    const b = (bearing * Math.PI) / 180;
    const lat1 = (center.lat * Math.PI) / 180;
    const lat2 = Math.asin(
      Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(b),
    );
    const lon2 =
      (center.lon * Math.PI) / 180 +
      Math.atan2(
        Math.sin(b) * Math.sin(d) * Math.cos(lat1),
        Math.cos(d) - Math.sin(lat1) * Math.sin(lat2),
      );
    const point = { lat: (lat2 * 180) / Math.PI, lon: (lon2 * 180) / Math.PI };
    assert.ok(areaContains(wide, point), `bearing ${bearing}`);
  }
});

test('lines touch an area when a segment crosses it with no vertex inside', async () => {
  const box = await resolveArea({ bbox: [-1, -1, 1, 1] });
  assert.ok(
    lineTouchesArea(
      [
        [-2, 0],
        [2, 0],
      ],
      box,
    ),
  );
  assert.ok(
    !lineTouchesArea(
      [
        [-2, 2],
        [2, 2],
      ],
      box,
    ),
  );
  const circle = await resolveArea({ lat: 0, lon: 0, radius_km: 50 });
  assert.ok(
    lineTouchesArea(
      [
        [-2, 0.3],
        [2, 0.3],
      ],
      circle,
    ),
  );
  // Inside the circle's box but beyond its radius.
  assert.ok(
    !lineTouchesArea(
      [
        [0.3, 0.42],
        [0.6, 0.42],
      ],
      circle,
    ),
  );
  const dateline = await resolveArea({ bbox: [179, -1, -179, 1] });
  assert.ok(
    lineTouchesArea(
      [
        [178, 0],
        [-178, 0],
      ],
      dateline,
    ),
  );
  const nearDateline = await resolveArea({ bbox: [179.5, -1, 179.9, 1] });
  assert.ok(
    lineTouchesArea(
      [
        [179, 0],
        [-179, 0],
      ],
      nearDateline,
    ),
  );
  assert.ok(
    !lineTouchesArea(
      [
        [170, 0],
        [175, 0],
      ],
      nearDateline,
    ),
  );
});

test('polygons touch an area by vertex, crossing edge or enclosing it', async () => {
  const box = await resolveArea({ bbox: [-1, -1, 1, 1] });
  const square = (half, x = 0) => [
    [
      [x - half, -half],
      [x + half, -half],
      [x + half, half],
      [x - half, half],
    ],
  ];
  assert.ok(polygonsTouchArea([square(5)], box), 'encloses the area');
  assert.ok(polygonsTouchArea([square(0.5)], box), 'inside the area');
  assert.ok(polygonsTouchArea([square(1, 1.5)], box), 'overlaps an edge');
  assert.ok(!polygonsTouchArea([square(0.5, 5)], box), 'elsewhere');
  const ring = [...square(5), ...square(3)];
  assert.ok(!polygonsTouchArea([ring], box), 'the area sits in a hole');
  const circle = await resolveArea({ lat: 0, lon: 0, radius_km: 20 });
  assert.ok(polygonsTouchArea([square(5)], circle));
});

test('a box radius reaches every point of the box, however large', async () => {
  const world = await resolveArea({ bbox: [-180, -90, 180, 90] });
  assert.ok(Math.abs(areaRadiusKm(world) - Math.PI * 6371.0088) < 1);
  const wide = await resolveArea({ bbox: [-60, -70, 100, 60] });
  const radius = areaRadiusKm(wide);
  const center = areaCenter(wide);
  for (let lat = -70; lat <= 60; lat += 2.5)
    for (let lon = -60; lon <= 100; lon += 2.5)
      assert.ok(
        distanceKm(center, { lat, lon }) <= radius + 0.5,
        `${lat},${lon}`,
      );
  const small = await resolveArea({ bbox: [-97.94, 30.1, -97.56, 30.52] });
  assert.ok(areaRadiusKm(small) < 30);
});
