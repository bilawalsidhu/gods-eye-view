import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  aircraftLayerPartState,
  aircraftPartState,
  enginesTurn,
  gearDown,
  groundVehiclePartState,
  SPIN_RATES_DPS,
  vesselPartState,
} from './modelPartDrivers.js';
import { fleetPartTable } from './fleetModels.js';
import { partTableOf } from '../render/modelParts.js';
import { partsModelGlb } from '../render/conformance/partsModel.js';

const AIRLINER = partTableOf({
  parts: [
    { name: 'body', kind: 'body' },
    { name: 'flap_right', kind: 'hinge', axis: [0, 0, -1], limits: [0, 40] },
    { name: 'engine_right', kind: 'marker' },
    {
      name: 'fan_right',
      kind: 'spin',
      parent: 'engine_right',
      axis: [1, 0, 0],
    },
    { name: 'gear_nose', kind: 'hinge', axis: [0, 0, 1], limits: [90, 0] },
    {
      name: 'door_nose_right',
      kind: 'hinge',
      axis: [1, 0, 0],
      limits: [0, 90],
    },
    { name: 'gear_right', kind: 'hinge', axis: [-1, 0, 0], limits: [90, 0] },
  ],
});

const HELICOPTER = partTableOf({
  parts: [
    { name: 'body', kind: 'body' },
    { name: 'rotor_main', kind: 'spin', axis: [0, 1, 0] },
    { name: 'rotor_tail', kind: 'spin', axis: [0, 0, -1] },
    { name: 'skids', kind: 'marker' },
  ],
});

const TRAWLER = partTableOf({
  parts: [
    { name: 'body', kind: 'body' },
    { name: 'radar', kind: 'spin', pivot: [-4, 10, 0], axis: [0, 1, 0] },
    { name: 'bridge', kind: 'marker' },
  ],
});

const BUS = partTableOf({
  parts: [
    { name: 'body', kind: 'body' },
    {
      name: 'doors_right',
      kind: 'slide',
      pivot: [-4.75, 0.35, -1.3],
      axis: [1, 0, 0],
      limits: [0, 1.08],
    },
    { name: 'axle_1', kind: 'spin', pivot: [-3.3, 0.5, 0], axis: [0, 0, -1] },
    { name: 'axle_2', kind: 'spin', pivot: [2.6, 0.5, 0], axis: [0, 0, -1] },
  ],
});

test('the gear is down on the ground and up in cruise', () => {
  assert.equal(gearDown({ onGround: true }), 1);
  assert.equal(gearDown({ heightAboveGroundM: 10000, verticalRateMps: 0 }), 0);
  assert.equal(
    gearDown({ heightAboveGroundM: 10000, verticalRateMps: -10 }),
    0,
  );
  // No height known: up.
  assert.equal(gearDown({ heightAboveGroundM: null }), 0);
});

test('without a ground height, the gear is down on approach: descending, slow and low', () => {
  // Denver: 1,650 m up, the ground under it unknown.
  const at = (fields) => gearDown({ heightAboveGroundM: null, ...fields });
  assert.equal(at({ altitudeM: 2000, verticalRateMps: -4, speedMps: 70 }), 1);
  // Climbing out, cruising, or descending fast: up.
  assert.equal(at({ altitudeM: 2000, verticalRateMps: 8, speedMps: 70 }), 0);
  assert.equal(at({ altitudeM: 11000, verticalRateMps: -4, speedMps: 70 }), 0);
  assert.equal(at({ altitudeM: 3000, verticalRateMps: -8, speedMps: 140 }), 0);
  // Without a speed it cannot tell: up.
  assert.equal(at({ altitudeM: 2000, verticalRateMps: -4 }), 0);
});

test('on approach the gear comes down between 750 and 600 m above the ground', () => {
  const at = (h) => gearDown({ heightAboveGroundM: h, verticalRateMps: -4 });
  assert.equal(at(800), 0);
  assert.equal(at(675), 0.5);
  assert.equal(at(600), 1);
  assert.equal(at(50), 1);
});

test('climbing or level, the gear goes up between 100 and 300 m', () => {
  const at = (h) => gearDown({ heightAboveGroundM: h, verticalRateMps: 8 });
  assert.equal(at(50), 1);
  assert.equal(at(200), 0.5);
  assert.equal(at(300), 0);
  assert.equal(at(700), 0);
  // Level at 700 m: up; descending through it: up until the approach band.
  assert.equal(gearDown({ heightAboveGroundM: 700, verticalRateMps: 0 }), 0);
});

test('an airliner in cruise spins its fans, gear, doors and flaps up', () => {
  const state = aircraftPartState(AIRLINER, {
    onGround: false,
    heightAboveGroundM: 11000,
    verticalRateMps: 0,
    speedMps: 230,
  });
  assert.deepEqual(state, {
    spin: { fan_right: SPIN_RATES_DPS.fan },
    deploy: {
      flap_right: 0,
      gear_nose: 0,
      door_nose_right: 0,
      gear_right: 0,
    },
  });
});

test('an airliner on final has gear, doors and flaps down', () => {
  const state = aircraftPartState(AIRLINER, {
    onGround: false,
    heightAboveGroundM: 300,
    verticalRateMps: -4,
    speedMps: 70,
  });
  assert.deepEqual(state.deploy, {
    flap_right: 1,
    gear_nose: 1,
    door_nose_right: 1,
    gear_right: 1,
  });
  // The doors open over the first quarter of the gear's travel.
  const coming = aircraftPartState(AIRLINER, {
    heightAboveGroundM: 745,
    verticalRateMps: -4,
  });
  assert.ok(coming.deploy.gear_nose > 0 && coming.deploy.gear_nose < 0.25);
  assert.ok(coming.deploy.door_nose_right > coming.deploy.gear_nose);
});

test('parked, its engines stop; taxiing, they turn; its flaps are up on the ground', () => {
  const parked = aircraftPartState(AIRLINER, { onGround: true, speedMps: 0 });
  assert.equal(parked.spin, undefined);
  assert.equal(parked.deploy.gear_nose, 1);
  assert.equal(parked.deploy.flap_right, 0);
  const taxiing = aircraftPartState(AIRLINER, { onGround: true, speedMps: 8 });
  assert.equal(taxiing.spin.fan_right, SPIN_RATES_DPS.fan);
});

test('a helicopter’s rotors turn in the air and stop on the ground', () => {
  const flying = aircraftPartState(HELICOPTER, {
    onGround: false,
    heightAboveGroundM: 300,
  });
  assert.deepEqual(flying, {
    spin: {
      rotor_main: SPIN_RATES_DPS.rotor,
      rotor_tail: SPIN_RATES_DPS.rotor_tail,
    },
  });
  assert.equal(
    aircraftPartState(HELICOPTER, { onGround: true, speedMps: 0 }),
    undefined,
  );
});

test('a vessel’s radar sweeps while it is under way', () => {
  assert.deepEqual(vesselPartState(TRAWLER, { speedMps: 4 }), {
    spin: { radar: SPIN_RATES_DPS.radar },
  });
  assert.equal(vesselPartState(TRAWLER, { speedMps: 0.2 }), undefined);
  assert.equal(vesselPartState(TRAWLER, { speedMps: null }), undefined);
  // A model without a radar, or without a table, gets nothing.
  assert.equal(vesselPartState(HELICOPTER, { speedMps: 4 }), undefined);
  assert.equal(vesselPartState(null, { speedMps: 4 }), undefined);
});

test('a bus’s wheels roll with its speed, top forward; its doors open at a stop', () => {
  const moving = groundVehiclePartState(BUS, { speedMps: 10 });
  // 10 m/s on 0.5 m wheels: 20 rad/s, about +Z (its left), the top rolling forward.
  const rate = -(10 / 0.5) * (180 / Math.PI);
  assert.ok(Math.abs(moving.spin.axle_1 - rate) < 1e-9);
  assert.equal(moving.deploy, undefined);
  const stopped = groundVehiclePartState(BUS, { speedMps: 0, atStop: true });
  assert.deepEqual(stopped, { deploy: { doors_right: 1 } });
  assert.equal(
    groundVehiclePartState(BUS, { speedMps: 0, atStop: false }),
    undefined,
  );
  // Speeds are rounded: 10.1 m/s turns the wheels as 10 does.
  assert.deepEqual(groundVehiclePartState(BUS, { speedMps: 10.1 }), moving);
});

test('an airport vehicle rolls its wheels and never holds its doors open; an aircraft is posed as one', () => {
  // A van: wheels roll with its speed.
  const rolling = aircraftLayerPartState(BUS, {
    klass: 'vehicle',
    onGround: true,
    speedMps: 10,
  });
  assert.deepEqual(rolling, groundVehiclePartState(BUS, { speedMps: 10 }));
  assert.ok(rolling.spin.axle_1 !== 0);
  // Stopped on the apron it is not at a stop: its doors stay shut.
  assert.equal(
    aircraftLayerPartState(BUS, {
      klass: 'vehicle',
      onGround: true,
      speedMps: 0,
    }),
    undefined,
  );
  // Every other class is an aircraft.
  const flying = {
    klass: 'helicopter',
    onGround: false,
    heightAboveGroundM: 300,
  };
  assert.deepEqual(
    aircraftLayerPartState(HELICOPTER, flying),
    aircraftPartState(HELICOPTER, flying),
  );
});

test('engines and rotors turn in the air, or on the ground faster than 1 m/s', () => {
  assert.equal(enginesTurn({ onGround: false }), true);
  assert.equal(enginesTurn({ onGround: true, speedMps: 0 }), false);
  assert.equal(enginesTurn({ onGround: true, speedMps: 1 }), false);
  assert.equal(enginesTurn({ onGround: true, speedMps: 1.5 }), true);
  assert.equal(enginesTurn({ onGround: true, speedMps: null }), false);
  assert.equal(enginesTurn({ onGround: true, speedMps: Number.NaN }), false);
});

test('a model of a loaded set has its part table, read once', () => {
  const set = { bytes: new Map([['pod', partsModelGlb()]]) };
  const table = fleetPartTable(set, 'pod');
  assert.deepEqual(
    table.parts.map((p) => p.name),
    ['body', 'pod', 'ram', 'arm'],
  );
  assert.equal(fleetPartTable(set, 'pod'), table);
  assert.equal(fleetPartTable(set, 'missing'), null);
  assert.equal(fleetPartTable(null, 'pod'), null);
  // A model without a table has none.
  const plain = { bytes: new Map([['x', new Uint8Array(4)]]) };
  assert.equal(fleetPartTable(plain, 'x'), null);
});
