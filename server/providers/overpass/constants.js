import path from 'node:path';

// ---------------------------------------------------------------------------
// Overpass API proxy constants and cache state
// ---------------------------------------------------------------------------
/**
 * User-Agent sent to every Overpass mirror.
 *
 * The OSM API usage policy asks for a "Valid User-Agent identifying application
 * and version"; a generic proxy label is not one. A mirror is free to refuse a
 * client it cannot identify, and `src/overpassProxy.test.mjs` pins what that
 * costs: a refusal is never data, so the query falls through to whatever
 * mirrors are left. Keep this honest and stable — if it is ever refused, the
 * answer is less query volume, not a new name.
 */
const OVERPASS_USER_AGENT =
  'gods-eye-view/0.1 (+https://github.com/bilawalsidhu/gods-eye-view)';

/** Ordered list of Overpass API mirrors; tried sequentially on failure/rate-limit. */
const OVERPASS_UPSTREAMS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
  // Community full-planet instance (privateforge nonprofit) — added 2026-07-30
  // when all three mirrors above refused this IP (likely a dev-traffic rate
  // ban; refused connections fail in ms, so healthy mirrors above still win).
  // Verified: planet coverage (Texas query), CORS *, ~5-20 s cold latency.
  'https://overpass.private.coffee/api/interpreter',
];

/**
 * Extra Overpass endpoints from OVERPASS_EXTRA_UPSTREAMS, tried BEFORE the
 * built-in list.
 *
 * The built-in mirrors are not reachable from everywhere, and as of #648 they
 * are not reachable from ANYWHERE for this app: overpass-api.de refuses any
 * request whose User-Agent carries this project's name, and the operators asked
 * — correctly — that heavy consumers run their own instance instead of rotating
 * through the remaining free ones. A self-hosted endpoint belongs in the
 * operator's environment, not in the repo's default list.
 *
 * Extras go FIRST: an endpoint someone configured deliberately is a better
 * first try than one that just timed out for them, and each dead built-in costs
 * a full OVERPASS_TIMEOUT_MS before the chain moves on.
 *
 * @param {string} raw Whitespace/comma-separated URL list.
 * @returns {Array<string>} Valid absolute http(s) endpoint URLs, in order.
 */
function parseExtraOverpassUpstreams(raw) {
  const out = [];
  for (const token of String(raw ?? '').split(/[\s,]+/)) {
    if (!token) continue;
    let url;
    try {
      url = new URL(token);
    } catch {
      console.warn(
        `[Overpass] ignoring unparseable OVERPASS_EXTRA_UPSTREAMS entry: ${token}`,
      );
      continue;
    }
    // Structural checks only. Unlike a world-editable OSM tag, this value comes
    // from the operator's own env, so a private or localhost address is a
    // legitimate self-hosted instance rather than an SSRF target.
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.username ||
      url.password ||
      !url.hostname
    ) {
      console.warn(
        `[Overpass] ignoring unusable OVERPASS_EXTRA_UPSTREAMS entry: ${token}`,
      );
      continue;
    }
    if (!out.includes(url.href)) out.push(url.href);
  }
  return out;
}

/** @type {{raw: string|null, list: Array<string>, extras: Set<string>}} Resolved-chain memo. */
let overpassUpstreamMemo = {
  raw: null,
  list: OVERPASS_UPSTREAMS,
  extras: new Set(),
};

/** Re-resolve the chain only when the env value actually changed. */
function overpassUpstreamState() {
  const raw = process.env.OVERPASS_EXTRA_UPSTREAMS ?? '';
  if (overpassUpstreamMemo.raw !== raw) {
    const extra = parseExtraOverpassUpstreams(raw);
    if (extra.length)
      console.log(
        `[Overpass] ${extra.length} extra upstream(s) from OVERPASS_EXTRA_UPSTREAMS, tried first`,
      );
    overpassUpstreamMemo = {
      raw,
      list: [...extra, ...OVERPASS_UPSTREAMS],
      extras: new Set(extra),
    };
  }
  return overpassUpstreamMemo;
}

/**
 * The endpoint chain to try, extras first. Resolved lazily: module evaluation
 * happens before the dev server copies `.env` into `process.env`, so reading the
 * variable at module scope would always see undefined.
 * @returns {Array<string>} Ordered endpoint URLs.
 */
function resolveOverpassUpstreams() {
  return overpassUpstreamState().list;
}

/**
 * Whether an endpoint came from OVERPASS_EXTRA_UPSTREAMS rather than the
 * built-in list.
 *
 * This exists for the REGIONAL-EXTRACT hazard. A self-hosted instance built
 * from a regional extract answers fast with HTTP 200 for the whole planet, but
 * serves an empty element list everywhere outside its extract — which the proxy
 * would otherwise store as a valid answer for 7 days, silently pinning every
 * Overpass-backed layer to "no data here" for regions that do have data. An
 * empty answer from an operator endpoint is therefore treated as that endpoint
 * declining, not as data. Built-in planet mirrors keep the old meaning, where
 * an empty result really can be the truth.
 * @param {string} endpoint Endpoint URL from the resolved chain.
 * @returns {boolean}
 */
function isExtraOverpassUpstream(endpoint) {
  return overpassUpstreamState().extras.has(endpoint);
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
  OVERPASS_UPSTREAMS,
  OVERPASS_USER_AGENT,
  OVERPASS_TIMEOUT_MS,
  parseExtraOverpassUpstreams,
  resolveOverpassUpstreams,
  isExtraOverpassUpstream,
};
