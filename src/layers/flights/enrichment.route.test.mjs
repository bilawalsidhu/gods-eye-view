import test from 'node:test';
import assert from 'node:assert/strict';
import { createEnrichment } from './enrichment.js';

function harness(callsign = 'UAL123') {
  let resolveLookup;
  let requests = 0;
  const pending = new Promise(resolve => { resolveLookup = resolve; });
  const meta = { callsign, airline: null, route: null };
  const flightState = {
    lifetime: { signal: new AbortController().signal },
    _enrichSeen: new Set(),
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
    tracking: { _updateTrackedLabelModel() { throw new Error('unexpected tracking update'); } },
  };
  const enrich = createEnrichment({ flightState, parts });
  enrich._requestRouteEnrichment('abc123');
  return { meta, flightState, resolveLookup, getRequests: () => requests };
}

async function settle() {
  // Flush the promise chains in _drainEnrich, including onData and finally.
  await new Promise(resolve => setImmediate(resolve));
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
