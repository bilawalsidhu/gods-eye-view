/**
 * Bundle budgets (docs/PLAN.md Phase 7, issue #40).
 *
 * CI runs `npm run check:budgets` after the production build (see
 * scripts/check-bundle-budgets.mjs). Every number below is a DELIBERATE
 * ceiling over a measured artifact — the check fails when a chunk grows past
 * its budget so bundle growth becomes a reviewed decision instead of a
 * surprise shipped to the network. Raise a budget in the same commit that
 * grows the bundle, with the reason in the commit message.
 *
 * Two failure modes matter more than the raw bytes:
 *   - PRECACHE_FILE_LIMIT mirrors workbox's `maximumFileSizeToCacheInBytes`
 *     in vite.config.js. A precache-shell file at or over that cap is
 *     SILENTLY dropped from the service-worker precache: the app keeps
 *     working online and quietly loses its offline shell. The index-chunk
 *     budget therefore sits AT the cap, and the check also verifies the
 *     built sw.js manifest actually lists every shell file.
 *   - Chunks without an explicit row get DEFAULT_CHUNK_BUDGET, so a new
 *     dynamic import cannot ship unbounded — the violation message points
 *     at this table to add a deliberate row.
 */

/** Mirrors workbox `maximumFileSizeToCacheInBytes` in vite.config.js (6 MiB). */
export const PRECACHE_FILE_LIMIT = 6 * 1024 * 1024;

/** Byte ceiling for any built chunk without an explicit row in BUNDLE_BUDGETS. */
export const DEFAULT_CHUNK_BUDGET = 512 * 1024;

/**
 * Byte ceilings for the precache shell as a whole (index.html + index-*.js +
 * *.css — the workbox globPatterns in vite.config.js). This is the offline
 * install cost every visitor pays on first load.
 */
export const PRECACHE_TOTAL_BUDGET = 6_500_000;

/**
 * Ceiling on the whole dist/ tree (including the copied Cesium runtime,
 * aircraft models, and the FIRMS WASM renderer). Generous by design: it
 * catches an accidentally committed multi-megabyte asset, not ordinary churn.
 */
export const DIST_TOTAL_BUDGET = 40 * 1024 * 1024;

/**
 * Ordered classification table — first matching row wins. Patterns match the
 * hashed BASENAME of a dist artifact (`assets/index-DJpUHRcE.js` matches
 * /^index-[^/]*\.js$/). Every measured number that a budget was set from is
 * recorded in `why` so the next person raising it knows the baseline.
 */
export const BUNDLE_BUDGETS = Object.freeze([
  {
    id: 'index-chunk',
    pattern: /^index-[^/]*\.js$/,
    label: 'precache shell: index chunk',
    budget: PRECACHE_FILE_LIMIT,
    why: 'the workbox per-file cap silently drops the chunk from the precache at/over this size — the offline shell breaks while the app still works online (measured 6,056,871 B at the 2026-09-13 diet)',
  },
  {
    id: 'css',
    pattern: /^[^/]*\.css$/,
    label: 'precache shell: stylesheets',
    budget: 220 * 1024,
    why: 'one stylesheet ships the whole HUD (measured 187,410 B after the render-perf de-blur pass)',
  },
  {
    id: 'index-html',
    pattern: /^index\.html$/,
    label: 'precache shell: document',
    budget: 64 * 1024,
    why: 'the boot document, precached verbatim (measured 55,022 B)',
  },
  {
    id: 'egm96',
    pattern: /^egm96-universal\.esm-[^/]*\.js$/,
    label: 'lazy: EGM96 geoid (altitude datum)',
    budget: 3_000_000,
    why: 'largest lazy chunk; loads on first terrain-height use (measured 2,770,496 B)',
  },
  {
    id: 'regions',
    pattern: /^regions-[^/]*\.js$/,
    label: 'lazy: Natural Earth regions',
    budget: 2_150_000,
    why: 'loads with the regions dataset (measured 1,987,147 B)',
  },
  {
    id: 'marine',
    pattern: /^marine-[^/]*\.js$/,
    label: 'lazy: marine ports/areas',
    budget: 700_000,
    why: 'loads with the marine dataset (measured 633,390 B)',
  },
  {
    id: 'san-francisco',
    pattern: /^san-francisco-[^/]*\.js$/,
    label: 'lazy: San Francisco demo scene',
    budget: 260_000,
    why: 'loads with the SF scene geometry (measured 222,263 B)',
  },
]);

/** The budget rows whose files workbox precaches (vite.config.js globPatterns). */
export const PRECACHE_ROW_IDS = Object.freeze(['index-chunk', 'css', 'index-html']);

const basenameOf = (relativePath) => relativePath.slice(relativePath.lastIndexOf('/') + 1);

/**
 * Classify one dist-relative artifact path. Returns the matching row, or
 * `null` when the file falls to DEFAULT_CHUNK_BUDGET (workers today).
 */
export function classifyBundleFile(relativePath) {
  const basename = basenameOf(relativePath);
  return BUNDLE_BUDGETS.find((row) => row.pattern.test(basename)) ?? null;
}

const formatKiB = (bytes) => `${(bytes / 1024).toFixed(1)} KiB`;

const remedial = (why, remedy) => `${remedy} — ${why}.`;

/**
 * Evaluate measured artifact sizes against the budget table.
 *
 * @param {object} input
 * @param {Array<{path: string, bytes: number}>} input.files dist-relative
 *   paths (as the build emitted them, e.g. `assets/index-DJpUHRcE.js`) with
 *   their sizes on disk.
 * @param {number|null} [input.distTotal] total dist/ size in bytes.
 * @param {string[]|null} [input.precacheManifestUrls] URLs extracted from the
 *   built sw.js precache manifest; when provided, shell files missing from it
 *   are violations (the workbox cap's silent-drop failure mode) and manifest
 *   entries missing from the build output are flagged as stale.
 * @param {string[]|null} [input.knownPaths] every dist-relative path in the
 *   build output — the universe the manifest's non-shell entries (icons, the
 *   boot document) are checked against. Required for the stale-entry check.
 * @returns {{classified: Array, violations: Array<{path: string, code: string, message: string}>, precacheTotal: number, distTotal: number|null}}
 */
export function evaluateBundleBudgets({
  files,
  distTotal = null,
  precacheManifestUrls = null,
  knownPaths = null,
}) {
  const classified = files.map((file) => {
    const row = classifyBundleFile(file.path);
    const budget = row ? row.budget : DEFAULT_CHUNK_BUDGET;
    return {
      path: file.path,
      bytes: file.bytes,
      id: row ? row.id : 'default',
      label: row ? row.label : 'unbudgeted chunk (default ceiling)',
      why: row ? row.why : 'no explicit budget row — add one in src/config/bundleBudgets.js before growing this chunk past the default',
      budget,
      precache: row ? PRECACHE_ROW_IDS.includes(row.id) : false,
      ok: file.bytes <= budget,
    };
  });

  const violations = [];
  for (const entry of classified) {
    if (entry.ok) continue;
    const remedy = entry.id === 'default'
      ? 'add an explicit budget row for this chunk'
      : 'raise its budget deliberately in src/config/bundleBudgets.js';
    violations.push({
      path: entry.path,
      code: 'OVER_BUDGET',
      message: `${entry.path} is ${formatKiB(entry.bytes)} — over the ${entry.label} budget of ${formatKiB(entry.budget)} by ${entry.bytes - entry.budget} B; ${remedial(entry.why, remedy)}`,
    });
  }

  // The silent-drop check: a shell file on disk that the built sw.js did NOT
  // precache means workbox excluded it (per-file cap is the only way that
  // happens for these globs) — the offline shell is broken right now.
  if (Array.isArray(precacheManifestUrls)) {
    const manifest = new Set(precacheManifestUrls);
    for (const entry of classified.filter((entry) => entry.precache)) {
      if (!manifest.has(entry.path)) {
        violations.push({
          path: entry.path,
          code: 'NOT_PRECACHED',
          message: `${entry.path} is a precache-shell file but the built sw.js manifest does not list it — workbox silently dropped it (per-file cap ${formatKiB(PRECACHE_FILE_LIMIT)}); the offline shell is broken`,
        });
      }
    }
    if (Array.isArray(knownPaths)) {
      const onDisk = new Set(knownPaths);
      for (const url of precacheManifestUrls) {
        if (!onDisk.has(url)) {
          violations.push({
            path: url,
            code: 'STALE_PRECACHE_ENTRY',
            message: `sw.js precache manifest lists ${url} but it is not in the build output — stale service worker`,
          });
        }
      }
    }
  }

  const precacheTotal = classified
    .filter((entry) => entry.precache)
    .reduce((sum, entry) => sum + entry.bytes, 0);
  if (precacheTotal > PRECACHE_TOTAL_BUDGET) {
    violations.push({
      path: '(precache shell total)',
      code: 'OVER_PRECACHE_TOTAL',
      message: `precache shell totals ${formatKiB(precacheTotal)} — over the ${formatKiB(PRECACHE_TOTAL_BUDGET)} first-install budget by ${precacheTotal - PRECACHE_TOTAL_BUDGET} B; move weight to a lazy chunk or raise PRECACHE_TOTAL_BUDGET in src/config/bundleBudgets.js`,
    });
  }
  if (distTotal !== null && distTotal > DIST_TOTAL_BUDGET) {
    violations.push({
      path: '(dist total)',
      code: 'OVER_DIST_TOTAL',
      message: `dist/ totals ${formatKiB(distTotal)} — over the ${formatKiB(DIST_TOTAL_BUDGET)} ceiling by ${distTotal - DIST_TOTAL_BUDGET} B; something large was added to the build output`,
    });
  }

  return { classified, violations, precacheTotal, distTotal };
}
