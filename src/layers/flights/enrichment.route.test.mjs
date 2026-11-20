import test from 'node:test';
import assert from 'node:assert/strict';
import { createEnrichment } from './enrichment.js';
import { FlightRecords } from './records.js';

const services = {
  militaryRegistry: { isMilitaryIcao: () => false },
  aircraftPresentation: { isTr3b: () => false },
};

function harness(callsign = 'UAL123') {
  let resolveLookup;
  let requests = 0;
  const pending = new Promise((resolve) => {
    resolveLookup = resolve;
  });
  const meta = { callsign, airline: null, route: null };
  const flightState = {
    lifetime: { signal: new AbortController().signal },
    _enrichSeen: new Set(),
    _enrichRetryAfter: new Map(),
    _enrichQueue: [],
    _enrichActive: 0,
    _enrichLastDispatchMs: 0,
    _enrichDripTimer: null,
    feed: {
      _source: {
        async getEnrichment() {
          requests++;
          return pending;
        },
      },
    },
    records: { data: new Map([['abc123', meta]]) },
    _trackedIcao: null,
    _trackedEntity: null,
  };
  const parts = {
    tracking: {
      _updateTrackedLabelModel() {
        throw new Error('unexpected tracking update');
      },
    },
  };
  const enrich = createEnrichment({ flightState, parts, services });
  enrich._requestRouteEnrichment('abc123');
  return { meta, flightState, resolveLookup, getRequests: () => requests };
}

async function settle() {
  // Flush the promise chains in _drainEnrich, including onData and finally.
  await new Promise((resolve) => setImmediate(resolve));
}

const result = {
  found: true,
  airline: 'United Airlines',
  origin: { code: 'SFO' },
  destination: { code: 'EWR' },
  source: 'adsbdb',
  retrievedAtMs: 1700000000000,
};

test('delayed enrichment never attaches an old route to a changed callsign', async () => {
  const h = harness();
  h.meta.callsign = 'DAL456';
  h.resolveLookup(result);
  await settle();
  assert.equal(h.meta.route, null);
  assert.equal(h.meta.airline, null);
  assert.equal(h.getRequests(), 1);
});

test('matching lookup is kept with explicit unverified reference provenance', async () => {
  const h = harness();
  h.resolveLookup(result);
  await settle();
  assert.equal(h.meta.route.origin.code, 'SFO');
  assert.equal(h.meta.route.source, 'adsbdb');
  assert.equal(h.meta.route.verification, 'unverified-reference');
  assert.equal(h.meta.route.retrievedAtMs, 1700000000000);
  assert.equal(h.meta.route.operatingDate, null);
});

test('removed aircraft is not recreated by late route results', async () => {
  const h = harness();
  h.flightState.records.data.delete('abc123');
  h.resolveLookup(result);
  await settle();
  assert.equal(h.flightState.records.data.size, 0);
});

test('a callsign A-B-A cycle drops the old route and permits a fresh lookup', async () => {
  const records = new FlightRecords({
    geoidHeight: () => 0,
    cachedGroundFloor: () => null,
    floorAltitudeM: (altitude) => altitude,
  });
  const receive = (callsign) =>
    records.receive(
      {
        id: 'abc123',
        reference: 'abc123',
        longitude: -77,
        latitude: 39,
        callsign,
        baroAltitudeM: 1000,
        ellipsoidAltitudeM: null,
        onGround: false,
        speedMps: 120,
        courseDeg: 90,
      },
      {
        viewerLatDeg: null,
        viewerLonDeg: null,
        trackedId: null,
        floorWarmPoints: [],
      },
    ).meta;

  const first = receive('UAL123');
  const requests = [];
  const flightState = {
    lifetime: { signal: new AbortController().signal },
    _enrichSeen: new Set(),
    _enrichRetryAfter: new Map(),
    _enrichQueue: [],
    _enrichActive: 0,
    _enrichLastDispatchMs: 0,
    _enrichDripTimer: null,
    records,
    feed: {
      _source: {
        getEnrichment(query) {
          return new Promise((resolve) => {
            requests.push({ callsign: query.id, resolve });
          });
        },
      },
    },
    _trackedIcao: null,
    _trackedEntity: null,
  };
  const enrich = createEnrichment({
    flightState,
    services,
    parts: {
      tracking: {
        _updateTrackedLabelModel() {
          throw new Error('unexpected tracking update');
        },
      },
    },
  });

  enrich._requestRouteEnrichment('abc123');
  await settle();
  assert.equal(requests.length, 1);
  receive('DAL456');
  const returned = receive('UAL123');
  requests[0].resolve(result);
  await settle();

  assert.equal(
    returned.route,
    null,
    'the first UAL123 response belongs to an obsolete association',
  );
  assert.notEqual(
    returned.routeAssociationVersion,
    first.routeAssociationVersion,
  );

  // A new request for the same callsign is not blocked by the old dedup key.
  flightState._enrichLastDispatchMs = 0;
  enrich._requestRouteEnrichment('abc123');
  await settle();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].callsign, 'UAL123');
  requests[1].resolve({ ...result, origin: { code: 'LAX' } });
  await settle();
  assert.equal(records.data.get('abc123').route.origin.code, 'LAX');
});
