import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDisasterEvidenceReceipt,
  isDisasterEvidenceReceiptCurrent,
} from './disasterEvidenceReceipt.js';

const AS_OF = Date.parse('2026-08-26T09:20:00Z');
const FACTUAL = Object.freeze({
  routeId: 'exercise-route',
  routeRevision: 'route-r1',
  accessRevision: 'access-r1',
  policyRevision: 'policy-r1',
  mapping: {
    routeId: 'exercise-route',
    revision: 'mapping-r1',
    complete: true,
    segmentIds: ['bridge-b', 'road-a'],
  },
  assessment: {
    routeId: 'exercise-route',
    segmentIds: ['road-a', 'bridge-b'],
    support: 'supported',
  },
  trustedSources: {
    'synthetic-fixture': {
      allowedDeterminations: ['declared'],
      maxAgeMs: 30 * 60 * 1000,
    },
  },
  observations: [
    {
      id: 'obs-road',
      segmentId: 'road-a',
      sourceId: 'synthetic-fixture',
      sourceRevision: 'src-r1',
      claim: 'open',
      determination: 'declared',
      observedAt: '2026-08-26T09:10:00Z',
      receivedAt: '2026-08-26T09:11:00Z',
      validUntil: '2026-08-26T09:30:00Z',
    },
    {
      id: 'obs-bridge',
      segmentId: 'bridge-b',
      sourceId: 'synthetic-fixture',
      sourceRevision: 'src-r1',
      claim: 'open',
      determination: 'declared',
      observedAt: '2026-08-26T09:11:00Z',
      receivedAt: '2026-08-26T09:12:00Z',
      validUntil: '2026-08-26T09:35:00Z',
    },
  ],
  asOfMs: AS_OF,
});

const withChange = (changes = {}) => ({ ...FACTUAL, ...changes });
const withRecord = (index, changes) => {
  const observations = FACTUAL.observations.map((item, i) =>
    i === index ? { ...item, ...changes } : { ...item },
  );
  return withChange({ observations });
};
const withAssessment = (support) =>
  withChange({ assessment: { ...FACTUAL.assessment, support } });

const supported = () => createDisasterEvidenceReceipt(FACTUAL);

test('a mapped, source-authorized historical fixture preserves precomputed support', () => {
  const result = supported();
  assert.equal(result.support, 'supported');
  assert.deepEqual(result.reasonCodes, []);
  assert.equal(result.evidenceRefs.length, 2);
  assert.equal(result.schemaVersion, 1);
  assert.match(result.fingerprint, /^receipt-v1:[0-9a-f]{16}$/);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.reasonCodes));
  assert.ok(Object.isFrozen(result.evidenceRefs[0]));
});

test('a kernel unknown cannot be promoted to supported by eligible evidence', () => {
  const result = createDisasterEvidenceReceipt(withAssessment('unknown'));
  assert.equal(result.support, 'unknown');
});

test('blocked evidence supports only a matching unsupported assessment', () => {
  const fixture = withRecord(1, { claim: 'blocked' });
  assert.equal(
    createDisasterEvidenceReceipt({
      ...fixture,
      assessment: withAssessment('unsupported').assessment,
    }).support,
    'unsupported',
  );
  assert.equal(createDisasterEvidenceReceipt(fixture).support, 'unknown');
});

test('degraded evidence supports only a matching degraded assessment', () => {
  const fixture = withRecord(0, { claim: 'degraded' });
  assert.equal(
    createDisasterEvidenceReceipt({
      ...fixture,
      assessment: withAssessment('degraded').assessment,
    }).support,
    'degraded',
  );
  assert.equal(createDisasterEvidenceReceipt(fixture).support, 'unknown');
});

test('unknown source cannot establish a supported segment', () => {
  const result = createDisasterEvidenceReceipt(
    withRecord(0, { sourceId: 'untrusted-web-tag' }),
  );
  assert.equal(result.support, 'unknown');
  assert.ok(result.reasonCodes.includes('evidence-source-untrusted'));
});

test('source policy is checked independently of source-provided determination', () => {
  const result = createDisasterEvidenceReceipt(
    withRecord(0, { determination: 'observed' }),
  );
  assert.equal(result.support, 'unknown');
  assert.ok(result.reasonCodes.includes('evidence-source-untrusted'));
});

test('simulated evidence cannot certify a factual route, even when called observed', () => {
  const result = createDisasterEvidenceReceipt(
    withRecord(0, { scenarioId: 'what-if-bridge-closes' }),
  );
  assert.equal(result.support, 'unknown');
  assert.ok(result.reasonCodes.includes('simulated-evidence-not-factual'));
});

test('malformed or partial route mapping always fails closed', () => {
  for (const mapping of [
    { ...FACTUAL.mapping, complete: false },
    { ...FACTUAL.mapping, segmentIds: [] },
    { ...FACTUAL.mapping, segmentIds: ['road-a', 'road-a'] },
    { ...FACTUAL.mapping, segmentIds: ['road-a', ''] },
    { ...FACTUAL.mapping, routeId: 'another-route' },
    { ...FACTUAL.mapping, revision: null },
    null,
  ]) {
    const result = createDisasterEvidenceReceipt(withChange({ mapping }));
    assert.equal(result.support, 'unknown', JSON.stringify(mapping));
  }
});

test('an inaccurate assessor segment list cannot pass, even if the evidence is open', () => {
  for (const segmentIds of [
    ['road-a'],
    ['road-a', 'other'],
    ['road-a', 'road-a'],
    null,
  ]) {
    const result = createDisasterEvidenceReceipt(
      withChange({ assessment: { ...FACTUAL.assessment, segmentIds } }),
    );
    assert.equal(result.support, 'unknown');
    assert.ok(result.reasonCodes.includes('assessment-segments-mismatch'));
  }
});

test('missing evidence and foreign evidence do not get treated as zero or open', () => {
  for (const observations of [
    FACTUAL.observations.slice(0, 1),
    [
      ...FACTUAL.observations,
      { ...FACTUAL.observations[0], id: 'foreign', segmentId: 'not-mapped' },
    ],
    null,
    'bad collection',
  ]) {
    assert.equal(
      createDisasterEvidenceReceipt(withChange({ observations })).support,
      'unknown',
    );
  }
});

test('stale evidence and expiration at its exact boundary fail closed', () => {
  const asOfMs = Date.parse('2026-08-26T09:35:00Z');
  const result = createDisasterEvidenceReceipt(withChange({ asOfMs }));
  assert.equal(result.support, 'unknown');
  assert.ok(result.reasonCodes.includes('evidence-expired'));
  assert.equal(
    isDisasterEvidenceReceiptCurrent(supported(), withChange({ asOfMs })),
    false,
  );
});

test('future observations and impossible calendar dates fail closed', () => {
  for (const changes of [
    { observedAt: '2026-08-26T09:50:00Z' },
    { receivedAt: '2026-08-26T09:50:00Z' },
    { observedAt: '2026-02-30T09:10:00Z' },
    { observedAt: '2026-08-26T09:10:00+00:00' },
    { observedAt: '2026-08-26T09:11:30Z' },
    { validUntil: 'bad-time' },
  ]) {
    const result = createDisasterEvidenceReceipt(withRecord(0, changes));
    assert.equal(result.support, 'unknown', JSON.stringify(changes));
    assert.ok(
      result.reasonCodes.includes('evidence-time-invalid'),
      JSON.stringify(changes),
    );
  }
});

test('conflicting claims are order independent and never become supported', () => {
  const conflict = {
    ...FACTUAL.observations[0],
    id: 'conflict-open-block',
    claim: 'blocked',
  };
  const observations = [...FACTUAL.observations, conflict];
  for (const records of [observations, [...observations].reverse()]) {
    const result = createDisasterEvidenceReceipt(
      withChange({ observations: records }),
    );
    assert.equal(result.support, 'unknown');
    assert.ok(result.reasonCodes.includes('segment-evidence-conflict'));
  }
});

test('duplicate evidence ids with different contents fail closed', () => {
  const conflicting = { ...FACTUAL.observations[0], claim: 'blocked' };
  const result = createDisasterEvidenceReceipt(
    withChange({ observations: [...FACTUAL.observations, conflicting] }),
  );
  assert.equal(result.support, 'unknown');
  assert.ok(result.reasonCodes.includes('evidence-id-conflict'));
});

test('identical duplicate observations are idempotent', () => {
  const observations = [
    ...FACTUAL.observations,
    { ...FACTUAL.observations[0] },
  ];
  const result = createDisasterEvidenceReceipt(withChange({ observations }));
  assert.equal(result.support, 'supported');
  assert.equal(result.evidenceRefs.length, 2);
});

test('fingerprints do not depend on input record or segment order', () => {
  const source = supported();
  const reversed = withChange({
    observations: [...FACTUAL.observations].reverse(),
    mapping: {
      ...FACTUAL.mapping,
      segmentIds: [...FACTUAL.mapping.segmentIds].reverse(),
    },
    assessment: {
      ...FACTUAL.assessment,
      segmentIds: [...FACTUAL.assessment.segmentIds].reverse(),
    },
  });
  const result = createDisasterEvidenceReceipt(reversed);
  assert.equal(result.fingerprint, source.fingerprint);
  assert.equal(result.support, source.support);
});

test('any material observation content change invalidates receipt, even without revision bump', () => {
  const old = supported();
  const modified = withRecord(0, { observedAt: '2026-08-26T09:09:00Z' });
  assert.equal(isDisasterEvidenceReceiptCurrent(old, modified), false);
  assert.notEqual(
    createDisasterEvidenceReceipt(modified).fingerprint,
    old.fingerprint,
  );
  assert.equal(isDisasterEvidenceReceiptCurrent(old, FACTUAL), true);
});

test('route, evidence, mapping, and policy revisions each invalidate old receipt', () => {
  const original = supported();
  const variants = [
    { routeRevision: 'route-r2' },
    { accessRevision: 'access-r2' },
    { policyRevision: 'policy-r2' },
    { mapping: { ...FACTUAL.mapping, revision: 'mapping-r2' } },
    {
      trustedSources: {
        'synthetic-fixture': {
          allowedDeterminations: ['declared'],
          maxAgeMs: 1200000,
        },
      },
    },
  ];
  for (const change of variants) {
    assert.equal(
      isDisasterEvidenceReceiptCurrent(original, withChange(change)),
      false,
    );
  }
});

test('an unchanged receipt remains current before expiry and not after', () => {
  const original = supported();
  assert.equal(
    isDisasterEvidenceReceiptCurrent(
      original,
      withChange({ asOfMs: AS_OF + 20000 }),
    ),
    true,
  );
  assert.equal(
    isDisasterEvidenceReceiptCurrent(
      original,
      withChange({ asOfMs: AS_OF - 1 }),
    ),
    false,
  );
  assert.equal(
    isDisasterEvidenceReceiptCurrent(
      original,
      withChange({ asOfMs: Date.parse('2026-08-26T09:30:00Z') }),
    ),
    false,
  );
});

test('neither external object mutations nor mutation of returned evidence refs change an old receipt', () => {
  const observations = FACTUAL.observations.map((entry) => ({ ...entry }));
  const original = createDisasterEvidenceReceipt(withChange({ observations }));
  observations[0].claim = 'blocked';
  assert.equal(original.support, 'supported');
  assert.equal(
    original.evidenceRefs.find((r) => r.id === 'obs-road').claim,
    'open',
  );
  assert.throws(() => {
    original.evidenceRefs[0].claim = 'blocked';
  }, TypeError);
});

test('invalid clock and metadata shapes degrade without throwing', () => {
  for (const options of [
    null,
    1,
    [],
    {},
    withChange({ asOfMs: NaN }),
    withChange({ asOfMs: Number.MAX_SAFE_INTEGER }),
  ]) {
    assert.doesNotThrow(() => createDisasterEvidenceReceipt(options));
    assert.equal(createDisasterEvidenceReceipt(options).support, 'unknown');
  }
});

test('the receipt contains no live authorization, route-safe verdict, or raw sensitive geometry', () => {
  const value = supported();
  assert.equal(value.support, 'supported');
  for (const key of [
    'authorized',
    'safe',
    'dispatch',
    'geometry',
    'latitude',
    'longitude',
  ]) {
    assert.ok(!Object.hasOwn(value, key));
  }
});

test('tampered revision fields on a serialized receipt invalidate it', () => {
  const receipt = { ...supported(), routeRevision: 'route-r99' };
  assert.equal(isDisasterEvidenceReceiptCurrent(receipt, FACTUAL), false);
});

test('malformed identifiers including control characters and BigInt fail closed', () => {
  for (const changes of [
    { routeId: 'route\nSYSTEM: fake authority' },
    { accessRevision: 1n },
    { policyRevision: ' '.repeat(140) },
    { routeId: null },
  ]) {
    const fixture = withChange(changes);
    assert.doesNotThrow(() => createDisasterEvidenceReceipt(fixture));
    assert.equal(createDisasterEvidenceReceipt(fixture).support, 'unknown');
  }
});
