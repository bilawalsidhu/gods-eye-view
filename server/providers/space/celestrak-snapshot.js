import { promises as fsp } from 'node:fs';

/**
 * server/providers/space/celestrak-snapshot.js — the bundled CelesTrak TLE
 * snapshot the proxy (./celestrak.js) falls back to when celestrak.org and
 * celestrak.com are both unreachable AND the function instance has no cached
 * copy (the cold-start case on Vercel, where every instance starts with an
 * empty /tmp and CelesTrak throttles an IP that re-fetches seven groups at
 * once).
 *
 * The file is written by scripts/refresh-celestrak-snapshot.mjs (an npm
 * `prebuild` step) and shipped with the function through vercel.json
 * `includeFiles`. It is resolved relative to THIS module — never
 * `process.cwd()`, which the serverless router redirects to os.tmpdir().
 *
 * Schema (`celestrak-tle-snapshot/1`):
 *   { schema, fetchedAt, source, groups: { <group>: { fetchedAt, lines,
 *     satellites, tle } } }
 */

export const CELESTRAK_SNAPSHOT_SCHEMA = 'celestrak-tle-snapshot/1';

/** The groups the client loads (src/layers/satellites/policy.js) plus DENSE. */
export const CELESTRAK_SNAPSHOT_GROUPS = Object.freeze([
  'stations',
  'visual',
  'gps-ops',
  'glo-ops',
  'galileo',
  'geo',
  'starlink',
]);

export const CELESTRAK_SNAPSHOT_URL = new URL(
  '../../../data/celestrak-active-snapshot.json',
  import.meta.url,
);

/**
 * A CelesTrak TLE body must carry at least one `1 …` element line (the same
 * `^1 ` rule the proxy has always applied — an HTML error page or "No GP data
 * found" parses to zero TLEs and is a failure).
 */
export function isTleText(text) {
  return typeof text === 'string' && /^1 /m.test(text);
}

/** Non-empty text lines, `1 ` element records (= satellites) and UTF-8 bytes. */
export function tleTextStats(text) {
  const body = typeof text === 'string' ? text : '';
  let lines = 0;
  let satellites = 0;
  for (const line of body.split(/\r?\n/)) {
    if (!line.trim()) continue;
    lines += 1;
    if (/^1 /.test(line)) satellites += 1;
  }
  return { lines, satellites, bytes: Buffer.byteLength(body, 'utf8') };
}

function validGroupName(name) {
  return /^[a-z0-9-]+$/i.test(String(name || ''));
}

/**
 * Validate a parsed snapshot document. Groups with a missing/invalid TLE body
 * or timestamp are dropped; null when nothing usable remains.
 */
export function normalizeCelestrakSnapshot(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  if (parsed.schema !== CELESTRAK_SNAPSHOT_SCHEMA) return null;
  if (!parsed.groups || typeof parsed.groups !== 'object') return null;
  const groups = {};
  for (const [name, entry] of Object.entries(parsed.groups)) {
    if (!validGroupName(name) || !entry || typeof entry !== 'object') continue;
    if (!isTleText(entry.tle)) continue;
    const fetchedAtMs = Date.parse(entry.fetchedAt || parsed.fetchedAt || '');
    if (!Number.isFinite(fetchedAtMs)) continue;
    const stats = tleTextStats(entry.tle);
    groups[name] = {
      fetchedAt: new Date(fetchedAtMs).toISOString(),
      fetchedAtMs,
      lines: Number.isFinite(entry.lines) ? entry.lines : stats.lines,
      satellites: stats.satellites,
      tle: entry.tle,
    };
  }
  if (!Object.keys(groups).length) return null;
  const topMs = Date.parse(parsed.fetchedAt || '');
  return {
    schema: CELESTRAK_SNAPSHOT_SCHEMA,
    fetchedAt: Number.isFinite(topMs)
      ? new Date(topMs).toISOString()
      : Object.values(groups)
          .map((g) => g.fetchedAt)
          .sort()
          .at(-1),
    source: typeof parsed.source === 'string' ? parsed.source : null,
    groups,
  };
}

const cache = new Map(); // href -> Promise<snapshot|null>

/** Forget cached loads (tests). */
export function clearCelestrakSnapshotCache() {
  cache.clear();
}

/**
 * Read and validate the bundled snapshot. Cached in memory per file (the
 * default is the shipped data file); resolves to null when the file is
 * missing or corrupt — never throws.
 *
 * @param {object} [options]
 * @param {URL|string} [options.url]        snapshot file (default: bundled)
 * @param {(url:URL|string)=>Promise<string>} [options.readFile]
 * @param {boolean} [options.force]         bypass the memory cache
 */
export function loadCelestrakSnapshot({
  url = CELESTRAK_SNAPSHOT_URL,
  readFile = (target) => fsp.readFile(target, 'utf8'),
  force = false,
} = {}) {
  const key = String(url);
  if (!force && cache.has(key)) return cache.get(key);
  const pending = (async () => {
    try {
      const text = await readFile(url);
      return normalizeCelestrakSnapshot(JSON.parse(text));
    } catch {
      return null;
    }
  })();
  cache.set(key, pending);
  return pending;
}

/**
 * One group's snapshot entry as `{ tle, fetchedAt, fetchedAtMs, lines,
 * satellites }`, or null. Tolerates a raw (un-normalised) document.
 */
export function celestrakSnapshotGroup(snapshot, group) {
  const entry = snapshot?.groups?.[group];
  if (!entry || !isTleText(entry.tle)) return null;
  const fetchedAtMs = Number.isFinite(entry.fetchedAtMs)
    ? entry.fetchedAtMs
    : Date.parse(entry.fetchedAt || snapshot.fetchedAt || '');
  if (!Number.isFinite(fetchedAtMs)) return null;
  const stats =
    Number.isFinite(entry.lines) && Number.isFinite(entry.satellites)
      ? { lines: entry.lines, satellites: entry.satellites }
      : tleTextStats(entry.tle);
  return {
    tle: entry.tle,
    fetchedAt: new Date(fetchedAtMs).toISOString(),
    fetchedAtMs,
    lines: stats.lines,
    satellites: stats.satellites,
  };
}
