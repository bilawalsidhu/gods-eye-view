/**
 * Electronic message signs (DMS / VMS boards).
 *
 *   GET /api/signs — active message signs with their currently posted text
 *
 * One layer, many agencies, in the shape the CCTV provider uses: adding an
 * agency is one entry in SIGN_PACKS plus its loader. Packs fail independently
 * and each has its own env kill switch.
 */
import { loadNe511Signs } from './messageSigns/ne511.js';

/** Refresh interval for the cached sign list. */
export const SIGNS_CACHE_MS = 60 * 1000;
/** Bounds one sign-face image fetch. */
export const SIGN_IMAGE_TIMEOUT_MS = 10 * 1000;
/** A sign face is a small PNG; anything larger is not one. */
export const SIGN_IMAGE_MAX_BYTES = 2 * 1024 * 1024;

/**
 * App-origin path for one sign's image page.
 *
 * The vendor URL never reaches the browser. Its bucket sends no
 * Access-Control-Allow-Origin, so a cross-origin texture load fails and the
 * board renders blank; and the client must not fetch third-party hosts
 * directly in any case.
 *
 * @param {string} signId
 * @param {number} pageIndex
 * @returns {string}
 */
export function signImagePath(signId, pageIndex) {
  return `/api/signs/image?sign=${encodeURIComponent(signId)}&page=${pageIndex}`;
}

/**
 * Serialize signs for the client, replacing vendor image URLs with app-origin
 * paths.
 *
 * @param {Array<object>} signs
 * @returns {Array<object>}
 */
export function serializeSigns(signs) {
  return signs.map((sign) => ({
    ...sign,
    views: sign.views.map((view, index) => ({
      ...view,
      imageUrl: view.imageUrl ? signImagePath(sign.id, index) : '',
    })),
  }));
}

/** Env kill switch: unset or anything but "0" means enabled. */
const envEnabled = (name) => String(process.env[name] || '1').trim() !== '0';

/**
 * Agency packs, in merge order. Each resolves normalized sign records.
 */
export const SIGN_PACKS = [
  {
    name: 'ne511',
    enabled: () => envEnabled('SIGNS_NE511_ENABLED'),
    load: loadNe511Signs,
  },
];

/**
 * Load every enabled pack, tolerating individual failures.
 *
 * @param {object} [options]
 * @param {Array} [options.packs]
 * @returns {Promise<Array<object>>} Normalized signs, deduplicated by id.
 */
export async function loadAllSigns({ packs = SIGN_PACKS } = {}) {
  const active = packs.filter((pack) => pack.enabled());
  const settled = await Promise.allSettled(active.map((pack) => pack.load()));
  const signs = [];
  for (const [index, result] of settled.entries()) {
    if (result.status === 'fulfilled' && Array.isArray(result.value)) {
      signs.push(...result.value);
      continue;
    }
    console.warn(
      `[Signs] pack ${active[index].name} failed:`,
      result.reason?.message || result.reason,
    );
  }
  return Array.from(new Map(signs.map((sign) => [sign.id, sign])).values());
}

/**
 * Vite plugin serving the message-sign route.
 *
 * @returns {{name:string, configureServer:Function, configurePreviewServer:Function}}
 */
export function messageSignsProxy({ cacheMs = SIGNS_CACHE_MS } = {}) {
  /** @type {{at:number, signs:Array<object>}|null} */
  let cache = null;
  /** @type {Promise<Array<object>>|null} */
  let inFlight = null;

  const getSigns = async () => {
    if (cache && Date.now() - cache.at < cacheMs) return cache.signs;
    // Collapse concurrent refreshes onto one upstream round.
    if (!inFlight) {
      inFlight = loadAllSigns()
        .then((signs) => {
          // Keep the last good list when a refresh comes back empty.
          cache =
            signs.length || !cache
              ? { at: Date.now(), signs }
              : { at: Date.now(), signs: cache.signs };
          return cache.signs;
        })
        .finally(() => {
          inFlight = null;
        });
    }
    return inFlight;
  };

  const installMiddleware = (server) => {
    server.middlewares.use('/api/signs', async (req, res) => {
      const url = new URL(req.url || '/', 'http://localhost');

      if (url.pathname === '/image') {
        const signId = url.searchParams.get('sign') || '';
        const page = Number(url.searchParams.get('page'));
        try {
          const signs = await getSigns();
          // Resolve the upstream URL from the cached catalog rather than from
          // the request, so only registered URLs are ever fetched.
          const upstream = signs.find((sign) => sign.id === signId)?.views?.[
            page
          ]?.imageUrl;
          if (!upstream) {
            res.writeHead(404, {
              'Content-Type': 'application/json',
              'Cache-Control': 'no-store',
            });
            res.end(JSON.stringify({ error: 'Unknown sign image' }));
            return;
          }
          const resp = await fetch(upstream, {
            redirect: 'manual',
            headers: { 'User-Agent': 'gods-eye-view-signs-proxy/1.0' },
            signal: AbortSignal.timeout(SIGN_IMAGE_TIMEOUT_MS),
          });
          if (!resp.ok) {
            res.writeHead(502, {
              'Content-Type': 'application/json',
              'Cache-Control': 'no-store',
            });
            res.end(JSON.stringify({ error: 'Sign image upstream declined' }));
            return;
          }
          const body = Buffer.from(await resp.arrayBuffer());
          if (body.length > SIGN_IMAGE_MAX_BYTES) {
            res.writeHead(502, {
              'Content-Type': 'application/json',
              'Cache-Control': 'no-store',
            });
            res.end(JSON.stringify({ error: 'Sign image too large' }));
            return;
          }
          // The bucket labels these application/octet-stream; the extension
          // was validated upstream, so serve the real media type.
          res.writeHead(200, {
            'Content-Type': 'image/png',
            'Content-Length': String(body.length),
            'Cache-Control': 'no-store',
          });
          res.end(body);
        } catch (error) {
          console.warn('[Signs] image proxy:', error?.message || String(error));
          res.writeHead(502, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          });
          res.end(JSON.stringify({ error: 'Sign image proxy error' }));
        }
        return;
      }

      if (url.pathname !== '/' && url.pathname !== '') {
        res.writeHead(404, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify({ error: 'Not found' }));
        return;
      }
      try {
        const signs = await getSigns();
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        // Each record carries its own provider and license, so a
        // mixed-agency response stays attributable per sign.
        res.end(JSON.stringify({ signs: serializeSigns(signs) }));
      } catch (error) {
        console.error('[Signs]', error?.message || String(error));
        res.writeHead(502, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify({ error: 'Message sign proxy error' }));
      }
    });
  };

  return {
    name: 'message-signs-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
