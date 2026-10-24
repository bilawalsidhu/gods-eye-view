/** Opt-in reads from an operator's local World Monitor installation. */
import http from 'node:http';
import https from 'node:https';
import { lookup } from 'node:dns';
import { isIP } from 'node:net';
import { openSync, fstatSync, readSync, closeSync, constants } from 'node:fs';
import { isLocalMcpRequest } from '../../src/localMcpGate.mjs';

const SOURCE = 'World Monitor (local)';
const MAX_BYTES = 2 * 1024 * 1024;
// The local digest can spend up to 22s finishing a cold RSS rebuild.
const TIMEOUT_MS = 25_000;
const STATES = new Set(['complete', 'partial', 'stale', 'unavailable']);
const VARIANTS = new Set(['full', 'tech', 'finance', 'happy', 'commodity']);
const text = (value, max = 1000) =>
  typeof value === 'string' ? value.slice(0, max) : null;
const object = (value) =>
  value && typeof value === 'object' && !Array.isArray(value);
const count = (value) => (Number.isInteger(value) && value >= 0 ? value : null);
const timestamp = (value) => {
  if (value == null || value === '' || value === 0) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};
const failure = (reason) =>
  Object.assign(new Error(reason), { safeReason: reason });

/** Only loopback and private LAN addresses may receive operator credentials. */
export function isLocalWorldMonitorAddress(address) {
  const host = String(address)
    .replace(/^\[|\]$/g, '')
    .toLowerCase();
  if (isIP(host) === 4) {
    const [a, b] = host.split('.').map(Number);
    return (
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  if (isIP(host) !== 6) return false;
  return host === '::1' || /^(fc|fd)[0-9a-f]{2}:/.test(host);
}

function readSecretFile(file) {
  const maxBytes = 16 * 1024;
  const descriptor = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > maxBytes)
      throw new Error('Invalid secret file');
    const buffer = Buffer.alloc(maxBytes + 1);
    let size = 0;
    for (;;) {
      const read = readSync(
        descriptor,
        buffer,
        size,
        buffer.length - size,
        size,
      );
      size += read;
      if (size > maxBytes) throw new Error('Invalid secret file');
      if (!read) return buffer.subarray(0, size).toString('utf8');
    }
  } finally {
    closeSync(descriptor);
  }
}

function secret(env, name) {
  const file = env[`${name}_FILE`];
  const value = (file ? readSecretFile(file) : env[name] || '').trim();
  if (value.length > 8192 || /[\r\n]/.test(value))
    throw failure('Invalid World Monitor credential configuration');
  return value;
}

function configuration(env) {
  if (!env.WORLD_MONITOR_API_BASE)
    throw failure('World Monitor is not configured');
  try {
    const base = new URL(env.WORLD_MONITOR_API_BASE);
    if (
      !['http:', 'https:'].includes(base.protocol) ||
      base.username ||
      base.password ||
      base.pathname !== '/' ||
      base.search ||
      base.hash
    )
      throw new Error();
    const hostname = base.hostname.replace(/^\[|\]$/g, '');
    if (isIP(hostname) && !isLocalWorldMonitorAddress(hostname))
      throw new Error();
    const headers = {
      Accept: 'application/json',
      'User-Agent': 'GodsEyeView-WorldMonitor/1.0',
    };
    const apiKey = secret(env, 'WORLD_MONITOR_API_KEY');
    const localToken = secret(env, 'WORLD_MONITOR_LOCAL_TOKEN');
    if (apiKey) headers['X-WorldMonitor-Key'] = apiKey;
    if (localToken) headers['x-worldmonitor-local-token'] = localToken;
    return { base, headers };
  } catch {
    throw failure('Invalid World Monitor local configuration');
  }
}

// Pin the actual connection to the locally resolved address. Checking DNS then
// calling ordinary fetch would resolve twice and allow a changed answer through.
function localLookup(hostname, options, callback) {
  lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
    if (
      error ||
      !addresses?.length ||
      addresses.some(({ address }) => !isLocalWorldMonitorAddress(address))
    ) {
      callback(failure('World Monitor must resolve to a local address'));
      return;
    }
    const selected = options?.family
      ? addresses.filter((row) => row.family === options.family)
      : addresses;
    if (!selected.length)
      return callback(failure('World Monitor has no compatible local address'));
    if (options?.all) callback(null, selected);
    else callback(null, selected[0].address, selected[0].family);
  });
}

function localJson(url, { headers, signal, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const deadline = AbortSignal.timeout(timeoutMs);
    const requestSignal = signal
      ? AbortSignal.any([signal, deadline])
      : deadline;
    const request = transport.request(
      url,
      {
        method: 'GET',
        headers,
        lookup: localLookup,
        signal: requestSignal,
      },
      (response) => {
        // http.request never follows redirects. Never return upstream error bodies,
        // which can contain internal URLs, credentials or diagnostic material.
        if (response.statusCode !== 200) {
          response.destroy();
          reject(
            failure(
              [401, 403].includes(response.statusCode)
                ? 'World Monitor authentication required'
                : 'World Monitor did not return data',
            ),
          );
          return;
        }
        if (
          !/^application\/json\b/i.test(response.headers['content-type'] || '')
        ) {
          response.destroy();
          reject(failure('World Monitor returned an invalid response'));
          return;
        }
        let size = 0;
        const chunks = [];
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_BYTES) {
            response.destroy();
            reject(failure('World Monitor response exceeded the size limit'));
          } else chunks.push(chunk);
        });
        response.on('error', () =>
          reject(failure('World Monitor response was interrupted')),
        );
        response.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (!object(body)) throw new Error();
            resolve(body);
          } catch {
            reject(failure('World Monitor returned an invalid response'));
          }
        });
      },
    );
    request.on('error', () =>
      reject(failure('World Monitor is unreachable or timed out')),
    );
    request.end();
  });
}

function countryCode(value) {
  if (typeof value !== 'string' || !/^[a-z]{2}$/i.test(value))
    throw failure('country must be a two-letter country code');
  return value.toUpperCase();
}

function article(row) {
  if (!object(row) || !text(row.title)?.trim()) return null;
  let url = null;
  try {
    const parsed = new URL(row.link);
    if (
      ['https:', 'http:'].includes(parsed.protocol) &&
      !parsed.username &&
      !parsed.password
    )
      url = parsed.href;
  } catch {
    /* Missing or unusable publisher links remain unknown. */
  }
  return {
    title: text(row.title),
    url,
    source: text(row.source, 200),
    publishedAt: timestamp(row.publishedAt),
  };
}

function unknownRisk() {
  return {
    status: 'unavailable',
    score: null,
    level: null,
    trend: null,
    computedAt: null,
    advisoryLevel: null,
    sanctionsActive: null,
    sanctionsCount: null,
    methodologyVersion: null,
  };
}

/** Fixed operations, bounded bodies/deadlines, and no hosted fallback. */
export function createWorldMonitorClient({
  env = process.env,
  timeoutMs = TIMEOUT_MS,
} = {}) {
  let active = 0;
  const envelope = () => ({
    source: SOURCE,
    retrievedAt: new Date().toISOString(),
  });
  const unavailable = (error) => ({
    ...envelope(),
    status: 'unavailable',
    reason: error?.safeReason || 'World Monitor data is unavailable',
  });
  async function read(path, query, signal) {
    const { base, headers } = configuration(env);
    if (active >= 4)
      throw failure('World Monitor bridge is busy; retry shortly');
    const url = new URL(path, base);
    for (const [key, value] of Object.entries(query))
      url.searchParams.set(key, value);
    active++;
    try {
      return await localJson(url, { headers, signal, timeoutMs });
    } finally {
      active--;
    }
  }
  async function getCountryHeadlines(country, { signal } = {}) {
    const code = countryCode(country);
    try {
      const body = await read(
        '/api/news/v1/list-country-headlines',
        { country_codes: code },
        signal,
      );
      if (!object(body.countries) || !STATES.has(body.state))
        throw failure('World Monitor headlines have an invalid schema');
      const raw = body.countries[code]?.items ?? [];
      if (!Array.isArray(raw))
        throw failure('World Monitor headlines have an invalid schema');
      const headlines =
        body.state === 'unavailable'
          ? []
          : raw.slice(0, 5).map(article).filter(Boolean);
      const rejected =
        body.state !== 'unavailable' &&
        headlines.length < Math.min(raw.length, 5);
      const status = rejected
        ? headlines.length
          ? 'partial'
          : 'unavailable'
        : body.state;
      return {
        ...envelope(),
        status,
        countryCode: code,
        headlines,
        coverage: {
          state: status,
          feedTotal: count(body.feedTotal),
          feedCached: count(body.feedCached),
          readAt: timestamp(body.readAt),
        },
        ...(status === 'unavailable'
          ? { reason: 'World Monitor headline caches are unavailable' }
          : {}),
      };
    } catch (error) {
      signal?.throwIfAborted();
      return {
        ...unavailable(error),
        countryCode: code,
        headlines: [],
        coverage: null,
      };
    }
  }
  async function getCountryBrief(country, { signal } = {}) {
    const code = countryCode(country);
    const [news, riskResult] = await Promise.all([
      getCountryHeadlines(code, { signal }),
      read(
        '/api/intelligence/v1/get-country-risk',
        { country_code: code },
        signal,
      )
        .then((body) => ({ body }))
        .catch((error) => ({ error })),
    ]);
    signal?.throwIfAborted();
    const body = riskResult.body;
    let risk = unknownRisk();
    if (
      object(body) &&
      body.countryCode === code &&
      body.upstreamUnavailable !== true &&
      (object(body.cii) ||
        typeof body.advisoryLevel === 'string' ||
        (typeof body.sanctionsActive === 'boolean' &&
          count(body.sanctionsCount) !== null))
    ) {
      const cii = body.cii;
      const score =
        Number.isFinite(cii?.combinedScore) &&
        cii.combinedScore >= 0 &&
        cii.combinedScore <= 100
          ? cii.combinedScore
          : null;
      const computedAt = timestamp(cii?.computedAt ?? body.fetchedAt);
      const sanctionsCount = count(body.sanctionsCount);
      risk = {
        ...risk,
        status:
          score != null && computedAt && sanctionsCount != null
            ? 'complete'
            : 'partial',
        score,
        trend: text(cii?.trend, 80),
        computedAt,
        advisoryLevel: text(body.advisoryLevel, 100) || null,
        sanctionsActive:
          typeof body.sanctionsActive === 'boolean'
            ? body.sanctionsActive
            : null,
        sanctionsCount,
        methodologyVersion: text(cii?.methodologyVersion, 100),
      };
    }
    const statuses = [news.status, risk.status];
    const status = statuses.every((state) => state === 'unavailable')
      ? 'unavailable'
      : statuses.every((state) => state === 'complete')
        ? 'complete'
        : statuses.includes('stale')
          ? 'stale'
          : 'partial';
    const countryName = text(body?.countryName, 200) || code;
    const summary = `${countryName}: ${risk.score == null ? 'risk score unavailable' : `World Monitor composite instability score ${risk.score}/100`}; ${news.headlines.length} cached country headlines. Coverage: ${status}.`;
    return {
      ...envelope(),
      status,
      countryCode: code,
      countryName,
      summary,
      headlines: news.headlines,
      headlineCoverage: news.coverage,
      risk,
      ...(status === 'unavailable'
        ? { reason: news.reason || 'World Monitor country data is unavailable' }
        : {}),
    };
  }
  async function getFeedDigest({ variant = 'full', limit = 25, signal } = {}) {
    if (
      !VARIANTS.has(variant) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw failure('Invalid digest variant or limit');
    try {
      const body = await read(
        '/api/news/v1/list-feed-digest',
        { variant, lang: 'en' },
        signal,
      );
      if (!object(body.categories) || !STATES.has(body.coverage?.state))
        throw failure('World Monitor digest has an invalid schema');
      const rows = [];
      let rejected = 0;
      for (const [category, bucket] of Object.entries(body.categories)) {
        if (!Array.isArray(bucket?.items))
          throw failure('World Monitor digest has an invalid schema');
        for (const item of bucket.items) {
          const normalized = article(item);
          if (normalized)
            rows.push({ ...normalized, category: category.slice(0, 100) });
          else rejected++;
        }
      }
      rows.sort((a, b) =>
        (b.publishedAt || '').localeCompare(a.publishedAt || ''),
      );
      const status =
        body.coverage.state === 'unavailable'
          ? 'unavailable'
          : rejected
            ? rows.length
              ? 'partial'
              : 'unavailable'
            : body.coverage.state;
      const available = status === 'unavailable' ? [] : rows;
      const items = available.slice(0, limit);
      return {
        ...envelope(),
        status,
        variant,
        generatedAt: timestamp(body.generatedAt),
        coverage: {
          state: status,
          servedStale: body.coverage.servedStale === true,
          staleAgeSeconds: count(body.coverage.staleAgeSeconds),
        },
        items,
        total: available.length,
        returned: items.length,
        truncated: items.length < available.length,
        ...(status === 'unavailable'
          ? { reason: 'World Monitor feed digest is unavailable' }
          : {}),
      };
    } catch (error) {
      signal?.throwIfAborted();
      return {
        ...unavailable(error),
        variant,
        generatedAt: null,
        coverage: null,
        items: [],
        total: 0,
        returned: 0,
        truncated: false,
      };
    }
  }
  return { getCountryHeadlines, getCountryBrief, getFeedDigest };
}

/** Mount local-only UI reads; clients never submit upstream URLs or credentials. */
export function worldMonitorProxy({
  env = process.env,
  client = createWorldMonitorClient({ env }),
} = {}) {
  const install = (server) => {
    server.middlewares.use('/api/worldmonitor', async (req, res) => {
      const send = (status, body) => {
        res.writeHead(status, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify(body));
      };
      if (
        !isLocalMcpRequest({
          remoteAddress: req.socket?.remoteAddress,
          localPort: req.socket?.localPort,
          host: req.headers.host,
          origin: req.headers.origin,
          headers: req.headers,
          env,
        })
      ) {
        return send(403, {
          status: 'unavailable',
          source: SOURCE,
          reason: 'Only direct local requests are accepted',
        });
      }
      if (req.method !== 'GET')
        return send(405, { status: 'unavailable', reason: 'Use GET' });
      const controller = new AbortController();
      const close = () => {
        if (!res.writableFinished) controller.abort();
      };
      res.on('close', close);
      try {
        const url = new URL(req.url, 'http://localhost');
        const params = url.searchParams;
        const allowed =
          url.pathname === '/feed-digest' ? ['variant', 'limit'] : ['country'];
        if (
          [...params.keys()].some(
            (key) => !allowed.includes(key) || params.getAll(key).length !== 1,
          )
        )
          throw new Error();
        let result;
        if (url.pathname === '/country-headlines')
          result = await client.getCountryHeadlines(params.get('country'), {
            signal: controller.signal,
          });
        else if (url.pathname === '/country-brief')
          result = await client.getCountryBrief(params.get('country'), {
            signal: controller.signal,
          });
        else if (url.pathname === '/feed-digest')
          result = await client.getFeedDigest({
            variant: params.get('variant') || 'full',
            limit: params.has('limit') ? Number(params.get('limit')) : 25,
            signal: controller.signal,
          });
        else
          return send(404, {
            status: 'unavailable',
            reason: 'Unknown World Monitor operation',
          });
        send(result.status === 'unavailable' ? 503 : 200, result);
      } catch {
        if (!controller.signal.aborted)
          send(400, {
            status: 'unavailable',
            source: SOURCE,
            reason: 'Invalid World Monitor request',
          });
      } finally {
        res.off('close', close);
      }
    });
  };
  return {
    name: 'local-world-monitor',
    configureServer: install,
    configurePreviewServer: install,
  };
}
