/**
 * Model-free disaster access semantics.
 *
 * This module does not route, fetch, render, or infer access from imagery.
 * It only evaluates explicit access observations against a candidate route.
 */

export const DISASTER_ACCESS_STATES = Object.freeze([
  'open',
  'blocked',
  'degraded',
  'unknown',
  'not-assessed',
]);

export const DISASTER_ACCESS_DETERMINATIONS = Object.freeze([
  'observed',
  'declared',
  'derived',
  'simulated',
]);

export const DISASTER_ACCESS_FRESHNESS = Object.freeze([
  'fresh',
  'stale',
  'unknown',
]);

const ACCESS_STATE_SET = new Set(DISASTER_ACCESS_STATES);
const DETERMINATION_SET = new Set(DISASTER_ACCESS_DETERMINATIONS);
const FRESHNESS_SET = new Set(DISASTER_ACCESS_FRESHNESS);

function nonEmptyText(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || null;
}

function uniqueIds(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map(nonEmptyText).filter(Boolean))];
}

/** Copy metadata to a deeply frozen, JSON-compatible evidence snapshot. */
function snapshotMetadata(value, ancestors = new WeakSet()) {
  if (value == null) return null;
  if (typeof value !== 'object') {
    return ['string', 'number', 'boolean'].includes(typeof value)
      ? value
      : null;
  }
  if (ancestors.has(value)) return null;
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    return null;
  ancestors.add(value);
  const copy = Array.isArray(value)
    ? value.map((item) => snapshotMetadata(item, ancestors))
    : Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          snapshotMetadata(item, ancestors),
        ]),
      );
  ancestors.delete(value);
  return Object.freeze(copy);
}

/**
 * Normalize one explicit access observation.
 *
 * Invalid/missing state is retained as UNKNOWN rather than disappearing.
 * A missing id cannot be associated with a route and is therefore rejected.
 */
export function normalizeDisasterAccessSegment(input) {
  if (!input || typeof input !== 'object') return null;
  const id = nonEmptyText(input.id);
  if (!id) return null;

  const state = ACCESS_STATE_SET.has(input.state) ? input.state : 'unknown';
  const determination = DETERMINATION_SET.has(input.determination)
    ? input.determination
    : null;
  const freshness = FRESHNESS_SET.has(input.freshness)
    ? input.freshness
    : 'unknown';

  return Object.freeze({
    id,
    state,
    determination,
    observedAt: nonEmptyText(input.observedAt),
    receivedAt: nonEmptyText(input.receivedAt),
    freshness,
    quality: snapshotMetadata(input.quality),
    provenance: snapshotMetadata(input.provenance),
  });
}

/**
 * Evaluate whether explicit evidence currently supports a candidate route.
 *
 * Result states are evidence-support states, not safety claims:
 * - supported: every referenced segment has fresh, direct open evidence
 * - degraded: direct fresh evidence has degraded but no block/unknown
 * - unsupported: >=1 segment has explicit fresh observed/declared blockage
 * - unknown: missing, stale, uncertain or simulated/derived evidence prevents support
 * Duplicate observations are order-independent: a direct fresh block wins.
 */
export function evaluateDisasterRouteSupport(route, accessSegments = []) {
  const routeId = nonEmptyText(route?.id) || 'candidate-route';
  const routeRefs = Array.isArray(route?.segmentIds) ? route.segmentIds : [];
  const segmentIds = uniqueIds(routeRefs);
  // Dropping malformed references must not create a fully supported route.
  // Iteration includes sparse entries; a known blockage still takes precedence.
  let invalidRouteRefs = false;
  for (const id of routeRefs) {
    if (!nonEmptyText(id)) {
      invalidRouteRefs = true;
      break;
    }
  }
  const records = Array.isArray(accessSegments) ? accessSegments : [];
  const normalizedSegments = records
    .map(normalizeDisasterAccessSegment)
    .filter(Boolean);
  const byId = new Map();
  for (const segment of normalizedSegments) {
    const observations = byId.get(segment.id) || [];
    observations.push(segment);
    byId.set(segment.id, observations);
  }

  if (segmentIds.length === 0) {
    return Object.freeze({
      routeId,
      support: 'unknown',
      segmentIds: Object.freeze(segmentIds),
      reasons: Object.freeze(
        invalidRouteRefs
          ? ['route-segments-not-mapped', 'invalid-route-segment-refs']
          : ['route-segments-not-mapped'],
      ),
    });
  }

  const reasons = invalidRouteRefs ? ['invalid-route-segment-refs'] : [];
  let blocked = false;
  let unknown = invalidRouteRefs;
  let degraded = false;

  for (const segmentId of segmentIds) {
    const observations = byId.get(segmentId);
    if (!observations) {
      unknown = true;
      reasons.push(`missing-access:${segmentId}`);
      continue;
    }

    const fresh = observations.filter(
      (observation) => observation.freshness === 'fresh',
    );
    const direct = fresh.filter(
      (observation) =>
        observation.determination === 'observed' ||
        observation.determination === 'declared',
    );

    if (direct.some((observation) => observation.state === 'blocked')) {
      blocked = true;
      reasons.push(`blocked:${segmentId}`);
      continue;
    }
    if (
      fresh.some(
        (observation) =>
          observation.determination !== 'observed' &&
          observation.determination !== 'declared',
      )
    ) {
      unknown = true;
      reasons.push(`unverified-access:${segmentId}`);
      continue;
    }
    const uncertain =
      direct.find((observation) => observation.state === 'unknown') ||
      direct.find((observation) => observation.state === 'not-assessed');
    if (uncertain) {
      unknown = true;
      reasons.push(`${uncertain.state}:${segmentId}`);
      continue;
    }
    if (direct.some((observation) => observation.state === 'degraded')) {
      degraded = true;
      reasons.push(`degraded:${segmentId}`);
      continue;
    }
    if (direct.some((observation) => observation.state === 'open')) continue;

    unknown = true;
    const freshness = observations.some(
      (observation) => observation.freshness === 'stale',
    )
      ? 'stale'
      : 'unknown';
    reasons.push(`${freshness}-access:${segmentId}`);
  }

  const support = blocked
    ? 'unsupported'
    : unknown
      ? 'unknown'
      : degraded
        ? 'degraded'
        : 'supported';

  return Object.freeze({
    routeId,
    support,
    segmentIds: Object.freeze(segmentIds),
    reasons: Object.freeze(reasons),
  });
}

/**
 * Build the smallest packet needed by downstream disaster experiments.
 *
 * No access record means NOT ASSESSED, never OPEN.
 */
export function buildDisasterAccessPacket(options = {}) {
  const {
    event = null,
    accessSegments = [],
    candidateRoutes = [],
  } = options && typeof options === 'object' && !Array.isArray(options)
    ? options
    : {};
  const records = Array.isArray(accessSegments) ? accessSegments : [];
  const candidates = Array.isArray(candidateRoutes) ? candidateRoutes : [];
  const normalizedSegments = records
    .map(normalizeDisasterAccessSegment)
    .filter(Boolean);
  const invalidAccessRecordCount =
    Math.max(0, records.length - normalizedSegments.length) +
    (accessSegments != null && !Array.isArray(accessSegments) ? 1 : 0);

  const gaps = [];
  if (normalizedSegments.length === 0) gaps.push('access-not-assessed');
  if (invalidAccessRecordCount > 0)
    gaps.push(`invalid-access-records:${invalidAccessRecordCount}`);

  const eventId = nonEmptyText(event?.id);
  const routes = candidates.map((route) =>
    evaluateDisasterRouteSupport(route, normalizedSegments),
  );

  return Object.freeze({
    schemaVersion: 1,
    event: eventId
      ? Object.freeze({
          id: eventId,
          title: nonEmptyText(event?.title),
          observedDate: nonEmptyText(event?.observedDate),
        })
      : null,
    access: Object.freeze({
      segments: Object.freeze(normalizedSegments),
    }),
    routes: Object.freeze(routes),
    gaps: Object.freeze(gaps),
  });
}
