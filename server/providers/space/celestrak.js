import path from 'node:path';
import { promises as fsp } from 'node:fs';
import {
  celestrakSatcatUrl,
  celestrakTleUrl,
} from '../../../src/data/spaceProviderRequests.js';
import { parseTleText, tleCatalogNumber } from '../../../src/sources/tle.js';
import { providerCooldownMs } from './cooldown.js';
import { admitSameSiteKeyless } from '../common/same-site.js';
import { readResponseTextCapped } from '../common/http.js';

function catalogNumbers(body) {
  return parseTleText(body || '').map(({ line1 }) => tleCatalogNumber(line1));
}

/** Count paired NORAD records across groups, including overlapping catalogues. */
export function uniqueNoradCount(bodies) {
  const ids = new Set();
  for (const body of bodies) for (const id of catalogNumbers(body)) ids.add(id);
  return ids.size;
}

/**
 * Vite plugin: CelesTrak TLE proxy.
 *
 * CelesTrak does not send CORS headers, so this middleware fetches
 * satellite TLE data server-side and forwards it to the browser.
 * Upstream URL: https://celestrak.org/NORAD/elements/gp.php
 *
 * @returns {import('vite').Plugin}
 */
/**
 * CelesTrak GP/TLE proxy with a memory + disk cache.
 * Upstream: https://celestrak.org/NORAD/elements/gp.php?GROUP=<group>&FORMAT=tle
 * CelesTrak asks clients not to re-fetch GP data more than ~every 2 h and
 * throttles offenders; every dev reload used to refetch every group. Cache TTL
 * 6 h; on upstream failure the freshest stale copy is served (a stale TLE
 * beats an empty satellites layer). Pattern mirrors openSkyProxy's
 * cache+serve-stale. Adapted from skylight's TleStore (MIT).
 *
 * The same plugin serves CelesTrak SATCAT records for the satellites layer's
 * groups at `/api/celestrak-satcat/<group>` (object type, operational status
 * and owner, which file each object under a class). The catalog changes
 * slowly, so SATCAT is cached for a day. CelesTrak throttles the client, not
 * the endpoint, so a 403 or 429 holds both routes off; any other failure
 * holds off only the route that failed, so a bad SATCAT answer never stops
 * TLE refreshes.
 */
export function celestrakProxy() {
  const TLE_TTL_MS = 6 * 3600_000;
  const SATCAT_TTL_MS = 24 * 3600_000;
  const CACHE_DIR = path.join(process.cwd(), '.gev-cache');
  /** The satellites layer's core groups (src/layers/satellites/policy.js). */
  const coreGroups = [
    'stations',
    'visual',
    'gps-ops',
    'glo-ops',
    'galileo',
    'geo',
    'resource',
    'weather',
    'planet',
    'sar',
    'science',
  ];
  const feeds = [
    {
      route: '/api/celestrak',
      ttlMs: TLE_TTL_MS,
      cacheHeader: 'x-tle-cache',
      cachedAtHeader: 'X-TLE-Cached-At',
      diskName: (group) => `celestrak-${group}.json`,
      upstreamUrl: celestrakTleUrl,
      groups: new Set([
        ...coreGroups,
        'starlink',
        // Space Missions (`getActiveTle`) reads the full active catalog.
        'active',
      ]),
      // An upstream error page parses to zero TLEs — treat as failure, keep cache.
      validate: (body) => /^1 /m.test(body),
      invalid: 'no TLE lines in response',
    },
    {
      route: '/api/celestrak-satcat',
      ttlMs: SATCAT_TTL_MS,
      cacheHeader: 'x-satcat-cache',
      cachedAtHeader: 'X-SATCAT-Cached-At',
      diskName: (group) => `celestrak-satcat-${group}.json`,
      upstreamUrl: celestrakSatcatUrl,
      groups: new Set(coreGroups),
      // A real answer, even for an empty group, starts with the CSV header.
      validate: (body) => /^OBJECT_NAME,/.test(body),
      invalid: 'no SATCAT header in response',
    },
  ];
  // CelesTrak throttling (403/429) is per client, so it holds every feed
  // off; any other failure holds off only the feed that failed, so a bad
  // SATCAT answer never blocks the TLEs the layer cannot do without.
  let hostCooldownUntil = 0;

  /** The largest group (`active`) measures ~2.7 MB; this bounds a runaway body. */
  const CELESTRAK_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

  // A count needs only the catalogue numbers to deduplicate overlapping groups.
  const countGroups = new Map();
  const countFile = (group) => `celestrak-count-${group}.json`;
  let combinedCount;
  function rememberCount(group, summary) {
    countGroups.set(group, summary);
    combinedCount = undefined;
  }

  async function readSummary(group) {
    try {
      const summary = JSON.parse(
        await fsp.readFile(path.join(CACHE_DIR, countFile(group)), 'utf8'),
      );
      if (
        Number.isFinite(summary?.at) &&
        Array.isArray(summary.ids) &&
        summary.ids.every(Number.isSafeInteger)
      )
        return summary;
    } catch {
      /* No complete count index for this group. */
    }
    return null;
  }

  async function cachedCount() {
    let files = [];
    try {
      files = await fsp.readdir(CACHE_DIR);
    } catch {
      /* In-memory counts remain available if the cache directory is absent. */
    }
    for (const group of coreGroups) {
      if (countGroups.has(group) || !files.includes(countFile(group))) continue;
      const saved = await readSummary(group);
      if (saved && !countGroups.has(group)) rememberCount(group, saved);
    }
    if (combinedCount === undefined) {
      const ids = new Set();
      let at = Infinity;
      for (const entry of countGroups.values()) {
        for (const id of entry.ids) ids.add(id);
        at = Math.min(at, entry.at);
      }
      combinedCount = ids.size ? { count: ids.size, at } : null;
    }
    return combinedCount;
  }

  function createFeedHandler(feed) {
    let feedCooldownUntil = 0;
    const cooldownUntil = () => Math.max(hostCooldownUntil, feedCooldownUntil);
    const mem = new Map(); // group -> { at: epochMs, body: string }
    const inflight = new Map(); // group -> Promise<{at, body}|null>
    const countWrites = new Map();
    const diskPath = (group) => path.join(CACHE_DIR, feed.diskName(group));

    function indexFeed(group, entry) {
      if (feed !== feeds[0] || !coreGroups.includes(group)) return;
      const summary = { at: entry.at, ids: catalogNumbers(entry.body) };
      rememberCount(group, summary);
      return summary;
    }

    async function replaceJson(file, entry, group) {
      const temporary = `${file}.${crypto.randomUUID()}.tmp`;
      try {
        await fsp.writeFile(temporary, JSON.stringify(entry), 'utf8');
        // A refresh can supersede a repair while its temporary index is written.
        if (group && countGroups.get(group) !== entry)
          await fsp.unlink(temporary);
        else await fsp.rename(temporary, file);
      } catch (error) {
        await fsp.unlink(temporary).catch(() => {});
        throw error;
      }
    }

    async function replaceCount(group, summary) {
      const previous = countWrites.get(group) ?? Promise.resolve();
      const writing = previous
        .catch(() => {})
        .then(() =>
          replaceJson(path.join(CACHE_DIR, countFile(group)), summary, group),
        );
      countWrites.set(group, writing);
      try {
        await writing;
      } finally {
        if (countWrites.get(group) === writing) countWrites.delete(group);
      }
    }

    async function restoreCount(group, entry) {
      if (feed !== feeds[0] || !coreGroups.includes(group)) return;
      const saved = await readSummary(group);
      // A newer refresh owns its own index and must persist its feed first.
      if (mem.get(group) !== entry) return;
      const current = countGroups.get(group);
      let summary;
      if (
        current &&
        current.at >= entry.at &&
        (!saved || current.at >= saved.at)
      ) {
        if (saved?.at === current.at) return;
        summary = current;
      } else if (saved && saved.at >= entry.at) {
        rememberCount(group, saved);
        return;
      } else {
        summary = indexFeed(group, entry);
      }
      try {
        await replaceCount(group, summary);
      } catch {
        /* The in-memory index can still serve this process. */
      }
    }

    async function restoreFromDisk(group) {
      let diskEntry = null;
      try {
        const parsed = JSON.parse(await fsp.readFile(diskPath(group), 'utf8'));
        if (typeof parsed?.body === 'string' && Number.isFinite(parsed?.at))
          diskEntry = parsed;
      } catch {
        /* no disk cache yet */
      }
      // A feed refresh can finish while this disk read is pending.
      const current = mem.get(group);
      if (current) return current;
      if (diskEntry) {
        mem.set(group, diskEntry);
        await restoreCount(group, diskEntry);
      }
      return mem.get(group) ?? diskEntry;
    }

    async function writeDisk(group, entry) {
      const summary = indexFeed(group, entry);
      try {
        await fsp.mkdir(CACHE_DIR, { recursive: true });
        if (summary) {
          await replaceJson(diskPath(group), entry);
          await replaceCount(group, summary);
        } else {
          await fsp.writeFile(diskPath(group), JSON.stringify(entry), 'utf8');
        }
      } catch (err) {
        console.warn('[celestrak-proxy] cache write failed');
      }
    }

    async function fetchUpstream(group) {
      const url = feed.upstreamUrl(group);
      const signal = AbortSignal.timeout(20000);
      const res = await fetch(url.toString(), {
        signal,
        // CelesTrak 403s bulk groups (e.g. `active`) unless the request carries a
        // descriptive User-Agent with a contact point.
        headers: {
          'User-Agent':
            'gods-eye-view-celestrak-proxy/1.0 (+https://github.com/bilawalsidhu/gods-eye-view)',
        },
      });
      if (!res.ok) {
        // Group refreshes run in parallel: a later failure without Retry-After
        // must never shorten a longer deadline an earlier one already set.
        const until = Date.now() + providerCooldownMs(res);
        if (res.status === 403 || res.status === 429)
          hostCooldownUntil = Math.max(hostCooldownUntil, until);
        else feedCooldownUntil = Math.max(feedCooldownUntil, until);
        void res.body?.cancel().catch(() => {});
        throw new Error(`HTTP ${res.status}`);
      }
      const body = await readResponseTextCapped(
        res,
        CELESTRAK_MAX_RESPONSE_BYTES,
        signal,
      );
      if (!feed.validate(body)) throw new Error(feed.invalid);
      return { at: Date.now(), body };
    }

    const handler = async (req, res) => {
      const group = String(req.url || '')
        .replace(/^\//, '')
        .split('?')[0];
      // Keyless and needed to render the satellites layer: refuse cross-site
      // browsers but keep the documented reverse-proxy deployment working.
      if (admitSameSiteKeyless(req, res)) return;
      if (req.method !== 'GET') {
        res.writeHead(405);
        res.end();
        return;
      }
      if (!feed.groups.has(group)) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('invalid group');
        return;
      }
      const send = (status, body, cacheStatus, entry) => {
        // Guard against a double-send (e.g. a throw AFTER a response already
        // went out routing into the catch's send): writeHead after headersSent
        // throws "Cannot set headers after they are sent".
        if (res.headersSent) return;
        res.writeHead(status, {
          'Content-Type': 'text/plain',
          [feed.cacheHeader]: cacheStatus,
          'Cache-Control': 'no-store',
          ...(entry
            ? { [feed.cachedAtHeader]: new Date(entry.at).toISOString() }
            : {}),
          ...(cooldownUntil() > 0 && Date.now() < cooldownUntil()
            ? {
                'Retry-After': String(
                  Math.ceil((cooldownUntil() - Date.now()) / 1000),
                ),
              }
            : {}),
        });
        res.end(body);
      };
      try {
        const now = Date.now();
        const entry = mem.get(group) ?? (await restoreFromDisk(group));
        if (entry && now - entry.at < feed.ttlMs) {
          send(200, entry.body, 'HIT', entry);
          return;
        }
        if (Date.now() < cooldownUntil()) {
          send(
            entry ? 200 : 502,
            entry?.body || 'celestrak upstream cooling down',
            entry ? 'STALE-ERROR' : 'NONE',
            entry,
          );
          return;
        }
        // Stale or missing → refresh, single-flight per group.
        if (!inflight.has(group)) {
          inflight.set(
            group,
            fetchUpstream(group)
              .then(async (fresh) => {
                mem.set(group, fresh);
                await writeDisk(group, fresh);
                return fresh;
              })
              .catch((err) => {
                if (Date.now() >= feedCooldownUntil)
                  feedCooldownUntil = Date.now() + 60000;
                console.warn(
                  '[celestrak-proxy] refresh failed — serving cache if any',
                );
                return null;
              })
              .finally(() => inflight.delete(group)),
          );
        }
        const fresh = await inflight.get(group);
        if (fresh) {
          send(200, fresh.body, 'MISS', fresh);
        } else if (entry) {
          send(200, entry.body, 'STALE-ERROR', entry); // upstream down — stale beats empty
        } else {
          send(502, 'celestrak fetch failed and no cache available', 'NONE');
        }
      } catch (err) {
        console.error('[celestrak-proxy] request failed');
        send(500, 'celestrak proxy error', 'ERROR');
      }
    };
    return handler;
  }

  const handlers = new Map(
    feeds.map((feed) => [feed.route, createFeedHandler(feed)]),
  );
  const installMiddleware = (server) => {
    for (const [route, handler] of handlers)
      server.middlewares.use(route, handler);
  };
  return {
    name: 'celestrak-proxy',
    // The TLE feed's cache counts the satellites layer (generous, keyless).
    api: { readLayerCount: cachedCount },
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
