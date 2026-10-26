/**
 * Fail-closed evidence admission for historical disaster-route support receipts.
 *
 * This does not fetch, route, infer road access, authenticate source credentials,
 * or replace the disaster-access evaluator in upstream draft PR #882. It checks
 * the evidence basis of a caller-supplied evaluation before it may be reported.
 * Source policies and route coverage MUST come from trusted, independent owners.
 */

const SUPPORT = new Set(['supported', 'degraded', 'unsupported', 'unknown']);
const CLAIMS = new Set(['open', 'degraded', 'blocked']);
const DIRECT = new Set(['observed', 'declared']);
const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._:/#-]*$/;
const ISO_UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/;
const RECEIPT_VERSION = 1;

function identifier(value) {
  return typeof value === 'string' &&
    value.length <= 128 &&
    IDENTIFIER.test(value)
    ? value
    : null;
}

function utcMs(value) {
  if (typeof value !== 'string' || !ISO_UTC.test(value)) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  // Date.parse normalizes some impossible dates instead of rejecting them.
  if (new Date(ms).toISOString().slice(0, 19) !== value.slice(0, 19))
    return null;
  return ms;
}

function uniqueSortedIds(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 128)
    return null;
  const ids = Array.from(value, identifier);
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) return null;
  return ids.sort();
}

function own(object, name) {
  return object != null && Object.prototype.hasOwnProperty.call(object, name)
    ? object[name]
    : undefined;
}

function sourcePolicy(trustedSources, sourceId) {
  const policy = own(trustedSources, sourceId);
  if (!policy || typeof policy !== 'object' || Array.isArray(policy))
    return null;
  if (!Number.isSafeInteger(policy.maxAgeMs) || policy.maxAgeMs <= 0)
    return null;
  const allowed = Array.isArray(policy.allowedDeterminations)
    ? policy.allowedDeterminations
    : [];
  if (!allowed.length || allowed.some((mode) => !DIRECT.has(mode))) return null;
  return { maxAgeMs: policy.maxAgeMs, allowed: [...new Set(allowed)].sort() };
}

function canonicalEvidence(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record))
    return null;
  const {
    id,
    segmentId,
    sourceId,
    sourceRevision,
    claim,
    determination,
    observedAt,
    receivedAt,
    validUntil = null,
    scenarioId = null,
  } = record;
  return {
    id: identifier(id),
    segmentId: identifier(segmentId),
    sourceId: identifier(sourceId),
    sourceRevision: identifier(sourceRevision),
    claim: CLAIMS.has(claim) ? claim : null,
    determination: DIRECT.has(determination) ? determination : null,
    observedAt: typeof observedAt === 'string' ? observedAt : null,
    receivedAt: typeof receivedAt === 'string' ? receivedAt : null,
    validUntil:
      validUntil === null
        ? null
        : typeof validUntil === 'string'
          ? validUntil
          : 'invalid',
    scenarioId: scenarioId === null ? null : identifier(scenarioId),
    // A non-null unrecognized scenario is invalid, not the factual branch.
    invalidScenario: scenarioId !== null && !identifier(scenarioId),
  };
}

function stableSnapshot({
  routeId,
  routeRevision,
  accessRevision,
  policyRevision,
  mapping,
  assessment,
  observations,
  trustedSources,
}) {
  const sourceIds =
    trustedSources &&
    typeof trustedSources === 'object' &&
    !Array.isArray(trustedSources)
      ? Object.keys(trustedSources).sort()
      : [];
  const policies = sourceIds.map((id) => [
    id,
    sourcePolicy(trustedSources, id),
  ]);
  const records = Array.isArray(observations)
    ? observations.map(canonicalEvidence)
    : null;
  // JSON-compatible structure with fixed key order and sorted collections.
  return JSON.stringify({
    routeId: identifier(routeId),
    routeRevision: identifier(routeRevision),
    accessRevision: identifier(accessRevision),
    policyRevision: identifier(policyRevision),
    mapping: {
      routeId: identifier(mapping?.routeId),
      revision: identifier(mapping?.revision),
      complete: mapping?.complete === true,
      segmentIds: uniqueSortedIds(mapping?.segmentIds),
    },
    assessment: {
      routeId: identifier(assessment?.routeId),
      support: SUPPORT.has(assessment?.support) ? assessment.support : null,
      segmentIds: uniqueSortedIds(assessment?.segmentIds),
    },
    policies,
    records:
      records?.sort((a, b) =>
        JSON.stringify(a).localeCompare(JSON.stringify(b)),
      ) ?? null,
  });
}

function fnv1a64(value) {
  // Stable change detector only; NOT a signature or cryptographic integrity proof.
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < value.length; i++) {
    hash ^= BigInt(value.charCodeAt(i));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
}

/**
 * Check whether a precomputed access result has an eligible, fully mapped
 * evidence basis. Never promotes a caller's decision; only retains/downgrades.
 *
 * `mapping.complete` is an attestation by a trusted route-segment mapper, not
 * a proof computed here. `trustedSources` must be application configuration,
 * not data or policies supplied by external feed records.
 */
export function createDisasterEvidenceReceipt(options = {}) {
  const input =
    options && typeof options === 'object' && !Array.isArray(options)
      ? options
      : {};
  const {
    routeId,
    routeRevision,
    accessRevision,
    policyRevision,
    mapping,
    assessment,
    observations,
    trustedSources,
    asOfMs,
  } = input;
  const reasonSet = new Set();
  const reasons = (reason) => reasonSet.add(reason);
  const validClock =
    Number.isSafeInteger(asOfMs) &&
    asOfMs >= 0 &&
    Number.isFinite(new Date(asOfMs).getTime());
  if (!validClock) reasons('assessment-clock-invalid');
  const segments = uniqueSortedIds(mapping?.segmentIds);
  const assessedSegments = uniqueSortedIds(assessment?.segmentIds);
  const ids = [
    routeId,
    routeRevision,
    accessRevision,
    policyRevision,
    mapping?.revision,
    mapping?.routeId,
    assessment?.routeId,
  ];
  if (
    ids.some((id) => !identifier(id)) ||
    mapping?.routeId !== routeId ||
    assessment?.routeId !== routeId
  )
    reasons('identity-or-revision-invalid');
  if (!mapping || mapping.complete !== true || !segments)
    reasons('route-coverage-unverified');
  if (
    !segments ||
    !assessedSegments ||
    JSON.stringify(segments) !== JSON.stringify(assessedSegments)
  )
    reasons('assessment-segments-mismatch');
  if (!SUPPORT.has(assessment?.support)) reasons('assessment-status-invalid');
  if (!Array.isArray(observations) || observations.length > 256)
    reasons('evidence-collection-invalid');
  if (
    !trustedSources ||
    typeof trustedSources !== 'object' ||
    Array.isArray(trustedSources)
  )
    reasons('source-policies-missing');

  const refs = [];
  const seen = new Map();
  const bySegment = new Map((segments ?? []).map((id) => [id, new Set()]));
  if (Array.isArray(observations) && observations.length <= 256) {
    for (const raw of observations) {
      const record = canonicalEvidence(raw);
      if (
        !record ||
        !record.id ||
        !record.segmentId ||
        !record.sourceId ||
        !record.sourceRevision ||
        !record.claim ||
        !record.determination ||
        record.invalidScenario
      ) {
        reasons('evidence-record-invalid');
        continue;
      }
      if (!bySegment.has(record.segmentId)) {
        reasons('evidence-unmapped');
        continue;
      }
      const canonical = JSON.stringify(record);
      if (seen.has(record.id)) {
        if (seen.get(record.id) !== canonical) reasons('evidence-id-conflict');
        continue;
      }
      seen.set(record.id, canonical);
      const policy = sourcePolicy(trustedSources, record.sourceId);
      if (!policy || !policy.allowed.includes(record.determination)) {
        reasons('evidence-source-untrusted');
        continue;
      }
      if (record.scenarioId !== null) {
        reasons('simulated-evidence-not-factual');
        continue;
      }
      const observed = utcMs(record.observedAt);
      const received = utcMs(record.receivedAt);
      const until =
        record.validUntil === null ? null : utcMs(record.validUntil);
      if (
        observed === null ||
        received === null ||
        observed > received ||
        !validClock ||
        received > asOfMs ||
        (record.validUntil !== null && (until === null || until <= observed))
      ) {
        reasons('evidence-time-invalid');
        continue;
      }
      if (
        asOfMs - observed > policy.maxAgeMs ||
        (until !== null && asOfMs >= until)
      ) {
        reasons('evidence-expired');
        continue;
      }
      bySegment.get(record.segmentId).add(record.claim);
      refs.push(
        Object.freeze({
          id: record.id,
          segmentId: record.segmentId,
          sourceId: record.sourceId,
          sourceRevision: record.sourceRevision,
          observedAt: record.observedAt,
          claim: record.claim,
        }),
      );
    }
  }

  const claims = new Set();
  for (const [id, values] of bySegment) {
    if (values.size === 0) reasons('segment-evidence-missing');
    if (values.size > 1) reasons('segment-evidence-conflict');
    if (values.size !== 1) continue;
    claims.add([...values][0]);
  }
  const basis = reasonSet.size
    ? 'unknown'
    : claims.has('blocked')
      ? 'unsupported'
      : claims.has('degraded')
        ? 'degraded'
        : claims.size === 1 && claims.has('open')
          ? 'supported'
          : 'unknown';
  // This is a consistency guard, not a second route evaluator. It cannot
  // change an upstream 'unknown' assessment into 'supported'.
  const support =
    !reasonSet.size && assessment?.support === basis ? basis : 'unknown';
  if (!reasonSet.size && assessment?.support !== basis)
    reasons('assessment-evidence-mismatch');

  const snapshot = stableSnapshot(input);
  const evidenceRefs = Object.freeze(
    refs.sort((a, b) => a.id.localeCompare(b.id)),
  );
  return Object.freeze({
    schemaVersion: RECEIPT_VERSION,
    routeId: identifier(routeId),
    routeRevision: identifier(routeRevision),
    accessRevision: identifier(accessRevision),
    mappingRevision: identifier(mapping?.revision),
    policyRevision: identifier(policyRevision),
    assessedAt: validClock ? new Date(asOfMs).toISOString() : null,
    support,
    reasonCodes: Object.freeze([...reasonSet].sort()),
    evidenceRefs,
    // Stable across record order; changes with the material evidence/policy.
    fingerprint: `receipt-v1:${fnv1a64(snapshot)}`,
  });
}

/**
 * A current receipt must have identical route/evidence/assessor inputs and
 * remain valid at the caller's current as-of clock. Clock and source registry
 * authenticity are the responsibility of the trusted host, not this helper.
 */
export function isDisasterEvidenceReceiptCurrent(receipt, options = {}) {
  if (
    !receipt ||
    receipt.schemaVersion !== RECEIPT_VERSION ||
    typeof receipt.assessedAt !== 'string'
  )
    return false;
  const issued = utcMs(receipt.assessedAt);
  const now = options?.asOfMs;
  if (issued === null || !Number.isSafeInteger(now) || now < issued)
    return false;
  const current = createDisasterEvidenceReceipt(options);
  return (
    current.fingerprint === receipt.fingerprint &&
    current.routeId === receipt.routeId &&
    current.routeRevision === receipt.routeRevision &&
    current.accessRevision === receipt.accessRevision &&
    current.mappingRevision === receipt.mappingRevision &&
    current.policyRevision === receipt.policyRevision &&
    current.support === receipt.support &&
    JSON.stringify(current.reasonCodes) === JSON.stringify(receipt.reasonCodes)
  );
}
