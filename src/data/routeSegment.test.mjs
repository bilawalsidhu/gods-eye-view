import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { routePlausible } from './routePlausible.js';
import { createTracking } from '../layers/flights/tracking.js';

const SFO = { lat: 37.6188, lon: -122.3754, code: 'SFO' };
const LAX = { lat: 33.9416, lon: -118.4085, code: 'LAX' };
const beyond = { lat: -35.818227816411174, lon: -66.16647396367095 };
const behind = { lat: 35.818227816411174, lon: 113.83352603632906 };
const antipode = { lat: -SFO.lat, lon: SFO.lon + 180 };
const midpoint = { lat: 35.8, lon: -120.4 };

const plausible = (position, origin = SFO, destination = LAX) =>
  routePlausible({
    latDeg: position.lat,
    lonDeg: position.lon,
    altitudeM: 10000,
    verticalRateMps: 0,
    origin,
    destination,
  });

// Independent spherical oracle: native unit-vector angular distances, without
// the production bearing/cross-track/along-track calculations.
const unit = ({ lat, lon }) => {
  const latitude = Cesium.Math.toRadians(lat);
  const longitude = Cesium.Math.toRadians(lon);
  return new Cesium.Cartesian3(
    Math.cos(latitude) * Math.cos(longitude),
    Math.cos(latitude) * Math.sin(longitude),
    Math.sin(latitude),
  );
};
const angle = (a, b) => Cesium.Cartesian3.angleBetween(unit(a), unit(b));
const excess = (position, origin, destination) =>
  angle(origin, position) +
  angle(position, destination) -
  angle(origin, destination);

test('a short airport route cannot describe a plane thousands of kilometres beyond its destination', () => {
  assert.ok(excess(beyond, SFO, LAX) > 2.9);
  assert.equal(plausible(beyond), false);
});

test('backwards and antipodal extensions are not the scheduled airport leg', () => {
  for (const position of [behind, antipode]) {
    assert.ok(excess(position, SFO, LAX) > 3);
    assert.equal(plausible(position), false);
  }
});

test('ordinary route offsets and generous endpoint extensions stay plausible', () => {
  assert.ok(excess(midpoint, SFO, LAX) < 0.001);
  for (const position of [midpoint, SFO, LAX, { lat: 36.5, lon: -119.5 }]) {
    assert.equal(plausible(position), true);
  }
  // ~167 km past either endpoint is outside the 130 km endpoint circle,
  // but remains inside the 200 km coarse-route tolerance.
  const origin = { lat: 0, lon: 0 };
  const destination = { lat: 0, lon: 10 };
  assert.equal(plausible({ lat: 0, lon: -1.5 }, origin, destination), true);
  assert.equal(plausible({ lat: 0, lon: 11.5 }, origin, destination), true);
});

test('the generous endpoint tolerance still excludes a clearly different leg', () => {
  const origin = { lat: 0, lon: 0 };
  const destination = { lat: 0, lon: 10 };
  assert.equal(plausible({ lat: 0, lon: -2.5 }, origin, destination), false);
  assert.equal(plausible({ lat: 0, lon: 12.5 }, origin, destination), false);
});

test('minor-arc admission works across the antimeridian and near the pole', () => {
  const dateline = [
    { lat: 10, lon: 170 },
    { lat: 10, lon: -170 },
  ];
  assert.equal(plausible({ lat: 10.15, lon: 180 }, ...dateline), true);
  assert.equal(plausible({ lat: -10.15, lon: 0 }, ...dateline), false);
  const polar = [
    { lat: 80, lon: -60 },
    { lat: 80, lon: 60 },
  ];
  const top = { lat: 84.96163122670251, lon: 0 };
  assert.ok(excess(top, ...polar) < 1e-8);
  assert.equal(plausible(top, ...polar), true);
  assert.equal(plausible({ lat: -top.lat, lon: 180 }, ...polar), false);
});

test('the forward tolerance survives the signed-angle branch cut in both directions', () => {
  const origin = { lat: 0, lon: 0 };
  for (const direction of [-1, 1]) {
    const destination = { lat: 0, lon: direction * 179.9 };
    const within = { lat: 0, lon: direction * -178.8 };
    const endpointGapKm = angle(destination, within) * 6371.0088;
    assert.ok(endpointGapKm > 130 && endpointGapKm < 200);
    assert.equal(plausible(within, origin, destination), true);
    assert.equal(
      plausible({ lat: 0, lon: direction * -178 }, origin, destination),
      false,
    );
  }
});

test('unjudgeable endpoint geometry and missing coordinates keep the loose contract', () => {
  assert.equal(
    plausible({ lat: 0, lon: -90 }, { lat: 0, lon: 0 }, { lat: 0, lon: 180 }),
    true,
  );
  assert.equal(
    plausible({ lat: 45, lon: 0 }, { lat: 0, lon: 0 }, { lat: 0, lon: 0 }),
    true,
  );
  assert.equal(plausible(beyond, SFO, null), true);
  assert.equal(plausible(beyond, null, null), true);
});

test('the actual native tracked label hides the wrong leg and keeps a healthy route', (t) => {
  const collection = new Cesium.BillboardCollection();
  t.after(() => collection.destroy());
  const flightState = {
    records: { data: new Map(), missingPolls: new Map() },
    feed: { _backoff: false },
    _billboards: new Map(),
    _scratchCarto: new Cesium.Cartographic(),
  };
  // Only application host services are supplied. Route admission, WGS84
  // billboard conversion and tracked-label formatting are the actual owners.
  const services = Object.fromEntries(
    [
      'context',
      'trails',
      'geoid',
      'groundFloor',
      'focus',
      'militaryRegistry',
      'readout',
      'camera',
      'picking',
    ].map((name) => [name, {}]),
  );
  services.aircraftPresentation = { isTr3b: () => false };
  const parts = { queries: { _contactLabel: (_, info) => info.callsign } };
  const tracking = createTracking({ flightState, services, parts });
  for (const [position, expected] of [
    [beyond, false],
    [midpoint, true],
  ]) {
    const id = 'abc001';
    const route = { origin: SFO, destination: LAX };
    flightState.records.data.set(id, {
      callsign: 'OWNED001',
      altitude: 10000,
      verticalRate: 0,
      route,
    });
    flightState._billboards.set(
      id,
      collection.add({
        id,
        position: Cesium.Cartesian3.fromDegrees(
          position.lon,
          position.lat,
          10000,
        ),
      }),
    );
    assert.equal(
      tracking._trackedLabelText(id).includes('SFO → LAX'),
      expected,
    );
    assert.equal(tracking._routeIsPlausible(id, route), expected);
  }
});
