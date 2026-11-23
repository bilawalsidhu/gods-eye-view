import { coalesceProxyRequest } from './common/http.js';
import { fetchLocalReceiverDocument } from './local-receivers.js';
import { parseTapAddress } from '../../src/data/tapAddress.js';
import { normalizeAisCatcherShips } from '../../src/sources/aisCatcherRecords.js';

export const LOCAL_AIS_ROUTE = '/api/local-receivers/vessels';
const MAX_FEEDS = 4;
const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;
const CACHE_MS = 2000;
const LOG_PREFIX = '[local-ais]';

/**
 * Operator-owned AIS-catcher URLs. No browser-selected host, userinfo, query,
 * fragment, redirect, public address, or cloud metadata endpoint is allowed.
 */
export function parseLocalAisFeeds(value) {
  const entries = String(value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const feeds = entries.map((raw, index) => {
    const feed = {
      id: `feed-${index + 1}`,
      label: `AIS receiver ${index + 1}`,
    };
    if (index >= MAX_FEEDS) return { ...feed, reason: 'too many feeds' };
    let url;
    try {
      url = new URL(raw);
    } catch {
      return { ...feed, reason: 'invalid URL' };
    }
    if (!['http:', 'https:'].includes(url.protocol))
      return { ...feed, reason: 'only HTTP(S) is supported' };
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      /[?#]/.test(raw)
    )
      return {
        ...feed,
        reason: 'URL credentials and parameters are forbidden',
      };
    // Both documented AIS-catcher v0 endpoints contain the same ships[] shape.
    if (!/^\/(?:api\/)?ships\.json$/.test(url.pathname))
      return { ...feed, reason: 'expected /ships.json or /api/ships.json' };
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    const address = parseTapAddress(`${url.hostname}:${port}`);
    if (!address)
      return {
        ...feed,
        reason: 'only loopback or RFC1918/local receiver hosts are allowed',
      };
    return {
      ...feed,
      url: `${url.protocol}//${address.host}:${address.port}${url.pathname}`,
    };
  });
  return { configured: entries.length > 0, feeds };
}

/** AIS-catcher's envelope `error`: any value other than absent or false. */
function receiverReportsError(value) {
  if (value === undefined || value === null || value === false) return false;
  if (typeof value === 'string')
    return !['', '0', 'false'].includes(value.trim().toLowerCase());
  if (typeof value === 'number') return value !== 0;
  return true;
}

/** Same-origin proxy with bounded, pinned local HTTP and no remote station disclosure. */
export function createLocalAisHandler({
  feedsValue = process.env.LOCAL_AIS_FEEDS,
  now = Date.now,
  fetchImpl,
  lookupImpl,
  logger = console,
  cacheMs = CACHE_MS,
} = {}) {
  const config = parseLocalAisFeeds(feedsValue);
  for (const feed of config.feeds)
    if (feed.reason)
      logger.warn?.(`${LOG_PREFIX} ${feed.label}: ${feed.reason}`);
  const inFlight = new Map();
  let cached = null;
  // Log a feed only when its status changes, so a dead receiver does not write
  // a line every poll. Error codes are kept; hostnames and ports are not.
  const lastStatus = new Map();
  const log = (feed, status, code) => {
    if (lastStatus.get(feed.label) === status) return;
    lastStatus.set(feed.label, status);
    if (status === 'live') logger.info?.(`${LOG_PREFIX} ${feed.label} live`);
    else
      logger.warn?.(
        `${LOG_PREFIX} ${feed.label} ${status === 'rejected' ? 'stale' : status}${code ? ` (${code})` : ''}`,
      );
  };

  async function readFeed(feed) {
    const summary = {
      label: feed.label,
      count: 0,
      dropped: 0,
      rejected: 0,
      filtered: 0,
      heardAt: null,
      newestAt: null,
    };
    if (!feed.url)
      return { status: { ...summary, status: 'invalid' }, records: [] };
    let document;
    try {
      document = await fetchLocalReceiverDocument(feed.url, {
        documentKey: 'ships',
        maxBytes: MAX_DOCUMENT_BYTES,
        timeoutMs: 3000,
        ...(fetchImpl ? { fetchImpl } : {}),
        ...(lookupImpl ? { lookupImpl } : {}),
      });
    } catch (error) {
      // No hostnames, ports, station coordinates or receiver identifiers are
      // copied into browser-facing error responses.
      log(feed, 'unreachable', error?.code);
      return { status: { ...summary, status: 'unreachable' }, records: [] };
    }
    // A receiver that reports an error gives no usable observations, however
    // many rows the document still carries.
    if (receiverReportsError(document.error)) {
      log(feed, 'unreachable', 'RECEIVER_ERROR');
      return { status: { ...summary, status: 'unreachable' }, records: [] };
    }
    const { records, dropped, rejected, filtered, newestSignalAt } =
      normalizeAisCatcherShips(document, now());
    // Live means at least one vessel was heard in the last ten minutes. An
    // empty list, or a list of only old rows, is a receiver that hears
    // nothing, which the operator must see as stale and not as healthy.
    const status = records.length > 0 ? 'live' : 'stale';
    // A quiet receiver that is also sending rows we reject must read as
    // rejected, not as silent. Base stations and aids to navigation, which are
    // left out by design, never count. The state is part of the log key, so
    // the line is written when a feed enters it, from any state, and not on
    // every poll.
    const rejecting = status === 'stale' && rejected > 0;
    log(
      feed,
      rejecting ? 'rejected' : status,
      rejecting
        ? `ROWS_REJECTED, ${rejected} refused`
        : status === 'stale'
          ? 'NO_RECENT_MESSAGES'
          : undefined,
    );
    return {
      status: {
        ...summary,
        status,
        count: records.length,
        dropped,
        rejected,
        filtered,
        heardAt: newestSignalAt,
        // The newest vessel or beacon the feed still holds, so the browser can
        // tell a feed that is live now from one whose only row has since aged
        // out.
        newestAt: records.length
          ? Math.max(...records.map((record) => record.lastSeenAt))
          : null,
      },
      records,
    };
  }

  async function snapshot() {
    const results = await Promise.all(config.feeds.map(readFeed));
    const seen = new Map();
    for (const result of results)
      for (const record of result.records) {
        const existing = seen.get(record.mmsi);
        if (!existing || record.lastSeenAt > existing.lastSeenAt)
          seen.set(record.mmsi, record);
      }
    return {
      configured: true,
      generatedAt: now(),
      feeds: results.map((result) => result.status),
      records: [...seen.values()],
    };
  }

  async function payload() {
    if (!config.configured)
      return { configured: false, feeds: [], records: [] };
    if (cached && now() - cached.at < cacheMs) return cached.body;
    const { promise } = coalesceProxyRequest(inFlight, 'ais', snapshot);
    const body = await promise;
    cached = { at: now(), body };
    return body;
  }

  async function handle(req, res) {
    if (req.headers?.['sec-fetch-site'] === 'cross-site') {
      res.writeHead(403, { 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    try {
      const result = await payload();
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify(result));
    } catch {
      res.writeHead(502, { 'Cache-Control': 'no-store' });
      res.end();
    }
  }
  return { config, handle };
}

/** Vite server/preview plug-in; an unconfigured installation makes no reads. */
export function localAisProxy(options = {}) {
  const install = (server) => {
    const { handle } = createLocalAisHandler(options);
    server.middlewares.use(LOCAL_AIS_ROUTE, (req, res, next) => {
      const path = new URL(req.url || '/', 'http://localhost').pathname;
      if (path !== '/' && path !== '') return next?.();
      return handle(req, res);
    });
  };
  return {
    name: 'local-ais-proxy',
    configureServer: install,
    configurePreviewServer: install,
  };
}
