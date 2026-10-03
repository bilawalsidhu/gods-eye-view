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
  const first = await eng.query({
    layers: ['flights'],
    scope: { kind: 'region', name: 'Texland' },
  });
  const r = await eng.query({
    followUp: true,
    filters: [{ field: 'onGround', op: 'eq', value: true }],
  });
  assert.equal(r.count, 1);
  assert.equal(r.items[0].id, 'GND1');
  assert.equal(r.coverage.followUp, true);
  assert.equal(r.scopeLabel, first.scopeLabel);
  assert.equal(r.display.scope, first.display.scope);
  assert.equal(r.coverage.scope, first.coverage.scope);
});

test('analyst: follow-ups preserve partial and unanswered coverage', async () => {
  const eng = createAnalystEngine({
    getRecords: (key) => (key === 'flights' ? FLIGHTS : []),
    getLayerSnapshot: (key) => ({
      enabled: key === 'flights',
      feedState: key === 'flights' ? 'nominal' : 'off',
    }),
    getViewContext: () => ({ lat: 30.27, lon: -97.74, viewRadiusKm: 150 }),
  });
  const first = await eng.query({
    layers: ['flights', 'military'],
    scope: { kind: 'anywhere' },
  });
  assert.equal(first.partial, true);
  assert.deepEqual(first.unanswered, ['military']);

  const followUp = await eng.query({ followUp: true, limit: 1 });
  assert.equal(followUp.partial, true);
  assert.deepEqual(followUp.unanswered, ['military']);
  assert.deepEqual(
    followUp.coverage.layersQueried.map(({ layerKey, status }) => [
      layerKey,
      status,
    ]),
    first.coverage.layersQueried.map(({ layerKey, status }) => [
      layerKey,
      status,
    ]),
  );
});

test('analyst: cancelled pre-commit work cannot replace follow-up memory', async () => {
  const eng = makeEngine();
  await eng.query({
    layers: ['flights'],
    scope: { kind: 'anywhere' },
    filters: [{ field: 'id', op: 'eq', value: 'SWA1' }],
  });
  let current = true;
  const stale = await eng.query(
    { layers: ['local-firms'], scope: { kind: 'anywhere' } },
    {
      isCurrent: () => current,
      beforeCommit: async () => {
        current = false;
      },
    },
  );
  assert.equal(stale.code, 'CANCELLED');
  const followUp = await eng.query({ followUp: true });
  assert.deepEqual(followUp.items.map((item) => item.id), ['SWA1']);
});

test('analyst: failed pre-commit work cannot replace follow-up memory', async () => {
  const eng = makeEngine();
  await eng.query({
    layers: ['flights'],
    scope: { kind: 'anywhere' },
    filters: [{ field: 'id', op: 'eq', value: 'SWA1' }],
  });
  await assert.rejects(
    eng.query(
      { layers: ['local-firms'], scope: { kind: 'anywhere' } },
      {
        beforeCommit: async () => {
          throw new Error('projection failed');
        },
      },
    ),
    /projection failed/,
  );
  const followUp = await eng.query({ followUp: true });
  assert.deepEqual(followUp.items.map((item) => item.id), ['SWA1']);
});

test('analyst: follow-ups preserve partial and unanswered coverage', async () => {
  const eng = createAnalystEngine({
    getRecords: (key) => (key === 'flights' ? FLIGHTS : []),
    getLayerSnapshot: (key) => ({
      enabled: key === 'flights',
      feedState: key === 'flights' ? 'nominal' : 'off',
    }),
    getViewContext: () => ({ lat: 30.27, lon: -97.74, viewRadiusKm: 150 }),
  });
  const first = await eng.query({
    layers: ['flights', 'military'],
    scope: { kind: 'anywhere' },
  });
  assert.equal(first.partial, true);
  assert.deepEqual(first.unanswered, ['military']);

  const followUp = await eng.query({ followUp: true, limit: 1 });
  assert.equal(followUp.partial, true);
  assert.deepEqual(followUp.unanswered, ['military']);
  assert.deepEqual(
    followUp.coverage.layersQueried.map(({ layerKey, status }) => [
      layerKey,
      status,
    ]),
    first.coverage.layersQueried.map(({ layerKey, status }) => [
      layerKey,
      status,
    ]),
  );
});

test('analyst: cancelled pre-commit work cannot replace follow-up memory', async () => {
  const eng = makeEngine();
  await eng.query({
    layers: ['flights'],
    scope: { kind: 'anywhere' },
    filters: [{ field: 'id', op: 'eq', value: 'SWA1' }],
  });
  let current = true;
  const stale = await eng.query(
    { layers: ['local-firms'], scope: { kind: 'anywhere' } },
    {
      isCurrent: () => current,
      beforeCommit: async () => {
        current = false;
      },
    },
  );
  assert.equal(stale.code, 'CANCELLED');
  const followUp = await eng.query({ followUp: true });
  assert.deepEqual(
    followUp.items.map((item) => item.id),
    ['SWA1'],
  );
});

test('analyst: failed pre-commit work cannot replace follow-up memory', async () => {
  const eng = makeEngine();
  await eng.query({
    layers: ['flights'],
    scope: { kind: 'anywhere' },
    filters: [{ field: 'id', op: 'eq', value: 'SWA1' }],
  });
  await assert.rejects(
    eng.query(
      { layers: ['local-firms'], scope: { kind: 'anywhere' } },
      {
        beforeCommit: async () => {
          throw new Error('projection failed');
        },
      },
    ),
    /projection failed/,
  );
  const followUp = await eng.query({ followUp: true });
  assert.deepEqual(
    followUp.items.map((item) => item.id),
    ['SWA1'],
  );
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

test('analyst: region lookup receives and obeys the owning action signal', async () => {
  const controller = new AbortController();
  let receivedSignal = null;
  const eng = createAnalystEngine({
    getRecords: () => FLIGHTS,
    resolveRegionRing: async (_name, { signal }) => {
      receivedSignal = signal;
      await new Promise((resolve) =>
        signal.addEventListener('abort', resolve, { once: true }),
      );
      return null;
    },
    getViewContext: () => ({
      lat: 30.27,
      lon: -97.74,
      viewRadiusKm: 150,
    }),
  });
  const pending = eng.query(
    { layers: ['flights'], scope: { kind: 'region', name: 'Texas' } },
    {
      signal: controller.signal,
      isCurrent: () => !controller.signal.aborted,
    },
  );
  await Promise.resolve();
  controller.abort();
  const result = await pending;
  assert.equal(receivedSignal, controller.signal);
  assert.equal(result.code, 'CANCELLED');
  assert.equal(result.cancelled, true);
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

test('capped cohorts report returned/total/truncated and keep it on follow-up', async () => {
  const engine = createAnalystEngine({
    getRecords: () => [{ id: 'sample dam', lat: 0, lon: 0, name: 'sample' }],
    getRecordCoverage: () => ({ total: 3000, truncated: true }),
    getViewContext: () => ({ lat: 0, lon: 0, viewRadiusKm: 25 }),
  });
  const result = await engine.query({ layers: ['local-dams'], scope: { kind: 'anywhere' }, sortBy: 'distance' });
  assert.equal(result.count, 1);
  const layer = result.coverage.layersQueried[0];
  assert.deepEqual({ returned: layer.returned, total: layer.total, truncated: layer.truncated }, { returned: 1, total: 3000, truncated: true });
  assert.deepEqual(result.coverage.records, { returned: 1, total: 3000, truncated: true });
  assert.match(result.display.caveat, /counted 1 of 3,000 loaded records/);
  const followUp = await engine.query({ followUp: true });
  assert.equal(followUp.coverage.layersQueried[0].total, 3000);
});

test('an uncapped cohort is complete and carries no caveat', async () => {
  const result = await makeEngine().query({ layers: ['flights'], scope: { kind: 'anywhere' } });
  assert.deepEqual(result.coverage.records, { returned: 4, total: 4, truncated: false });
  assert.equal(result.display.caveat, undefined);
  assert.equal(result.display.scope, 'anywhere in the loaded data');
});

test('unknown fields, operators, scopes and wrong-typed values are refused with the allowed values', async () => {
  const engine = makeEngine();
  const field = await engine.query({ layers: ['flights'], filters: [{ field: 'time', op: 'gte', value: 5 }] });
  assert.equal(field.ok, false);
  assert.equal(field.code, 'UNKNOWN_FIELD');
  assert.ok(field.allowed.includes('altitudeM'));
  const op = await engine.query({ layers: ['flights'], filters: [{ field: 'altitudeM', op: 'wat', value: 5 }] });
  assert.equal(op.code, 'BAD_OPERATOR');
  assert.deepEqual(op.allowed, ['gt', 'gte', 'lt', 'lte', 'eq', 'neq']);
  const flag = await engine.query({ layers: ['flights'], filters: [{ field: 'military', op: 'eq', value: 'false' }] });
  assert.equal(flag.code, 'BAD_VALUE', 'the string "false" must not match the TRUE record');
  const num = await engine.query({ layers: ['flights'], filters: [{ field: 'altitudeM', op: 'gt', value: 'high' }] });
  assert.equal(num.code, 'BAD_VALUE');
  const scope = await engine.query({ layers: ['flights'], scope: { kind: 'polygon' } });
  assert.equal(scope.code, 'UNKNOWN_SCOPE');
  assert.deepEqual(scope.allowed, ['view', 'region', 'radius', 'anywhere', 'area', 'drawn', 'annotation']);
  const noId = await engine.query({ layers: ['flights'], scope: { kind: 'area' } });
  assert.equal(noId.code, 'BAD_SCOPE', 'an area scope needs its areaId');
  const sort = await engine.query({ layers: ['flights'], sortBy: 'loudness' });
  assert.equal(sort.code, 'UNKNOWN_FIELD');
  assert.equal(engine.hasMemory(), false, 'refusals never become follow-up memory');
});

test('a typed boolean filter still matches exactly', async () => {
  const r = await makeEngine().query({ layers: ['flights'], scope: { kind: 'anywhere' }, filters: [{ field: 'military', op: 'eq', value: false }] });
  assert.deepEqual(r.items.map((i) => i.id).sort(), ['GND1', 'N123', 'SWA1']);
});

test('distance honours sortDir: desc is farthest first', async () => {
  const far = await makeEngine().query({ layers: ['flights'], scope: { kind: 'anywhere' }, sortBy: 'distance', sortDir: 'desc', limit: 1 });
  assert.equal(far.items[0].id, 'N123');
  const near = await makeEngine().query({ layers: ['flights'], scope: { kind: 'anywhere' }, sortBy: 'distance', limit: 1 });
  assert.equal(near.items[0].id, 'SWA1');
});

test('a follow-up without a previous answer is refused, not a fresh flights query', async () => {
  const r = await makeEngine().query({ followUp: true, filters: [] });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'NO_RESULT_CONTEXT');
});

test('follow-ups never rewrite the remembered rows', async () => {
  const engine = makeEngine();
  await engine.query({ layers: ['flights'], scope: { kind: 'anywhere' } });
  await engine.query({ followUp: true, sortBy: 'distance' });
  const again = await engine.query({ followUp: true });
  assert.equal(again.count, 4, 'a follow-up keeps the remembered set, not the view');
  assert.ok(again.items.every((item) => item.distanceKm === undefined));
});

test('a superseded slow region query cannot overwrite the newer follow-up memory', async () => {
  let releaseSlow;
  const engine = createAnalystEngine({
    getRecords: (key) => ({ flights: FLIGHTS, 'ais-live-vessels': SHIPS }[key] || []),
    resolveRegionRing: () => new Promise((resolve) => { releaseSlow = () => resolve(TEXLAND); }),
    getViewContext: () => ({ lat: 30.27, lon: -97.74, viewRadiusKm: 150 }),
  });
  let generation = 0;
  const slowGeneration = ++generation;
  const slow = engine.query({ layers: ['flights'], scope: { kind: 'region', name: 'Texland' } }, { isCurrent: () => generation === slowGeneration });
  const newGeneration = ++generation;
  const fresh = await engine.query({ layers: ['ais-live-vessels'], scope: { kind: 'anywhere' } }, { isCurrent: () => generation === newGeneration });
  assert.equal(fresh.ok, true);
  releaseSlow();
  const stale = await slow;
  assert.equal(stale.code, 'CANCELLED');
  const followUp = await engine.query({ followUp: true });
  assert.deepEqual(followUp.items.map((i) => i.layerKey), ['ais-live-vessels', 'ais-live-vessels']);
});

test('off, loading and unavailable layers are refused distinctly; a real zero stays ok', async () => {
  const engineFor = (snapshot, rows = [], warming = false) => createAnalystEngine({
    getRecords: () => rows,
    getLayerSnapshot: () => snapshot,
    isWarming: () => warming,
    getViewContext: () => ({ lat: 0, lon: 0, viewRadiusKm: 25 }),
  });
  assert.equal((await engineFor({ enabled: false, feedState: 'off' }).query({ layers: ['earthquakes'] })).code, 'LAYER_OFF');
  assert.equal((await engineFor({ enabled: true, feedState: 'loading' }).query({ layers: ['earthquakes'] })).code, 'NOT_READY');
  assert.equal((await engineFor({ enabled: true, feedState: 'nominal' }, [], true).query({ layers: ['earthquakes'] })).code, 'NOT_READY');
  assert.equal((await engineFor({ enabled: true, feedState: 'unavailable' }).query({ layers: ['earthquakes'] })).code, 'FEED_UNAVAILABLE');
  const zero = await engineFor({ enabled: true, feedState: 'nominal' }, [{ id: 'q', lat: 50, lon: 50, magnitude: 2 }]).query({ layers: ['earthquakes'], filters: [{ field: 'magnitude', op: 'gte', value: 5 }] });
  assert.equal(zero.ok, true);
  assert.equal(zero.count, 0);
  assert.equal(zero.coverage.layersQueried[0].status, 'ok');
});

test('time fields filter by ISO and derive ageHours; the feed window is exposed', async () => {
  const now = Date.parse('2026-09-23T12:00:00Z');
  const engine = createAnalystEngine({
    now: () => now,
    getRecords: () => [
      { id: 'recent', lat: 0, lon: 0, magnitude: 4, timeMs: now - 2 * 3_600_000 },
      { id: 'older', lat: 0, lon: 0, magnitude: 5, timeMs: now - 20 * 3_600_000 },
    ],
    getViewContext: () => ({ lat: 0, lon: 0, viewRadiusKm: 25 }),
  });
  const iso = await engine.query({ layers: ['earthquakes'], scope: { kind: 'anywhere' }, filters: [{ field: 'timeMs', op: 'gte', value: '2026-09-23T06:00:00Z' }] });
  assert.deepEqual(iso.items.map((i) => i.id), ['recent']);
  const age = await engine.query({ layers: ['earthquakes'], scope: { kind: 'anywhere' }, filters: [{ field: 'ageHours', op: 'lte', value: 6 }] });
  assert.deepEqual(age.items.map((i) => i.id), ['recent']);
  assert.equal(age.items[0].ageHours, 2);
  assert.equal(age.display.window, 'last 24 h');
  assert.equal(age.coverage.layersQueried[0].window, 'last 24 h');
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

test('a large loaded set sorts and summarizes without overflowing the stack', async () => {
  const rows = Array.from({ length: 200_000 }, (_, i) => ({ id: `FIRE-${i}`, lat: 0, lon: 0, frp: i }));
  const engine = createAnalystEngine({
    getRecords: () => rows,
    getViewContext: () => ({ lat: 0, lon: 0, viewRadiusKm: 25 }),
  });
  const result = await engine.query({ layers: ['local-firms'], scope: { kind: 'anywhere' }, sortBy: 'frp', limit: 1 });
  assert.equal(result.count, 200_000);
  assert.equal(result.items[0].frp, 199_999);
  assert.equal(result.summary.frpMin, 0);
});

test('an enabled but empty layer says why on screen', async () => {
  const engine = createAnalystEngine({
    getRecords: () => [],
    getLayerSnapshot: () => ({ enabled: true, feedState: 'nominal' }),
    getEmptyNote: () => 'Fly below 400 km to a covered region',
    getViewContext: () => ({ lat: 0, lon: 0, viewRadiusKm: 25 }),
  });
  const result = await engine.query({ layers: ['transit'] });
  assert.equal(result.ok, true);
  assert.equal(result.count, 0);
  assert.equal(result.coverage.layersQueried[0].status, 'empty');
  assert.match(result.display.caveat, /transit: Fly below 400 km/);
});

test('a radius around a named place without a centre is refused, not measured around the camera', async () => {
  const r = await makeEngine().query({ layers: ['ais-live-vessels'], scope: { kind: 'radius', name: 'Singapore', km: 200 } });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'BAD_SCOPE');
  const ok = await makeEngine().query({ layers: ['ais-live-vessels'], scope: { kind: 'radius', name: 'Houston', km: 200, center: { lat: 29.6, lon: -95.0 } } });
  assert.equal(ok.ok, true);
});

test('a field copied with its hinted unit still resolves', async () => {
  const r = await makeEngine().query({ layers: ['local-firms'], scope: { kind: 'anywhere' }, sortBy: 'frp(MW)', filters: [{ field: 'frp (MW)', op: 'gt', value: 100 }] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.items.map((i) => i.id), ['FIRE-3', 'FIRE-1']);
});

test('a written unit converts to the field unit or is refused', async () => {
  const engine = makeEngine();
  const feet = await engine.query({ layers: ['flights'], scope: { kind: 'anywhere' }, filters: [{ field: 'altitudeM(ft)', op: 'gt', value: 40000 }] });
  assert.equal(feet.ok, true);
  assert.deepEqual(feet.items.map((i) => i.id), ['RCH01'], '40,000 ft is 12,192 m, not 40,000 m');
  const same = await engine.query({ layers: ['flights'], scope: { kind: 'anywhere' }, filters: [{ field: 'altitudeM (m)', op: 'gt', value: 12192 }] });
  assert.deepEqual(same.items.map((i) => i.id), ['RCH01']);
  const knots = await engine.query({ layers: ['flights'], scope: { kind: 'anywhere' }, filters: [{ field: 'speedMps(kts)', op: 'gt', value: 470 }] });
  assert.deepEqual(knots.items.map((i) => i.id), ['RCH01'], '470 kn is ~242 m/s');
  const wrong = await engine.query({ layers: ['flights'], filters: [{ field: 'altitudeM(kts)', op: 'gt', value: 1 }] });
  assert.equal(wrong.code, 'BAD_UNIT');
  const unitless = await engine.query({ layers: ['flights'], filters: [{ field: 'callsign(ft)', op: 'eq', value: 'X' }] });
  assert.equal(unitless.code, 'BAD_UNIT');
  const hinted = await engine.query({ layers: ['local-firms'], scope: { kind: 'anywhere' }, sortBy: 'frp(MW)' });
  assert.equal(hinted.ok, true);
});

test('unambiguous numeric strings are numbers; blanks, booleans and words are not', async () => {
  const engine = makeEngine();
  const text = await engine.query({ layers: ['flights'], scope: { kind: 'anywhere' }, filters: [{ field: 'altitudeM', op: 'gt', value: '12192' }] });
  assert.equal(text.ok, true);
  assert.deepEqual(text.items.map((i) => i.id), ['RCH01']);
  for (const value of ['', '  ', true, 'high', '12k'])
    assert.equal((await engine.query({ layers: ['flights'], filters: [{ field: 'altitudeM', op: 'gt', value }] })).code, 'BAD_VALUE', JSON.stringify(value));
});

test('any supplied centre must be a real coordinate', async () => {
  const engine = makeEngine();
  for (const center of [{ lat: 0 }, { lat: 999, lon: 0 }, { lat: 10, lon: 200 }, { lat: '10', lon: 20 }])
    assert.equal((await engine.query({ layers: ['flights'], scope: { kind: 'radius', km: 100, center } })).code, 'BAD_SCOPE', JSON.stringify(center));
  assert.equal((await engine.query({ layers: ['flights'], scope: { kind: 'radius', km: 100, center: { lat: 30.2, lon: -97.7 } } })).ok, true);
});

test('mixed off/loading/unavailable layers refuse; a partly answerable query says so', async () => {
  const snapshots = { earthquakes: { enabled: true, feedState: 'unavailable' }, 'local-firms': { enabled: true, feedState: 'loading' }, flights: { enabled: false, feedState: 'off' } };
  const engine = createAnalystEngine({
    getRecords: (key) => (key === 'ais-live-vessels' ? SHIPS : []),
    getLayerSnapshot: (key) => snapshots[key] || { enabled: true, feedState: 'nominal' },
    getViewContext: () => ({ lat: 0, lon: 0, viewRadiusKm: 25 }),
  });
  const none = await engine.query({ layers: ['earthquakes', 'local-firms', 'flights'] });
  assert.equal(none.ok, false);
  assert.equal(none.code, 'NOT_READY');
  assert.deepEqual(none.layerStatus.map((l) => l.status), ['error', 'loading', 'off']);
  assert.equal(engine.hasMemory(), false, 'a refusal never becomes follow-up memory');
  const down = await engine.query({ layers: ['earthquakes', 'flights'] });
  assert.equal(down.code, 'FEED_UNAVAILABLE');
  const partial = await engine.query({ layers: ['ais-live-vessels', 'earthquakes'], scope: { kind: 'anywhere' } });
  assert.equal(partial.ok, true);
  assert.equal(partial.partial, true);
  assert.deepEqual(partial.unanswered, ['earthquakes']);
  assert.match(partial.display.caveat, /earthquakes error/);
});

test('returned items are copies: mutating them cannot change the remembered answer', async () => {
  const engine = makeEngine();
  const first = await engine.query({ layers: ['flights'], scope: { kind: 'anywhere' }, sortBy: 'altitudeM' });
  for (const item of first.items) {
    item.altitudeM = -1;
    item.id = 'MUTATED';
  }
  const again = await engine.query({ followUp: true, sortBy: 'altitudeM' });
  assert.deepEqual(again.items.map((i) => i.id), ['RCH01', 'SWA1', 'N123', 'GND1']);
  assert.equal(FLIGHTS[1].altitudeM, 13500, 'the provider rows are untouched');
});

test('ranking 250k rows stays within a budget and yields to the page', async () => {
  const rows = Array.from({ length: 250_000 }, (_, i) => ({ id: `F${i}`, lat: (i % 170) - 85, lon: (i % 350) - 175, frp: (i * 7919) % 100_003 }));
  const engine = createAnalystEngine({ getRecords: () => rows, getViewContext: () => ({ lat: 0, lon: 0, viewRadiusKm: 25 }) });
  let ticks = 0;
  const timer = setInterval(() => ticks++, 0);
  const started = performance.now();
  const result = await engine.query({ layers: ['local-firms'], scope: { kind: 'anywhere' }, sortBy: 'frp', limit: 1 });
  const elapsed = performance.now() - started;
  clearInterval(timer);
  assert.equal(result.count, 250_000);
  assert.equal(result.items[0].frp, 100_002);
  assert.ok(elapsed < 400, `took ${Math.round(elapsed)} ms`);
  assert.ok(ticks > 0, 'the scan yielded between slices');
  let current = true;
  const pending = engine.query({ layers: ['local-firms'], scope: { kind: 'anywhere' }, sortBy: 'distance' }, { isCurrent: () => current });
  current = false;
  assert.equal((await pending).code, 'CANCELLED', 'a superseded scan stops at the next slice');
});

test('analyst: a follow-up naming other layers than the last answer is refused', async () => {
  const engine = createAnalystEngine({
    getRecords: (key) => ({ flights: FLIGHTS, 'local-firms': FIRES }[key] || []),
    resolveRegionRing: async () => null,
    getViewContext: () => ({ lat: 30.27, lon: -97.74, viewRadiusKm: 150 }),
  });
  await engine.query({ layers: ['flights'], scope: { kind: 'anywhere' } });
  const r = await engine.query({ layers: ['local-firms'], followUp: true });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'FOLLOW_UP_MISMATCH');
  assert.equal(engine.hasMemory(), true, 'the earlier answer is still the last answer');
});

// ── Area handles: region multipolygons and the area / drawn / annotation scopes ──

const box = (w, s, e, n) => [[w, s], [e, s], [e, n], [w, n], [w, s]];

function makeAreaEngine(overrides = {}) {
  return createAnalystEngine({
    getRecords: (key) => ({ flights: FLIGHTS, 'local-firms': FIRES }[key] || []),
    resolveRegionRing: async () => null,
    getViewContext: () => ({ lat: 30.27, lon: -97.74, viewRadiusKm: 150 }),
    ...overrides,
  });
}

test('analyst: a region counts every part of a multipolygon and skips its holes', async () => {
  // Main part around Austin with a hole over the airport ground traffic, and a
  // separate island over Oregon: the old largest-ring shortcut dropped N123.
  const engine = makeAreaEngine({
    resolveRegionRing: async () => ({
      name: 'Archipelago',
      geometry: [
        [box(-100, 28, -94, 33), box(-97.7, 30.1, -97.6, 30.25)],
        [box(-123, 44, -121, 46)],
      ],
      source: 'osm',
    }),
  });
  const r = await engine.query({ layers: ['flights'], scope: { kind: 'region', name: 'Archipelago' }, limit: 10 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.items.map((i) => i.id).sort(), ['N123', 'RCH01']);
  assert.equal(r.count, 2, 'SWA1 and GND1 sit in the hole');
  assert.match(r.display.scope, /over Archipelago · osm/);
});

test('analyst: an ambiguous region asks instead of counting', async () => {
  const engine = makeAreaEngine({
    resolveRegionRing: async () => ({
      ok: false,
      needsClarification: true,
      candidates: [{ candidateId: 'osm:r1', name: 'Georgia', level: 'country' }],
      error: '"Georgia" matches 2 places — ask which one.',
    }),
  });
  const r = await engine.query({ layers: ['flights'], scope: { kind: 'region', name: 'Georgia' } });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'NEEDS_CLARIFICATION');
  assert.equal(r.candidates.length, 1);
  assert.equal(engine.hasMemory(), false);
});

test('analyst: region lookup receives the caller lifetime signal', async () => {
  const controller = new AbortController();
  let received;
  const engine = makeAreaEngine({
    resolveRegionRing: async (_name, options) => {
      received = options?.signal;
      return { error: 'region-timeout' };
    },
  });
  const result = await engine.query(
    {
      layers: ['flights'],
      scope: { kind: 'region', name: 'Signal Region' },
    },
    { signal: controller.signal },
  );
  assert.equal(received, controller.signal);
  assert.equal(result.code, 'region-timeout');
});

test('analyst: an area scope counts inside the stored handle and names it', async () => {
  const { prepareArea } = await import('./areaGeometry.js');
  const prepared = prepareArea([[box(-99, 30, -97.5, 31)]]);
  const seen = [];
  const engine = makeAreaEngine({
    resolveAreaScope: async (scope) => {
      seen.push(scope);
      if (scope.kind === 'area' && scope.areaId === 'osm:r42')
        return { ok: true, area: { areaId: 'osm:r42', name: 'Hill Country', prepared, source: 'osm' } };
      if (scope.kind === 'drawn')
        return { ok: true, area: { areaId: 'anno:anno-7', name: 'the drawn area', prepared, source: 'drawn' } };
      return { ok: false, code: 'AREA_UNKNOWN', error: 'No such area' };
    },
  });
  const fires = await engine.query({ layers: ['local-firms'], scope: { kind: 'area', areaId: 'osm:r42' } });
  assert.equal(fires.ok, true);
  assert.equal(fires.count, 2);
  assert.equal(fires.scopeLabel, 'inside Hill Country');
  assert.equal(fires.areaId, 'osm:r42');
  assert.equal(fires.coverage.scope, 'area:osm:r42');
  const followUp = await engine.query({ followUp: true, limit: 1 });
  assert.equal(followUp.scopeLabel, 'inside Hill Country');
  assert.match(followUp.display.scope, /inside Hill Country/);
  assert.equal(followUp.coverage.scope, 'area:osm:r42');
  assert.equal(followUp.areaId, 'osm:r42');
  const drawn = await engine.query({ layers: ['flights'], scope: { kind: 'drawn' } });
  assert.equal(drawn.ok, true);
  assert.equal(drawn.count, 2, 'SWA1 and GND1 sit inside the drawn box');
  const missing = await engine.query({ layers: ['flights'], scope: { kind: 'area', areaId: 'osm:r0' } });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'AREA_UNKNOWN');
  assert.deepEqual(seen.map((s) => s.kind), ['area', 'drawn', 'area']);
});

test('analyst: an area scope superseded while resolving is cancelled and leaves no memory', async () => {
  const { prepareArea } = await import('./areaGeometry.js');
  let current = true;
  const engine = makeAreaEngine({
    resolveAreaScope: async () => {
      current = false; // a newer turn arrived while the area was looked up
      return { ok: true, area: { name: 'X', prepared: prepareArea([[box(-100, 28, -94, 33)]]) } };
    },
  });
  const r = await engine.query(
    { layers: ['flights'], scope: { kind: 'annotation' } },
    { isCurrent: () => current },
  );
  assert.equal(r.code, 'CANCELLED');
  assert.equal(engine.hasMemory(), false);
});

test('analyst: without an area provider the area scopes refuse plainly', async () => {
  const r = await makeAreaEngine().query({ layers: ['flights'], scope: { kind: 'drawn' } });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'AREA_UNAVAILABLE');
});
