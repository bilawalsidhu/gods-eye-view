import { lookup as lookupDns } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';

import { readResponseTextCapped } from '../common/http.js';
import { isPublicRadioAddress } from '../radio/transport.js';
import { cleanReceiverText } from '../../../src/sources/webReceivers.js';
import {
  mergeWebReceivers,
  normalizeKiwiSdrRows,
  normalizeReceiverbookSites,
} from './directory.js';
import {
  WEB_RECEIVERS_CACHE_MS,
  WEB_RECEIVERS_FETCH_TIMEOUT_MS,
  WEB_RECEIVERS_MIN_CATALOG,
  WEB_RECEIVERS_RESPONSE_MAX_BYTES,
  WEB_RECEIVERS_SOURCES,
  WEB_RECEIVERS_STALE_MS,
  WEB_RECEIVERS_USER_AGENT,
} from './constants.js';

/** Only the two registered directory URLs are ever fetched; nothing is client-supplied. */
function webReceiversDestination(value) {
  const href = String(value ?? '');
  return Object.values(WEB_RECEIVERS_SOURCES).includes(href)
    ? new URL(href)
    : null;
}

async function resolvePublicAddresses(hostname, lookupImpl) {
  const resolved = await lookupImpl(hostname, { all: true, verbatim: true });
  const rows = Array.isArray(resolved) ? resolved : [resolved];
  const addresses = rows
    .map((row) => ({
      address: String(row?.address || ''),
      family: Number(row?.family) || undefined,
    }))
    .filter((row) => row.address);
  if (
    !addresses.length ||
    addresses.some((row) => !isPublicRadioAddress(row.address))
  ) {
    throw new Error('Web receiver directory resolved to a forbidden address');
  }
  return addresses;
}

/** Fetch over the validated addresses only; the KiwiSDR feed is plain http. */
function fetchPinnedResponse(url, options, addresses) {
  const transport = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const address = addresses[0];
    const request = transport.request(
      url,
      {
        method: 'GET',
        headers: options.headers,
        signal: options.signal,
        lookup(_hostname, lookupOptions, callback) {
          if (lookupOptions?.all) callback(null, addresses);
          else callback(null, address.address, address.family);
        },
      },
      (response) => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (Array.isArray(value))
            value.forEach((item) => headers.append(name, item));
          else if (value !== undefined) headers.set(name, String(value));
        }
        resolve(
          new Response(Readable.toWeb(response), {
            status: response.statusCode || 500,
            statusText: response.statusMessage || '',
            headers,
          }),
        );
      },
    );
    request.on('error', reject);
    request.end();
  });
}

/** Create the testable Connect middleware backing `/api/web-receivers`. */
export function createWebReceiversProxyMiddleware({
  fetchImpl = null,
  lookupImpl = lookupDns,
  now = Date.now,
} = {}) {
  let catalogCache = null;
  let refreshPromise = null;

  async function fetchText(url) {
    const destination = webReceiversDestination(url);
    if (!destination)
      throw new Error('Web receiver directory destination is not permitted');
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      WEB_RECEIVERS_FETCH_TIMEOUT_MS,
    );
    try {
      const addresses = await resolvePublicAddresses(
        destination.hostname,
        lookupImpl,
      );
      const options = {
        headers: {
          Accept: 'text/html, application/javascript, text/plain',
          'User-Agent': WEB_RECEIVERS_USER_AGENT,
        },
        signal: controller.signal,
        redirect: 'manual',
      };
      const response = fetchImpl
        ? await fetchImpl(destination.href, options)
        : await fetchPinnedResponse(destination, options, addresses);
      if (response.status >= 300 && response.status < 400) {
        try {
          await response.body?.cancel?.();
        } catch {
          /* no-op */
        }
        throw new Error('Web receiver directory redirects are refused');
      }
      if (!response.ok)
        throw new Error(`Web receiver directory returned ${response.status}`);
      return readResponseTextCapped(response, WEB_RECEIVERS_RESPONSE_MAX_BYTES);
    } finally {
      clearTimeout(timer);
    }
  }

  async function refreshCatalog() {
    const [receiverbookOutcome, kiwiOutcome] = await Promise.allSettled([
      fetchText(WEB_RECEIVERS_SOURCES.receiverbook).then(
        normalizeReceiverbookSites,
      ),
      fetchText(WEB_RECEIVERS_SOURCES.kiwisdr).then(normalizeKiwiSdrRows),
    ]);
    const summarize = (outcome) =>
      outcome.status === 'fulfilled'
        ? { ok: true, count: outcome.value.length, error: null }
        : {
            ok: false,
            count: 0,
            error: cleanReceiverText(outcome.reason?.message, 200) || 'failed',
          };
    const sources = {
      receiverbook: summarize(receiverbookOutcome),
      kiwisdr: summarize(kiwiOutcome),
    };
    const receivers = mergeWebReceivers({
      receiverbook:
        receiverbookOutcome.status === 'fulfilled'
          ? receiverbookOutcome.value
          : [],
      kiwisdr: kiwiOutcome.status === 'fulfilled' ? kiwiOutcome.value : [],
    });
    if (receivers.length < WEB_RECEIVERS_MIN_CATALOG) {
      const error = new Error(
        `Web receiver directories answered with only ${receivers.length} receivers`,
      );
      error.webReceiversSources = sources;
      throw error;
    }
    catalogCache = {
      receivers,
      sources,
      degraded: !(sources.receiverbook.ok && sources.kiwisdr.ok),
      updatedAt: new Date(now()).toISOString(),
      cachedAt: now(),
    };
    return catalogCache;
  }

  async function getCatalog() {
    if (
      catalogCache &&
      now() - catalogCache.cachedAt < WEB_RECEIVERS_CACHE_MS
    ) {
      return { ...catalogCache, stale: false };
    }
    if (!refreshPromise)
      refreshPromise = refreshCatalog().finally(() => {
        refreshPromise = null;
      });
    try {
      return { ...(await refreshPromise), stale: false };
    } catch (error) {
      if (
        catalogCache &&
        now() - catalogCache.cachedAt <= WEB_RECEIVERS_STALE_MS
      ) {
        return {
          ...catalogCache,
          stale: true,
          degraded: true,
          degradedReason: cleanReceiverText(error?.message, 200),
        };
      }
      throw error;
    }
  }

  function sendJson(res, status, body) {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(body));
  }

  return async function webReceiversProxyMiddleware(req, res) {
    const requestUrl = new URL(req.url || '/', 'http://localhost');
    if (requestUrl.pathname !== '/catalog') {
      sendJson(res, 404, { error: 'Unknown web receiver route' });
      return;
    }
    if (req.method !== 'GET') {
      res.writeHead(405, { Allow: 'GET', 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    try {
      const catalog = await getCatalog();
      sendJson(res, 200, {
        receivers: catalog.receivers,
        updatedAt: catalog.updatedAt,
        stale: catalog.stale,
        degraded: Boolean(catalog.degraded),
        degradedReason: catalog.degradedReason || null,
        sources: catalog.sources,
      });
    } catch (error) {
      sendJson(res, 503, {
        error: 'Web receiver directory is temporarily unavailable',
        degraded: true,
        sources: error?.webReceiversSources || null,
      });
    }
  };
}
