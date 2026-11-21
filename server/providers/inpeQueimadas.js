import { readResponseTextCapped } from './common/http.js';
import { filterTrailing24h } from '../../src/data/firmsCsv.js';
import {
  INPE_10MIN_URL,
  parseInpeCsv,
  parseInpeListing,
} from '../../src/data/inpeQueimadasCsv.js';

/**
 * Keyless South American fire detections from INPE's Programa Queimadas, the
 * Active Fires source when no FIRMS_MAP_KEY is configured.
 *
 * INPE publishes one CSV every 10 minutes and keeps about four days of them.
 * A file can carry passes observed up to about 28 hours earlier, so a refresh
 * reads every file named in the last LOOKBACK_MS and keeps the detections whose
 * own pass time is inside the trailing 24 hours. Each file is downloaded once
 * and kept until it ages out of the lookback: after the first refresh, a
 * 10-minute refresh asks INPE for the listing and one new file. A file that
 * fails is not kept, so the next refresh retries it.
 *
 * Programa Queimadas states that its data are free to access at no cost (FAQ
 * 5) and asks to be cited (FAQ 36); DATA_SOURCES.md and dataCredits.js carry
 * the citation.
 */

/** File-name lookback: 24 hours of detections plus the slowest observed arrival. */
const LOOKBACK_MS = 30 * 3600_000;
/** The listing is about 180 KB for four days of files. */
const LISTING_MAX_BYTES = 2 * 1024 * 1024;
/** A 10-minute file averaged 13 KB on 2026-10-29 (1.9 MB across 144 files). */
const FILE_MAX_BYTES = 8 * 1024 * 1024;
/** 30 hours of 10-minute files is 180; a refresh never downloads more than this. */
const MAX_FILES = 240;
/** Parallel downloads during the first fill; later refreshes fetch one file. */
const CONCURRENCY = 4;
const TIMEOUT_MS = 30_000;
const USER_AGENT =
  'gods-eye-view-fires (+https://github.com/bilawalsidhu/gods-eye-view)';

/**
 * @param {{fetchImpl?: typeof fetch, now?: () => number, log?: {warn: Function}}} [deps]
 * @returns {{refresh: () => Promise<{at: number, sources: Array<object>, fires: Array<object>}>,
 *   fileCount: () => number}}
 */
export function createInpeFires({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  log = console,
} = {}) {
  /** @type {Map<string, Array<object>>} file name → parsed records */
  const files = new Map();

  async function getText(url, maxBytes) {
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    const response = await fetchImpl(url, {
      signal,
      headers: { 'User-Agent': USER_AGENT },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return readResponseTextCapped(response, maxBytes, signal);
  }

  /**
   * Bring the file set up to date and return the trailing-24h detections.
   * Throws when the listing fails or when no file could be read at all, so the
   * caller can serve its last good snapshot.
   */
  async function refresh() {
    const at = now();
    const listing = parseInpeListing(
      await getText(INPE_10MIN_URL, LISTING_MAX_BYTES),
    );
    // INPE normally retains several days of 10-minute files. An HTTP 200
    // error page may contain no CSV links; don't discard a populated cache
    // and report zero fires as a successful refresh.
    if (files.size > 0 && listing.length === 0)
      throw new Error('INPE listing unexpectedly empty');
    const wanted = listing.filter((file) => file.at >= at - LOOKBACK_MS);
    const keep = new Set(wanted.map((file) => file.name));
    for (const name of files.keys()) if (!keep.has(name)) files.delete(name);

    const missing = wanted
      .filter((file) => !files.has(file.name))
      .slice(-MAX_FILES);
    let failed = 0;
    let next = 0;
    async function worker() {
      while (next < missing.length) {
        const { name } = missing[next];
        next += 1;
        try {
          const records = parseInpeCsv(
            await getText(INPE_10MIN_URL + name, FILE_MAX_BYTES),
          );
          if (records === null) throw new Error('not an INPE fire CSV');
          files.set(name, records);
        } catch (err) {
          failed += 1;
          log.warn(`[inpe-queimadas] ${name} failed:`, err?.message || err);
        }
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, missing.length) }, worker),
    );
    if (wanted.length && !wanted.some((file) => files.has(file.name)))
      throw new Error('every INPE file failed');

    const fires = [];
    for (const { name } of wanted) {
      // Not fires.push(...records): see the argument-limit note in firms.js.
      for (const record of filterTrailing24h(files.get(name) || [], at))
        fires.push(record);
    }
    return {
      at,
      sources: [
        { source: 'INPE_QUEIMADAS', count: fires.length, ok: failed === 0 },
      ],
      fires,
    };
  }

  return { refresh, fileCount: () => files.size };
}
