/**
 * @file Cached, rate-limited text fetch shared by the catalog builders.
 *
 * Every response is stored under the caller's cache directory, keyed by a hash
 * of its URL, so a builder's outputs derive from the cache and its inputs alone.
 * With `offline` a cache miss throws instead of fetching, which proves a rerun
 * reproduces without the network. With `force` the cache is ignored and refilled.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const RETRIES = 6;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {object} opts
 * @param {string} opts.cacheDir
 * @param {string} opts.userAgent A generic client name, never contact details.
 * @param {boolean} [opts.force]
 * @param {boolean} [opts.offline]
 * @returns {(url: string) => Promise<string>} resolves to the UTF-8 body.
 */
export function createTextFetcher({
  cacheDir,
  userAgent,
  force = false,
  offline = false,
}) {
  return async function fetchText(url) {
    const hash = createHash('sha1').update(url).digest('hex').slice(0, 16);
    const file = path.join(cacheDir, `txt-${hash}.txt`);
    if (!force && existsSync(file)) return readFileSync(file, 'utf8');
    if (offline) throw new Error(`offline cache miss: ${url}`);
    for (let attempt = 0; attempt < RETRIES; attempt++) {
      let response;
      try {
        response = await fetch(url, { headers: { 'User-Agent': userAgent } });
      } catch {
        await sleep(2000 * (attempt + 1));
        continue;
      }
      if (response.status === 429 || response.status >= 500) {
        await sleep(4000 * (attempt + 1));
        continue;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
      const body = Buffer.from(await response.arrayBuffer());
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(file, body);
      return body.toString('utf8');
    }
    throw new Error(`fetch failed after ${RETRIES} attempts: ${url}`);
  };
}
