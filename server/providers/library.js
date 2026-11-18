import { LIBRARY_ENTRIES } from '../../src/library/catalog.js';
import { createLibraryHandler } from '../../src/library/proxy.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';
import { admitSameSite, admitSameSiteKeyless } from './common/same-site.js';

export {
  libraryAvailability,
  libraryKeyValue,
  parseLibraryTilePath,
} from '../../src/library/proxy.js';

/** `content-type` as `Content-Type`: a fetch Response's names, as Node writes them. */
const headerName = (name) =>
  name.replace(
    /(^|-)([a-z])/g,
    (_, dash, letter) => dash + letter.toUpperCase(),
  );

/**
 * The Data Library's one server route on the dev and preview servers: the
 * portable handler (`src/library/proxy.js`) behind this server's same-site
 * gate and rate limits.
 */
export function libraryProxy({
  entries = LIBRARY_ENTRIES,
  env = process.env,
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const handle = createLibraryHandler({ entries, env, fetchImpl, now });
  const allowData = makeRateLimiter({
    windowMs: 60_000,
    max: 30,
    globalMax: 600,
  });
  const allowTiles = makeRateLimiter({
    windowMs: 60_000,
    max: 600,
    globalMax: 6000,
  });

  function refuse(res, status, error) {
    if (res.destroyed) return;
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...(status === 405 ? { Allow: 'GET' } : {}),
      ...(status === 429 ? { 'Retry-After': '60' } : {}),
    });
    res.end(JSON.stringify({ error }));
  }

  async function handler(req, res) {
    if (req.method !== 'GET') return refuse(res, 405, 'method_not_allowed');
    const path = (req.url || '/').split('?')[0];
    const [route, id] = path.split('/').filter(Boolean);
    const entry = byId.get(id);
    if (route === 'catalog' || !entry) {
      if (admitSameSiteKeyless(req, res)) return undefined;
    } else {
      // A keyed entry spends the operator's credential: refuse forwarded
      // requests like the other cost-bearing routes. Keyless entries keep
      // working behind a reverse proxy, like terrain heights.
      if (
        entry.source?.key
          ? admitSameSite(req, res)
          : admitSameSiteKeyless(req, res)
      )
        return undefined;
      const allow = route === 'tile' ? allowTiles : allowData;
      if (!allow(clientKey(req))) return refuse(res, 429, 'rate_limited');
    }
    const response = await handle(
      new Request(`http://library.invalid/api/library${req.url || '/'}`, {
        headers: { Accept: String(req.headers?.accept || '*/*') },
      }),
    );
    if (res.destroyed) return undefined;
    const headers = {};
    for (const [name, value] of response.headers)
      headers[headerName(name)] = value;
    const body = Buffer.from(await response.arrayBuffer());
    res.writeHead(response.status, headers);
    res.end(
      String(headers['Content-Type']).startsWith('application/json')
        ? body.toString('utf8')
        : body,
    );
    return undefined;
  }

  return {
    name: 'data-library',
    handler,
    configureServer({ middlewares }) {
      middlewares.use('/api/library', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/library', handler);
    },
  };
}
