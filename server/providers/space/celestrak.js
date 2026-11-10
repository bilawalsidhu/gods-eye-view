import path from 'node:path';
import { promises as fsp } from 'node:fs';
import {
  celestrakSatcatUrl,
  celestrakTleUrl,
} from '../../../src/data/spaceProviderRequests.js';
import { providerCooldownMs } from './cooldown.js';
import { admitSameSiteKeyless } from '../common/same-site.js';
import { readResponseTextCapped } from '../common/http.js';

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

  function createFeedHandler(feed) {
    let feedCooldownUntil = 0;
    const cooldownUntil = () => Math.max(hostCooldownUntil, feedCooldownUntil);
    const mem = new Map(); // group -> { at: epochMs, body: string }
    const inflight = new Map(); // group -> Promise<{at, body}|null>
    const diskPath = (group) => path.join(CACHE_DIR, feed.diskName(group));

    async function readDisk(group) {
      try {
        const parsed = JSON.parse(await fsp.readFile(diskPath(group), 'utf8'));
        if (typeof parsed?.body === 'string' && Number.isFinite(parsed?.at))
          return parsed;
      } catch {
        /* no disk cache yet */
      }
      return null;
    }

    async function writeDisk(group, entry) {
      try {
        await fsp.mkdir(CACHE_DIR, { recursive: true });
        await fsp.writeFile(diskPath(group), JSON.stringify(entry), 'utf8');
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

    return async (req, res) => {
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
        let entry = mem.get(group);
        if (!entry) {
          entry = await readDisk(group);
          if (entry) mem.set(group, entry);
        }
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
  }

  const handlers = feeds.map((feed) => [feed.route, createFeedHandler(feed)]);
  const installMiddleware = (server) => {
    for (const [route, handler] of handlers)
      server.middlewares.use(route, handler);
  };
  return {
    name: 'celestrak-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
