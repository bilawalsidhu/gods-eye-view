import path from 'node:path';
import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Overpass API proxy constants and cache state
// ---------------------------------------------------------------------------
/** Stable application identity for operator-configured Overpass instances. */
const OVERPASS_USER_AGENT =
  'gods-eye-view/0.1 (+https://github.com/bilawalsidhu/gods-eye-view)';

/** Parse only operator-supplied HTTP(S) endpoints; private instances are allowed. */
function parseOverpassUpstreams(raw) {
  const endpoints = [];
  for (const token of String(raw || '').split(',')) {
    try {
      const url = new URL(token.trim());
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        !url.hostname ||
        url.hash
      )
        continue;
      if (!endpoints.includes(url.href)) endpoints.push(url.href);
    } catch {
      // Invalid configuration never becomes an upstream or appears in logs.
    }
  }
  return endpoints.slice(0, 8);
}

let upstreamMemo = { raw: null, endpoints: [], tag: 'none' };

/**
 * Short, stable identifier for the configured upstream set. Cached responses
 * carry it so an answer produced by a different instance is not served after
 * the operator repoints `OVERPASS_UPSTREAMS` — the disk cache outlives the
 * configuration change by 7 days, a month for boundary queries, and forever on
 * the serve-stale path. It is a hash, never the URLs, and it is only ever
 * compared on read: it is not sent to clients and does not appear in errors.
 */
function upstreamTag(endpoints) {
  if (!endpoints.length) return 'none';
  return createHash('sha1')
    .update(endpoints.join('\n'))
    .digest('hex')
    .slice(0, 12);
}

/** Resolve after environment loading. Public Overpass instances are not used by default. */
function resolveOverpassUpstreams() {
  readUpstreamMemo();
  return [...upstreamMemo.endpoints];
}

/** The configured-upstream tag stored alongside, and checked against, cache entries. */
function resolveOverpassUpstreamTag() {
  return readUpstreamMemo().tag;
}

let reportedForeignCache = false;

/**
 * Was this cached entry produced by the upstream set configured now?
 *
 * With nothing configured there is no instance to contradict, and serving
 * last-good data at any age is the point of the cache (the proxy's
 * not-configured path depends on it), so any entry is accepted. Once an
 * operator does configure an instance, only its own answers are served: an
 * entry with no tag, or one from a different instance, is refused rather than
 * matched on the query alone. Shared by both caches fed by these upstreams.
 */
function cachedByConfiguredUpstream(entry) {
  const tag = resolveOverpassUpstreamTag();
  if (tag === 'none' || entry?.upstreams === tag) return true;
  if (!reportedForeignCache) {
    reportedForeignCache = true;
    console.warn(
      '[Overpass] ignoring cached responses produced by a different OVERPASS_UPSTREAMS; they will be refetched from the configured instance.',
    );
  }
  return false;
}

function readUpstreamMemo() {
  const raw = process.env.OVERPASS_UPSTREAMS || '';
  if (upstreamMemo.raw !== raw) {
    const endpoints = parseOverpassUpstreams(raw);
    upstreamMemo = { raw, endpoints, tag: upstreamTag(endpoints) };
  }
  return upstreamMemo;
}

/**
 * TTL for FRESH cached Overpass responses (ms). Road geometry is static for
 * months — the original 45 s TTL forced a public-mirror round-trip on nearly
 * every viewport revisit and left nothing to serve when the mirrors 502
 * (field-test 2026-07-17: all three mirrors down during US morning peak =
 * "traffic takes forever to load"). 24 h in memory; the disk layer below
 * keeps 7 days and also survives dev-server restarts.
 */
const OVERPASS_CACHE_MS = 86_400_000;

/** Disk-cache TTL for Overpass responses (ms) — 7 days. */
const OVERPASS_DISK_TTL_MS = 7 * 86_400_000;

/**
 * Disk-cache TTL for BOUNDARY-class queries (is_in / admin-relation pivots) — 30
 * days. Admin boundaries change ≈never, and their pivots are the most expensive
 * queries the app issues (multi-MB coastline geometry, 10–25 s on public mirrors —
 * field test 2026-07-23: outline latency + the Sicily miss). Keeping them a month
 * means each boundary is fetched roughly once per machine, ever.
 */
const OVERPASS_BOUNDARY_DISK_TTL_MS = 30 * 86_400_000;

/** Disk-cache directory for Overpass responses. */
const OVERPASS_DISK_DIR = path.join(process.cwd(), '.gev-cache', 'overpass');

/** Per-upstream fetch timeout (ms). */
const OVERPASS_TIMEOUT_MS = 22000;

/** Max entries in the Overpass response cache (LRU-like, oldest evicted first). */
const OVERPASS_CACHE_MAX_ENTRIES = 120;

// --- Abuse guards shared by the Overpass + route proxies --------------------
/** Max accepted POST body for the Overpass proxy (Overpass QL queries are tiny). */
const OVERPASS_MAX_BODY_BYTES = 24 * 1024;

// 24 KB
/**
 * Hard cap on a single Overpass upstream response we will buffer into memory.
 * 32 MB (was 12 MB): a dense island/state admin boundary at full `out geom`
 * fidelity — Sicilia's Mediterranean coastline — can exceed 12 MB, and clipping
 * it read as a permanent "transient" failure (field test 2026-07-23, Sicily
 * never traced). The buffered payload is SIMPLIFIED server-side before it is
 * cached or sent (simplifyOverpassPayloadBody), so the raised cap does not
 * raise what clients receive or what the disk stores.
 */
const OVERPASS_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

// 32 MB
/** Only payloads at least this large go through geometry simplification. */
const OVERPASS_SIMPLIFY_MIN_BYTES = 1_500_000;

/** Only per-element geometry arrays with at least this many points are simplified. */
const OVERPASS_SIMPLIFY_MIN_POINTS = 1200;

/**
 * Douglas-Peucker tolerance (degrees, ≈44 m of latitude). Region/state boundary
 * rings are drawn at regional camera scale and the client simplifies again for
 * draw, so ~44 m fidelity is invisible; building footprints never reach the
 * point threshold above and pass through untouched.
 */
const OVERPASS_SIMPLIFY_TOLERANCE_DEG = 0.0004;

/** Max concurrent in-flight upstream Overpass fetches across all distinct queries. */
const OVERPASS_MAX_CONCURRENT = 6;

/** Server-side timeout ceiling (seconds) we allow inside an Overpass QL query. */
const OVERPASS_MAX_QL_TIMEOUT = 30;

/** Max `around:` radius (m) — every app caller uses <= 1800 m. */
const OVERPASS_MAX_AROUND_M = 50000;

/** Max bbox span (degrees) — app bboxes are small viewport tiles. */
const OVERPASS_MAX_BBOX_DEG = 12;

/**
 * Every Overpass element-type specifier, including the combined shortcuts
 * (nwr/nw/nr/wr) and `rel`. Shared by the selector + area-element-deny regexes so
 * they can't drift (a missing shortcut like `wr` was an area-scan bypass).
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

export {
  OVERPASS_BOUNDARY_DISK_TTL_MS,
  OVERPASS_DISK_TTL_MS,
  OVERPASS_DISK_DIR,
  OVERPASS_CACHE_MS,
  OVERPASS_CACHE_MAX_ENTRIES,
  OVERPASS_MAX_BODY_BYTES,
  OVERPASS_MAX_CONCURRENT,
  OVERPASS_MAX_AROUND_M,
  OVERPASS_MAX_BBOX_DEG,
  OVERPASS_AREA_ELEMENT_RE,
  OVERPASS_SELECTOR_RE,
  OVERPASS_BBOX_RE,
  OVERPASS_MAX_QL_TIMEOUT,
  OVERPASS_SIMPLIFY_MIN_BYTES,
  OVERPASS_SIMPLIFY_MIN_POINTS,
  OVERPASS_SIMPLIFY_TOLERANCE_DEG,
  OVERPASS_MAX_RESPONSE_BYTES,
  parseOverpassUpstreams,
  resolveOverpassUpstreams,
  resolveOverpassUpstreamTag,
  cachedByConfiguredUpstream,
  OVERPASS_USER_AGENT,
  OVERPASS_TIMEOUT_MS,
};
