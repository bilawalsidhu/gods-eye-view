import { createCountyLocationResolver } from './chesterCountyEms/locations.js';
import { readResponseBytesCapped } from './common/http.js';
import { parseWebCad } from './chesterCountyEms/parser.js';

export const WEBCAD_URL = 'https://webcad.chesco.org/WebCad/webcad.asp';
/** One shared, bounded, on-demand county feed; no archive or background polling. */
export function createChesterCountyFeed({
  fetchImpl = globalThis.fetch,
  now = Date.now,
  resolveLocation = createCountyLocationResolver({ fetchImpl, now }),
} = {}) {
  let cached, pending;
  let failed = false;
  let lastAttempt = -Infinity;
  async function request(url) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const signal = AbortSignal.timeout(6000);
      try {
        const response = await fetchImpl(url, { signal, redirect: 'error' });
        if (!response.ok) {
          await response.body?.cancel();
          const error = new Error('County source unavailable');
          error.retryable = [502, 503, 504].includes(response.status);
          throw error;
        }
        return new TextDecoder('windows-1252').decode(
          await readResponseBytesCapped(response, 512000, signal),
        );
      } catch (error) {
        const transient =
          error.retryable ||
          ['TypeError', 'AbortError', 'TimeoutError'].includes(error.name);
        if (attempt || !transient) throw error;
      }
    }
  }
  async function load() {
    lastAttempt = now();
    try {
      const snapshot = parseWebCad(await request(WEBCAD_URL));
      const located = [];
      let cursor = 0;
      const locationDeadline = AbortSignal.timeout(16000);
      await Promise.all(
        Array.from({ length: Math.min(4, snapshot.rows.length) }, async () => {
          while (cursor < snapshot.rows.length) {
            const index = cursor++;
            const row = snapshot.rows[index];
            let location;
            try {
              location = locationDeadline.aborted
                ? { position: null, status: 'unavailable' }
                : typeof resolveLocation.resolveDetailed === 'function'
                  ? await resolveLocation.resolveDetailed(row, {
                      signal: locationDeadline,
                    })
                  : await Promise.resolve(
                      resolveLocation(row, { signal: locationDeadline }),
                    ).then((position) => ({
                      position,
                      status: position ? 'matched' : 'unmatched',
                    }));
            } catch {
              location = { position: null, status: 'unavailable' };
            }
            located[index] = {
              ...row,
              mapPosition: location.position,
              locationStatus: location.status,
            };
          }
        }),
      );
      failed = false;
      cached = {
        ...snapshot,
        fetchedAt: now(),
        locationCoverage: {
          matched: located.filter((row) => row.locationStatus === 'matched')
            .length,
          unmatched: located.filter((row) => row.locationStatus === 'unmatched')
            .length,
          unavailable: located.filter(
            (row) => row.locationStatus === 'unavailable',
          ).length,
        },
        rows: located,
      };
      return {
        ...cached,
        stale:
          now() - cached.observedAt > 180000 ||
          cached.observedAt > now() + 60000,
      };
    } catch {
      failed = true;
      if (cached) return { ...cached, stale: true };
      throw new Error('Chester County incidents unavailable');
    }
  }
  return async () => {
    if (pending) return pending;
    if (now() - lastAttempt < 60000) {
      if (!cached) throw new Error('Chester County incidents unavailable');
      return {
        ...cached,
        stale:
          failed ||
          now() - cached.observedAt > 180000 ||
          cached.observedAt > now() + 60000,
      };
    }
    pending = load();
    try {
      return await pending;
    } finally {
      pending = null;
    }
  };
}

/** Install the same fixed endpoint in development and production preview. */
export function chesterCountyEmsProxy(options) {
  const acquire = createChesterCountyFeed(options);
  async function handler(req, res, next) {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/') return next();
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET') {
      res.statusCode = 405;
      res.setHeader('Allow', 'GET');
      return res.end('{}');
    }
    if (url.search) {
      res.statusCode = 400;
      return res.end('{}');
    }
    try {
      res.end(JSON.stringify(await acquire()));
    } catch {
      res.statusCode = 502;
      res.end(
        JSON.stringify({ error: 'Chester County incidents unavailable' }),
      );
    }
  }
  const install = ({ middlewares }) => {
    middlewares.use('/api/chester-county-ems', handler);
  };
  return {
    name: 'chester-county-ems',
    configureServer: install,
    configurePreviewServer: install,
  };
}
