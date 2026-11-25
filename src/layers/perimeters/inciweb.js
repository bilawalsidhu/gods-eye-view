/** InciWeb incident catalog: full-index fetch and WFIGS-name matching. */

import { readResponseJsonCapped } from '../../sources/httpBody.js';

/**
 * Normalize an incident title for matching: lowercase, collapsed whitespace,
 * a leading year dropped ('2026 Coleman Creek'), a trailing 'Fire' dropped
 * ('Coyote Fire') — InciWeb titles carry both decorations inconsistently and
 * WFIGS names carry neither.
 */
function normalizeName(name) {
  return String(name)
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/^(19|20)\d{2} /, '')
    .replace(/ fire$/, '');
}

function nodeCandidates(publications, { name, state }) {
  if (!Array.isArray(publications) || !name) return [];
  const wanted = normalizeName(name);
  let candidates = publications.filter(
    (row) =>
      typeof row?.incident_title === 'string' &&
      /^\d+$/.test(String(row?.incident_id ?? '')) &&
      normalizeName(row.incident_title) === wanted,
  );
  // The catalog is all-time and nationwide, so the dispatch unit's state
  // must corroborate every match — a globally unique title is NOT evidence
  // it's the same fire (live data shows same-name incidents across states).
  const statePrefix =
    typeof state === 'string' && /^US-[A-Za-z]{2}$/.test(state)
      ? state.slice(3).toLowerCase()
      : null;
  if (statePrefix) {
    candidates = candidates.filter(
      (row) =>
        typeof row.tau === 'string' &&
        row.tau.slice(0, 2).toLowerCase() === statePrefix,
    );
  } else if (candidates.length > 1) {
    return [];
  }
  // Same-state duplicates are usually reburns of the same name. Newest wins live.
  return candidates
    .sort((a, b) => Number(b.incident_id) - Number(a.incident_id))
    .map((row) => `https://inciweb.wildfire.gov/node/${row.incident_id}`);
}

/**
 * Resolve one WFIGS incident against the publication catalog.
 * Only rows whose normalized title equals the incident's normalized name
 * count. Matches are filtered by the tau dispatch unit's state prefix.
 * The `/node/{id}` link 301s to the canonical page, so no slug construction
 * is needed.
 * @param {?Array} publications - Publication catalog rows.
 * @param {{name: ?string, state: ?string}} incident - WFIGS row facts.
 * @returns {?string} InciWeb node URL.
 */
export function resolveInciwebNodeLink(publications, incident) {
  return nodeCandidates(publications, incident)[0] ?? null;
}

/** The publication id inside a node link produced above, or null. */
export function inciwebNodeId(link) {
  const match = /^https:\/\/inciweb\.wildfire\.gov\/node\/(\d+)$/.exec(
    String(link ?? ''),
  );
  return match ? match[1] : null;
}

// A fire's InciWeb page is created around the incident's start; a match
// whose page predates discovery by more than this is an archived
// same-name incident from a earlier season.
const CREATED_BEFORE_DISCOVERY_MS = 60 * 24 * 3600000;
// Without a discovery date, require editorial activity on the page in the
// 180 days up to the moment shown.
const CHANGED_WITHIN_MS = 180 * 24 * 3600000;

/**
 * Whether a publication plausibly describes the given current incident.
 * Fails closed on unusable timestamps.
 * @param {{createdMs: ?number, changedMs: ?number}} publication
 * @param {{discoveredTime: ?number, nowMs?: number}} incident
 * @returns {boolean}
 */
export function isCurrentPublication(
  { createdMs, changedMs },
  { discoveredTime, nowMs = Date.now() },
) {
  if (Number.isFinite(discoveredTime) && Number.isFinite(createdMs)) {
    return createdMs >= discoveredTime - CREATED_BEFORE_DISCOVERY_MS;
  }
  if (Number.isFinite(changedMs)) {
    const age = nowMs - changedMs;
    return age >= 0 && age <= CHANGED_WITHIN_MS;
  }
  return false;
}

/** Fetch one publication's created/changed timestamps for currency checks. */
export function createInciwebPublicationSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async getPublication(id, { signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl(
        `/api/fire-perimeters/inciweb/publication/${encodeURIComponent(id)}`,
        { signal },
      );
      if (!response.ok) throw new Error(`InciWeb HTTP ${response.status}`);
      const payload = await readResponseJsonCapped(
        response,
        512 * 1024,
        signal,
      );
      signal?.throwIfAborted();
      return {
        createdMs: Number.isFinite(payload?.createdMs)
          ? payload.createdMs
          : null,
        changedMs: Number.isFinite(payload?.changedMs)
          ? payload.changedMs
          : null,
      };
    },
  };
}

/** Every same-name page that could be this incident's, newest first: the own name's, else its complex's. */
export function findInciwebLinks(publications, { name, state, complexName }) {
  const links = nodeCandidates(publications, { name, state });
  return links.length
    ? links
    : nodeCandidates(publications, { name: complexName, state });
}

/**
 * Resolve one WFIGS incident to its InciWeb page, or null.
 * The incident's own name is tried first; a member of a complex whose own
 * name has no page falls back to the complex's page (InciWeb tracks the
 * managing complex, not each member fire). Anything ambiguous yields null
 * rather than a wrong page.
 * @param {?Array} publications - Publication catalog rows.
 * @param {{name: ?string, state: ?string, complexName: ?string}} incident
 *   - WFIGS row facts.
 * @returns {?string} InciWeb URL.
 */
export function findInciwebLink(publications, incident) {
  return findInciwebLinks(publications, incident)[0] ?? null;
}

/** Fetch the full InciWeb incident catalog. */
export function createInciwebIndexSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async getIndex({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl('/api/fire-perimeters/inciweb/index', {
        signal,
      });
      if (!response.ok) throw new Error(`InciWeb HTTP ${response.status}`);
      const rows = await readResponseJsonCapped(
        response,
        4 * 1024 * 1024,
        signal,
      );
      signal?.throwIfAborted();
      return Array.isArray(rows) ? rows : [];
    },
  };
}
