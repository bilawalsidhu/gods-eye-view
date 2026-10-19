import { readResponseTextCapped } from './common/http.js';
import {
  parseKiwiDirectoryScript,
  normalizeKiwiDirectory,
} from '../../src/sources/kiwisdr.js';

// One fixed upstream; clients can never choose a destination.
const DIRECTORY_URL = 'http://rx.linkfanel.net/kiwisdr_com.js';
const FRESH_MS = 10 * 60_000;
const STALE_MS = 6 * 60 * 60_000;
const RETRY_MS = 60_000;
const MAX_BYTES = 8 * 1024 * 1024;

/** Fixed-host KiwiSDR directory proxy: one shared, bounded, cached refresh. */
export function kiwiSdrDirectory({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  timeoutMs = 15_000,
} = {}) {
  let cache = null;
  let operation = null;
  let attemptedAt = -Infinity;

  async function refresh() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response;
      try {
        response = await fetchImpl(DIRECTORY_URL, {
          signal: controller.signal,
          redirect: 'error',
          headers: {
            Accept: 'text/javascript,*/*',
            'User-Agent': 'GodsEyeView/1.0 (KiwiSDR directory client)',
          },
        });
      } catch (cause) {
        // Network-level failure (DNS, refused, timeout, unexpected redirect).
        throw Object.assign(new Error('kiwisdr_fetch_failed'), { cause });
      }
      if (!response.ok) {
        await response.body?.cancel?.();
        throw new Error(`kiwisdr_upstream_http_${response.status}`);
      }
      const text = await readResponseTextCapped(
        response,
        MAX_BYTES,
        controller.signal,
      );
      const stations = normalizeKiwiDirectory(parseKiwiDirectoryScript(text));
      // A tiny result means the upstream is broken, not that the world's
      // receivers vanished; keep the last good snapshot instead.
      if (stations.length < 20)
        throw new Error('kiwisdr_directory_implausible');
      cache = { stations, fetchedAt: now() };
      return cache;
    } finally {
      clearTimeout(timer);
    }
  }

  async function acquire() {
    if (cache && now() - cache.fetchedAt < FRESH_MS) return cache;
    if (!operation) {
      if (now() - attemptedAt < RETRY_MS) {
        if (cache) return cache;
        throw new Error('kiwisdr_retry_later');
      }
      attemptedAt = now();
      operation = refresh().finally(() => {
        operation = null;
      });
    }
    try {
      return await operation;
    } catch (error) {
      if (cache && now() - cache.fetchedAt < STALE_MS) return cache;
      throw error;
    }
  }

  return async function kiwiSdrMiddleware(req, res, next) {
    if (req.url !== '/' && req.url !== '' && !req.url?.startsWith('/?'))
      return next ? next() : undefined;
    const send = (status, value, extra = {}) => {
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        ...extra,
      });
      res.end(JSON.stringify(value));
    };
    if (req.method !== 'GET') return send(405, { error: 'method_not_allowed' });
    try {
      const { stations, fetchedAt } = await acquire();
      send(200, {
        fetchedAt: new Date(fetchedAt).toISOString(),
        stations,
      });
    } catch (error) {
      const code = String(error?.message || '');
      // A short, fixed-vocabulary reason for the UI; the full detail only
      // goes to the server log, never to the browser.
      const reason = /^kiwisdr_[a-z0-9_]+$/.test(code)
        ? code
        : 'kiwisdr_unavailable';
      if (code !== 'kiwisdr_retry_later') {
        const cause = error?.cause;
        console.warn(
          `[kiwisdr] directory refresh failed (${reason})`,
          cause?.cause?.code || cause?.code || cause?.message || '',
        );
      }
      send(502, { error: 'kiwisdr_unavailable', reason });
    }
  };
}

/** Vite plugin installing `/api/kiwisdr` on dev and preview servers. */
export function kiwiSdrProxy(options) {
  const middleware = kiwiSdrDirectory(options);
  const install = (server) => {
    server.middlewares.use('/api/kiwisdr', middleware);
  };
  return {
    name: 'kiwisdr-proxy',
    configureServer: install,
    configurePreviewServer: install,
  };
}
