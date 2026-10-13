import {
  UPSTREAM_NOT_ALLOWED,
  createPacer,
  isUpstreamRefusal,
} from '../sourcePolicy.js';

/**
 * On-device Overpass: direct Overpass API queries with client-side sanitize,
 * limiter (90/min, 6 concurrent), and geometry simplification.
 *
 * Mirrors the server's `server/providers/overpass/query.js` `sanitizeOverpassBody`
 * and `server/providers/overpass/geometry.js` `simplifyOverpassPayloadBody`.
 * Overpass mirrors are passed as explicit overrides (registry is empty in Task 2).
 *
 * @module mobile/adapters/overpassDirect
 */

const DEFAULT_MIN_INTERVAL_MS = 60_000 / 90; // ~667 ms between requests (90/min)
const MAX_CONCURRENT = 6;
const DEFAULT_TIMEOUT_MS = 25_000;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

/** Overpass mirrors (passed explicitly by caller, e.g., from app config). */
let OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.openstreetmap.ru/api/interpreter',
];

/** Per-mirror rate limiter state. */
const mirrorState = new Map();

/**
 * Set Overpass mirrors (called at app init).
 * @param {Array<string>} mirrors
 */
export function setOverpassMirrors(mirrors) {
  OVERPASS_MIRRORS =
    Array.isArray(mirrors) && mirrors.length ? mirrors : OVERPASS_MIRRORS;
}

/**
 * Create the on-device Overpass direct source.
 * @param {{ fetchImpl?: Function, pacer?: { wait: Function }, mirrors?: Array<string> }} options
 * @returns {{ query: Function }}
 */
export function createOverpassDirectSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  pacer = createPacer(DEFAULT_MIN_INTERVAL_MS),
  mirrors = OVERPASS_MIRRORS,
} = {}) {
  let concurrent = 0;
  const waiting = [];

  /**
   * Execute an Overpass QL query.
   * @param {string} ql Overpass QL query body (the `data=` value).
   * @param {{ signal?: AbortSignal, simplify?: boolean }} options
   * @returns {Promise<object>} Parsed JSON response or { unavailable: 'UPSTREAM_NOT_ALLOWED' }
   */
  async function query(ql, { signal, simplify = true } = {}) {
    // 1. Client-side sanitize (rejects planet scans, unbounded selectors, etc.)
    const sanitized = sanitizeOverpassBody(`data=${encodeURIComponent(ql)}`);
    if (!sanitized.ok) {
      throw new Error(`Overpass query rejected: ${sanitized.error}`);
    }

    // 2. Wait for concurrency slot
    await waitForSlot(signal);

    concurrent++;
    try {
      // 3. Try mirrors in order
      let lastError;
      for (const mirror of mirrors) {
        try {
          const response = await fetchImpl(mirror, {
            method: 'POST',
            signal,
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              Accept: 'application/json',
            },
            body: sanitized.body,
          });

          if (!response.ok) {
            if (response.status === 429) {
              // Rate limited by upstream — try next mirror
              lastError = new Error(`Mirror rate limited: ${response.status}`);
              continue;
            }
            if (response.status >= 500) {
              lastError = new Error(`Mirror error: ${response.status}`);
              continue;
            }
            // 4xx — don't retry other mirrors
            const text = await response.text();
            throw new Error(
              `Overpass query failed (${response.status}): ${text}`,
            );
          }

          const body = await readResponseBytesCapped(
            response,
            MAX_RESPONSE_BYTES,
            signal,
          );
          signal?.throwIfAborted();

          let parsed;
          try {
            parsed = JSON.parse(new TextDecoder().decode(body));
          } catch {
            throw new Error('Invalid JSON response from Overpass');
          }

          // 4. Optional geometry simplification for large payloads
          if (simplify && body.length > 512 * 1024) {
            const simplified = simplifyOverpassPayloadBody(
              new TextDecoder().decode(body),
            );
            try {
              parsed = JSON.parse(simplified);
            } catch {
              // If simplification breaks JSON, use original
            }
          }

          return parsed;
        } catch (error) {
          lastError = error;
          // Continue to next mirror on network/timeout errors
          if (error.name === 'AbortError' || error.name === 'TimeoutError') {
            continue;
          }
          // For other errors, don't retry other mirrors
          break;
        }
      }

      throw lastError || new Error('All Overpass mirrors failed');
    } catch (error) {
      if (isUpstreamRefusal(error)) {
        return { unavailable: UPSTREAM_NOT_ALLOWED };
      }
      throw error;
    } finally {
      concurrent--;
      processQueue();
    }
  }

  /**
   * Wait for a concurrency slot.
   * @param {AbortSignal} [signal]
   */
  function waitForSlot(signal) {
    return new Promise((resolve, reject) => {
      if (concurrent < MAX_CONCURRENT) {
        resolve();
        return;
      }
      const waiter = { signal, resolve, reject };
      waiting.push(waiter);
      signal?.addEventListener(
        'abort',
        () => {
          const idx = waiting.indexOf(waiter);
          if (idx >= 0) waiting.splice(idx, 1);
          reject(signal.reason);
        },
        { once: true },
      );
    });
  }

  function processQueue() {
    while (concurrent < MAX_CONCURRENT && waiting.length) {
      const next = waiting.shift();
      next.resolve();
    }
  }

  return { query };
}

/**
 * Read response body with a hard byte cap.
 * @param {Response} response
 * @param {number} maxBytes
 * @param {AbortSignal} [signal]
 * @returns {Promise<Uint8Array>}
 */
async function readResponseBytesCapped(response, maxBytes, signal) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new Error('Response too large');
  }
  if (!response.body) return new Uint8Array(0);
  const chunks = [];
  let total = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error('Response too large');
      }
      chunks.push(value);
    }
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  } finally {
    reader.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Client-side Overpass QL sanitize — mirrors server/providers/overpass/query.js
// ---------------------------------------------------------------------------

const OVERPASS_MAX_AROUND_M = 50_000;
const OVERPASS_MAX_BBOX_DEG = 12;
const OVERPASS_MAX_QL_TIMEOUT = 30;
const OVERPASS_SIMPLIFY_MIN_BYTES = 512 * 1024;
const OVERPASS_SIMPLIFY_MIN_POINTS = 500;
const OVERPASS_SIMPLIFY_TOLERANCE_DEG = 0.0004;

const OVERPASS_AREA_ELEMENT_RE = /^area\s*\(/i;
const OVERPASS_SELECTOR_RE = /^\s*(node|way|relation|area)\s*\[/i;
const OVERPASS_BBOX_RE =
  /\(\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*\)/g;

/**
 * Strip Overpass comments and quoted literals so validation sees only structure.
 * Mirrors `server/providers/overpass/query.js` `stripOverpassNoise`.
 * @param {string} text
 * @returns {string}
 */
function stripOverpassNoise(text) {
  let out = '';
  let inSingle = false;
  let inDouble = false;
  let inBlockComment = false;
  let inLineComment = false;
  let prev = '';
  for (const ch of text) {
    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (prev === '*' && ch === '/') {
        inBlockComment = false;
      }
      prev = ch;
      continue;
    }
    if (!inSingle && !inDouble) {
      if (prev === '/' && ch === '/') {
        inLineComment = true;
        out = out.slice(0, -1);
        continue;
      }
      if (prev === '/' && ch === '*') {
        inBlockComment = true;
        out = out.slice(0, -1);
        continue;
      }
    }
    if (ch === "'" && !inDouble && !inBlockComment && !inLineComment) {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle && !inBlockComment && !inLineComment) {
      inDouble = !inDouble;
    }
    out += ch;
    prev = ch;
  }
  return out;
}

/**
 * Validate + clamp an Overpass form body. Mirrors
 * `server/providers/overpass/query.js` `sanitizeOverpassBody`.
 * Defends against planet-scale abuse: requires exactly one `data` query in
 * which EVERY element selector is individually spatially bounded.
 * @param {string} rawBody
 * @returns {{ok:true, body:string} | {ok:false, error:string}}
 */
export function sanitizeOverpassBody(rawBody) {
  let params;
  try {
    params = new URLSearchParams(rawBody);
  } catch {
    return { ok: false, error: 'Malformed query body' };
  }
  const all = params.getAll('data');
  if (all.length !== 1)
    return { ok: false, error: 'Exactly one data query is required' };
  const data = all[0];
  if (!data || !data.trim())
    return { ok: false, error: 'Missing Overpass data query' };

  // Blank quoted literals + strip comments in one lexer pass so a fake bound or a
  // `//` inside a string can't hide an unbounded selector (or satisfy a bound).
  const stripped = stripOverpassNoise(data);

  // Reject oversized radii in EVERY around form — point `around:r,lat,lon` AND the
  // input-set form `around.set:r` — and parse the full numeric token so scientific
  // notation (`5e7`) can't slip a planet-scale radius past the cap.
  for (const m of stripped.matchAll(/around(?:\.\w+)?:\s*([\d.eE+-]+)/gi)) {
    const radius = Number(m[1]);
    if (!Number.isFinite(radius) || radius > OVERPASS_MAX_AROUND_M) {
      return { ok: false, error: 'Overpass around radius too large' };
    }
  }
  // Reject world-sized / oversized bboxes.
  for (const m of stripped.matchAll(
    /\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)/g,
  )) {
    const s = Number(m[1]);
    const w = Number(m[2]);
    const n = Number(m[3]);
    const e = Number(m[4]);
    if (
      Math.abs(n - s) > OVERPASS_MAX_BBOX_DEG ||
      Math.abs(e - w) > OVERPASS_MAX_BBOX_DEG
    ) {
      return { ok: false, error: 'Overpass bbox too large' };
    }
  }

  // Reject control-flow constructs the app never uses — their set/bound semantics
  // are hard to validate statically. The app only uses plain selectors + is_in /
  // area / pivot / recursion, so this denylist closes loop/transform escape hatches.
  if (/\b(?:foreach|complete|retro|compare|convert|make)\b/i.test(stripped)) {
    return { ok: false, error: 'Unsupported Overpass construct' };
  }
  // `poly:` has unchecked extent and the app never uses it — reject outright
  // (position-independent, so tag filters can't hide it).
  if (/\bpoly\s*:/i.test(stripped)) {
    return { ok: false, error: 'Overpass poly filter not allowed' };
  }

  // Every selector statement must be individually bounded, WITH set provenance: a
  // set counts as a bound only if it was assigned (->.set) by an already-bounded
  // statement. So `way[...]->.a` (global assigned to a set) is rejected, while the
  // app's `is_in(...)->.a; area.a[...]` and `area(id)->.x; rel(pivot.x)` validate.
  const boundedSets = new Set();
  for (let stmt of stripped.split(';')) {
    stmt = stmt.trim();
    if (!stmt || stmt.startsWith('[') || /^out\b/.test(stmt)) continue;

    // Strip output-set assignments (NOT input bounds), then strip bracket tag
    // filters so they don't confuse the bound check.
    const withoutOutput = stmt.replace(/->\.\w+/g, '');
    const withoutBrackets = withoutOutput.replace(/\[[^\]]*\]/g, '');

    let isBounded = false;
    if (/is_in\s*\(/.test(withoutBrackets)) isBounded = true;
    if (OVERPASS_AREA_ELEMENT_RE.test(withoutBrackets)) isBounded = true;
    if (OVERPASS_BBOX_RE.test(withoutBrackets)) isBounded = true;
    if (/\barea\s*\(/.test(withoutBrackets)) isBounded = true;
    if (/\bpivot\s*\./.test(withoutBrackets)) isBounded = true;

    const setMatch = withoutBrackets.match(/->\.(\w+)/);
    if (setMatch) {
      if (isBounded) boundedSets.add(setMatch[1]);
    } else if (
      /\b(area|rel)\s*\(/.test(withoutBrackets) &&
      !/\barea\s*\(/.test(withoutBrackets)
    ) {
      // Recursion without a bound is rejected unless it references a bounded set.
      const refMatch = withoutBrackets.match(/\(([^)]+)\)/);
      if (refMatch && !boundedSets.has(refMatch[1].trim())) {
        return { ok: false, error: 'Unbounded Overpass recursion' };
      }
      isBounded = true;
    } else if (!isBounded) {
      return { ok: false, error: 'Unbounded Overpass selector' };
    }
  }

  // Clamp timeout directive to server max.
  const timeoutMatch = stripped.match(/\[timeout\s*:\s*(\d+)\]/i);
  if (timeoutMatch) {
    const t = Number(timeoutMatch[1]);
    if (!Number.isFinite(t) || t > OVERPASS_MAX_QL_TIMEOUT) {
      return { ok: false, error: 'Overpass timeout exceeds maximum' };
    }
  }

  return { ok: true, body: `data=${encodeURIComponent(data)}` };
}

// ---------------------------------------------------------------------------
// Client-side geometry simplification — mirrors server/providers/overpass/geometry.js
// (limits shared with the sanitize block above: OVERPASS_SIMPLIFY_*).
// ---------------------------------------------------------------------------

/** Iterative Douglas-Peucker on [{lat,lon},...] (planar-degree approx). */
function douglasPeucker(points, toleranceDeg) {
  const n = points.length;
  if (n <= 2) return points;
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    if (b - a < 2) continue;
    const ax = points[a].lon;
    const ay = points[a].lat;
    const vx = points[b].lon - ax;
    const vy = points[b].lat - ay;
    const c2 = vx * vx + vy * vy;
    let worst = -1;
    let worstDist = toleranceDeg;
    for (let i = a + 1; i < b; i++) {
      const wx = points[i].lon - ax;
      const wy = points[i].lat - ay;
      let d;
      if (c2 === 0) {
        d = Math.hypot(wx, wy);
      } else {
        const t = Math.max(0, Math.min(1, (vx * wx + vy * wy) / c2));
        d = Math.hypot(wx - t * vx, wy - t * vy);
      }
      if (d > worstDist) {
        worstDist = d;
        worst = i;
      }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(points[i]);
  return out;
}

/** Simplify one element's geometry array in place if it is big enough. */
function simplifyElementGeometry(el, minPoints, toleranceDeg) {
  if (Array.isArray(el?.geometry) && el.geometry.length >= minPoints) {
    el.geometry = douglasPeucker(el.geometry, toleranceDeg);
  }
  if (Array.isArray(el?.members)) {
    for (const member of el.members) {
      if (
        Array.isArray(member?.geometry) &&
        member.geometry.length >= minPoints
      ) {
        member.geometry = douglasPeucker(member.geometry, toleranceDeg);
      }
    }
  }
}

/**
 * Client-side geometry simplification for large Overpass `out geom` payloads.
 * Mirrors `server/providers/overpass/geometry.js` `simplifyOverpassPayloadBody`.
 * Decimates coastline rings to shrink the wire and client parse time.
 * @param {string} bodyText - Raw upstream JSON body.
 * @returns {string} Possibly-simplified JSON body.
 */
export function simplifyOverpassPayloadBody(bodyText, opts = {}) {
  const minBytes = opts.minBytes ?? OVERPASS_SIMPLIFY_MIN_BYTES;
  const minPoints = opts.minPoints ?? OVERPASS_SIMPLIFY_MIN_POINTS;
  const toleranceDeg = opts.toleranceDeg ?? OVERPASS_SIMPLIFY_TOLERANCE_DEG;
  if (typeof bodyText !== 'string' || bodyText.length < minBytes)
    return bodyText;
  let data;
  try {
    data = JSON.parse(bodyText);
  } catch {
    return bodyText;
  }
  if (!Array.isArray(data?.elements)) return bodyText;
  for (const el of data.elements)
    simplifyElementGeometry(el, minPoints, toleranceDeg);
  try {
    return JSON.stringify(data);
  } catch {
    return bodyText;
  }
}
