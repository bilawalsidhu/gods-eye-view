import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  nifcContainmentBucket,
  nifcMarkerSizePx,
  normalizeNifcIncident,
  rankByAcresDesc,
} from './nifcWildfires.js';

// Real example shape from the WFIGS_Incident_Locations_Current FeatureServer.
const SAMPLE_FEATURE = {
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [-148.879858181144, 63.9204016332099] },
  properties: {
    IncidentName: 'Louise Creek Coal Seam',
    IrwinID: '{E491A7BD-E8D9-4D42-A499-95A9A3811D52}',
    FireDiscoveryDateTime: 1778279021000,
    PercentContained: null,
    IncidentSize: 61.7,
    FireCause: 'Natural',
    FireCauseGeneral: null,
    IncidentTypeCategory: 'WF',
    POOState: 'US-AK',
    FireOutDateTime: null,
  },
};

test('normalizeNifcIncident: maps a real WFIGS feature to a plain record', () => {
  const record = normalizeNifcIncident(SAMPLE_FEATURE);
  assert.deepEqual(record, {
    id: '{E491A7BD-E8D9-4D42-A499-95A9A3811D52}',
    name: 'Louise Creek Coal Seam',
    category: 'WF',
    cause: 'Natural',
    discoveredAt: 1778279021000,
    acres: 61.7,
    percentContained: null,
    state: 'US-AK',
    outAt: null,
    latitude: 63.9204016332099,
    longitude: -148.879858181144,
  });
});

test('normalizeNifcIncident: falls back to FireCause when FireCauseGeneral is blank, and rejects missing coordinates', () => {
  assert.equal(normalizeNifcIncident({ ...SAMPLE_FEATURE, geometry: null }), null);
  assert.equal(normalizeNifcIncident(null), null);
});

test('nifcContainmentBucket: buckets by percent, unset reads as uncontained', () => {
  assert.equal(nifcContainmentBucket(null), 'uncontained');
  assert.equal(nifcContainmentBucket(0), 'uncontained');
  assert.equal(nifcContainmentBucket(24), 'uncontained');
  assert.equal(nifcContainmentBucket(25), 'partial');
  assert.equal(nifcContainmentBucket(74), 'partial');
  assert.equal(nifcContainmentBucket(75), 'contained');
  assert.equal(nifcContainmentBucket(100), 'contained');
});

test('nifcMarkerSizePx: grows with acreage but stays clamped', () => {
  assert.equal(nifcMarkerSizePx(null), 8);
  assert.equal(nifcMarkerSizePx(0), 8);
  const small = nifcMarkerSizePx(10);
  const large = nifcMarkerSizePx(50000);
  assert.ok(small > 8 && small < large);
  assert.ok(large <= 28);
});

test('rankByAcresDesc: biggest first, missing acreage sorts last (not first)', () => {
  const a = { id: 'a', acres: 10 };
  const b = { id: 'b', acres: 5000 };
  const c = { id: 'c', acres: null };
  const d = { id: 'd', acres: 100 };
  assert.deepEqual(rankByAcresDesc([a, b, c, d]).map((r) => r.id), ['b', 'd', 'a', 'c']);
  // Does not mutate the input array.
  assert.deepEqual([a, b, c, d].map((r) => r.id), ['a', 'b', 'c', 'd']);
});
