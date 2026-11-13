import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aircraftInsights,
  describeEntity,
  findRecord,
  formatFact,
  layerBreakdown,
  nearbyEntities,
  recordTitle,
  recordWarnings,
  searchEntities,
  viewSummary,
} from './entityContext.js';

/** A data manager over fixed layer records. */
function manager(layers) {
  const map = new Map(
    Object.entries(layers).map(([id, { name, records }]) => [
      id,
      { id, name, enabled: true, module: { getAnalystRecords: () => records } },
    ]),
  );
  return {
    layers: map,
    isEnabled: (id) => map.get(id)?.enabled === true,
    getAll: () => [...map.values()],
  };
}

const flights = Array.from({ length: 2500 }, (_, i) => ({
  id: `FLT${i}`,
  icao24: `a${String(i).padStart(5, '0')}`,
  callsign: `FLT${i}`,
  lat: 34 + i * 0.001,
  lon: -118,
  altitudeM: 10000,
}));
const dams = [
  { id: 'Grand Coulee Dam', name: 'Grand Coulee Dam', lat: 47.957, lon: -118.981, operator: 'Bureau of Reclamation' },
  { id: '123456', name: null, lat: 47.9, lon: -118.9, operator: 'Some Utility' },
];
const dm = manager({
  flights: { name: 'Live Flights', records: flights },
  'local-dams': { name: 'Dams', records: dams },
});

test('a click identity finds its record by key, past the first 2000 records', () => {
  const record = findRecord(dm, { layerId: 'flights', id: 'a02400', lat: 0, lon: 0 });
  assert.equal(record?.callsign, 'FLT2400');
});

test('a transit click finds its vehicle by the layer key and reads its state', () => {
  const buses = manager({
    transit: {
      name: 'Transit',
      records: [
        {
          id: 'M634',
          key: 'capmetro-austin:M634',
          route: '801',
          operator: 'CapMetro',
          status: 'IN_TRANSIT_TO',
          lat: 30.2,
          lon: -97.7,
        },
      ],
    },
  });
  const card = describeEntity(buses, {
    layerId: 'transit',
    id: 'capmetro-austin:M634',
    lat: 30.21,
    lon: -97.71,
  });
  assert.equal(card?.title, 'M634');
  const facts = Object.fromEntries(card.facts.map((fact) => [fact.label, fact.value]));
  assert.equal(facts.Operator, 'CapMetro');
  assert.equal(facts.Status, 'Heading to next stop');
  assert.equal(facts.Key, undefined, 'the layer key is not shown');
});

test('transit vehicles break down by motion, mode and reported state', () => {
  const at = { lat: 30.2, lon: -97.7 };
  const buses = manager({
    transit: {
      name: 'Transit',
      records: [
        { id: '1', mode: 'bus', motion: 'moving', status: 'IN_TRANSIT_TO', ...at },
        { id: '2', mode: 'bus', motion: 'stopped', status: 'STOPPED_AT', ...at },
        { id: '3', mode: 'rail', motion: 'moving', occupancy: 'FULL', ...at },
      ],
    },
  });
  const breakdown = layerBreakdown(buses, 'transit');
  assert.equal(breakdown.total, 3);
  const split = (title) =>
    Object.fromEntries(breakdown.splits.find((item) => item.title === title).parts.map((part) => [part.label, part.count]));
  assert.deepEqual(split('Motion'), { Moving: 2, Stopped: 1 });
  assert.deepEqual(split('Mode'), { Bus: 2, Rail: 1 });
  assert.deepEqual(split('Last reported'), { 'Heading to next stop': 1, 'Stopped at a stop': 1 });
  assert.deepEqual(split('Crowding'), { Full: 1 });
});

test('a moving item never borrows a nearby craft when its key is unknown', () => {
  const record = findRecord(dm, { layerId: 'flights', id: 'zzzzzz', label: 'NOPE', lat: 34.0004, lon: -118.05 });
  assert.equal(record, null);
});

test('an unnamed site goes by its operator, not its database number', () => {
  assert.equal(recordTitle(dams[1]), 'Some Utility');
});

test('a card lists facts with units and keeps the title out of them', () => {
  const card = describeEntity(dm, { layerId: 'flights', id: 'a00001' });
  assert.equal(card.title, 'FLT1');
  assert.equal(card.kind, 'aircraft');
  assert.ok(card.facts.some((fact) => fact.label === 'Altitude' && fact.value === '32,808 ft'));
  assert.ok(!card.facts.some((fact) => fact.value === 'FLT1'));
});

test('nearby lists the closest of the same kind and one of each other layer', () => {
  const card = describeEntity(dm, { layerId: 'local-dams', id: 'Grand Coulee Dam' });
  const { same, other } = nearbyEntities(dm, card, { radiusKm: 2000 });
  assert.equal(same[0].title, 'Some Utility');
  assert.equal(other.length, 1);
  assert.equal(other[0].layerId, 'flights');
});

test('search ranks an exact name first and needs two characters', () => {
  assert.deepEqual(searchEntities(dm, 'f'), []);
  const [first] = searchEntities(dm, 'FLT12');
  assert.equal(first.title, 'FLT12');
  assert.equal(searchEntities(dm, 'coulee')[0]?.title, 'Grand Coulee Dam');
});

test('fact formatting follows the field suffix', () => {
  assert.equal(formatFact('speedMps', 100).value, '194 kt');
  // Orbital speeds read in km/s, road and rail in km/h.
  assert.equal(formatFact('speedMps', 7670).value, '7.67 km/s');
  assert.equal(formatFact('speedMps', 10, { kind: 'vehicle' }).value, '36 km/h');
  // Units follow the field's suffix; feed codes and bare words read as words.
  assert.equal(formatFact('containedPct', 96).value, '96%');
  assert.equal(formatFact('windKt', 30).value, '30 kt');
  assert.equal(formatFact('pressureHpa', 1009).value, '1,009 hPa');
  assert.equal(formatFact('classification', 'TD').value, 'Tropical depression');
  assert.equal(formatFact('telecom', 'data_center').value, 'Data center');
  assert.equal(formatFact('icao24', 'abcdef').value, 'abcdef');
  assert.equal(formatFact('shipType', 70).value, 'Cargo');
  assert.equal(formatFact('shipType', 'Tanker').value, 'Tanker');
  assert.equal(formatFact('discoveredTime', Date.UTC(2026, 5, 29)).value, '29 Jun 2026');
  assert.equal(formatFact('updatedTime', 1_700_000_000_000, { nowMs: 1_700_000_060_000 }).age, 60_000);
  assert.equal(formatFact('altitudeM', 420000).value, '420 km');
  assert.equal(formatFact('confidence', 0.82).value, '82%');
  assert.equal(formatFact('onGround', false), null);
  assert.equal(formatFact('lastContactAtMs', 1_700_000_000_000, { nowMs: 1_700_000_060_000 }).age, 60_000);
});

test('warnings lead with an emergency, then the squawk code, and stay out of the facts', () => {
  assert.deepEqual(recordWarnings({ emergency: true, emergencyKind: 'medical' }), ['Emergency: medical']);
  assert.deepEqual(recordWarnings({ squawk: '7600' }), ['Radio failure (squawk 7600)']);
  assert.deepEqual(recordWarnings({ squawk: '1200', emergencyKind: 'none' }), []);
  assert.deepEqual(recordWarnings({ tsunami: 1 }), ['Tsunami warning issued']);
  const urgent = manager({
    flights: { name: 'Live Flights', records: [{ id: 'X1', icao24: 'x00001', callsign: 'X1', lat: 1, lon: 1, emergency: true, emergencyKind: 'fuel' }] },
  });
  const card = describeEntity(urgent, { layerId: 'flights', id: 'x00001' });
  assert.deepEqual(card.warnings, ['Emergency: fuel']);
  assert.ok(!card.facts.some((fact) => /emergency/i.test(fact.label)));
});

test('the view summary counts each layer inside the view, closest to the middle first', () => {
  const groups = viewSummary(
    dm,
    { west: -119, south: 34, east: -117, north: 34.5 },
    { lat: 34.1, lon: -118 },
    { perLayer: 2 },
  );
  assert.equal(groups.length, 1);
  assert.equal(groups[0].layerId, 'flights');
  assert.equal(groups[0].count, 501);
  assert.equal(groups[0].items[0].title, 'FLT100');
});

test('flight insights work out phase, flight level, Mach, squawk meaning and signal age', () => {
  const insights = aircraftInsights(
    { altitudeM: 10668, verticalRateMps: 0, speedMps: 230, squawk: '7000', lastContactAtMs: 1_000_000 },
    { nowMs: 1_012_000 },
  );
  const value = (label) => insights.find((item) => item.label === label)?.value;
  assert.equal(value('Phase'), 'Cruising, level');
  assert.equal(value('Flight level'), 'FL350');
  assert.equal(value('Mach'), 'M 0.78');
  assert.equal(value('Squawk 7000'), 'VFR conspicuity');
  assert.equal(value('Signal'), '12 s ago');
  assert.equal(aircraftInsights({ onGround: true })[0].value, 'On the ground');
  assert.match(aircraftInsights({ verticalRateMps: -8 })[0].value, /^Descending 1600 ft\/min$/);
});

test('a layer breakdown splits aircraft by status and type, inside a view when given', () => {
  const craft = [
    { id: 'A', lat: 10, lon: 10, onGround: false, military: false, aircraftClass: 'airliner' },
    { id: 'B', lat: 10, lon: 11, onGround: false, military: true, aircraftClass: 'fastjet' },
    { id: 'C', lat: 10, lon: 12, onGround: true, military: true, aircraftClass: 'airliner' },
    { id: 'D', lat: 60, lon: 12, onGround: false, military: false, aircraftClass: 'airliner' },
  ];
  const data = manager({ flights: { name: 'Live Flights', records: craft }, 'local-dams': { name: 'Dams', records: dams } });
  const all = layerBreakdown(data, 'flights');
  assert.equal(all.total, 4);
  assert.deepEqual(all.splits[0].parts, [
    { label: 'Civilian, in the air', count: 2 },
    { label: 'Military, in the air', count: 1 },
    { label: 'On the ground', count: 1 },
  ]);
  assert.deepEqual(all.splits[1].parts, [
    { label: 'Airliners', count: 3 },
    { label: 'Fast jets', count: 1 },
  ]);
  const near = layerBreakdown(data, 'flights', { rect: { west: 9, east: 13, south: 9, north: 11 } });
  assert.equal(near.total, 3);
  assert.equal(layerBreakdown(data, 'local-dams'), null);
});

test('a moving item with an unknown key is not matched to a craft right beside it', () => {
  // About 110 m from FLT0: well inside any nearest-item reach.
  assert.equal(findRecord(dm, { layerId: 'flights', id: 'zzzzzz', label: 'NOPE', lat: 34.001, lon: -118 }), null);
});

test('sites that share a key are told apart by where the identity says they are', () => {
  const sites = [
    { id: 'Amazon Web Services', name: 'Amazon Web Services', lat: -52.942, lon: -70.849 },
    { id: 'Amazon Web Services', name: 'Amazon Web Services', lat: -33.557, lon: -70.813 },
  ];
  const data = manager({ 'local-datacenters': { name: 'Datacenters', records: sites } });
  const identity = { layerId: 'local-datacenters', id: 'Amazon Web Services', label: 'Amazon Web Services', lat: -33.557, lon: -70.813 };
  assert.equal(findRecord(data, identity), sites[1]);
  const card = describeEntity(data, identity);
  assert.equal(card.lat, -33.557);
  // The card's own identity finds the same site again, as its refresh does.
  assert.equal(findRecord(data, card.identity), sites[1]);
});

test('a link is built only from a language code, and a level is not a warning', () => {
  const site = { id: 'X', name: 'X', lat: 1, lon: 1, wikipedia: 'evil.example/a#:Y' };
  const data = manager({ 'local-dams': { name: 'Dams', records: [site] } });
  assert.deepEqual(describeEntity(data, { layerId: 'local-dams', id: 'X', lat: 1, lon: 1 }).links, []);
  assert.deepEqual(recordWarnings({ alert: 'green' }), []);
});

test('a breakdown names "Other" once', () => {
  const ships = [30, 30, 70, 70, 70, 80, 80, 60, 37, 52, 52, 90, 90, 90].map((shipType, i) => ({ id: `S${i}`, mmsi: String(i), lat: 1, lon: 1 + i * 0.01, shipType }));
  const data = manager({ 'ais-live-vessels': { name: 'Vessels', records: ships } });
  const labels = layerBreakdown(data, 'ais-live-vessels').splits[0].parts.map((part) => part.label);
  assert.equal(labels.filter((label) => label === 'Other').length <= 1, true);
  assert.equal(new Set(labels).size, labels.length);
});
