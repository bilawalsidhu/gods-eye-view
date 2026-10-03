import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAnalystEngine, applyScope, haversineKm } from './analystEngine.js';

// Stub world: a square "Texland" region, flights + ships + fires around it.
const TEXLAND = { name: 'Texland', ring: [[-100, 28], [-94, 28], [-94, 33], [-100, 33]] };
const FLIGHTS = [
  { id: 'SWA1', lat: 30.2, lon: -97.7, altitudeM: 11000, speedMps: 240, military: false, onGround: false, routeOrigin: 'AUS', routeDestination: 'LAX' },
  { id: 'RCH01', lat: 31.0, lon: -97.0, altitudeM: 13500, speedMps: 250, military: true, onGround: false, routeOrigin: null, routeDestination: null },
  { id: 'N123', lat: 45.0, lon: -122.0, altitudeM: 2000, speedMps: 80, military: false, onGround: false, routeOrigin: null, routeDestination: null },
  { id: 'GND1', lat: 30.19, lon: -97.66, altitudeM: 150, speedMps: 5, military: false, onGround: true, routeOrigin: null, routeDestination: null },
];
const SHIPS = [
  { id: 'EVERGIVEN', lat: 29.5, lon: -94.9, speedKts: 12, shipType: 'Cargo', destination: 'OAKLAND', navStatus: 'under way' },
  { id: 'SLOWBOAT', lat: 29.6, lon: -95.0, speedKts: 0.2, shipType: 'Tanker', destination: 'HOUSTON', navStatus: 'anchored' },
];
const FIRES = [
  { id: 'FIRE-1', lat: 30.5, lon: -98.2, frp: 1500 },
  { id: 'FIRE-2', lat: 30.6, lon: -98.1, frp: 90 },
  { id: 'FIRE-3', lat: 51.9, lon: -121.9, frp: 2400 },
];

function makeEngine() {
  return createAnalystEngine({
    getRecords: (key) => ({ flights: FLIGHTS, 'ais-live-vessels': SHIPS, 'local-firms': FIRES }[key] || []),
    resolveRegionRing: async (name) => (/texland/i.test(name) ? TEXLAND : null),
    getViewContext: () => ({ lat: 30.27, lon: -97.74, viewRadiusKm: 150 }),
  });
}

/** Same world, but Contacts is up with a subject far from the parked camera. */
function makeContactsEngine(subject) {
  return createAnalystEngine({
    getRecords: (key) => ({ flights: FLIGHTS, 'ais-live-vessels': SHIPS, 'local-firms': FIRES }[key] || []),
    resolveRegionRing: async (name) => (/texland/i.test(name) ? TEXLAND : null),
    // Parked far away, as a high-altitude camera often is.
    getViewContext: () => ({ lat: 45.0, lon: -122.0, viewRadiusKm: 150 }),
    getContextSubject: () => subject,
  });
}

test('analyst: a radius query centers on the active contact, not the parked camera', async () => {
  // Field case: the Contacts panel counted a contact-centred window while the
  // camera sat off-coast at 441 km, so "how many within 250 km" answered from
  // the camera and disagreed with what the operator could see.
  const subject = { lat: 30.2, lon: -97.7, label: 'SWA1' };
  const r = await makeContactsEngine(subject).query({
    layers: ['flights'],
    scope: { kind: 'radius', km: 250 },
    limit: 50,
  });
  assert.equal(r.ok, true);
  // Austin-area flights, not the Oregon one the camera is parked over.
  assert.equal(r.count, 3);
  assert.equal(r.centeredOn, 'SWA1', 'the answer names the centre it measured from');
  assert.ok(r.coverage.scope.includes('@SWA1'));
});

test('analyst: an explicit center still wins over the active contact', async () => {
  const subject = { lat: 30.2, lon: -97.7, label: 'SWA1' };
  const r = await makeContactsEngine(subject).query({
    layers: ['flights'],
    scope: { kind: 'radius', km: 250, center: { lat: 45.0, lon: -122.0 } },
    limit: 50,
  });
  assert.equal(r.count, 1, 'only the Oregon flight is within 250 km of the given center');
  assert.equal(r.centeredOn, undefined, 'an explicit center is not relabelled');
});

test('analyst: with Contacts off, radius still centers on the view', async () => {
  const r = await makeContactsEngine(null).query({
    layers: ['flights'],
    scope: { kind: 'radius', km: 250 },
    limit: 50,
  });
  assert.equal(r.count, 1, 'view-centred behaviour is unchanged outside Contacts');
  assert.equal(r.centeredOn, undefined);
  assert.equal(r.coverage.scope, 'radius:250km');
});

test('analyst: a subject without usable coordinates cannot lend its name to a camera-centred count', async () => {
  // The label is the only thing telling the operator WHICH centre produced the
  // number. A subject present but position-less fell back to the camera and
  // kept the contact's name on the answer, so a camera-centred count read as
  // contact-centred with nothing in the payload to catch it.
  const r = await makeContactsEngine({ lat: null, lon: null, label: 'SWA1' }).query({
    layers: ['flights'],
    scope: { kind: 'radius', km: 250 },
    limit: 50,
  });
  assert.equal(r.count, 1, 'the count is the camera-centred one it actually measured');
  assert.equal(r.centeredOn, undefined, 'and it must not claim a centre it did not use');
  assert.equal(r.coverage.scope, 'radius:250km');
  assert.equal(r.scopeLabel, 'within 250 km');
});

test('analyst: every scope names itself in words', async () => {
  // Rule 3 of the counting contract: a bare number is what made two honest
  // answers look like a contradiction, so each scope carries its own phrasing.
  const subject = { lat: 30.2, lon: -97.7, label: 'DYNO11' };
  const centred = await makeContactsEngine(subject).query({
    layers: ['flights'], scope: { kind: 'radius', km: 250 }, limit: 1,
  });
  assert.equal(centred.scopeLabel, 'within 250 km of DYNO11');

  const plainRadius = await makeContactsEngine(null).query({
    layers: ['flights'], scope: { kind: 'radius', km: 250 }, limit: 1,
  });
  assert.equal(plainRadius.scopeLabel, 'within 250 km');

  const inView = await makeEngine().query({
    layers: ['flights'], scope: { kind: 'view' }, limit: 1,
  });
  assert.equal(inView.scopeLabel, 'in view');

  const region = await makeEngine().query({
    layers: ['flights'], scope: { kind: 'region', name: 'Texland' }, limit: 1,
  });
  assert.equal(region.scopeLabel, 'over Texland');

  const anywhere = await makeEngine().query({
    layers: ['flights'], scope: { kind: 'anywhere' }, limit: 1,
  });
  assert.equal(anywhere.scopeLabel, 'anywhere in the loaded data');
});

test('analyst: count flights over a region', async () => {
  const r = await makeEngine().query({ layers: ['flights'], scope: { kind: 'region', name: 'Texland' }, limit: 50 });
  assert.equal(r.ok, true);
  assert.equal(r.count, 3, 'Oregon flight excluded');
  assert.ok(r.coverage.scope.includes('Texland'));
});

test('analyst: attribute filter — above 40,000 ft (~12,192 m)', async () => {
  const r = await makeEngine().query({
    layers: ['flights'], scope: { kind: 'anywhere' },
    filters: [{ field: 'altitudeM', op: 'gt', value: 12192 }],
  });
  assert.deepEqual(r.items.map((i) => i.id), ['RCH01']);
});

test('analyst: military flag + region compose', async () => {
  const r = await makeEngine().query({
    layers: ['flights'], scope: { kind: 'region', name: 'Texland' },
    filters: [{ field: 'military', op: 'eq', value: true }],
  });
  assert.equal(r.count, 1);
  assert.equal(r.items[0].id, 'RCH01');
});

test('analyst: ships headed to Oakland (destination contains)', async () => {
  const r = await makeEngine().query({
    layers: ['ais-live-vessels'], scope: { kind: 'anywhere' },
    filters: [{ field: 'destination', op: 'contains', value: 'oakland' }],
  });
  assert.deepEqual(r.items.map((i) => i.id), ['EVERGIVEN']);
});

test('analyst: superlative — biggest fire in view radius', async () => {
  const r = await makeEngine().query({
    layers: ['local-firms'], scope: { kind: 'view' }, sortBy: 'frp', limit: 1,
  });
  assert.equal(r.items[0].id, 'FIRE-1', 'BC monster is out of view scope');
  assert.equal(r.summary.frpMax, 1500);
});

test('analyst: nearest sorting attaches distanceKm ascending', async () => {
  const r = await makeEngine().query({
    layers: ['flights'], scope: { kind: 'view' }, sortBy: 'distance', limit: 3,
  });
  assert.ok(r.items[0].distanceKm <= r.items[1].distanceKm);
  assert.ok(Number.isFinite(r.items[0].distanceKm));
});

test('analyst: follow-up re-filters the remembered set without re-snapshot', async () => {
  const eng = makeEngine();
  await eng.query({ layers: ['flights'], scope: { kind: 'region', name: 'Texland' } });
  const r = await eng.query({ followUp: true, filters: [{ field: 'onGround', op: 'eq', value: true }] });
  assert.equal(r.count, 1);
  assert.equal(r.items[0].id, 'GND1');
  assert.equal(r.coverage.followUp, true);
});

test('analyst: unresolved region is an honest failure, not empty success', async () => {
  const r = await makeEngine().query({ layers: ['flights'], scope: { kind: 'region', name: 'Atlantis' } });
  assert.equal(r.ok, false);
  assert.match(r.error, /Atlantis/);
});

test('analyst: a region lookup timeout is reported as region-timeout', async () => {
  const eng = createAnalystEngine({
    getRecords: () => FLIGHTS,
    resolveRegionRing: async (name) => ({ name, ring: null, error: 'region-timeout' }),
    getViewContext: () => ({ lat: 30.27, lon: -97.74, viewRadiusKm: 150 }),
  });
  const r = await eng.query({ layers: ['flights'], scope: { kind: 'region', name: 'Texas' } });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'region-timeout');
  assert.match(r.error, /Texas/);
  assert.equal(r.coverage.scope, 'region:Texas:timeout');
});

test('analyst: route fields queryable from cached enrichment only', async () => {
  const r = await makeEngine().query({
    layers: ['flights'], scope: { kind: 'anywhere' },
    filters: [{ field: 'routeDestination', op: 'eq', value: 'LAX' }],
  });
  assert.deepEqual(r.items.map((i) => i.id), ['SWA1'], 'null route fields never match');
});

test('analyst: satellites and local infrastructure are queryable layers', async () => {
  const SATS = [
    { id: 'ISS (ZARYA)', noradId: '25544', name: 'ISS (ZARYA)', lat: 30.3, lon: -97.7, altitudeM: 410000, satelliteClass: 'STATION · ISS', group: 'stations' },
    { id: 'GPS BIIR-2', noradId: '24876', name: 'GPS BIIR-2', lat: 51.0, lon: 0.0, altitudeM: 20200000, satelliteClass: 'NAV · GPS', group: 'gps-ops' },
  ];
  const DAMS = [
    { id: 'Austin Dam', name: 'Austin Dam', lat: 30.27, lon: -97.74, operator: 'LCRA', river: 'Colorado', output: '2 MW' },
    { id: 'Far Dam', name: 'Far Dam', lat: 45.0, lon: -122.0, operator: 'USACE', river: 'Columbia', output: '1000 MW' },
  ];
  const DCS = [
    { id: 'AUS-1', name: 'AUS-1', lat: 30.28, lon: -97.75, operator: 'Example Cloud', capacity: '27 MW' },
  ];
  const eng = createAnalystEngine({
    getRecords: (key) => ({ satellites: SATS, 'local-dams': DAMS, 'local-datacenters': DCS }[key] || []),
    resolveRegionRing: async (name) => (/texland/i.test(name) ? TEXLAND : null),
    getViewContext: () => ({ lat: 30.27, lon: -97.74, viewRadiusKm: 150 }),
  });

  const sats = await eng.query({
    layers: ['satellites'], scope: { kind: 'view' }, sortBy: 'distance', limit: 2,
  });
  assert.equal(sats.ok, true);
  assert.equal(sats.count, 1, 'GPS sat is out of the Austin view radius');
  assert.equal(sats.items[0].noradId, '25544');
  assert.ok(Number.isFinite(sats.items[0].distanceKm));

  const nav = await eng.query({
    layers: ['satellites'], scope: { kind: 'anywhere' },
    filters: [{ field: 'satelliteClass', op: 'contains', value: 'NAV' }],
  });
  assert.deepEqual(nav.items.map((i) => i.id), ['GPS BIIR-2']);

  const dams = await eng.query({
    layers: ['local-dams'], scope: { kind: 'view' }, sortBy: 'distance', limit: 5,
  });
  assert.equal(dams.count, 1);
  assert.equal(dams.items[0].id, 'Austin Dam');
  assert.equal(dams.items[0].river, 'Colorado');

  const dcs = await eng.query({
    layers: ['local-datacenters'], scope: { kind: 'region', name: 'Texland' },
    filters: [{ field: 'operator', op: 'contains', value: 'cloud' }],
  });
  assert.equal(dcs.count, 1);
  assert.equal(dcs.items[0].id, 'AUS-1');
});

test('helpers: haversine sanity + scope radius', () => {
  const km = haversineKm(30.2672, -97.7431, 29.7604, -95.3698); // Austin→Houston
  assert.ok(km > 200 && km < 280, `Austin-Houston ~235km, got ${km}`);
  const scoped = applyScope(FLIGHTS, { kind: 'radius' }, { center: { lat: 30.27, lon: -97.74 }, km: 50 });
  assert.deepEqual(scoped.map((f) => f.id).sort(), ['GND1', 'SWA1']);
});

test('bounded loaded cohorts disclose truncation before filtering and retain it on follow-up', async () => {
  const engine = createAnalystEngine({
    getRecords: () => [{ id: 'sample dam', lat: 0, lon: 0, name: 'sample' }],
    getRecordCoverage: () => ({ basis: 'bounded-loaded-records', recordsExamined: 1, loadedCount: 3000, sourceTruncated: true }),
    getViewContext: () => ({ lat: 0, lon: 0, viewRadiusKm: 25 }),
  });
  const result = await engine.query({ layers: ['local-dams'], scope: { kind: 'anywhere' }, sortBy: 'distance' });
  assert.equal(result.count, 1);
  assert.equal(result.coverage.layersQueried[0].sourceTruncated, true);
  assert.match(result.coverage.note, /omitted records may change the nearest item or count/);
  const followUp = await engine.query({ followUp: true });
  assert.equal(followUp.coverage.layersQueried[0].loadedCount, 3000);
});


test('follow-up provenance stays attached to old rows after a feed recovers', async () => {
  let state = 'stale';
  const engine = createAnalystEngine({
    getRecords: () => [{ id: 'A', lat: 0, lon: 0 }],
    getLayerSnapshot: () => ({ id: 'flights', enabled: true, feedState: state }),
    getViewContext: () => ({ lat: 0, lon: 0, viewRadiusKm: 25 }),
  });
  const first = await engine.query();
  state = 'nominal';
  const followUp = await engine.query({ followUp: true });
  assert.equal(first.coverage.feedProvenance.overall, 'stale');
  assert.equal(followUp.coverage.feedProvenance.overall, 'stale');
  engine.reset();
  assert.equal(engine.hasMemory(), false);
  assert.equal((await engine.query()).coverage.feedProvenance.overall, 'nominal');
});
