import { test } from 'node:test';
import assert from 'node:assert/strict';
import { twoline2satrec } from 'satellite.js';
import { EARTH_RADIUS_KM } from '../geoDistance.js';
import { fromDegrees } from '../geo/ellipsoid.js';
import {
  CONTEXT_FEATURE,
  CONTEXT_LINES,
  contextLine,
} from './contextGeometry.js';
import { createControls } from '../layers/awareness/controls.js';
import { createControls as createInstallationControls } from '../layers/installations/controls.js';
import { createOrbits } from '../layers/satellites/orbits.js';
import { createRecords } from '../layers/satellites/records.js';
import {
  aircraftInsights,
  describeEntity,
  findRecord,
  formatFact,
  layerBreakdown,
  layerMatches,
  layerRecords,
  nearbyByKind,
  nearbyForLayer,
  nearbyEntities,
  recordKey,
  recordTitle,
  recordWarnings,
  searchEntities,
  viewSummaryForLayer,
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
  {
    id: 'Grand Coulee Dam',
    name: 'Grand Coulee Dam',
    lat: 47.957,
    lon: -118.981,
    operator: 'Bureau of Reclamation',
  },
  {
    id: '123456',
    name: null,
    lat: 47.9,
    lon: -118.9,
    operator: 'Some Utility',
  },
];
const dm = manager({
  flights: { name: 'Live Flights', records: flights },
  'local-dams': { name: 'Dams', records: dams },
});

test('uncached layer readers return empty results when a host reader fails', () => {
  const layerId = 'local-dams';
  const data = manager({ [layerId]: { records: [] } });
  const layer = data.layers.get(layerId);
  const center = { lat: 0, lon: 0 };
  const unavailable = () => {
    throw new Error('records unavailable');
  };
  layer.module.getAnalystRecords = unavailable;
  assert.deepEqual(layerRecords(data, layerId), []);
  assert.equal(nearbyForLayer(data, layer, center).count, 0);
  const globe = () =>
    viewSummaryForLayer(data, layer, null, center, { hemisphere: true });
  assert.equal(globe(), null);

  layer.module.getNearbyContextPoints = unavailable;
  assert.equal(nearbyForLayer(data, layer, center), null);
  assert.equal(globe(), null);
});

test('globe search resolves records using the point snapshot as receiver', () => {
  const layerId = 'local-dams';
  const data = manager({ [layerId]: { name: 'Dams', records: [] } });
  const layer = data.layers.get(layerId);
  const point = { id: 'dam-a', lat: 0, lon: 0 };
  const record = { ...point, name: 'Cedar Dam' };
  const snapshot = {
    points: [point],
    records: new Map([[point.id, record]]),
    recordForPoint(hit) {
      return this.records.get(hit.id);
    },
  };
  layer.module.getNearbyContextPoints = () => snapshot;
  const result = viewSummaryForLayer(data, layer, null, point, {
    hemisphere: true,
    query: 'cedar',
  });
  assert.equal(result.count, 1);
  assert.equal(result.items[0].title, 'Cedar Dam');
});

test('a failed selected-row conversion uses ordinary records or propagates a second failure', () => {
  const layerId = 'local-dams';
  const center = { lat: 0, lon: 0 };
  const ordinary = { id: 'ordinary', name: 'Cedar ordinary', ...center };
  const data = manager({ [layerId]: { name: 'Dams', records: [ordinary] } });
  const layer = data.layers.get(layerId);
  const snapshot = {
    points: [{ id: 'optimized', ...center }],
    recordForPoint(point, full = true) {
      assert.equal(this, snapshot);
      if (full) throw new Error('selected row conversion failed');
      return { ...point, name: 'Cedar optimized' };
    },
  };
  layer.module.getNearbyContextPoints = () => snapshot;
  let fallbackAttempts = 0;
  const options = {
    query: 'cedar',
    throwOnReadError: true,
    onSnapshotFallback: () => {
      fallbackAttempts++;
    },
  };
  const reads = [
    () => nearbyForLayer(data, layer, center, options),
    () =>
      viewSummaryForLayer(data, layer, null, center, {
        ...options,
        hemisphere: true,
      }),
  ];
  for (const read of reads) {
    const result = read();
    assert.equal(result.count, 1);
    assert.deepEqual(
      result.items.map(({ title }) => title),
      ['Cedar ordinary'],
    );
  }
  assert.equal(fallbackAttempts, 2);

  const failure = new Error('ordinary records failed');
  layer.module.getAnalystRecords = () => {
    throw failure;
  };
  for (const read of reads) assert.throws(read, (error) => error === failure);
  assert.equal(fallbackAttempts, 4);
});

test('a click identity finds its record by key, past the first 2000 records', () => {
  const record = findRecord(dm, {
    layerId: 'flights',
    id: 'a02400',
    lat: 0,
    lon: 0,
  });
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
  const facts = Object.fromEntries(
    card.facts.map((fact) => [fact.label, fact.value]),
  );
  assert.equal(facts.Operator, 'CapMetro');
  assert.equal(facts.Status, 'Heading to next stop');
  assert.equal(facts.Key, undefined, 'the layer key is not shown');
});

test('transit vehicles with the same fleet label keep distinct Nearby and card keys', () => {
  const records = [
    { id: '42', label: '42', key: 'first:42', lat: 30.2, lon: -97.7 },
    { id: '42', label: '42', key: 'other:42', lat: 30.3, lon: -97.7 },
  ];
  const vehicles = manager({ transit: { name: 'Transit', records } });
  const group = nearbyForLayer(
    vehicles,
    vehicles.layers.get('transit'),
    records[0],
  );
  assert.deepEqual(
    group.items.map(({ key }) => key),
    ['transit:first:42', 'transit:other:42'],
  );
  const first = describeEntity(vehicles, group.items[0].identity);
  assert.equal(first.identity.id, 'first:42');
  const other = records.pop();
  records[0] = other;
  assert.equal(findRecord(vehicles, first.identity), null);
});

test('transit vehicles break down by motion, mode and reported state', () => {
  const at = { lat: 30.2, lon: -97.7 };
  const buses = manager({
    transit: {
      name: 'Transit',
      records: [
        {
          id: '1',
          mode: 'bus',
          motion: 'moving',
          status: 'IN_TRANSIT_TO',
          ...at,
        },
        {
          id: '2',
          mode: 'bus',
          motion: 'stopped',
          status: 'STOPPED_AT',
          ...at,
        },
        { id: '3', mode: 'rail', motion: 'moving', occupancy: 'FULL', ...at },
      ],
    },
  });
  const breakdown = layerBreakdown(buses, 'transit');
  assert.equal(breakdown.total, 3);
  const split = (title) =>
    Object.fromEntries(
      breakdown.splits
        .find((item) => item.title === title)
        .parts.map((part) => [part.label, part.count]),
    );
  assert.deepEqual(split('Motion'), { Moving: 2, Stopped: 1 });
  assert.deepEqual(split('Mode'), { Bus: 2, Rail: 1 });
  assert.deepEqual(split('Last reported'), {
    'Heading to next stop': 1,
    'Stopped at a stop': 1,
  });
  assert.deepEqual(split('Crowding'), { Full: 1 });
});

test('a moving item never borrows a nearby craft when its key is unknown', () => {
  const record = findRecord(dm, {
    layerId: 'flights',
    id: 'zzzzzz',
    label: 'NOPE',
    lat: 34.0004,
    lon: -118.05,
  });
  assert.equal(record, null);
});

test('an unnamed site goes by its operator, not its database number', () => {
  assert.equal(recordTitle(dams[1]), 'Some Utility');
});

test('a card lists facts with units and keeps the title out of them', () => {
  const card = describeEntity(dm, { layerId: 'flights', id: 'a00001' });
  assert.equal(card.title, 'FLT1');
  assert.equal(card.kind, 'aircraft');
  assert.ok(
    card.facts.some(
      (fact) => fact.label === 'Altitude' && fact.value === '32,808 ft',
    ),
  );
  assert.ok(!card.facts.some((fact) => fact.value === 'FLT1'));
});

test('nearby lists the closest of the same kind and one of each other layer', () => {
  const card = describeEntity(dm, {
    layerId: 'local-dams',
    id: 'Grand Coulee Dam',
  });
  const { same, other } = nearbyEntities(dm, card, { radiusKm: 2000 });
  assert.equal(same[0].title, 'Some Utility');
  assert.equal(other.length, 1);
  assert.equal(other[0].layerId, 'flights');
});

test('a card and its Contacts alias omit their shared subject from Nearby', () => {
  const here = { lat: 30.3, lon: -97.7 };
  const layers = manager({
    flights: {
      name: 'Live Flights',
      records: [{ icao24: 'abc123', callsign: 'UAL1', ...here }],
    },
    'military-awareness': { name: 'Global Context', records: [] },
  });
  const subject = {
    layerId: 'flights',
    id: 'abc123',
    label: 'UAL1',
    position: fromDegrees(here.lon, here.lat, 10000),
  };
  const contacts = layers.layers.get('military-awareness');
  contacts.module = createControls({
    state: { enabled: true, subject },
    services: {},
    parts: {},
  }).methods;
  const card = describeEntity(layers, { layerId: 'flights', id: 'abc123' });
  const options = { excludeKey: card.key };
  const contactsList = () => nearbyForLayer(layers, contacts, here, options);
  assert.deepEqual(nearbyByKind(layers, here, options).other, []);
  assert.deepEqual(nearbyEntities(layers, card).other, []);
  assert.equal(contactsList().count, 0);

  const alias = describeEntity(layers, {
    layerId: 'military-awareness',
    id: 'flights:abc123',
  });
  assert.equal(alias.key, 'military-awareness:flights:abc123');
  assert.deepEqual(nearbyEntities(layers, alias).other, []);
  assert.deepEqual(
    nearbyByKind(layers, here, { excludeKey: alias.key }).flights.items,
    [],
  );
  assert.equal(
    nearbyForLayer(layers, layers.layers.get('flights'), here, {
      excludeKey: alias.key,
    }).count,
    0,
  );

  subject.layerId = 'military';
  assert.equal(
    nearbyByKind(layers, here, options).other[0]?.key,
    'military-awareness:military:abc123',
  );
  assert.equal(
    contactsList().count,
    1,
    'an identical ID in another layer stays visible',
  );
});

test('selected-card nearby rows open a cable at the point used for its distance', () => {
  const layerId = 'telegeography-submarine-cables';
  const here = { lat: 21, lon: -160 };
  const cable = {
    id: 'cable:example',
    name: 'Example Cable',
    feature: 'cable',
    lat: 21,
    lon: -150,
    parts: [here],
  };
  const layers = manager({ [layerId]: { name: 'Cables', records: [cable] } });
  const rows = [
    nearbyEntities(layers, { layerId, ...here }).same[0],
    nearbyByKind(layers, here).other[0],
    nearbyByKind(layers, here, { query: 'example' }).other[0],
  ];
  assert.deepEqual(
    rows.map((row) => [
      row.identity.id,
      row.distanceKm,
      row.identity.lat,
      row.identity.lon,
    ]),
    rows.map(() => [cable.id, 0, here.lat, here.lon]),
  );
  for (const row of rows) {
    const { lat, lon } = describeEntity(layers, row.identity);
    assert.deepEqual({ lat, lon }, here);
  }
});

test('a rounded GeoJSON pick stays on its selected part when the card refreshes', () => {
  const layerId = 'local-datacenters';
  const part = { lat: 37.12345648, lon: 179.99999972 };
  const site = {
    id: 'campus',
    name: 'Campus',
    lat: 20,
    lon: 10,
    parts: [part],
  };
  const data = manager({ [layerId]: { records: [site] } });
  const card = describeEntity(data, {
    layerId,
    id: 'campus_2',
    label: site.name,
    lat: 37.123456,
    lon: -180,
  });
  assert.deepEqual({ lat: card.lat, lon: card.lon }, part);
  const refreshed = describeEntity(data, card.identity);
  assert.deepEqual({ lat: refreshed.lat, lon: refreshed.lon }, part);
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
  assert.equal(
    formatFact('speedMps', 10, { kind: 'vehicle' }).value,
    '36 km/h',
  );
  // Units follow the field's suffix; feed codes and bare words read as words.
  assert.equal(formatFact('containedPct', 96).value, '96%');
  assert.equal(formatFact('windKt', 30).value, '30 kt');
  assert.equal(formatFact('pressureHpa', 1009).value, '1,009 hPa');
  assert.equal(formatFact('classification', 'TD').value, 'Tropical depression');
  assert.equal(formatFact('telecom', 'data_center').value, 'Data center');
  assert.equal(formatFact('icao24', 'abcdef').value, 'abcdef');
  assert.equal(formatFact('shipType', 70).value, 'Cargo');
  assert.equal(formatFact('shipType', 'Tanker').value, 'Tanker');
  assert.equal(
    formatFact('discoveredTime', Date.UTC(2026, 5, 29)).value,
    '29 Jun 2026',
  );
  assert.equal(
    formatFact('updatedTime', 1_700_000_000_000, { nowMs: 1_700_000_060_000 })
      .age,
    60_000,
  );
  assert.equal(formatFact('altitudeM', 420000).value, '420 km');
  assert.equal(formatFact('confidence', 0.82).value, '82%');
  assert.equal(formatFact('onGround', false), null);
  assert.equal(
    formatFact('lastContactAtMs', 1_700_000_000_000, {
      nowMs: 1_700_000_060_000,
    }).age,
    60_000,
  );
});

test('warnings lead with an emergency, then the squawk code, and stay out of the facts', () => {
  assert.deepEqual(
    recordWarnings({ emergency: true, emergencyKind: 'medical' }),
    ['Emergency: medical'],
  );
  assert.deepEqual(recordWarnings({ squawk: '7600' }), [
    'Radio failure (squawk 7600)',
  ]);
  assert.deepEqual(
    recordWarnings({ squawk: '1200', emergencyKind: 'none' }),
    [],
  );
  assert.deepEqual(recordWarnings({ tsunami: 1 }), ['Tsunami warning issued']);
  const urgent = manager({
    flights: {
      name: 'Live Flights',
      records: [
        {
          id: 'X1',
          icao24: 'x00001',
          callsign: 'X1',
          lat: 1,
          lon: 1,
          emergency: true,
          emergencyKind: 'fuel',
        },
      ],
    },
  });
  const card = describeEntity(urgent, { layerId: 'flights', id: 'x00001' });
  assert.deepEqual(card.warnings, ['Emergency: fuel']);
  assert.ok(!card.facts.some((fact) => /emergency/i.test(fact.label)));
});

test('the view summary counts items inside the view, closest to the middle first', () => {
  const group = viewSummaryForLayer(
    dm,
    dm.layers.get('flights'),
    { west: -119, south: 34, east: -117, north: 34.5 },
    { lat: 34.1, lon: -118 },
    { perLayer: 2 },
  );
  assert.equal(group.layerId, 'flights');
  assert.equal(group.count, 501);
  assert.equal(group.items[0].title, 'FLT100');
});

test('the view summary counts a multipart cable once at its closest visible piece', () => {
  const first = { lat: 0, lon: 0 };
  const closest = { lat: 0, lon: -179 };
  const cable = {
    id: 'cable:test',
    ...first,
    parts: [first, { lat: 0, lon: 175 }, closest],
  };
  const cables = manager({
    'telegeography-submarine-cables': { name: 'Cables', records: [cable] },
  });
  const center = { lat: 0, lon: 179 };
  const rect = { west: 174, east: -178, south: -2, north: 2 };
  const layer = cables.layers.get('telegeography-submarine-cables');

  for (const [view, options] of [
    [null, { hemisphere: true }],
    [rect, {}],
  ]) {
    const group = viewSummaryForLayer(cables, layer, view, center, options);
    assert.ok(group, 'the cable is in view even though its first piece is not');
    assert.equal(group.count, 1);
    assert.equal(group.items.length, 1);
    const { id, lat, lon } = group.items[0].identity;
    assert.equal(id, cable.id);
    assert.deepEqual({ lat, lon }, closest);
  }

  delete cable.lat;
  delete cable.lon;
  const partOnly = viewSummaryForLayer(cables, layer, rect, center);
  assert.equal(partOnly.count, 1, 'a visible part works without a main point');
});

test('Omnibar area counts use the closest qualifying cable part and count the cable once', () => {
  const layerId = 'telegeography-submarine-cables';
  const part = { lat: 0, lon: -179.9 };
  const cable = {
    id: 'example',
    lat: 0,
    lon: 0,
    parts: [{ lat: 0, lon: 178 }, part],
  };
  const data = manager({ [layerId]: { records: [cable] } });
  const center = { lat: 0, lon: 179.9 };
  for (const area of [
    { rect: { west: 177, east: -179, south: -1, north: 1 } },
    { radiusKm: 30 },
  ]) {
    const { count, items } = layerMatches(data, layerId, { center, ...area });
    assert.equal(count, 1);
    assert.equal(items.length, 1);
    const picked = describeEntity(data, items[0].identity);
    assert.deepEqual({ lat: picked.lat, lon: picked.lon }, part);
  }
  assert.equal(layerMatches(data, layerId, { center, radiusKm: 5 }).count, 0);
});

test('the globe view counts only the cap a camera at its height can see', () => {
  // From 10,000 km up the horizon is acos(6371/16371), about 67 degrees
  // from the centre: 60 degrees away is in view, 80 is over the horizon.
  const places = manager({
    'local-datacenters': {
      name: 'Data centers',
      records: [
        { id: 'near', name: 'Near', lat: 0, lon: 60 },
        { id: 'far', name: 'Far', lat: 0, lon: 80 },
      ],
    },
  });
  const center = { lat: 0, lon: 0 };
  const layer = places.layers.get('local-datacenters');
  const group = viewSummaryForLayer(places, layer, null, center, {
    hemisphere: true,
    heightM: 10_000_000,
  });
  assert.equal(group.count, 1);
  assert.equal(group.items[0].title, 'Near');
  assert.equal(
    viewSummaryForLayer(places, layer, null, center, { hemisphere: true })
      .count,
    2,
    'without a height, the hemisphere',
  );
});

test('GeoJSON lines and points share the same Nearby radius threshold', () => {
  const degreesAt = (km) => (km / EARTH_RADIUS_KM) * (180 / Math.PI);
  const near = { lat: degreesAt(24.99998), lon: 0 };
  const far = { lat: degreesAt(26), lon: 0 };
  const layerId = 'local-dams';
  const data = manager({
    [layerId]: {
      records: [
        { id: 'point', ...near },
        {
          id: 'line',
          key: 'geojson:id:line',
          ...far,
          [CONTEXT_LINES]: [contextLine([near, far])],
        },
      ],
    },
  });
  const nearby = nearbyForLayer(
    data,
    data.layers.get(layerId),
    { lat: 0, lon: 0 },
    { radiusKm: 25 },
  );
  assert.equal(nearby.count, 2);
  assert.equal(nearby.items[1].distanceKm, nearby.items[0].distanceKm);
});

test('a GeoJSON crest across the globe limb opens at its closest visible point', () => {
  const layerId = 'local-dams';
  const data = manager({
    [layerId]: {
      name: 'Dams',
      records: [
        {
          id: 'crest',
          key: 'geojson:id:crest',
          name: 'Horizon Crest',
          lat: 0,
          lon: 57,
          [CONTEXT_LINES]: [
            contextLine([
              { lat: 0, lon: 55 },
              { lat: 0, lon: 57 },
            ]),
          ],
        },
        {
          id: 'meridian',
          key: 'geojson:id:meridian',
          name: 'Meridian Crest',
          lat: 15,
          lon: 55,
          [CONTEXT_LINES]: [
            contextLine([
              { lat: -15, lon: 55 },
              { lat: 15, lon: 55 },
            ]),
          ],
        },
      ],
    },
  });
  const center = { lat: 0, lon: 60 };
  const group = viewSummaryForLayer(
    data,
    data.layers.get(layerId),
    null,
    center,
    {
      hemisphere: true,
      heightM: 5_000_000,
      eye: { lat: 0, lon: 0 },
    },
  );
  assert.equal(group?.count, 2);
  assert.deepEqual(
    group.items.map((row) => row.title),
    ['Horizon Crest', 'Meridian Crest'],
  );
  const card = describeEntity(data, group.items[0].identity);
  assert.ok(
    card.lon > 55.5 && card.lon < 56,
    'the anchor is just inside the limb',
  );
  assert.equal(describeEntity(data, card.identity).lon, card.lon);
  assert.equal(
    group.items[1].identity.lat,
    0,
    'a segment can show its middle while both ends are hidden',
  );
});

test('an elevated satellite beyond the surface horizon can still be in view', () => {
  const center = { lat: 0, lon: 0 };
  const layers = manager({
    satellites: {
      name: 'Satellites',
      records: [
        { id: 'front', lat: 0, lon: 70, altitudeM: 550_000 },
        { id: 'over-limb', lat: 0, lon: 80, altitudeM: 550_000 },
        { id: 'occluded', lat: 0, lon: 110, altitudeM: 550_000 },
      ],
    },
    'local-datacenters': {
      name: 'Data centers',
      records: [{ id: 'ground', lat: 0, lon: 80 }],
    },
  });
  // From 20,000 km, the surface horizon is at 76 degrees. The satellite
  // above longitude 80 clears the limb while the one at 110 is hidden.
  const options = { hemisphere: true, heightM: 20_000_000 };
  const satellites = viewSummaryForLayer(
    layers,
    layers.layers.get('satellites'),
    null,
    center,
    options,
  );
  assert.equal(satellites.count, 2);
  assert.deepEqual(
    satellites.items.map((item) => item.identity.id),
    ['front', 'over-limb'],
  );
  assert.equal(
    viewSummaryForLayer(
      layers,
      layers.layers.get('local-datacenters'),
      null,
      center,
      options,
    ),
    null,
  );
});

test('globe search finds an airborne aircraft that clears the limb', () => {
  const center = { lat: 0, lon: 0 };
  const layers = manager({
    flights: {
      name: 'Live Flights',
      records: [
        {
          callsign: 'LIMB1',
          lat: 0,
          lon: 57,
          altitudeM: 10_000,
          onGround: false,
        },
        {
          callsign: 'LIMB2',
          lat: 0,
          lon: 57,
          altitudeM: 10_000,
          onGround: true,
        },
        {
          callsign: 'LIMB3',
          lat: 0,
          lon: 80,
          altitudeM: 10_000,
          onGround: false,
        },
      ],
    },
  });
  const group = viewSummaryForLayer(
    layers,
    layers.layers.get('flights'),
    null,
    center,
    {
      hemisphere: true,
      heightM: 5_000_000,
      query: 'LIMB',
    },
  );
  assert.equal(group?.count, 1);
  assert.deepEqual(
    group.items.map(({ title }) => title),
    ['LIMB1'],
  );
});

test("on a tilted globe view the horizon is the camera's, while rows rank from the centre", () => {
  // A camera 5,000 km above (0, 0) whose middle of the screen falls on
  // (0, 25): its horizon is about 56 degrees from (0, 0), so a place at
  // longitude 70 is behind the Earth, though only 45 degrees from the centre.
  const places = manager({
    'local-datacenters': {
      name: 'Data centers',
      records: [
        { id: 'near', name: 'Near', lat: 0, lon: 25 },
        { id: 'under', name: 'Under', lat: 0, lon: 0 },
        { id: 'behind', name: 'Behind', lat: 0, lon: 70 },
      ],
    },
  });
  const group = viewSummaryForLayer(
    places,
    places.layers.get('local-datacenters'),
    null,
    { lat: 0, lon: 25 },
    {
      hemisphere: true,
      heightM: 5_000_000,
      eye: { lat: 0, lon: 0 },
    },
  );
  assert.equal(group.count, 2);
  assert.deepEqual(
    group.items.map((item) => item.title),
    ['Near', 'Under'],
    'nearest the centre first',
  );
  assert.ok(group.items[0].distanceKm < 1, 'measured from the centre');
});

test('the view summary with no rows wanted still counts, and never throws', () => {
  const group = viewSummaryForLayer(
    dm,
    dm.layers.get('flights'),
    null,
    { lat: 34.1, lon: -118 },
    {
      perLayer: 0,
      hemisphere: true,
    },
  );
  assert.equal(group.layerId, 'flights');
  assert.ok(group.count > 0);
  assert.deepEqual(group.items, []);
});

test('in-view satellites stand at their SGP4 catalogue positions (the layer records), not the renderer', () => {
  const satrec = twoline2satrec(
    '1 25544U 98067A   08264.51782528 -.00002182  00000-0 -11606-4 0  2927',
    '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537',
  );
  const at = new Date(Date.UTC(2008, 8, 20, 12));
  const orbits = createOrbits({
    state: {},
    services: {},
    parts: {},
    source: {},
  });
  let rendererAsked = 0;
  const records = createRecords({
    state: {
      _enabled: true,
      _catalog: new Map([
        [25544, { name: 'ISS (ZARYA)', group: 'stations', satrec }],
      ]),
      now: () => at.getTime(),
    },
    parts: {
      orbits,
      rendering: {
        _pointPosition: () => {
          rendererAsked++;
          return null;
        },
      },
    },
  });
  const layer = {
    id: 'satellites',
    name: 'Satellites',
    enabled: true,
    module: { getAnalystRecords: records.getAnalystRecords },
  };
  const layers = {
    layers: new Map([['satellites', layer]]),
    getAll: () => [layer],
    isEnabled: () => true,
  };
  const sgp4 = orbits.propagatePosition(satrec, at);
  const group = viewSummaryForLayer(
    layers,
    layer,
    null,
    { lat: sgp4.latitude, lon: sgp4.longitude },
    { hemisphere: true },
  );
  const item = group.items[0];
  assert.equal(item.title, 'ISS (ZARYA)');
  assert.equal(item.identity.lat, sgp4.latitude);
  assert.equal(item.identity.lon, sgp4.longitude);
  assert.ok(item.distanceKm < 0.01, 'centred on its propagated point');
  assert.equal(rendererAsked, 0, 'no renderer position is read');
});

test('flight insights work out phase, flight level, Mach, squawk meaning and signal age', () => {
  const insights = aircraftInsights(
    {
      altitudeM: 10668,
      verticalRateMps: 0,
      speedMps: 230,
      squawk: '7000',
      lastContactAtMs: 1_000_000,
    },
    { nowMs: 1_012_000 },
  );
  const value = (label) => insights.find((item) => item.label === label)?.value;
  assert.equal(value('Phase'), 'Cruising, level');
  assert.equal(value('Flight level'), 'FL350');
  assert.equal(value('Mach'), 'M 0.78');
  assert.equal(value('Squawk {code}'), 'VFR conspicuity');
  assert.deepEqual(
    insights.find((item) => item.label === 'Squawk {code}').labelValues,
    { code: '7000' },
  );
  assert.equal(value('Signal'), '12 s ago');
  assert.equal(aircraftInsights({ onGround: true })[0].value, 'On the ground');
  assert.match(
    aircraftInsights({ verticalRateMps: -8 })[0].value,
    /^Descending 1600 ft\/min$/,
  );
});

test('a layer breakdown splits aircraft by status and type, inside a view when given', () => {
  const craft = [
    {
      id: 'A',
      lat: 10,
      lon: 10,
      onGround: false,
      military: false,
      aircraftClass: 'airliner',
    },
    {
      id: 'B',
      lat: 10,
      lon: 11,
      onGround: false,
      military: true,
      aircraftClass: 'fastjet',
    },
    {
      id: 'C',
      lat: 10,
      lon: 12,
      onGround: true,
      military: true,
      aircraftClass: 'airliner',
    },
    {
      id: 'D',
      lat: 60,
      lon: 12,
      onGround: false,
      military: false,
      aircraftClass: 'airliner',
    },
  ];
  const data = manager({
    flights: { name: 'Live Flights', records: craft },
    'local-dams': { name: 'Dams', records: dams },
  });
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
  const near = layerBreakdown(data, 'flights', {
    rect: { west: 9, east: 13, south: 9, north: 11 },
  });
  assert.equal(near.total, 3);
  assert.equal(layerBreakdown(data, 'local-dams'), null);
});

test('a moving item with an unknown key is not matched to a craft right beside it', () => {
  // About 110 m from FLT0: well inside any nearest-item reach.
  assert.equal(
    findRecord(dm, {
      layerId: 'flights',
      id: 'zzzzzz',
      label: 'NOPE',
      lat: 34.001,
      lon: -118,
    }),
    null,
  );
});

test('sites that share a key are told apart by where the identity says they are', () => {
  const sites = [
    {
      id: 'Amazon Web Services',
      name: 'Amazon Web Services',
      lat: -52.942,
      lon: -70.849,
    },
    {
      id: 'Amazon Web Services',
      name: 'Amazon Web Services',
      lat: -33.557,
      lon: -70.813,
    },
  ];
  const data = manager({
    'local-datacenters': { name: 'Datacenters', records: sites },
  });
  const identity = {
    layerId: 'local-datacenters',
    id: 'Amazon Web Services',
    label: 'Amazon Web Services',
    lat: -33.557,
    lon: -70.813,
  };
  assert.equal(findRecord(data, identity), sites[1]);
  const card = describeEntity(data, identity);
  assert.equal(card.lat, -33.557);
  // The card's own identity finds the same site again, as its refresh does.
  assert.equal(findRecord(data, card.identity), sites[1]);
});

test('a link is built only from a language code, and a level is not a warning', () => {
  const site = {
    id: 'X',
    name: 'X',
    lat: 1,
    lon: 1,
    wikipedia: 'evil.example/a#:Y',
  };
  const data = manager({ 'local-dams': { name: 'Dams', records: [site] } });
  assert.deepEqual(
    describeEntity(data, { layerId: 'local-dams', id: 'X', lat: 1, lon: 1 })
      .links,
    [],
  );
  assert.deepEqual(recordWarnings({ alert: 'green' }), []);
});

test('a breakdown names "Other" once', () => {
  const ships = [30, 30, 70, 70, 70, 80, 80, 60, 37, 52, 52, 90, 90, 90].map(
    (shipType, i) => ({
      id: `S${i}`,
      mmsi: String(i),
      lat: 1,
      lon: 1 + i * 0.01,
      shipType,
    }),
  );
  const data = manager({
    'ais-live-vessels': { name: 'Vessels', records: ships },
  });
  const labels = layerBreakdown(data, 'ais-live-vessels').splits[0].parts.map(
    (part) => part.label,
  );
  assert.equal(labels.filter((label) => label === 'Other').length <= 1, true);
  assert.equal(new Set(labels).size, labels.length);
});

test('a card shows the photo its layer looked up: the tracked airliner, the selected vessel', () => {
  const photo = {
    src: 'https://cdn.example/p.jpg',
    link: 'https://example/p',
    photographer: 'A. Spotter',
    width: 640,
  };
  const planes = manager({
    flights: {
      name: 'Live Flights',
      records: [
        {
          id: 'DAL1',
          icao24: 'aa0001',
          callsign: 'DAL1',
          lat: 34,
          lon: -118,
          typeCode: 'B739',
          category: 'A3',
        },
        { id: 'DAL2', icao24: 'aa0002', callsign: 'DAL2', lat: 35, lon: -118 },
      ],
    },
    'ais-live-vessels': {
      name: 'Vessels',
      records: [
        {
          id: 'EVER GIVEN',
          vesselId: 'v1',
          mmsi: '353136000',
          lat: 30,
          lon: 32,
        },
      ],
    },
  });
  planes.layers.get('flights').module.getTrackedSubject = () => ({
    id: 'aa0001',
    photo,
  });
  planes.layers.get('ais-live-vessels').module.getVesselPhoto = (id) =>
    id === 'v1' ? { ...photo, licence: 'CC BY 4.0' } : null;

  const tracked = describeEntity(planes, { layerId: 'flights', id: 'aa0001' });
  assert.deepEqual(tracked.photo, {
    src: photo.src,
    link: photo.link,
    photographer: 'A. Spotter',
    licence: '',
  });
  // What picks the globe's fleet model for it.
  assert.deepEqual(tracked.aircraftModel, {
    typeCode: 'B739',
    category: 'A3',
    callsign: 'DAL1',
  });
  // Photos are looked up for the tracked plane only.
  assert.equal(
    describeEntity(planes, { layerId: 'flights', id: 'aa0002' }).photo,
    null,
  );
  assert.equal(
    describeEntity(planes, { layerId: 'ais-live-vessels', id: 'EVER GIVEN' })
      .photo.licence,
    'CC BY 4.0',
  );
});

test('Nearby reads one enabled layer, nearest first, with a count of what is in range', () => {
  const here = { lat: 30, lon: -97 };
  const layers = manager({
    flights: {
      name: 'Live Flights',
      records: [
        { icao24: 'far', callsign: 'FAR', lat: 31, lon: -97 },
        { icao24: 'near', callsign: 'NEAR', lat: 30.05, lon: -97 },
        { icao24: 'out', callsign: 'OUT', lat: 40, lon: -97 },
      ],
    },
    earthquakes: { name: 'Earthquakes', records: [] },
  });
  // A layer with no list of items (a weather map) has no list at all.
  layers.layers.set('weather-radar', {
    id: 'weather-radar',
    name: 'Radar',
    enabled: true,
    module: {},
  });
  // A layer that is off is never read.
  layers.layers.set('vessels-off', {
    id: 'vessels-off',
    name: 'Vessels',
    enabled: false,
    module: {
      getAnalystRecords: () => [{ mmsi: '1', name: 'BOAT', lat: 30, lon: -97 }],
    },
  });
  const ask = (id, options) =>
    nearbyForLayer(layers, layers.layers.get(id), here, options);
  const list = ask('flights', { radiusKm: 250, limit: 1 });
  assert.equal(list.count, 2);
  assert.equal(ask('earthquakes').count, 0);
  assert.equal(ask('weather-radar'), null);
  assert.equal(ask('vessels-off'), null);
  assert.deepEqual(
    list.items.map((item) => item.title),
    ['NEAR'],
    'the nearest leads, up to the limit',
  );
  assert.equal(list.items[0].identity.layerId, 'flights');
  assert.equal(ask('flights', { query: 'far' }).count, 1);
  assert.equal(
    ask('flights', { excludeKey: 'flights:near' }).items[0].title,
    'FAR',
  );
  assert.equal(
    nearbyForLayer(layers, layers.layers.get('flights'), null),
    null,
  );
});

test('Nearby keeps counts and stable nearest rows when only a few of many matches are shown', () => {
  const records = Array.from({ length: 300 }, (_, i) => ({
    icao24: `plane-${i}`,
    callsign: i % 3 ? 'Keep' : 'Other',
    lat: 30 + ((i * 17) % 50) / 100,
    lon: -97,
  }));
  const layers = manager({ flights: { name: 'Flights', records } });
  const expected = records
    .filter(
      (record) => record.callsign === 'Keep' && record.icao24 !== 'plane-1',
    )
    .sort((a, b) => a.lat - b.lat);
  const options = { query: 'keep', excludeKey: 'flights:plane-1' };
  for (const limit of [0, 3, 12]) {
    const list = nearbyForLayer(
      layers,
      layers.layers.get('flights'),
      { lat: 30, lon: -97 },
      { ...options, limit },
    );
    assert.equal(list.count, expected.length);
    assert.deepEqual(
      list.items.map((item) => item.identity.record),
      expected.slice(0, limit),
    );
  }
});

test('installation and its Contacts record exclude each other', () => {
  // A source record; installations/controls.js turns it into the analyst record (inst).
  const src = {
    id: 'osm:way/42',
    name: 'Fort Example',
    class: 'base',
    latitude: 10,
    longitude: 20,
  };
  const [inst] = createInstallationControls({
    state: { enabled: true, records: [src] },
    services: {},
    parts: {},
    source: {},
  }).methods.getAnalystRecords();
  // Contacts record as awareness/controls.js builds it from subjectFromContext({id: record.id}).
  const contact = {
    id: `military-installations:${src.id}`,
    name: src.name,
    subjectLayer: 'military-installations',
    lat: 10,
    lon: 20,
  };
  const dm = manager({
    'military-installations': { name: 'Installations', records: [inst] },
    'military-awareness': { name: 'Contacts', records: [contact] },
  });
  const cardKey = recordKey('military-installations', inst);
  const groups = nearbyByKind(
    dm,
    { lat: 10, lon: 20 },
    { radiusKm: 25, excludeKey: cardKey },
  );
  assert.equal(
    groups.other.length,
    0,
    'the selected installation reappears through Contacts',
  );
  const contactKey = recordKey('military-awareness', contact);
  const list = nearbyForLayer(
    dm,
    { id: 'military-installations', enabled: true },
    { lat: 10, lon: 20 },
    { radiusKm: 25, excludeKey: contactKey },
  );
  assert.equal(list.count, 0, 'the Contacts card lists its own subject');
});

test("a feature's description is the card's paragraph, not one of its facts", () => {
  const pier = {
    id: 'pier-1',
    name: 'Ferry pier',
    lat: 47.6,
    lon: -122.3,
    [CONTEXT_FEATURE]: {
      properties: {
        description: 'Old ferry   pier,\nrebuilt 1990',
        operator: 'Port',
      },
    },
  };
  const dm = manager({ places: { name: 'Places', records: [pier] } });
  const card = describeEntity(dm, { layerId: 'places', id: 'pier-1' });
  assert.equal(card.description, 'Old ferry pier, rebuilt 1990');
  assert.equal(
    card.facts.some((fact) => fact.field === 'description'),
    false,
  );

  const long = 'é'.repeat(999) + '😀😀';
  const told = describeEntity(dm, {
    layerId: 'places',
    id: 'told',
    record: { id: 'told', name: 'Told', description: long },
  });
  assert.equal(Array.from(told.description).length, 1000);
  assert.ok(told.description.endsWith('…'));
  assert.equal(
    describeEntity(dm, {
      layerId: 'places',
      id: 'quiet',
      record: { id: 'quiet', name: 'Quiet' },
    }).description,
    null,
  );
});
