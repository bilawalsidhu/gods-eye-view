import test from 'node:test';
import assert from 'node:assert/strict';
import { aircraftTypeCardModel } from './typeCard.js';

const tracked = {
  icao24: '4b1814',
  callsign: 'SWR100 ',
  registration: 'HB-JNA',
  typeCode: 'B789',
  altitudeM: 11277,
  velocityMps: 251.4,
  track: 281.6,
  latitude: 47.45,
  longitude: 8.55,
  origin: 'ZRH',
  destination: 'JFK',
};

test('a known civil type resolves to its name, class and photo', () => {
  const model = aircraftTypeCardModel(tracked, { isMilitary: false });
  assert.equal(model.faction, 'civil');
  assert.equal(model.type.name, 'Boeing 787-9');
  assert.equal(model.type.manufacturer, 'Boeing Commercial Airplanes');
  assert.equal(model.photo.path, '/aircraft-types/B789.webp');
  assert.ok(model.photo.licence);
  assert.ok(model.photo.sourceUrl);
});

test('the type spec figures reach the card', () => {
  const { specs } = aircraftTypeCardModel(tracked, { isMilitary: false });
  assert.ok(specs.lengthM > 50 && specs.spanM > 50);
  assert.equal(specs.engines, 2);
});

test('identity and telemetry pass through trimmed', () => {
  const model = aircraftTypeCardModel(tracked, { isMilitary: false });
  assert.deepEqual(model.identity, {
    callsign: 'SWR100',
    registration: 'HB-JNA',
    icao24: '4b1814',
    typeCode: 'B789',
  });
  assert.deepEqual(model.telemetry, {
    altitudeM: 11277,
    speedMs: 251.4,
    headingDeg: 281.6,
    lat: 47.45,
    lon: 8.55,
    origin: 'ZRH',
    destination: 'JFK',
  });
});

test('the military flag decides the faction', () => {
  const model = aircraftTypeCardModel(tracked, { isMilitary: true });
  assert.equal(model.faction, 'military');
});

test('a lower-case, padded type code still resolves', () => {
  const model = aircraftTypeCardModel(
    { ...tracked, typeCode: ' b789 ' },
    { isMilitary: false },
  );
  assert.equal(model.type.name, 'Boeing 787-9');
});

test('an unknown type keeps a valid model with the raw code and no type data', () => {
  const model = aircraftTypeCardModel(
    { ...tracked, typeCode: 'ZZZZ' },
    { isMilitary: false },
  );
  assert.equal(model.type, null);
  assert.equal(model.specs, null);
  assert.equal(model.photo, null);
  assert.equal(model.identity.typeCode, 'ZZZZ');
  assert.equal(model.telemetry.altitudeM, 11277);
});

test('a contact with nothing known still yields a model with null fields', () => {
  const model = aircraftTypeCardModel(null, { isMilitary: false });
  assert.equal(model.type, null);
  assert.equal(model.identity.callsign, null);
  assert.equal(model.telemetry.altitudeM, null);
  assert.equal(model.telemetry.headingDeg, null);
});

test('the operator and country slots exist and stay null', () => {
  const model = aircraftTypeCardModel(tracked, { isMilitary: false });
  assert.equal(model.operator, null);
  assert.equal(model.country, null);
  assert.ok('operator' in model && 'country' in model);
});

test('a heading of zero is kept, not treated as missing', () => {
  const model = aircraftTypeCardModel(
    { ...tracked, track: 0, altitudeM: 0 },
    { isMilitary: false },
  );
  assert.equal(model.telemetry.headingDeg, 0);
  assert.equal(model.telemetry.altitudeM, 0);
});
