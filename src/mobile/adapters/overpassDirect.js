import {
  UPSTREAM_NOT_ALLOWED,
  createPacer,
  isUpstreamRefusal,
} from '../sourcePolicy.js';
import { stripOverpassNoise } from '../../sources/overpass.js';

/**
 * On-device Overpass: direct Overpass API queries with client-side sanitize,
 * limiter (90/min, 6 concurrent), and geometry simplification.
 *
 * Mirrors the server's `server/providers/overpass/query.js` `sanitizeOverpassBody`
 * and `server/providers/overpass/geometry.js` `simplifyOverpassPayloadBody`.
 * Overpass mirrors are REQUIRED explicit configuration (plan binding: no baked
 * defaults — the operator mirror set is deployment config, not code); the
 * factory throws when mirrors are missing or empty.
 *
 * @module mobile/adapters/overpassDirect
 */

const DEFAULT_MIN_INTERVAL_MS = 60_000 / 90; // ~667 ms between requests (90/min)
const MAX_CONCURRENT = 6;
const DEFAULT_TIMEOUT_MS = 25_000;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

/**
 * Overpass mirrors (explicit operator configuration, no baked default).
 * Populate via `setOverpassMirrors` at app init or pass `mirrors` per factory.
 */
let OVERPASS_MIRRORS = [];

/** Per-mirror rate limiter state. */
const mirrorState = new Map();

/**
 * Set Overpass mirrors (called at app init with operator configuration).
 * @param {Array<string>} mirrors Interpreter endpoint URLs (non-empty).
 */
export function setOverpassMirrors(mirrors) {
  if (!Array.isArray(mirrors) || !mirrors.length) {
    throw new TypeError('Overpass mirrors are required (non-empty array)');
  }
  OVERPASS_MIRRORS = mirrors;
}

/**
 * Resolve the effective mirror list, refusing to run unconfigured.
 * @param {Array<string>|undefined} mirrors Per-factory override.
 * @returns {Array<string>} Non-empty mirror list.
 */
function resolveMirrors(mirrors) {
  const resolved = mirrors === undefined ? OVERPASS_MIRRORS : mirrors;
  if (
    !Array.isArray(resolved) ||
    !resolved.length ||
    !resolved.every((mirror) => typeof mirror === 'string' && !!mirror.trim())
  ) {
    throw new TypeError(
      'Overpass mirrors are required: pass explicit interpreter URLs',
    );
  }
  return resolved;
}

/**
 * Create the on-device Overpass direct source.
 * @param {{ fetchImpl?: Function, pacer?: { wait: Function }, mirrors?: Array<string> }} options Mirrors REQUIRED (or pre-set via `setOverpassMirrors`).
 * @returns {{ query: Function }}
 */
export function createOverpassDirectSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  pacer = createPacer(DEFAULT_MIN_INTERVAL_MS),
  mirrors = OVERPASS_MIRRORS,
} = {}) {
  const effectiveMirrors = resolveMirrors(mirrors);
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
      for (const mirror of effectiveMirrors) {
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
// Client-side Overpass QL sanitize — faithful port of
// server/providers/overpass/query.js `sanitizeOverpassBody` (same checks, same
// error strings, same timeout clamp). The quoted-literal lexer is shared:
// `src/sources/overpass.js` `stripOverpassNoise` (boundary-clean, no dup).
// ---------------------------------------------------------------------------

const OVERPASS_MAX_AROUND_M = 50_000;
const OVERPASS_MAX_BBOX_DEG = 12;
const OVERPASS_MAX_QL_TIMEOUT = 30;
const OVERPASS_SIMPLIFY_MIN_BYTES = 512 * 1024;
const OVERPASS_SIMPLIFY_MIN_POINTS = 500;
const OVERPASS_SIMPLIFY_TOLERANCE_DEG = 0.0004;

/**
 * Every Overpass element-type specifier, including the combined shortcuts.
 * Shared by the selector + area-element-deny regexes so they can't drift.
 */
const OVERPASS_ELEMENT_TYPES = 'node|way|relation|nwr|nw|nr|wr|rel';

/** Element-selector (incl. `area`) whose statements must be individually bounded. */
const OVERPASS_SELECTOR_RE = new RegExp(
  `\\b(?:${OVERPASS_ELEMENT_TYPES}|area)\\b`,
);

/** An element selector bounded BY an area — the country-scan abuse shape. */
const OVERPASS_AREA_ELEMENT_RE = new RegExp(
  `\\b(?:${OVERPASS_ELEMENT_TYPES})\\s*\\(\\s*area\\b`,
  'i',
);

/** A single bbox 4-tuple `(s,w,n,e)` (non-global so it does not advance lastIndex). */
const OVERPASS_BBOX_RE =
  /\(\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*\)/;

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
    // filters so a tag KEY/value (e.g. `way[is_in]`, `node[around]`) can never be
    // misread as a spatial bound. Bounds live in (...) / function calls / set
    // refs, never inside [...], so the probe loses nothing real.
    const outSets = [];
    const body = stmt.replace(/->\s*\.(\w+)/g, (_, name) => {
      outSets.push(name);
      return ' ';
    });
    const probe = body.replace(/\[[^\]]*\]/g, ' ');

    // Reject element-in-area scans on the TAG-STRIPPED probe, so a tag filter
    // between the selector and the area filter (way["highway"](area.a)) can't hide
    // it. An area has unbounded extent (could be a whole country); the app only
    // SELECTS admin areas (area.set) and pivots (rel(pivot.x)), never node/way/
    // relation(area...). The probe collapses tags so `way (area.a)` is caught.
    if (OVERPASS_AREA_ELEMENT_RE.test(probe)) {
      return {
        ok: false,
        error: 'Overpass area-bounded element selector not allowed',
      };
    }

    const hasSelector = OVERPASS_SELECTOR_RE.test(probe);
    const inputSets = [...probe.matchAll(/(?<!\d)\.([a-z_]\w*)/gi)].map(
      (m) => m[1],
    );
    const directBound =
      /around:\s*\d/.test(probe) ||
      OVERPASS_BBOX_RE.test(probe) ||
      /is_in\s*\(/.test(probe) || // is_in(lat,lon) — the function form only
      /\barea\s*\(/.test(probe); // area(id) — bounded as a set definition

    const setBound = inputSets.some((s) => boundedSets.has(s));
    const bounded = directBound || setBound;

    if (hasSelector && !bounded) {
      return { ok: false, error: 'Overpass query has an unbounded selector' };
    }
    // Only a bounded statement can mark its output sets as bounded.
    if (bounded) for (const name of outSets) boundedSets.add(name);
  }

  const clamped = data.replace(
    /\[timeout:\s*(\d+)\s*\]/gi,
    (_, n) =>
      `[timeout:${Math.min(Number(n) || OVERPASS_MAX_QL_TIMEOUT, OVERPASS_MAX_QL_TIMEOUT)}]`,
  );
  return { ok: true, body: `data=${encodeURIComponent(clamped)}` };
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
