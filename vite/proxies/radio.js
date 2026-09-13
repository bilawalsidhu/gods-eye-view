/**
 * Radio Browser directory proxy (`/api/radio`).
 *
 * Extracted verbatim from vite.config.js (Batch 4, PLAN.md) so each
 * endpoint can be unit-tested in isolation; vite.config.js assembles the
 * plugin list from these modules.
 */

import https from 'node:https';
import { Readable } from 'node:stream';
import { createRadioCatalogBroker, isPublicRadioAddress } from '../../functions/api/radio/_broker.js';
import { lookup as lookupDns } from 'node:dns/promises';

// ---------------------------------------------------------------------------
// Radio Browser directory proxy
// ---------------------------------------------------------------------------
export async function resolveRadioProxyAddresses(hostname, lookupImpl) {
  const resolved = await lookupImpl(hostname, { all: true, verbatim: true });
  const rows = Array.isArray(resolved) ? resolved : [resolved];
  const addresses = rows
    .map((row) => ({ address: String(row?.address || ''), family: Number(row?.family) || undefined }))
    .filter((row) => row.address);
  if (!addresses.length || addresses.some((row) => !isPublicRadioAddress(row.address))) {
    throw new Error('Radio Browser resolved to a forbidden address');
  }
  return addresses;
}

export function fetchPinnedRadioResponse(url, options, addresses) {
  return new Promise((resolve, reject) => {
    const address = addresses[0];
    const request = https.request(url, {
      method: 'GET',
      headers: options.headers,
      signal: options.signal,
      lookup(_hostname, lookupOptions, callback) {
        if (lookupOptions?.all) callback(null, addresses);
        else callback(null, address.address, address.family);
      },
    }, (response) => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(response.headers)) {
        if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
        else if (value !== undefined) headers.set(name, String(value));
      }
      resolve(new Response(Readable.toWeb(response), {
        status: response.statusCode || 500,
        statusText: response.statusMessage || '',
        headers,
      }));
    });
    request.on('error', reject);
    request.end();
  });
}

/**
 * The Connect middleware backing `/api/radio`. All destination policy,
 * catalog refresh, health-gate and served-station logic lives in the shared
 * worker-safe broker (`functions/api/radio/_broker.js`) so the Pages Function
 * (`functions/api/radio/[[path]].js`) and this middleware cannot drift. The
 * dev-only DNS resolution + TLS pinning is injected here as the transport.
 *
 * @param {object} [options]
 * @param {(url: string, options: {headers: object, signal: AbortSignal, redirect: 'manual'}) => Promise<Response>} [options.fetchImpl]
 *   Test double standing in for the whole transport (URL string form).
 * @param {typeof lookupDns} [options.lookupImpl] Test double for DNS.
 * @param {() => number} [options.now] Clock injection for tests.
 */
export function createRadioProxyMiddleware({ fetchImpl = null, lookupImpl = lookupDns, now = Date.now } = {}) {
  const broker = createRadioCatalogBroker({
    now,
    transport: async (destination, options) => {
      // Resolve and validate every mirror address BEFORE connecting, then pin
      // the TLS session to the validated address. An injected fetchImpl still
      // passes the address policy check first — the tests pin that ordering.
      const addresses = await resolveRadioProxyAddresses(destination.hostname, lookupImpl);
      return fetchImpl
        ? fetchImpl(destination.href, options)
        : fetchPinnedRadioResponse(destination, options, addresses);
    },
  });

  function sendJson(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  return async function radioProxyMiddleware(req, res) {
    const requestUrl = new URL(req.url || '/', 'http://localhost');
    if (requestUrl.pathname === '/stations') {
      if (req.method !== 'GET') {
        res.writeHead(405, { Allow: 'GET', 'Cache-Control': 'no-store' });
        res.end();
        return;
      }
      try {
        sendJson(res, 200, await broker.catalogResponseBody());
      } catch (error) {
        sendJson(res, 503, {
          error: 'Radio directory is temporarily unavailable',
          degraded: Boolean(error?.radioCatalogDegraded),
          degradedReason: error?.radioDegradedReason || null,
        });
      }
      return;
    }

    const clickMatch = requestUrl.pathname.match(/^\/click\/([0-9a-f-]+)$/i);
    if (clickMatch) {
      if (req.method !== 'POST') {
        res.writeHead(405, { Allow: 'POST', 'Cache-Control': 'no-store' });
        res.end();
        return;
      }
      const id = clickMatch[1].toLowerCase();
      if (!broker.isServedStation(id)) {
        sendJson(res, 404, { error: 'Unknown radio station' });
        return;
      }
      res.writeHead(204, { 'Cache-Control': 'no-store' });
      res.end();
      broker.pingStation(id);
      return;
    }

    sendJson(res, 404, { error: 'Unknown radio route' });
  };
}

export function radioBrowserProxy() {
  const middleware = createRadioProxyMiddleware();
  const install = (server) => {
    server.middlewares.use('/api/radio', middleware);
  };
  return {
    name: 'radio-browser-proxy',
    configureServer: install,
    configurePreviewServer: install,
  };
}
