import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDisasterAccessPacket,
  evaluateDisasterRouteSupport,
  normalizeDisasterAccessSegment,
} from './disasterAccess.js';

function segment(id, state = 'open', freshness = 'fresh') {
  return {
    id,
    state,
    determination: 'observed',
    observedAt: '2026-08-26T08:00:00Z',
    receivedAt: '2026-08-26T08:01:00Z',
    freshness,
    provenance: { source: 'fixture' },
  };
}

test('missing access remains explicitly not assessed', () => {
  const packet = buildDisasterAccessPacket({
    event: {
      id: 'bhote-koshi-2026',
      title: 'Bhote Koshi Outburst Flood',
      observedDate: '2026-08-26',
    },
  });

  assert.equal(packet.event.id, 'bhote-koshi-2026');
  assert.deepEqual(packet.access.segments, []);
  assert.deepEqual(packet.gaps, ['access-not-assessed']);
});

test('a fresh blocked segment invalidates an otherwise supported candidate', () => {
  const route = { id: 'relief-a', segmentIds: ['a', 'b', 'c'] };
  const baseline = [
    segment('a'),
    segment('b'),
    segment('c'),
  ];

  assert.equal(
    evaluateDisasterRouteSupport(route, baseline).support,
    'supported',
  );

  const outage = baseline.map((entry) =>
    entry.id === 'b' ? segment('b', 'blocked') : entry,
  );
  const result = evaluateDisasterRouteSupport(route, outage);

  assert.equal(result.support, 'unsupported');
  assert.deepEqual(result.reasons, ['blocked:b']);
});

test('stale open evidence cannot support a current-open route claim', () => {
  const result = evaluateDisasterRouteSupport(
    { id: 'relief-a', segmentIds: ['a'] },
    [segment('a', 'open', 'stale')],
  );

  assert.equal(result.support, 'unknown');
  assert.deepEqual(result.reasons, ['stale-access:a']);
});

test('unknown, not-assessed and missing segments remain unknown', () => {
  const access = [
    segment('a', 'unknown'),
    segment('b', 'not-assessed'),
  ];
  const result = evaluateDisasterRouteSupport(
    { id: 'relief-a', segmentIds: ['a', 'b', 'c'] },
    access,
  );

  assert.equal(result.support, 'unknown');
  assert.deepEqual(result.reasons, [
    'unknown:a',
    'not-assessed:b',
    'missing-access:c',
  ]);
});

test('fresh degraded evidence stays distinct from open', () => {
  const result = evaluateDisasterRouteSupport(
    { id: 'relief-a', segmentIds: ['a', 'b'] },
    [segment('a'), segment('b', 'degraded')],
  );

  assert.equal(result.support, 'degraded');
  assert.deepEqual(result.reasons, ['degraded:b']);
});

test('invalid state fails closed to unknown instead of disappearing', () => {
  const normalized = normalizeDisasterAccessSegment({
    id: 'a',
    state: 'probably-open',
    determination: 'declared',
    freshness: 'fresh',
  });

  assert.equal(normalized.state, 'unknown');
  assert.equal(normalized.determination, 'declared');
  assert.equal(
    evaluateDisasterRouteSupport(
      { id: 'relief-a', segmentIds: ['a'] },
      [normalized],
    ).support,
    'unknown',
  );
});

test('candidate with no mapped access segments is unknown', () => {
  const result = evaluateDisasterRouteSupport(
    { id: 'relief-a', segmentIds: [] },
    [],
  );

  assert.equal(result.support, 'unknown');
  assert.deepEqual(result.reasons, ['route-segments-not-mapped']);
});

test('packet results use evidence-support language, never a safety verdict', () => {
  const packet = buildDisasterAccessPacket({
    accessSegments: [segment('a')],
    candidateRoutes: [{ id: 'relief-a', segmentIds: ['a'] }],
  });

  assert.equal(packet.routes[0].support, 'supported');
  assert.equal(JSON.stringify(packet).toLowerCase().includes('safe'), false);
});
