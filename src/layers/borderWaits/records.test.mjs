import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { decodeRing } from '../../data/adminBoundaries.js';
import { normalizeBorderWaitSnapshot } from './records.js';
import { BORDER_CROSSING_LOCATIONS } from './crossings.js';
import { cbpPort, cbpPedestrianPort, FIXTURE_LOCATIONS } from './fixture.mjs';

test('a crossing keeps its reported lanes, in card order, and drops N/A lanes', () => {
  const { rows, unlocated } = normalizeBorderWaitSnapshot(
    [cbpPort()],
    FIXTURE_LOCATIONS,
  );
  assert.deepEqual(unlocated, []);
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.equal(row.id, '380001');
  assert.equal(row.border, 'canada');
  assert.equal(row.port, 'Detroit');
  assert.equal(row.crossing, 'Ambassador Bridge');
  assert.equal(row.lat, 42.3119);
  assert.equal(row.lon, -83.0741);
  assert.equal(row.portStatus, 'open');
  assert.equal(row.hours, '24 hrs/day');
  assert.match(row.notice, /^A Ready Lane is available from 11am-2pm Monday/);
  assert.deepEqual(
    row.lanes.map(({ mode, kind }) => `${mode}/${kind}`),
    [
      'passenger/standard',
      'passenger/nexus-sentri',
      'passenger/ready',
      'commercial/standard',
      'commercial/fast',
    ],
  );
  assert.deepEqual(row.lanes[0], {
    mode: 'passenger',
    kind: 'standard',
    status: 'no delay',
    delayMinutes: 5,
    lanesOpen: 2,
    updated: '9:00 am EDT',
  });
  assert.deepEqual(row.lanes[2], {
    mode: 'passenger',
    kind: 'ready',
    status: 'lanes closed',
    delayMinutes: null,
    lanesOpen: null,
    updated: null,
  });
  assert.equal(row.delayMinutes, 5);
  assert.equal(row.delayStatus, 'no delay');
});

test('a crossing with no passenger lanes is headlined by its pedestrian wait', () => {
  const [row] = normalizeBorderWaitSnapshot(
    [cbpPedestrianPort()],
    FIXTURE_LOCATIONS,
  ).rows;
  assert.equal(row.border, 'mexico');
  assert.equal(row.delayMinutes, 75);
  assert.equal(row.delayStatus, 'delay');
  assert.equal(row.notice, null);
  assert.deepEqual(
    row.lanes.map(({ mode, kind, status }) => `${mode}/${kind}/${status}`),
    ['pedestrian/standard/delay', 'pedestrian/ready/update pending'],
  );
});

test('crossings that cannot be placed are reported, not dropped silently or fatal', () => {
  const { rows, unlocated } = normalizeBorderWaitSnapshot(
    [cbpPort({ port_number: '999901' }), cbpPort(), cbpPedestrianPort()],
    FIXTURE_LOCATIONS,
  );
  assert.deepEqual(
    rows.map(({ id }) => id),
    ['380001', '250407'],
  );
  assert.deepEqual(unlocated, ['999901']);

  const unknownBorder = normalizeBorderWaitSnapshot(
    [cbpPort({ border: 'Ferry' })],
    FIXTURE_LOCATIONS,
  );
  assert.deepEqual(unknownBorder, { rows: [], unlocated: ['380001'] });
});

test('a malformed document never replaces a good snapshot', () => {
  for (const payload of [
    null,
    {},
    'ports',
    [null],
    [[]],
    [cbpPort({ port_number: 380001 })],
    [cbpPort({ port_number: '38-001' })],
    [cbpPort(), cbpPort()],
    [cbpPort({ passenger_vehicle_lanes: [] })],
    Array.from({ length: 501 }, (_, index) =>
      cbpPort({ port_number: String(100000 + index) }),
    ),
  ])
    assert.equal(
      normalizeBorderWaitSnapshot(payload, FIXTURE_LOCATIONS),
      null,
      JSON.stringify(payload)?.slice(0, 60),
    );
});

test('values outside their contract read as unreported rather than as data', () => {
  const [row] = normalizeBorderWaitSnapshot(
    [
      cbpPort({
        crossing_name: '<script>',
        hours: '',
        construction_notice: 'x'.repeat(401),
        passenger_vehicle_lanes: {
          standard_lanes: {
            update_time: 'At 9:00 am EDT',
            operational_status: 'delay',
            delay_minutes: '-5',
            lanes_open: '12345',
          },
        },
      }),
    ],
    FIXTURE_LOCATIONS,
  ).rows;
  assert.equal(row.crossing, null);
  assert.equal(row.hours, null);
  assert.equal(row.notice, null);
  assert.equal(row.lanes[0].delayMinutes, null);
  assert.equal(row.lanes[0].lanesOpen, null);
  assert.equal(row.delayMinutes, null);
});

// Every crossing in the live CBP document on 2026-10-13, by border. A crossing
// CBP adds later is logged by the proxy and listed in `unlocated` until placed.
const CANADA_2026_10_13 = [
  '010401',
  '010601',
  '011501',
  '011502',
  '011503',
  '020901',
  '021101',
  '021201',
  '070101',
  '070401',
  '070801',
  '071201',
  '090101',
  '090102',
  '090103',
  '090104',
  '300401',
  '300402',
  '300403',
  '300901',
  '302301',
  '331001',
  '340101',
  '360401',
  '380001',
  '380002',
  '380102',
  '380201',
  '380301',
  'L01901',
];
const MEXICO_2026_10_13 = [
  '202401',
  '230103',
  '230106',
  '230201',
  '230301',
  '230302',
  '230401',
  '230402',
  '230403',
  '230404',
  '230501',
  '230502',
  '230503',
  '230701',
  '230901',
  '230902',
  '231001',
  '231002',
  '240104',
  '240201',
  '240202',
  '240203',
  '240204',
  '240207',
  '240215',
  '240221',
  '240301',
  '240401',
  '240601',
  '240801',
  '250201',
  '250301',
  '250302',
  '250401',
  '250407',
  '250409',
  '250501',
  '250601',
  '250602',
  '250608',
  '250609',
  '260101',
  '260201',
  '260301',
  '260305',
  '260401',
  '260402',
  '260403',
  '260801',
  '260802',
  '535501',
  '535502',
  '535503',
  '535504',
  'l24501',
];

test('every crossing CBP reports has a bundled location on its own border', () => {
  const reported = [...CANADA_2026_10_13, ...MEXICO_2026_10_13];
  assert.equal(new Set(reported).size, 85);
  assert.deepEqual(
    reported.filter((id) => !Object.hasOwn(BORDER_CROSSING_LOCATIONS, id)),
    [],
  );
  for (const [id, { lat, lon }] of Object.entries(BORDER_CROSSING_LOCATIONS)) {
    assert.ok(reported.includes(id), `${id} is a CBP crossing`);
    // Southern crossings sit along 25.8–32.8° N; northern ones 41.9–49.1° N.
    const mexico = MEXICO_2026_10_13.includes(id);
    const [south, north, west, east] = mexico
      ? [25.8, 32.8, -117.2, -97.1]
      : [41.9, 49.1, -123.1, -66.9];
    assert.ok(
      lat >= south && lat <= north && lon >= west && lon <= east,
      `${id} at ${lat},${lon} lies on the ${mexico ? 'Mexican' : 'Canadian'} border`,
    );
  }
});

// Natural Earth admin-0 outlines (public domain), simplified to about 1 km.
const COUNTRIES = JSON.parse(
  fs.readFileSync(
    new URL(
      '../../data/local_data/natural_earth/countries.json',
      import.meta.url,
    ),
  ),
);
const outline = (iso2) =>
  COUNTRIES.features
    .find((feature) => feature.iso2 === iso2)
    .polygons.flatMap((rings) =>
      rings.map((ring) => decodeRing(ring, COUNTRIES.meta.decimals)),
    );

/** Kilometres from a point to the nearest edge of any ring (equirectangular). */
function kmToOutline(rings, lat, lon) {
  const kx = 111.32 * Math.cos((lat * Math.PI) / 180);
  const ky = 110.57;
  let best = Infinity;
  for (const ring of rings)
    for (let i = 0; i < ring.length; i++) {
      const [ax, ay] = ring[i];
      const [bx, by] = ring[(i + 1) % ring.length];
      const ux = (bx - ax) * kx;
      const uy = (by - ay) * ky;
      const px = (lon - ax) * kx;
      const py = (lat - ay) * ky;
      const t = Math.max(
        0,
        Math.min(1, (px * ux + py * uy) / (ux * ux + uy * uy || 1)),
      );
      best = Math.min(best, Math.hypot(px - t * ux, py - t * uy));
    }
  return best;
}

// The bundled outlines drop parts under 20 km², which removes the Point
// Roberts exclave, so its crossing is checked against Canada's outline only.
const EXCLAVES = new Set(['300403']);

test('every bundled location sits on the international boundary itself', () => {
  const us = outline('US');
  const neighbours = { canada: outline('CA'), mexico: outline('MX') };
  for (const [id, { lat, lon }] of Object.entries(BORDER_CROSSING_LOCATIONS)) {
    const neighbour = MEXICO_2026_10_13.includes(id)
      ? neighbours.mexico
      : neighbours.canada;
    // Near both outlines means near the shared border, not just a coastline.
    // 5 km allows for the outlines' simplification along winding rivers.
    const fromUs = EXCLAVES.has(id) ? 0 : kmToOutline(us, lat, lon);
    const fromNeighbour = kmToOutline(neighbour, lat, lon);
    assert.ok(
      Math.max(fromUs, fromNeighbour) < 5,
      `${id} is ${fromUs.toFixed(1)} km from the U.S. outline and ` +
        `${fromNeighbour.toFixed(1)} km from its neighbour's`,
    );
  }
});
