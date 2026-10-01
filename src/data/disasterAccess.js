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
    quality: input.quality ?? null,
    provenance: input.provenance ?? null,
  });
}

/**
 * Evaluate whether explicit evidence currently supports a candidate route.
 *
 * Result states are evidence-support states, not safety claims:
 * - supported: every referenced segment is explicitly fresh + open
 * - degraded: every segment is known, but >=1 is explicitly fresh + degraded
 * - unsupported: >=1 segment is explicitly fresh + blocked
 * - unknown: missing, stale, unknown or not-assessed evidence prevents support
 */
export function evaluateDisasterRouteSupport(route, accessSegments = []) {
  const routeId = nonEmptyText(route?.id) || 'candidate-route';
  const segmentIds = uniqueIds(route?.segmentIds);
  const normalizedSegments = accessSegments
    .map(normalizeDisasterAccessSegment)
    .filter(Boolean);
  const byId = new Map(
    normalizedSegments.map((segment) => [segment.id, segment]),
  );

  if (segmentIds.length === 0) {
    return Object.freeze({
      routeId,
      support: 'unknown',
      segmentIds,
      reasons: Object.freeze(['route-segments-not-mapped']),
    });
  }

  const reasons = [];
  let blocked = false;
  let unknown = false;
  let degraded = false;

  for (const segmentId of segmentIds) {
    const segment = byId.get(segmentId);
    if (!segment) {
      unknown = true;
      reasons.push(`missing-access:${segmentId}`);
      continue;
    }

    if (segment.freshness !== 'fresh') {
      unknown = true;
      reasons.push(`${segment.freshness}-access:${segmentId}`);
      continue;
    }

    switch (segment.state) {
      case 'blocked':
        blocked = true;
        reasons.push(`blocked:${segmentId}`);
        break;
      case 'degraded':
        degraded = true;
        reasons.push(`degraded:${segmentId}`);
        break;
      case 'open':
        break;
      case 'unknown':
      case 'not-assessed':
      default:
        unknown = true;
        reasons.push(`${segment.state}:${segmentId}`);
        break;
    }
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
export function buildDisasterAccessPacket({
  event = null,
  accessSegments = [],
  candidateRoutes = [],
} = {}) {
  const normalizedSegments = accessSegments
    .map(normalizeDisasterAccessSegment)
    .filter(Boolean);
  const invalidAccessRecordCount = Math.max(
    0,
    accessSegments.length - normalizedSegments.length,
  );

  const gaps = [];
  if (normalizedSegments.length === 0) gaps.push('access-not-assessed');
  if (invalidAccessRecordCount > 0)
    gaps.push(`invalid-access-records:${invalidAccessRecordCount}`);

  const eventId = nonEmptyText(event?.id);
  const routes = candidateRoutes.map((route) =>
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
