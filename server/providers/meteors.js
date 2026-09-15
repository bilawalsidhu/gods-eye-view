import { readResponseTextCapped } from './common/http.js';
import {
  GMN_SUMMARY_URL,
  parseGmnSummary,
} from '../../src/layers/meteors/records.js';

const TTL_MS = 6 * 60 * 60 * 1000;

/** Fixed public upstream, bounded downloads, shared refresh and explicit stale-cache fallback. */
export function createMeteorProvider({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = Date.now,
} = {}) {
  let cache = null;
  let pending = null;
  let retryAfter = 0;
  async function refresh() {
    try {
      const signal = AbortSignal.timeout(25000);
      const response = await fetchImpl(GMN_SUMMARY_URL, {
        signal,
        redirect: 'error',
      });
      if (!response.ok) throw new Error('GMN unavailable');
      const text = await readResponseTextCapped(
        response,
        64 * 1024 * 1024,
        signal,
      );
      const result = parseGmnSummary(text);
      cache = { ...result, fetchedAt: now() };
      retryAfter = 0;
      return cache;
    } catch {
      retryAfter = now() + 60000;
      return null;
    } finally {
      pending = null;
    }
  }
  return {
    async getSnapshot() {
      let failed = false;
      if (!cache || now() - cache.fetchedAt >= TTL_MS) {
        if (now() < retryAfter) failed = true;
        else {
          if (!pending) pending = refresh();
          failed = !(await pending);
        }
      }
      if (!cache) throw new Error('Meteor data temporarily unavailable');
      return {
        ...cache,
        stale: failed || now() - cache.generatedAt > 24 * 60 * 60 * 1000,
        source: 'Global Meteor Network',
        license: 'CC BY 4.0',
        sourceUrl: GMN_SUMMARY_URL,
      };
    },
  };
}

/** Serve the same meteor route in development and built preview. */
export function meteorsProxy(options) {
  const provider = createMeteorProvider(options);
  const install = (server) => {
    server.middlewares.use('/api/meteors', async (req, res) => {
      const send = (status, body) => {
        res.writeHead(status, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify(body));
      };
      if (!['', '/'].includes(req.url || ''))
        return send(404, { error: 'Unknown meteor route' });
      if (req.method !== 'GET')
        return send(405, { error: 'Method not allowed' });
      try {
        send(200, await provider.getSnapshot());
      } catch {
        send(502, { error: 'Meteor data temporarily unavailable' });
      }
    });
  };
  return {
    name: 'meteors-proxy',
    configureServer: install,
    configurePreviewServer: install,
  };
}
