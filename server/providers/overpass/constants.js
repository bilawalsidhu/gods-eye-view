import path from 'node:path';
import { PROVIDER_USER_AGENT } from '../common/upstream.js';

// ---------------------------------------------------------------------------
// Overpass API proxy constants and cache state
// ---------------------------------------------------------------------------
/**
 * User-Agent sent to every Overpass mirror — the ONE shared provider UA
 * (server/providers/common/upstream.js PROVIDER_USER_AGENT: application name,
 * package major.minor and a route back to the project).
 *
 * The OSM API usage policy asks for a "Valid User-Agent identifying application
 * and version"; a generic proxy label is not one. A mirror is free to refuse a
 * client it cannot identify, and `src/overpassProxy.test.mjs` pins what that
 * costs: a refusal is never data, so the query falls through to whatever
 * mirrors are left. Keep this honest and stable — if it is ever refused, the
 * answer is less query volume, not a new name.
 */
const OVERPASS_USER_AGENT = PROVIDER_USER_AGENT;

/**
 * Default ordered list of Overpass API mirrors; tried sequentially on
 * refusal / rate-limit / 5xx / network error / timeout. Overridable per
 * deployment through `OVERPASS_ENDPOINTS` (canonical, closeout 2026-09-19) or
 * its accepted alias `OVERPASS_UPSTREAMS` (2026-09-18) — see
 * `resolveOverpassEndpoints` below.
 *
 * Order = reachability measured 2026-09-19T01:28Z from the agent sandbox with
 * the tiny probe `[out:json][timeout:25];node(1);out;` (POST, this UA,
 * `Accept: application/json`): kumi.systems answered 200 in 1.4 s;
 * private.coffee is round-robin DNS with lagging members (200 in 1.7–4.7 s on
 * two probes, a 12 s timeout on a third); overpass-api.de and its lz4./z.
 * aliases answered HTTP 406 to every probe (client refusal — the same page
 * from Vercel egress on 2026-09-18). Unreachable mirrors stay in the list,
 * LAST, rather than being dropped: a refusal is per-egress and may lift.
 */
const OVERPASS_DEFAULT_UPSTREAMS = Object.freeze([
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
  'https://z.overpass-api.de/api/interpreter',
]);

/** Env names for the mirror list: canonical first, then the accepted alias. */
const OVERPASS_ENDPOINTS_ENV = Object.freeze({
  canonical: 'OVERPASS_ENDPOINTS',
  alias: 'OVERPASS_UPSTREAMS',
  order: Object.freeze(['OVERPASS_ENDPOINTS', 'OVERPASS_UPSTREAMS', 'default']),
});

// --- Road-network configuration point (env-driven, 2026-09-18) --------------
/**
 * Why this exists: from cloud egress (Vercel functions) the public Overpass
 * mirrors are not a dependable road-network source — measured 2026-09-18:
 * overpass-api.de answers HTTP 406 to this client, kumi.systems and
 * private.coffee time out. The two env vars below are the operator's levers;
 * `roadNetworkConfig()` reports them (never their raw values beyond the
 * parsed list) so `GET /api/tools/road_network_status` can say why the OSM
 * road fetch is degraded and what to set. The Overpass transport itself is
 * unchanged apart from reading the parsed mirror list.
 */
/** Accepted `ROAD_NETWORK_SOURCE` values: 'overpass' (default) or 'off' (no OSM road fetch). */
const ROAD_NETWORK_SOURCES = Object.freeze(['overpass', 'off']);

/** Fixed operator-facing blocker text (verbatim in road_network_status). */
const ROAD_NETWORK_BLOCKER =
  'Public Overpass mirrors refuse or time out for cloud egress (overpass-api.de HTTP 406, kumi.systems/private.coffee timeouts — measured 2026-09-18); set OVERPASS_UPSTREAMS to a private mirror';

/**
 * Parse an `OVERPASS_ENDPOINTS` / `OVERPASS_UPSTREAMS` value: comma-separated
 * absolute http(s) URLs (whitespace around and between entries is trimmed,
 * empty entries are ignored, duplicates collapse, order is kept). Returns the
 * parsed list, or null when the value is absent or holds no usable URL (→ the
 * next name in `OVERPASS_ENDPOINTS_ENV.order` is consulted, then the default
 * list).
 * @param {unknown} value
 * @returns {string[]|null}
 */
function parseOverpassEndpoints(value) {
  if (typeof value !== 'string') return null;
  const urls = [];
  for (const part of value.split(/[,\s]+/)) {
    const candidate = part.trim();
    if (!candidate) continue;
    try {
      const url = new URL(candidate);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
      if (!urls.includes(url.href)) urls.push(url.href);
    } catch {
      /* not a URL — ignored, never thrown at import time */
    }
  }
  return urls.length ? urls : null;
}

/** Accepted alias of `parseOverpassEndpoints` (name used since 2026-09-18). */
const parseOverpassUpstreams = parseOverpassEndpoints;

/**
 * The ordered mirror list in force for `env`, plus which name supplied it:
 * `OVERPASS_ENDPOINTS` (canonical) → `OVERPASS_UPSTREAMS` (alias) → the
 * default list. Never returns an empty list.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ endpoints: string[], source: 'OVERPASS_ENDPOINTS'|'OVERPASS_UPSTREAMS'|'default' }}
 */
function resolveOverpassEndpoints(env = process.env) {
  for (const name of [
    OVERPASS_ENDPOINTS_ENV.canonical,
    OVERPASS_ENDPOINTS_ENV.alias,
  ]) {
    const parsed = parseOverpassEndpoints(env?.[name]);
    if (parsed) return { endpoints: parsed, source: name };
  }
  return { endpoints: [...OVERPASS_DEFAULT_UPSTREAMS], source: 'default' };
}

/**
 * Short operator-facing label for a mirror URL: its hostname without a
 * leading `overpass.` label (`overpass.kumi.systems` → `kumi.systems`,
 * `lz4.overpass-api.de` stays as is). Used in the DEGRADED reason string.
 * @param {string} url
 * @returns {string}
 */
function overpassMirrorLabel(url) {
  try {
    return new URL(String(url)).hostname.replace(/^overpass\./i, '');
  } catch {
    return String(url).slice(0, 60);
  }
}

/** `ROAD_NETWORK_SOURCE` → 'overpass' | 'off' (anything unrecognised is the default). */
function parseRoadNetworkSource(value) {
  const source = String(value ?? '')
    .trim()
    .toLowerCase();
  return ROAD_NETWORK_SOURCES.includes(source) ? source : 'overpass';
}

/**
 * The road-network configuration as seen by the running process:
 *   { source: 'overpass'|'off', upstreams: string[], endpointsSource:
 *     'OVERPASS_ENDPOINTS'|'OVERPASS_UPSTREAMS'|'default', blocker: string,
 *     fromEnv: { ROAD_NETWORK_SOURCE: boolean, OVERPASS_ENDPOINTS: boolean,
 *                OVERPASS_UPSTREAMS: boolean } }
 * `fromEnv` only says whether each variable is SET to a usable value (never
 * its raw text); `env` is injectable for tests; production reads process.env
 * at call time.
 * @param {NodeJS.ProcessEnv} [env]
 */
function roadNetworkConfig(env = process.env) {
  const source = parseRoadNetworkSource(env.ROAD_NETWORK_SOURCE);
  const resolved = resolveOverpassEndpoints(env);
  return {
    source,
    upstreams: [...resolved.endpoints],
    endpointsSource: resolved.source,
    blocker: ROAD_NETWORK_BLOCKER,
    fromEnv: {
      ROAD_NETWORK_SOURCE: Boolean(
        String(env.ROAD_NETWORK_SOURCE ?? '').trim(),
      ),
      OVERPASS_ENDPOINTS: Boolean(
        parseOverpassEndpoints(env[OVERPASS_ENDPOINTS_ENV.canonical]),
      ),
      OVERPASS_UPSTREAMS: Boolean(
        parseOverpassEndpoints(env[OVERPASS_ENDPOINTS_ENV.alias]),
      ),
    },
  };
}

/**
 * Ordered list of Overpass API mirrors actually used by the transport:
 * `OVERPASS_ENDPOINTS` (canonical) or `OVERPASS_UPSTREAMS` (alias) when set
 * to a usable csv (read once at import, like every other constant here),
 * otherwise the default list above.
 */
const OVERPASS_UPSTREAMS = resolveOverpassEndpoints(process.env).endpoints;

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

/**
 * Per-mirror request timeout (ms) — the HTTP budget ONE mirror gets before the
 * transport rotates to the next. 12 s (was 22 s until 2026-09-19): the
 * serverless function that hosts `/api/overpass` has a 60 s ceiling, and a
 * five-mirror rotation at 22 s each could not finish inside it. Override with
 * `OVERPASS_MIRROR_TIMEOUT_MS` (1 000–60 000). The road query itself carries
 * an explicit `[timeout:20]` (src/layers/traffic/ingestion.js), so a mirror
 * that is merely slow answers within the budget or not at all.
 */
const OVERPASS_TIMEOUT_MS = clampMs(
  process.env.OVERPASS_MIRROR_TIMEOUT_MS,
  12_000,
  1_000,
  60_000,
);

/**
 * Whole-rotation budget (ms) across ALL mirrors for one request. Once spent,
 * the remaining mirrors are not tried and the reason says so ("N skipped
 * (time budget)"). 40 s leaves ~20 s of the 60 s function ceiling for stale
 * lookups and the response. Override with `OVERPASS_TOTAL_TIMEOUT_MS`.
 */
const OVERPASS_TOTAL_TIMEOUT_MS = clampMs(
  process.env.OVERPASS_TOTAL_TIMEOUT_MS,
  40_000,
  2_000,
  120_000,
);

/** Integer-ms env parser with a default and a [min, max] clamp (never throws). */
function clampMs(value, fallback, min, max) {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

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
  OVERPASS_DEFAULT_UPSTREAMS,
  OVERPASS_ENDPOINTS_ENV,
  OVERPASS_UPSTREAMS,
  OVERPASS_USER_AGENT,
  OVERPASS_TIMEOUT_MS,
  OVERPASS_TOTAL_TIMEOUT_MS,
  ROAD_NETWORK_BLOCKER,
  ROAD_NETWORK_SOURCES,
  overpassMirrorLabel,
  parseOverpassEndpoints,
  parseOverpassUpstreams,
  resolveOverpassEndpoints,
  roadNetworkConfig,
};
