// src/data/aircraftClass.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AIRCRAFT_CLASS_LABELS, classifyAircraft } from './aircraftClass.js';

test('type-code classification (military layer path)', () => {
  assert.equal(classifyAircraft({ typeCode: 'F16' }), 'fastjet');
  assert.equal(classifyAircraft({ typeCode: 'EC35' }), 'helicopter');
  assert.equal(classifyAircraft({ typeCode: 'B744' }), 'quadjet');
  assert.equal(classifyAircraft({ typeCode: 'B77W' }), 'widebody');
  assert.equal(classifyAircraft({ typeCode: 'C17' }), 'widebody');
  assert.equal(classifyAircraft({ typeCode: 'AT76' }), 'turboprop');
  assert.equal(classifyAircraft({ typeCode: 'C172' }), 'light');
  assert.equal(classifyAircraft({ typeCode: 'b738' }), 'airliner'); // case-insensitive default-jet
});

test('bizjet + uav classes (2026-08-16 Hangar fleet)', () => {
  assert.equal(classifyAircraft({ typeCode: 'C25A' }), 'bizjet');
  assert.equal(classifyAircraft({ typeCode: 'C56X' }), 'bizjet');
  assert.equal(classifyAircraft({ typeCode: 'GLF5' }), 'bizjet');
  assert.equal(classifyAircraft({ typeCode: 'CL60' }), 'bizjet');
  // SF50 Cirrus Vision Jet is a JET — it must NOT fall back to the light/prop class.
  assert.equal(classifyAircraft({ typeCode: 'SF50' }), 'bizjet');
  assert.equal(classifyAircraft({ typeCode: 'MQ9' }), 'uav');
  assert.equal(classifyAircraft({ typeCode: 'Q4' }), 'uav');
  assert.equal(classifyAircraft({ typeCode: 'TB2' }), 'uav');
});

test('category fallback (flights layer path — OpenSky extended int)', () => {
  assert.equal(classifyAircraft({ category: 8 }), 'helicopter');
  assert.equal(classifyAircraft({ category: 6 }), 'widebody');
  assert.equal(classifyAircraft({ category: 7 }), 'fastjet');
  assert.equal(classifyAircraft({ category: 2 }), 'light');
  assert.equal(classifyAircraft({ category: 9 }), 'glider');
  assert.equal(classifyAircraft({ category: 4 }), 'airliner');
});

test('ADS-B emitter string categories', () => {
  assert.equal(classifyAircraft({ category: 'A7' }), 'helicopter');
  assert.equal(classifyAircraft({ category: 'A5' }), 'widebody');
  assert.equal(classifyAircraft({ category: 'A1' }), 'light');
  assert.equal(classifyAircraft({ category: 'B1' }), 'glider');
});

test('typeCode outranks category; unknown → airliner', () => {
  assert.equal(classifyAircraft({ typeCode: 'F18', category: 6 }), 'fastjet');
  assert.equal(classifyAircraft({}), 'airliner');
  assert.equal(classifyAircraft({ typeCode: null, category: 0 }), 'airliner');
});

test('every class has a label', () => {
  for (const kind of [
    'light',
    'glider',
    'turboprop',
    'airliner',
    'widebody',
    'quadjet',
    'helicopter',
    'fastjet',
    'bizjet',
    'uav',
    'vehicle',
    'station',
  ]) {
    assert.ok(AIRCRAFT_CLASS_LABELS[kind], kind);
  }
});

test('airport vehicles and ground stations class apart from aircraft', () => {
  // A feed's own types, in any case.
  assert.equal(classifyAircraft({ typeCode: 'ZVEH' }), 'vehicle');
  assert.equal(classifyAircraft({ typeCode: ' zveh ' }), 'vehicle');
  assert.equal(classifyAircraft({ typeCode: 'GRND' }), 'station');
  // Emitter categories: surface vehicles, then obstacles.
  assert.equal(classifyAircraft({ category: 'C1' }), 'vehicle');
  assert.equal(classifyAircraft({ category: 'C2' }), 'vehicle');
  for (const category of ['C3', 'C4', 'C5'])
    assert.equal(classifyAircraft({ category }), 'station', category);
  // OpenSky's integer categories for the same.
  assert.equal(classifyAircraft({ category: 16 }), 'vehicle');
  assert.equal(classifyAircraft({ category: 17 }), 'vehicle');
  assert.equal(classifyAircraft({ category: 18 }), 'station');
  // A type code still outranks the category.
  assert.equal(
    classifyAircraft({ typeCode: 'ZVEH', category: 'A3' }),
    'vehicle',
  );
  assert.equal(
    classifyAircraft({ typeCode: 'A320', category: 'C1' }),
    'airliner',
  );
});

test('helicopter types and categories', () => {
  for (const typeCode of ['EC35', 'R44', 'S76', 'H60', 'AS50', 'B407'])
    assert.equal(classifyAircraft({ typeCode }), 'helicopter', typeCode);
  assert.equal(classifyAircraft({ category: 'A7' }), 'helicopter');
  assert.equal(classifyAircraft({ category: 8 }), 'helicopter');
});
