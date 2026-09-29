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

test('analyst: a region-timeout reports its own code, distinct from unresolved', async () => {
  // The resolver abandons (never cancels) a lookup that blows its budget —
  // the caches keep filling, so the honest answer is "ask again in a moment".
  // That must not render as "I couldn't resolve a boundary" (which reads like
  // the name is wrong) nor as an unresolved coverage scope.
  const e = createAnalystEngine({
    getRecords: () => FLIGHTS,
    resolveRegionRing: async () => ({ error: 'region-timeout' }),
    getViewContext: () => ({ lat: 30.27, lon: -97.74, viewRadiusKm: 150 }),
  });
  const r = await e.query({ layers: ['flights'], scope: { kind: 'region', name: 'Kazakhstan' } });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'region-timeout');
  assert.match(r.error, /still resolving/);
  assert.equal(r.coverage.scope, 'region:Kazakhstan:timeout');
});

test('analyst: route fields queryable from cached enrichment only', async () => {
  const r = await makeEngine().query({
    layers: ['flights'], scope: { kind: 'anywhere' },
    filters: [{ field: 'routeDestination', op: 'eq', value: 'LAX' }],
  });
  assert.deepEqual(r.items.map((i) => i.id), ['SWA1'], 'null route fields never match');
});

test('helpers: haversine sanity + scope radius', () => {
  const km = haversineKm(30.2672, -97.7431, 29.7604, -95.3698); // Austin→Houston
  assert.ok(km > 200 && km < 280, `Austin-Houston ~235km, got ${km}`);
  const scoped = applyScope(FLIGHTS, { kind: 'radius' }, { center: { lat: 30.27, lon: -97.74 }, km: 50 });
  assert.deepEqual(scoped.map((f) => f.id).sort(), ['GND1', 'SWA1']);
});

test('analyst: an unsupported layer is an honest failure naming what it can query', async () => {
  const r = await makeEngine().query({ layers: ['flights', 'ghost-layer'] });
  assert.equal(r.ok, false);
  assert.match(r.error, /ghost-layer/, 'the unsupported layer is named');
  assert.match(r.error, /flights/, 'so are the layers that would have worked');
  assert.deepEqual(r.coverage, { layersQueried: [], scope: 'unsupported-layer' });
});

test('applyScope: an unrecognized scope kind passes the records through', () => {
  // Fail-open by design: a scope kind a newer query parser emits must degrade
  // to "everywhere", never to a silently empty answer.
  const passthrough = applyScope(
    FLIGHTS,
    { kind: 'boulevard' },
    { center: { lat: 0, lon: 0 }, km: 0 },
  );
  assert.deepEqual(passthrough.map((f) => f.id), FLIGHTS.map((f) => f.id));
});

// ── wave-6b: filter operator table, scope fallbacks, follow-up memory ───────

test('applyFilter (via query): every operator arm and the degenerate guards', async () => {
  const e = makeEngine();
  const world = { layers: ['flights'], scope: { kind: 'anywhere' }, limit: 50 };

  // Guard: a filter missing field/op is returned unchanged.
  const noFilter = await e.query({ ...world, filters: [{ value: 5 }] });
  assert.equal(noFilter.count, 4, 'incomplete filter is ignored');

  const gt = await e.query({ ...world, filters: [{ field: 'altitudeM', op: 'gt', value: 5000 }] });
  assert.deepEqual(gt.items.map((i) => i.id).sort(), ['RCH01', 'SWA1']);
  const gte = await e.query({ ...world, filters: [{ field: 'altitudeM', op: 'gte', value: 11000 }] });
  assert.deepEqual(gte.items.map((i) => i.id).sort(), ['RCH01', 'SWA1']);
  const lt = await e.query({ ...world, filters: [{ field: 'speedMps', op: 'lt', value: 100 }] });
  assert.deepEqual(lt.items.map((i) => i.id).sort(), ['GND1', 'N123']);
  const lte = await e.query({ ...world, filters: [{ field: 'speedMps', op: 'lte', value: 5 }] });
  assert.deepEqual(lte.items.map((i) => i.id), ['GND1']);

  // Boolean coercion: eq with a boolean compares booleans, not strings.
  const boolEq = await e.query({ ...world, filters: [{ field: 'onGround', op: 'eq', value: true }] });
  assert.deepEqual(boolEq.items.map((i) => i.id), ['GND1']);
  const strEq = await e.query({ ...world, layers: ['ais-live-vessels'], scope: { kind: 'anywhere' }, limit: 50,
    filters: [{ field: 'destination', op: 'eq', value: 'oakland' }] });
  assert.equal(strEq.count, 1, 'string eq is case-insensitive');
  const neq = await e.query({ ...world, filters: [{ field: 'military', op: 'neq', value: false }] });
  assert.deepEqual(neq.items.map((i) => i.id), ['RCH01'], 'neq keeps the non-matching case-insensitively');
  const contains = await e.query({ ...world, layers: ['ais-live-vessels'], scope: { kind: 'anywhere' }, limit: 50,
    filters: [{ field: 'destination', op: 'contains', value: 'hou' }] });
  assert.equal(contains.count, 1, 'contains is case-insensitive');
  const unknownOp = await e.query({ ...world, filters: [{ field: 'speedMps', op: 'wat', value: 5 }] });
  assert.equal(unknownOp.count, 4, 'unknown op passes everything through');
});

test('applyFilter: null/undefined record fields never pass a comparison', async () => {
  const e = makeEngine();
  // RCH01 has routeOrigin: null — a filter on it must drop, not throw.
  const r = await e.query({
    layers: ['flights'], scope: { kind: 'anywhere' }, limit: 50,
    filters: [{ field: 'routeOrigin', op: 'eq', value: 'aus' }],
  });
  assert.deepEqual(r.items.map((i) => i.id), ['SWA1'], 'null routeOrigin drops out');
});

test('applyScope: region without a resolved ring and radius without a center pass through', () => {
  const records = [{ lat: 30.2, lon: -97.7 }, { lat: Number.NaN, lon: Number.NaN }];
  // Engine-level: a named-but-unresolvable region is an ok:false answer
  // BEFORE scope runs, so the ring-missing pass-through arm is only
  // reachable at the unit seam — an unnamed region scope with no resolved
  // ring must return the records unchanged, not empty.
  const passthrough = applyScope(records, { kind: 'region' }, { ring: null });
  assert.equal(passthrough.length, 2, 'missing ring passes records through');
  // Non-finite coordinates drop even when the ring would contain them.
  const finiteOnly = applyScope(records, { kind: 'region' }, { ring: TEXLAND.ring });
  assert.equal(finiteOnly.length, 1, 'non-finite coordinates never pass a ring test');
  // radius/view whose resolved scope lacks center/km passes through.
  const noCenter = applyScope(records, { kind: 'radius' }, { center: null });
  assert.equal(noCenter.length, 2, 'centerless radius scope is a no-op');
  // Unknown scope kind falls to the terminal passthrough.
  const other = applyScope(records, { kind: 'galaxy' }, null);
  assert.equal(other.length, 2, 'unknown scope kind is a no-op');
});

test('query: a resolved region filters to inside the ring', async () => {
  const e = makeEngine();
  const resolved = await e.query({ layers: ['flights'], scope: { kind: 'region', name: 'Texland' }, limit: 50 });
  assert.equal(resolved.count, 3, 'resolved ring filters to inside Texland');

  // radius with no resolvable center (no subject, engine without contacts):
  // scopeNote should note the fallback — records still answer from the camera.
  const e2 = makeEngine();
  const r2 = await e2.query({ layers: ['flights'], scope: { kind: 'radius', km: 100 }, limit: 50 });
  assert.ok(r2.ok && typeof r2.count === 'number', 'radius without a subject still answers');
});

test('query: unknown layers answer with the supported-list error', async () => {
  const e = makeEngine();
  const r = await e.query({ layers: ['flights', 'ufo-tracks'] });
  assert.equal(r.ok, false);
  assert.match(r.error, /ufo-tracks/);
  assert.match(r.error, /supported layers/);
});

test('query: followUp re-filters the remembered set without re-snapshotting', async () => {
  let reads = 0;
  const e = createAnalystEngine({
    getRecords: () => { reads += 1; return FLIGHTS; },
    resolveRegionRing: async () => null,
    getViewContext: () => ({ lat: 30.27, lon: -97.74, viewRadiusKm: 150 }),
  });
  const first = await e.query({ layers: ['flights'], scope: { kind: 'anywhere' }, limit: 50 });
  assert.equal(first.ok, true);
  assert.equal(reads, 1);
  assert.equal(e.hasMemory(), true, 'first query leaves a memory');

  const follow = await e.query({ followUp: true, scope: { kind: 'anywhere' }, limit: 2 });
  assert.equal(reads, 1, 'follow-up did NOT re-read the layer');
  // count reflects the FULL remembered filtered set; items is the limited top.
  assert.equal(follow.count, 4, 'follow-up re-filtered the remembered set');
  assert.equal(follow.items.length, 2, 'limit applies to the displayed top');
  assert.equal(follow.truncated, true);
  assert.equal(follow.coverage.layersQueried.length, 1, 'coverage carried over from the first query');

  e.reset();
  assert.equal(e.hasMemory(), false, 'reset clears the memory');
  const afterReset = await e.query({ followUp: true, scope: { kind: 'anywhere' } });
  assert.equal(reads, 2, 'a followUp with no memory falls back to a fresh snapshot');
  assert.ok(afterReset.ok);
});
