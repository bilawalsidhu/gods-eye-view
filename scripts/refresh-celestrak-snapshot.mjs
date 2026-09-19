#!/usr/bin/env node
/**
 * scripts/refresh-celestrak-snapshot.mjs — refresh the bundled CelesTrak TLE
 * snapshot (data/celestrak-active-snapshot.json) that the /api/celestrak proxy
 * serves when celestrak.org, celestrak.com AND the instance cache are all
 * empty (a cold serverless instance while CelesTrak throttles the egress IP).
 *
 *   node scripts/refresh-celestrak-snapshot.mjs                 refresh now
 *   node scripts/refresh-celestrak-snapshot.mjs --dry-run       fetch + report, no write
 *   node scripts/refresh-celestrak-snapshot.mjs --skip-if-fresh 6
 *                                                               no-op while the file is < 6 h old
 *
 * Designed to run as an npm `prebuild` step, so it NEVER throws and NEVER
 * exits non-zero: a build must not fail because CelesTrak was slow. Groups are
 * fetched sequentially with a short gap (CelesTrak asks for politeness and
 * blocks IPs that hammer it); a group that fails keeps its previous snapshot
 * entry. Summary lines only — TLE bodies are never printed.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fetchUpstream } from '../server/providers/common/upstream.js';
import {
  CELESTRAK_SNAPSHOT_GROUPS,
  CELESTRAK_SNAPSHOT_SCHEMA,
  CELESTRAK_SNAPSHOT_URL,
  isTleText,
  tleTextStats,
} from '../server/providers/space/celestrak-snapshot.js';
import { celestrakTleUrl } from '../src/data/spaceProviderRequests.js';

export const DEFAULT_SKIP_IF_FRESH_HOURS = 6;
export const DEFAULT_GAP_MS = 300;
export const SNAPSHOT_SOURCE_TEMPLATE =
  'https://celestrak.org/NORAD/elements/gp.php?GROUP=<g>&FORMAT=tle';

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** `--dry-run` and `--skip-if-fresh [hours]` (hours default 6 when the flag has no value). */
export function parseRefreshArgs(argv = []) {
  const options = { dryRun: false, skipIfFreshHours: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--skip-if-fresh' || arg.startsWith('--skip-if-fresh=')) {
      let value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : null;
      if (value == null && argv[i + 1] != null && !argv[i + 1].startsWith('--'))
        value = argv[++i];
      const hours = value == null || value === '' ? NaN : Number(value);
      options.skipIfFreshHours =
        Number.isFinite(hours) && hours >= 0
          ? hours
          : DEFAULT_SKIP_IF_FRESH_HOURS;
    }
  }
  return options;
}

/** Parse a previous snapshot document; null when missing or corrupt. */
export function parsePreviousSnapshot(text) {
  try {
    const parsed = JSON.parse(text);
    if (
      parsed?.schema === CELESTRAK_SNAPSHOT_SCHEMA &&
      parsed.groups &&
      typeof parsed.groups === 'object'
    )
      return parsed;
  } catch {
    /* corrupt or absent */
  }
  return null;
}

/**
 * Merge this run's per-group results into the previous snapshot: a refreshed
 * group replaces its entry, a failed group KEEPS its previous entry (when
 * there is one), and the top-level `fetchedAt` only moves when at least one
 * group was refreshed. Pure — no I/O.
 *
 * @param {object} args
 * @param {object|null} args.previous   previous snapshot document (or null)
 * @param {Array<{group:string, ok:boolean, tle?:string, error?:string}>} args.results
 * @param {Date} args.now
 * @returns {{ snapshot: object|null, summary: Array<{group:string,status:string,lines:number,bytes:number,detail:string|null}> }}
 */
export function mergeSnapshot({ previous, results, now = new Date() }) {
  const nowIso = now.toISOString();
  const previousGroups = previous?.groups || {};
  const groups = {};
  const summary = [];
  let refreshed = 0;
  for (const result of results) {
    const group = result.group;
    if (result.ok && isTleText(result.tle)) {
      const stats = tleTextStats(result.tle);
      groups[group] = {
        fetchedAt: nowIso,
        lines: stats.lines,
        satellites: stats.satellites,
        tle: result.tle,
      };
      refreshed += 1;
      summary.push({
        group,
        status: 'refreshed',
        lines: stats.lines,
        bytes: stats.bytes,
        detail: null,
      });
      continue;
    }
    const kept = previousGroups[group];
    if (kept && isTleText(kept.tle)) {
      groups[group] = kept;
      const stats = tleTextStats(kept.tle);
      summary.push({
        group,
        status: 'kept-previous',
        lines: stats.lines,
        bytes: stats.bytes,
        detail: result.error || 'no TLE lines',
      });
    } else {
      summary.push({
        group,
        status: 'missing',
        lines: 0,
        bytes: 0,
        detail: result.error || 'no TLE lines',
      });
    }
  }
  // Groups the previous snapshot had but this run did not ask for survive too.
  for (const [group, entry] of Object.entries(previousGroups)) {
    if (!groups[group] && isTleText(entry?.tle)) groups[group] = entry;
  }
  if (!Object.keys(groups).length) return { snapshot: null, summary };
  return {
    snapshot: {
      schema: CELESTRAK_SNAPSHOT_SCHEMA,
      fetchedAt: refreshed ? nowIso : previous?.fetchedAt || nowIso,
      source: SNAPSHOT_SOURCE_TEMPLATE,
      groups,
    },
    summary,
  };
}

/** Age of the previous snapshot in hours (Infinity when unknown). */
export function snapshotAgeHours(previous, now = new Date()) {
  const at = Date.parse(previous?.fetchedAt || '');
  if (!Number.isFinite(at)) return Number.POSITIVE_INFINITY;
  return Math.max(0, (now.getTime() - at) / 3_600_000);
}

/**
 * Fetch every group (sequentially, politely) and write the merged snapshot.
 * Never throws; the returned `status` is one of 'written' | 'dry-run' |
 * 'skipped' | 'empty' | 'failed'.
 */
export async function refreshCelestrakSnapshot({
  groups = CELESTRAK_SNAPSHOT_GROUPS,
  url = CELESTRAK_SNAPSHOT_URL,
  fetchImpl,
  readFile = (target) => fsp.readFile(target, 'utf8'),
  writeFile = async (target, text) => {
    await fsp.mkdir(path.dirname(fileURLToPath(target)), { recursive: true });
    await fsp.writeFile(target, text, 'utf8');
  },
  now = () => new Date(),
  sleep = defaultSleep,
  gapMs = DEFAULT_GAP_MS,
  timeoutMs = 15_000,
  retries = 1,
  dryRun = false,
  skipIfFreshHours = null,
  log = (line) => console.log(line),
} = {}) {
  const label = '[celestrak-snapshot]';
  try {
    let previous = null;
    try {
      previous = parsePreviousSnapshot(await readFile(url));
    } catch {
      previous = null;
    }
    const started = now();
    if (skipIfFreshHours != null && previous) {
      const ageHours = snapshotAgeHours(previous, started);
      if (ageHours < skipIfFreshHours) {
        log(
          `${label} skipped — existing snapshot is ${ageHours.toFixed(1)} h old (< ${skipIfFreshHours} h)`,
        );
        return {
          status: 'skipped',
          fetchedAt: previous.fetchedAt,
          groups: {},
          path: String(url),
        };
      }
    }
    const results = [];
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i];
      if (i > 0 && gapMs > 0) await sleep(gapMs);
      const result = await fetchUpstream(celestrakTleUrl(group), {
        timeoutMs,
        retries,
        accept: 'text/plain',
        maxBytes: 8 * 1024 * 1024,
        label: 'CelesTrak',
        fetchImpl,
        sleep,
      });
      if (result.ok && isTleText(result.text)) {
        results.push({ group, ok: true, tle: result.text });
      } else {
        results.push({
          group,
          ok: false,
          error: result.ok
            ? 'CelesTrak returned no TLE lines'
            : result.error?.message || 'CelesTrak fetch failed',
        });
      }
    }
    const { snapshot, summary } = mergeSnapshot({
      previous,
      results,
      now: started,
    });
    const report = {};
    for (const row of summary) {
      report[row.group] = {
        status: row.status,
        lines: row.lines,
        bytes: row.bytes,
      };
      log(
        `${label} ${row.group}: ${row.status} · ${row.lines} lines · ${row.bytes} bytes${row.detail ? ` (${row.detail})` : ''}`,
      );
    }
    if (!snapshot) {
      log(
        `${label} nothing to write — no group succeeded and no previous snapshot`,
      );
      return {
        status: 'empty',
        fetchedAt: null,
        groups: report,
        path: String(url),
      };
    }
    if (dryRun) {
      log(
        `${label} dry run — snapshot not written (fetchedAt ${snapshot.fetchedAt})`,
      );
      return {
        status: 'dry-run',
        fetchedAt: snapshot.fetchedAt,
        groups: report,
        path: String(url),
        snapshot,
      };
    }
    const text = JSON.stringify(snapshot, null, 2) + '\n';
    await writeFile(url, text);
    log(
      `${label} wrote ${Buffer.byteLength(text, 'utf8')} bytes · ${Object.keys(snapshot.groups).length} groups · fetchedAt ${snapshot.fetchedAt}`,
    );
    return {
      status: 'written',
      fetchedAt: snapshot.fetchedAt,
      groups: report,
      path: String(url),
      bytes: Buffer.byteLength(text, 'utf8'),
    };
  } catch (error) {
    log(`${label} refresh failed — ${error?.message || error}`);
    return {
      status: 'failed',
      fetchedAt: null,
      groups: {},
      path: String(url),
      error: String(error?.message || error),
    };
  }
}

const invoked = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : '';
if (import.meta.url === invoked) {
  const options = parseRefreshArgs(process.argv.slice(2));
  await refreshCelestrakSnapshot(options);
  // A build step: always exit 0 (see header).
  process.exitCode = 0;
}
