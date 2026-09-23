import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import { coalesceProxyRequest, readResponseTextCapped } from './common/http.js';
import { isLocalIpv4, parseTapAddress } from '../../src/data/tapAddress.js';
import { normalizeDump1090Aircraft } from '../../src/sources/adsbRecords.js';

/**
 * Local decoder feeds for the Local ADS-B layer.
 *
 * A user who runs dump1090 / readsb / tar1090 (1090 MHz) or dump978-fa +
 * skyaware978 (978 MHz UAT) exposes an `aircraft.json` over HTTP. This route
 * reads those documents and returns them as Local ADS-B records.
 *
 * The feed list comes only from the operator's `LOCAL_RECEIVER_FEEDS`
 * environment value; the browser never supplies an address. Every host must
 * pass the shared receiver-tap address rule (`src/data/tapAddress.js`:
 * loopback, RFC1918, `localhost`, `*.local`), the scheme must be http(s) and
 * the path must end in `aircraft.json`. Invalid entries are logged at startup,
 * reported as `invalid` and never fetched.
 *
 * A name (`localhost`, `*.local`) is resolved before every read; each address
 * it resolves to must itself be loopback or RFC1918, and the connection is
 * pinned to exactly those validated addresses, so a later re-resolution
 * cannot redirect it anywhere else.
 */

export const LOCAL_RECEIVERS_ROUTE = '/api/local-receivers/aircraft';
export const LOCAL_RECEIVER_FEEDS_ENV = 'LOCAL_RECEIVER_FEEDS';
export const LOCAL_RECEIVER_BANDS = Object.freeze(['1090', '978']);
export const LOCAL_RECEIVER_TIMEOUT_MS = 2_000;
export const LOCAL_RECEIVER_MAX_BODY_BYTES = 2 * 1024 * 1024;
export const LOCAL_RECEIVER_CACHE_MS = 1_000;
/** A feed whose own `now` is older than this is reported stale. */
export const LOCAL_RECEIVER_STALE_MS = 10_000;
const MAX_FEEDS = 8;
const LOG_PREFIX = '[local-receivers]';

const BAND_LABELS = Object.freeze({ 1090: '1090 MHz', 978: '978 MHz UAT' });

function defaultPort(protocol) {
  return protocol === 'https:' ? 443 : 80;
}

/**
 * Validate one `band=url` entry.
 * @param {string} entry Raw entry text.
 * @returns {{band:string, url:string}|{band:string|null, reason:string}}
 */
function parseEntry(entry) {
  const separator = entry.indexOf('=');
  if (separator <= 0) return { band: null, reason: 'expected band=url' };
  const band = entry.slice(0, separator).trim();
  const rawUrl = entry.slice(separator + 1).trim();
  if (!LOCAL_RECEIVER_BANDS.includes(band))
    return { band: null, reason: 'band must be 1090 or 978' };
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return { band, reason: 'not a valid URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    return { band, reason: 'scheme must be http or https' };
  if (url.username || url.password)
    return { band, reason: 'credentials are not allowed in the URL' };
  if (url.search || url.hash || rawUrl.includes('?') || rawUrl.includes('#'))
    return { band, reason: 'query and fragment are not allowed' };
  const port = url.port ? Number(url.port) : defaultPort(url.protocol);
  const address = parseTapAddress(`${url.hostname}:${port}`);
  if (!address)
    return {
      band,
      reason: 'host must be loopback, RFC1918, localhost or *.local',
    };
  if (!/(?:^|\/)aircraft\.json$/.test(url.pathname))
    return { band, reason: 'path must end in aircraft.json' };
  return {
    band,
    url: `${url.protocol}//${address.host}:${address.port}${url.pathname}`,
  };
}

/**
 * Parse `LOCAL_RECEIVER_FEEDS` (`band=url[,band=url…]`).
 *
 * Labels name the band only (plus an ordinal when a band repeats), so feed
 * addresses never reach the browser.
 * @param {string|undefined} value Environment value.
 * @returns {{configured:boolean, feeds:object[]}} Each feed is
 *   `{ id, band, label, url }` when valid or `{ id, band, label, reason }`
 *   when invalid (never fetched).
 */
export function parseLocalReceiverFeeds(value) {
  const entries = String(value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  const feeds = [];
  const perBand = new Map();
  entries.forEach((entry, index) => {
    const parsed =
      index < MAX_FEEDS
        ? parseEntry(entry)
        : { band: null, reason: `at most ${MAX_FEEDS} feeds are read` };
    const band = parsed.band;
    const ordinal = (perBand.get(band) || 0) + 1;
    perBand.set(band, ordinal);
    const base = band ? BAND_LABELS[band] : `entry ${index + 1}`;
    const label = band && ordinal > 1 ? `${base} #${ordinal}` : base;
    feeds.push({
      id: `feed-${index + 1}`,
      band,
      label,
      ...(parsed.url ? { url: parsed.url } : { reason: parsed.reason }),
    });
  });
  // Ordinals are only needed when a band actually repeats.
  for (const feed of feeds) {
    if (feed.band && perBand.get(feed.band) > 1 && !feed.label.includes('#'))
      feed.label = `${feed.label} #1`;
  }
  return { configured: feeds.length > 0, feeds };
}

class FeedError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

/**
 * Whether a resolved address satisfies the receiver-tap rule: loopback or
 * RFC1918 IPv4, the IPv6 loopback, or an IPv4-mapped form of the former.
 * @param {string} address Resolved IP address.
 * @returns {boolean}
 */
export function isLocalReceiverAddress(address) {
  const value = String(address || '').toLowerCase();
  if (value === '::1') return true;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(value);
  return isLocalIpv4(mapped ? mapped[1] : value);
}

/**
 * Resolve a feed host name and require every address to be local.
 * @param {string} hostname `localhost` or a `*.local` name.
 * @param {typeof dnsLookup} lookupImpl `dns.promises.lookup`-compatible.
 * @returns {Promise<Array<{address:string, family:number}>>}
 */
export async function resolveLocalReceiverAddresses(hostname, lookupImpl) {
  let resolved;
  try {
    resolved = await lookupImpl(hostname, { all: true, verbatim: true });
  } catch {
    throw new FeedError('UNRESOLVED');
  }
  const addresses = (Array.isArray(resolved) ? resolved : [resolved])
    .map((row) => ({
      address: String(row?.address || ''),
      family: Number(row?.family) || (String(row?.address).includes(':') ? 6 : 4),
    }))
    .filter((row) => row.address);
  if (!addresses.length) throw new FeedError('UNRESOLVED');
  if (addresses.some((row) => !isLocalReceiverAddress(row.address)))
    throw new FeedError('FORBIDDEN_ADDRESS');
  return addresses;
}

/** A `net`-style lookup that only ever answers the validated addresses. */
function pinnedLookup(addresses) {
  return (_hostname, options, callback) => {
    const done = typeof options === 'function' ? options : callback;
    if (options?.all) done(null, addresses.map((row) => ({ ...row })));
    else done(null, addresses[0].address, addresses[0].family);
  };
}

/**
 * Default transport. With `options.lookup` (a pinned feed name) the request
 * is made with node:http(s) so the socket connects only to the validated
 * addresses (TLS still verifies the name); otherwise it is a plain fetch of
 * an IP-literal URL. Redirects are never followed either way.
 * @param {string} url
 * @param {object} options
 * @returns {Promise<Response>}
 */
function fetchLocalReceiverFeed(url, options) {
  if (typeof options?.lookup !== 'function') return fetch(url, options);
  const client = new URL(url).protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = client.request(
      url,
      {
        method: 'GET',
        headers: options.headers,
        signal: options.signal,
        lookup: options.lookup,
        // A fresh socket per read: a pooled one could outlive the pin.
        agent: false,
      },
      (response) => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (Array.isArray(value))
            value.forEach((item) => headers.append(name, item));
          else if (value !== undefined) headers.set(name, String(value));
        }
        const status = response.statusCode || 500;
        resolve(
          new Response(
            status === 204 || status === 304 ? null : Readable.toWeb(response),
            { status, statusText: response.statusMessage || '', headers },
          ),
        );
      },
    );
    request.on('error', reject);
    request.end();
  });
}

/**
 * Fetch one validated feed document without following redirects and with the
 * body cap enforced while it streams.
 * @param {string} url Validated feed URL.
 * @param {object} options
 * @returns {Promise<object>} Parsed JSON document.
 */
export async function fetchLocalReceiverDocument(
  url,
  {
    fetchImpl = fetchLocalReceiverFeed,
    lookupImpl = dnsLookup,
    timeoutMs = LOCAL_RECEIVER_TIMEOUT_MS,
    maxBytes = LOCAL_RECEIVER_MAX_BODY_BYTES,
  } = {},
) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  let upstream;
  try {
    const { hostname } = new URL(url);
    // IP literals were validated when the feed list was parsed; a name is
    // validated by what it resolves to now, and the socket is pinned there.
    const lookup = isLocalIpv4(hostname)
      ? undefined
      : pinnedLookup(await resolveLocalReceiverAddresses(hostname, lookupImpl));
    upstream = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      redirect: 'manual',
      signal: controller.signal,
      ...(lookup ? { lookup } : {}),
    });
    if (upstream.status >= 300 && upstream.status < 400)
      throw new FeedError('REDIRECT_REFUSED');
    // Opaque redirect responses from `redirect: 'manual'` report status 0.
    if (upstream.type === 'opaqueredirect')
      throw new FeedError('REDIRECT_REFUSED');
    if (!upstream.ok) throw new FeedError('HTTP_STATUS');
    const text = await readResponseTextCapped(
      upstream,
      maxBytes,
      controller.signal,
    );
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new FeedError('BAD_JSON');
    }
    if (!json || typeof json !== 'object' || !Array.isArray(json.aircraft))
      throw new FeedError('BAD_DOCUMENT');
    return json;
  } catch (error) {
    controller.abort();
    if (upstream?.body && !upstream.body.locked)
      void upstream.body.cancel().catch(() => {});
    if (error instanceof FeedError) throw error;
    if (error?.code === 'RESPONSE_TOO_LARGE')
      throw new FeedError('RESPONSE_TOO_LARGE');
    if (error?.name === 'AbortError' || controller.signal.aborted)
      throw new FeedError('TIMEOUT');
    throw new FeedError('UNREACHABLE');
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Read one feed and describe it.
 * @returns {Promise<{status:object, records:object[]}>}
 */
async function readFeed(
  feed,
  { fetchImpl, lookupImpl, now, timeoutMs, maxBytes, log },
) {
  const summary = { band: feed.band, label: feed.label };
  if (!feed.url)
    return {
      status: { ...summary, status: 'invalid', aircraft: 0, ageMs: null },
      records: [],
    };
  let json;
  try {
    json = await fetchLocalReceiverDocument(feed.url, {
      fetchImpl,
      lookupImpl,
      timeoutMs,
      maxBytes,
    });
  } catch (error) {
    log(feed, 'unreachable', error.code);
    return {
      status: { ...summary, status: 'unreachable', aircraft: 0, ageMs: null },
      records: [],
    };
  }
  const receivedAt = now();
  const feedNowS = Number(json.now);
  // The feed's own clock decides staleness. A clock ahead of ours reads as
  // age 0; a document without `now` is treated as current.
  const ageMs = Number.isFinite(feedNowS)
    ? Math.max(0, Math.round(receivedAt - feedNowS * 1000))
    : 0;
  const status = ageMs > LOCAL_RECEIVER_STALE_MS ? 'stale' : 'live';
  log(feed, status);
  // Anchor record ages at the document time so a stale feed ages out
  // naturally, without trusting a receiver clock that runs ahead of ours.
  const records = normalizeDump1090Aircraft(json, receivedAt - ageMs, {
    band: feed.band,
  });
  return {
    status: { ...summary, status, aircraft: records.length, ageMs },
    records,
  };
}

/**
 * Build the route handler. Exposed for tests; the plugin wraps it.
 * @param {object} [options]
 * @param {string} [options.feedsValue] `LOCAL_RECEIVER_FEEDS` value.
 * @param {typeof fetch} [options.fetchImpl] Receives `options.lookup` when
 *   the feed host is a name; the connection must resolve only through it.
 * @param {Function} [options.lookupImpl] `dns.promises.lookup`-compatible.
 * @param {() => number} [options.now]
 * @param {{warn:Function, info?:Function}} [options.logger]
 * @returns {{handle:Function, config:object}}
 */
export function createLocalReceiversHandler({
  feedsValue = process.env[LOCAL_RECEIVER_FEEDS_ENV],
  fetchImpl = fetchLocalReceiverFeed,
  lookupImpl = dnsLookup,
  now = Date.now,
  logger = console,
  timeoutMs = LOCAL_RECEIVER_TIMEOUT_MS,
  maxBytes = LOCAL_RECEIVER_MAX_BODY_BYTES,
  cacheMs = LOCAL_RECEIVER_CACHE_MS,
} = {}) {
  const config = parseLocalReceiverFeeds(feedsValue);
  for (const feed of config.feeds) {
    if (feed.reason)
      logger.warn(
        `${LOG_PREFIX} ${LOCAL_RECEIVER_FEEDS_ENV} ${feed.id} (${feed.label}) rejected: ${feed.reason}. It will not be fetched.`,
      );
  }
  const lastStatus = new Map();
  // Log a feed only when its status changes, so a feed that is down does not
  // write a line every second.
  const log = (feed, status, code) => {
    if (lastStatus.get(feed.id) === status) return;
    lastStatus.set(feed.id, status);
    if (status === 'live') logger.info?.(`${LOG_PREFIX} ${feed.label} live`);
    else
      logger.warn(
        `${LOG_PREFIX} ${feed.label} ${status}${code ? ` (${code})` : ''}`,
      );
  };
  const inFlight = new Map();
  let cached = null;

  async function snapshot() {
    const results = await Promise.all(
      config.feeds.map((feed) =>
        readFeed(feed, {
          fetchImpl,
          lookupImpl,
          now,
          timeoutMs,
          maxBytes,
          log,
        }),
      ),
    );
    return {
      configured: true,
      generatedAt: now(),
      feeds: results.map((result) => result.status),
      records: results.flatMap((result) => result.records),
    };
  }

  async function payload() {
    if (!config.configured)
      return { configured: false, feeds: [], records: [] };
    if (cached && now() - cached.at < cacheMs) return cached.payload;
    const { promise } = coalesceProxyRequest(inFlight, 'all', snapshot);
    const result = await promise;
    cached = { at: now(), payload: result };
    return result;
  }

  async function handle(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify({ error: 'Method Not Allowed' }));
      return;
    }
    try {
      const body = await payload();
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify(body));
    } catch {
      res.writeHead(502, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify({ error: 'Local receiver feeds unavailable' }));
    }
  }

  return { handle, config };
}

/**
 * Vite plugin mounting `GET /api/local-receivers/aircraft`.
 *
 * The environment is read when the server starts, so construction alone
 * neither parses configuration nor fetches anything.
 * @param {object} [options] Passed to {@link createLocalReceiversHandler}.
 * @returns {import('vite').Plugin}
 */
export function localReceiversProxy(options = {}) {
  const install = (server) => {
    const { handle } = createLocalReceiversHandler(options);
    server.middlewares.use(LOCAL_RECEIVERS_ROUTE, (req, res, next) => {
      const path = new URL(req.url || '/', 'http://localhost').pathname;
      if (path !== '/' && path !== '') {
        if (typeof next === 'function') return next();
        return undefined;
      }
      return handle(req, res);
    });
  };
  return {
    name: 'local-receivers-proxy',
    configureServer: install,
    configurePreviewServer: install,
  };
}
