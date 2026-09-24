import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { readResponseTextCapped } from '../common/http.js';

const OTX_API = 'https://otx.alienvault.com/api/v1';
const OTX_TTL_MS = 30 * 60_000;
const OTX_TIMEOUT_MS = 10_000;
const OTX_RESPONSE_LIMIT = 128 * 1024;
const OTX_CACHE_LIMIT = 100;

function failure(code, status) {
  return Object.assign(new Error(code), { code, status });
}

function safeText(value, max = 500) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text && text.length <= max && !/[\u0000-\u001f<>]/.test(text)
    ? text
    : null;
}

const OTX_TYPES = Object.freeze({
  ipv4: { path: 'IPv4', label: 'IPv4' },
  ipv6: { path: 'IPv6', label: 'IPv6' },
  domain: { path: 'domain', label: 'Domain' },
  url: { path: 'url', label: 'URL' },
  file: { path: 'file', label: 'File hash' },
  cve: { path: 'cve', label: 'CVE' },
});

function normalizeIndicator(value, requestedType = 'auto') {
  const indicator = String(value || '').trim();
  if (
    !indicator ||
    indicator.length > 2_000 ||
    /[\u0000-\u001f<>]/.test(indicator)
  )
    throw failure('invalid_indicator', 400);

  let type = String(requestedType || 'auto').toLowerCase();
  if (type === 'auto') {
    if (isIP(indicator) === 4) type = 'ipv4';
    else if (isIP(indicator) === 6) type = 'ipv6';
    else if (/^CVE-\d{4}-\d{4,}$/i.test(indicator)) type = 'cve';
    else if (/^[a-f\d]{32}$|^[a-f\d]{40}$|^[a-f\d]{64}$/i.test(indicator))
      type = 'file';
    else if (/^https?:\/\//i.test(indicator)) type = 'url';
    else type = 'domain';
  }
  if (!OTX_TYPES[type]) throw failure('invalid_indicator', 400);

  if (type === 'ipv4' && isIP(indicator) !== 4)
    throw failure('invalid_indicator', 400);
  if (type === 'ipv6' && isIP(indicator) !== 6)
    throw failure('invalid_indicator', 400);
  if (
    type === 'domain' &&
    (!/^(?=.{1,253}$)(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+[a-z]{2,63}$/i.test(
      indicator,
    ) ||
      isIP(indicator))
  )
    throw failure('invalid_indicator', 400);
  if (
    type === 'url' &&
    (() => {
      try {
        const url = new URL(indicator);
        return (
          !['http:', 'https:'].includes(url.protocol) ||
          Boolean(url.username || url.password)
        );
      } catch {
        return true;
      }
    })()
  )
    throw failure('invalid_indicator', 400);
  if (
    type === 'file' &&
    !/^(?:[a-f\d]{32}|[a-f\d]{40}|[a-f\d]{64})$/i.test(indicator)
  )
    throw failure('invalid_indicator', 400);
  if (type === 'cve' && !/^CVE-\d{4}-\d{4,}$/i.test(indicator))
    throw failure('invalid_indicator', 400);
  return { indicator, type, ...OTX_TYPES[type] };
}

function normalizePulse(value) {
  if (!value || typeof value !== 'object') return null;
  const id = safeText(value.id, 40);
  const name = safeText(value.name, 180);
  if (!id || !/^[a-f\d]{24}$/i.test(id) || !name) return null;
  const date = (field) => {
    const timestamp = typeof field === 'string' ? Date.parse(field) : NaN;
    return Number.isFinite(timestamp)
      ? new Date(timestamp).toISOString()
      : null;
  };
  return Object.freeze({
    id,
    name,
    description: safeText(value.description, 1_000),
    author: safeText(value.author_name, 100),
    created: date(value.created),
    modified: date(value.modified),
    tags: Object.freeze(
      (Array.isArray(value.tags) ? value.tags : [])
        .slice(0, 8)
        .map((tag) => safeText(tag, 80))
        .filter(Boolean),
    ),
    indicatorCount:
      Number.isSafeInteger(value.indicator_count) && value.indicator_count >= 0
        ? value.indicator_count
        : null,
    tlp: safeText(value.TLP || value.tlp, 16),
  });
}

function normalizeOtxResponse(identity, payload, fetchedAt) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    throw failure('invalid_provider_data', 502);
  const pulseInfo = payload.pulse_info;
  const pulses = (Array.isArray(pulseInfo?.pulses) ? pulseInfo.pulses : [])
    .slice(0, 5)
    .map(normalizePulse)
    .filter(Boolean);
  const pulseCount = Number.isSafeInteger(pulseInfo?.count)
    ? Math.max(0, Math.min(1_000_000, pulseInfo.count))
    : pulses.length;
  return Object.freeze({
    schemaVersion: 1,
    provider: 'alienvault-otx',
    indicator: identity.indicator,
    indicatorType: identity.type,
    indicatorTypeLabel: identity.label,
    fetchedAt,
    attribution: 'AlienVault Open Threat Exchange (OTX)',
    pulseCount,
    pulses: Object.freeze(pulses),
    link: `https://otx.alienvault.com/indicator/${identity.path}/${encodeURIComponent(identity.indicator)}`,
  });
}

function cacheKey(secret, identity) {
  const fingerprint = createHash('sha256').update(secret).digest('hex');
  return `${fingerprint}:${identity.type}:${identity.indicator.toLowerCase()}`;
}

/** Server-only, explicit OTX indicator lookups with bounded responses and cache. */
export function createOtxProvider({
  fetchImpl = fetch,
  now = () => Date.now(),
} = {}) {
  const cache = new Map();
  const pending = new Map();

  async function request(url, secret, signal) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OTX_TIMEOUT_MS);
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      signal?.throwIfAborted();
      const response = await fetchImpl(url, {
        signal: controller.signal,
        redirect: 'error',
        headers: {
          Accept: 'application/json',
          'X-OTX-API-KEY': secret,
          'User-Agent': 'Gods Eye View Cyber Activity',
        },
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 401 || response.status === 403)
          throw failure('invalid_credentials', 401);
        if (response.status === 404) throw failure('not_found', 404);
        if (response.status === 429) throw failure('rate_limited', 429);
        throw failure('upstream_unavailable', 503);
      }
      const text = await readResponseTextCapped(
        response,
        OTX_RESPONSE_LIMIT,
        controller.signal,
      );
      signal?.throwIfAborted();
      try {
        return JSON.parse(text);
      } catch {
        throw failure('invalid_provider_data', 502);
      }
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? new Error('cancelled');
      if (error?.code) throw error;
      if (controller.signal.aborted) throw failure('upstream_timeout', 503);
      throw failure('upstream_unavailable', 503);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  async function testConnection({ signal } = {}) {
    const secret = String(process.env.ALIENVAULT_OTX_API_KEY || '').trim();
    if (!secret) throw failure('missing_credentials', 401);
    const result = await request(
      `${OTX_API}/pulses/subscribed?limit=1`,
      secret,
      signal,
    );
    if (!result || typeof result !== 'object' || !Array.isArray(result.results))
      throw failure('invalid_provider_data', 502);
    return { message: 'AlienVault OTX connection succeeded.' };
  }

  async function lookupIndicator(
    value,
    requestedType = 'auto',
    { signal } = {},
  ) {
    const identity = normalizeIndicator(value, requestedType);
    const secret = String(process.env.ALIENVAULT_OTX_API_KEY || '').trim();
    if (!secret) throw failure('missing_credentials', 401);
    const key = cacheKey(secret, identity);
    const cached = cache.get(key);
    if (cached && now() - cached.cachedAt < OTX_TTL_MS) return cached.value;
    if (pending.has(key)) return pending.get(key);
    const operation = (async () => {
      const path = `${OTX_API}/indicators/${identity.path}/${encodeURIComponent(identity.indicator)}/general`;
      const payload = await request(path, secret, signal);
      const value = normalizeOtxResponse(
        identity,
        payload,
        new Date(now()).toISOString(),
      );
      cache.set(key, { value, cachedAt: now() });
      while (cache.size > OTX_CACHE_LIMIT)
        cache.delete(cache.keys().next().value);
      return value;
    })().finally(() => pending.delete(key));
    pending.set(key, operation);
    return operation;
  }

  return Object.freeze({ testConnection, lookupIndicator });
}

export { normalizeIndicator as normalizeOtxIndicator, normalizeOtxResponse };
