import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeNgsiVehicles, normalizeNgsiVehicle } from './ngsiVehicles.js';
import {
  GTFS_INCREMENTALITY_FULL_DATASET,
  GTFS_MAX_STRING_CHARS,
} from './gtfsRealtime.js';

/** One STCP entity as the Porto broker sent it on 2026-11-07 (trimmed). */
function stcpEntity(overrides = {}) {
  return {
    id: 'urn:ngsi-ld:Vehicle:porto:stcp:bus:3466',
    type: 'Vehicle',
    annotations: {
      type: 'Array',
      value: [
        'stcp:route:200',
        'stcp:nr_turno:na',
        'stcp:nr_viagem:200_0_1|332|D2|T8|N7',
        'stcp:sentido:0',
      ],
      metadata: {},
    },
    bearing: { type: 'Number', value: 262, metadata: {} },
    fleetVehicleId: { type: 'Text', value: '3466', metadata: {} },
    heading: { type: 'Number', value: 262, metadata: {} },
    location: {
      type: 'geo:json',
      value: { type: 'Point', coordinates: [-8.660084724, 41.150615692] },
      metadata: {},
    },
    observationDateTime: {
      type: 'DateTime',
      value: '2026-11-07T23:28:06.00Z',
      metadata: {},
    },
    speed: { type: 'Number', value: 9.4, metadata: {} },
    vehicleType: { type: 'Text', value: 'bus', metadata: {} },
    ...overrides,
  };
}

const bytesOf = (value) => new TextEncoder().encode(JSON.stringify(value));

test('an STCP Vehicle entity becomes the same record a GTFS-RT vehicle does', () => {
  assert.deepEqual(normalizeNgsiVehicle(stcpEntity()), {
    id: '3466',
    lat: 41.150616,
    lon: -8.660085,
    bearing: 262,
    speedMps: 9.4,
    timestamp: Date.parse('2026-11-07T23:28:06Z') / 1000,
    routeId: '200',
    tripId: null,
    directionId: 0,
    label: '3466',
    stopId: null,
    status: null,
    occupancy: null,
  });
});

test('keyValues entities read the same as normalized ones', () => {
  const record = normalizeNgsiVehicle({
    id: 'urn:x',
    fleetVehicleId: '1395',
    location: { type: 'Point', coordinates: [-8.6, 41.16] },
    heading: -90,
    speed: 0,
    observationDateTime: '2026-11-07T23:28:06+00:00',
    annotations: ['stcp:route:ZC', 'stcp:sentido:1'],
  });
  assert.equal(record.id, '1395');
  assert.equal(record.bearing, 270, 'heading stands in and wraps to 0–360');
  assert.equal(record.speedMps, 0);
  assert.equal(record.routeId, 'ZC');
  assert.equal(record.directionId, 1);
});

test('no position, null island, or out-of-range coordinates yield no record', () => {
  assert.equal(normalizeNgsiVehicle(stcpEntity({ location: undefined })), null);
  for (const coordinates of [[0, 0], [-8.6, 95], ['-8.6', '41.1'], [-8.6]]) {
    assert.equal(
      normalizeNgsiVehicle(
        stcpEntity({ location: { value: { type: 'Point', coordinates } } }),
      ),
      null,
      JSON.stringify(coordinates),
    );
  }
  assert.equal(
    normalizeNgsiVehicle(
      stcpEntity({
        location: { value: { type: 'LineString', coordinates: [-8.6, 41] } },
      }),
    ),
    null,
    'only a Point is a vehicle position',
  );
  assert.equal(normalizeNgsiVehicle(null), null);
  assert.equal(normalizeNgsiVehicle([stcpEntity()]), null);
});

test('an over-long string drops the whole record rather than truncating it', () => {
  const long = 'x'.repeat(GTFS_MAX_STRING_CHARS + 1);
  assert.equal(
    normalizeNgsiVehicle(stcpEntity({ fleetVehicleId: { value: long } })),
    null,
  );
  assert.equal(
    normalizeNgsiVehicle(stcpEntity({ annotations: { value: [long] } })),
    null,
  );
  assert.equal(
    normalizeNgsiVehicle(
      stcpEntity({ annotations: { value: [`stcp:route:${long}`] } }),
    ),
    null,
  );
});

test('the entity id stands in when the fleet number is missing', () => {
  const record = normalizeNgsiVehicle(
    stcpEntity({ fleetVehicleId: undefined }),
  );
  assert.equal(record.id, 'urn:ngsi-ld:Vehicle:porto:stcp:bus:3466');
  assert.equal(record.label, null);
});

test('a loose or zoneless time is no time, and a negative speed is no speed', () => {
  for (const value of [
    '2026-11-07 23:28:06',
    '2026-11-07T23:28:06',
    'yesterday',
    1_762_558_086,
  ]) {
    assert.equal(
      normalizeNgsiVehicle(stcpEntity({ observationDateTime: { value } }))
        .timestamp,
      null,
      String(value),
    );
  }
  assert.equal(
    normalizeNgsiVehicle(stcpEntity({ speed: { value: -1 } })).speedMps,
    null,
  );
  assert.equal(
    normalizeNgsiVehicle(stcpEntity({ speed: { value: '9' } })).speedMps,
    null,
  );
});

test('calendar-invalid observation times cannot be reinterpreted as newer bus fixes', () => {
  for (const value of [
    '2026-02-30T23:28:06Z',
    '2026-04-31T23:28:06+00:00',
    '2025-02-29T23:28:06Z',
  ]) {
    const record = normalizeNgsiVehicle(
      stcpEntity({ observationDateTime: { value } }),
    );
    assert.equal(record.timestamp, null, value);
  }
  const leapTime = '2024-02-29T23:28:06Z';
  const leapRecord = normalizeNgsiVehicle(
    stcpEntity({ observationDateTime: { value: leapTime } }),
  );
  assert.equal(leapRecord.timestamp, Date.parse(leapTime) / 1000);
});

test('decoding an entity array gives a full-dataset snapshot, newest fix per vehicle', () => {
  const older = stcpEntity({
    observationDateTime: { value: '2026-11-07T23:27:00Z' },
    speed: { value: 1 },
  });
  const other = stcpEntity({
    id: 'urn:ngsi-ld:Vehicle:porto:stcp:bus:1395',
    fleetVehicleId: { value: '1395' },
  });
  const decoded = decodeNgsiVehicles(
    bytesOf([stcpEntity(), older, other, { junk: true }]),
  );
  assert.equal(decoded.incrementality, GTFS_INCREMENTALITY_FULL_DATASET);
  assert.equal(decoded.entityCount, 4);
  assert.equal(decoded.truncated, false);
  assert.equal(decoded.version, null);
  assert.equal(decoded.timestamp, null);
  assert.deepEqual(decoded.vehicles.map((v) => v.id).sort(), ['1395', '3466']);
  assert.equal(
    decoded.vehicles.find((v) => v.id === '3466').speedMps,
    9.4,
    'the newer of two fixes for one bus wins',
  );
});

test('a body that is not an NGSI entity array is an upstream failure', () => {
  assert.throws(() => decodeNgsiVehicles(bytesOf({ error: 'BadRequest' })), {
    message: /not an NGSI entity array/,
  });
  assert.throws(() => decodeNgsiVehicles(new TextEncoder().encode('<html>')), {
    message: /not JSON/,
  });
  assert.deepEqual(decodeNgsiVehicles(bytesOf([])).vehicles, []);
});
