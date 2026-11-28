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

test('blocked access invalidates an otherwise supported route', () => {
  const route = { id: 'relief-a', segmentIds: ['a', 'b', 'c'] };
  const baseline = [segment('a'), segment('b'), segment('c')];

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
  const access = [segment('a', 'unknown'), segment('b', 'not-assessed')];
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
    evaluateDisasterRouteSupport({ id: 'relief-a', segmentIds: ['a'] }, [
      normalized,
    ]).support,
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

test('packet labels support without asserting safety', () => {
  const packet = buildDisasterAccessPacket({
    accessSegments: [segment('a')],
    candidateRoutes: [{ id: 'relief-a', segmentIds: ['a'] }],
  });

  assert.equal(packet.routes[0].support, 'supported');
  assert.equal(JSON.stringify(packet).toLowerCase().includes('safe'), false);
});

test('malformed route references cannot become fully supported', () => {
  for (const ref of [null, undefined, ' ', false, 0, {}, []]) {
    const result = evaluateDisasterRouteSupport(
      { id: 'relief-bridge', segmentIds: ['bridge', ref] },
      [segment('bridge')],
    );
    assert.equal(result.support, 'unknown');
    assert.deepEqual(result.reasons, ['invalid-route-segment-refs']);
    assert.deepEqual(result.segmentIds, ['bridge']);
  }
});

test('a blocked segment overrides malformed route references', () => {
  const result = evaluateDisasterRouteSupport(
    { id: 'relief-bridge', segmentIds: [null, 'bridge'] },
    [segment('bridge', 'blocked')],
  );
  assert.equal(result.support, 'unsupported');
  assert.deepEqual(result.reasons, [
    'invalid-route-segment-refs',
    'blocked:bridge',
  ]);
});

test('fully invalid reference set is unknown', () => {
  const result = evaluateDisasterRouteSupport({
    id: 'relief-bridge',
    segmentIds: [null, ' '],
  });
  assert.equal(result.support, 'unknown');
  assert.deepEqual(result.reasons, [
    'route-segments-not-mapped',
    'invalid-route-segment-refs',
  ]);
});

test('unmapped route receipt keeps its segment identifiers immutable', () => {
  const result = evaluateDisasterRouteSupport(
    { id: 'relief-a', segmentIds: [] },
    [],
  );
  assert.equal(Object.isFrozen(result.segmentIds), true);
  assert.throws(() => result.segmentIds.push('invented-segment'), TypeError);
  assert.deepEqual(result.segmentIds, []);
});

test('sparse segment references fail closed', () => {
  const refs = Array(2);
  refs[0] = 'bridge';
  const result = evaluateDisasterRouteSupport(
    { id: 'relief-bridge', segmentIds: refs },
    [segment('bridge')],
  );
  assert.equal(result.support, 'unknown');
  assert.deepEqual(result.reasons, ['invalid-route-segment-refs']);
});

test('duplicate references preserve support and input ownership', () => {
  const refs = [' bridge ', 'bridge'];
  const result = evaluateDisasterRouteSupport(
    { id: 'relief-bridge', segmentIds: refs },
    [segment('bridge')],
  );
  assert.equal(result.support, 'supported');
  assert.deepEqual(result.segmentIds, ['bridge']);
  assert.deepEqual(result.reasons, []);
  assert.deepEqual(refs, [' bridge ', 'bridge']);
  refs.push('later');
  assert.deepEqual(result.segmentIds, ['bridge']);
  assert.equal(Object.isFrozen(result.segmentIds), true);
});

test('duplicate fresh blockage wins regardless of observation order', () => {
  const route = { id: 'relief-a', segmentIds: ['a'] };
  for (const observations of [
    [segment('a', 'blocked'), segment('a', 'open')],
    [segment('a', 'open'), segment('a', 'blocked')],
  ]) {
    const result = evaluateDisasterRouteSupport(route, observations);
    assert.equal(result.support, 'unsupported');
    assert.deepEqual(result.reasons, ['blocked:a']);
  }
});

test('duplicate open with degraded or unknown evidence is conservative', () => {
  const route = { id: 'relief-a', segmentIds: ['a'] };
  for (const state of ['degraded', 'unknown', 'not-assessed']) {
    for (const observations of [
      [segment('a', state), segment('a')],
      [segment('a'), segment('a', state)],
    ]) {
      const result = evaluateDisasterRouteSupport(route, observations);
      assert.equal(
        result.support,
        state === 'degraded' ? 'degraded' : 'unknown',
      );
      assert.deepEqual(result.reasons, [`${state}:a`]);
    }
  }
});

test('simulated, derived and missing determinations never support access', () => {
  const route = { id: 'relief-a', segmentIds: ['a'] };
  for (const determination of ['simulated', 'derived', null]) {
    const observation = { ...segment('a'), determination };
    const result = evaluateDisasterRouteSupport(route, [observation]);
    assert.equal(result.support, 'unknown');
    assert.deepEqual(result.reasons, ['unverified-access:a']);
  }
  const mixed = evaluateDisasterRouteSupport(route, [
    segment('a'),
    { ...segment('a', 'blocked'), determination: 'simulated' },
  ]);
  assert.equal(mixed.support, 'unknown');
});

test('fresh direct evidence takes priority over stale duplicates', () => {
  const result = evaluateDisasterRouteSupport(
    { id: 'relief-a', segmentIds: ['a'] },
    [segment('a', 'blocked', 'stale'), segment('a')],
  );
  assert.equal(result.support, 'supported');
});

test('null packet lists are treated as unassessed, never as open', () => {
  for (const options of [
    null,
    { accessSegments: null, candidateRoutes: null },
    { accessSegments: false, candidateRoutes: false },
  ]) {
    const packet = buildDisasterAccessPacket(options);
    assert.deepEqual(packet.access.segments, []);
    assert.deepEqual(packet.routes, []);
    assert.ok(packet.gaps.includes('access-not-assessed'));
  }
  assert.equal(
    evaluateDisasterRouteSupport({ segmentIds: ['a'] }, null).support,
    'unknown',
  );
});

test('quality and provenance remain snapshots after input mutation', () => {
  const input = {
    ...segment('a'),
    quality: { flags: ['validated'] },
    provenance: { source: { name: 'report' } },
  };
  const packet = buildDisasterAccessPacket({ accessSegments: [input] });
  const observation = packet.access.segments[0];
  assert.equal(Object.isFrozen(observation.quality.flags), true);
  assert.equal(Object.isFrozen(observation.provenance.source), true);
  input.quality.flags.push('modified');
  input.provenance.source.name = 'overwritten';
  assert.deepEqual(observation.quality.flags, ['validated']);
  assert.equal(observation.provenance.source.name, 'report');
  assert.throws(() => observation.quality.flags.push('new'), TypeError);
});
