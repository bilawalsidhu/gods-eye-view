/**
 * server/sources/_shared.js — the deterministic building blocks every Gate 3
 * source adapter (rows 2–N) is made of. No LLM, no env reads except through
 * the `env` argument callers pass in, no I/O beyond the injected `fetchImpl`.
 *
 *   validateParams(raw, spec)         whitelist + type/range/enum validation →
 *                                     { ok:true, params } or a structured 400
 *   fetchWithRetry(url, options)      timeout + ONE retry on network/timeout/5xx;
 *                                     4xx never retried; 429 surfaced as
 *                                     `rate_limited`, 401/403 as `upstream_auth`
 *   parseJson(response)               body → JSON or a 502 `malformed_upstream`
 *   provenance(fields)                the provenance envelope; completeness is
 *                                     NEVER 'complete'
 *   failure(status, code, message, param?)  the structured error shape
 *   missingAuth(envName, message)     4xx `missing_auth` when a server-side key
 *                                     is absent (never guessed)
 *   isoUtc(date)                      ISO-8601 UTC string
 *
 * Error shape (every 4xx/5xx the adapters return):
 *   { ok:false, status, error:{ code, message, param? } }
 * Success shape:
 *   { ok:true, status:200, data:{...}, provenance:{...} }
 */

export const COMPLETENESS_VALUES = Object.freeze([
  'partial',
  'sampled',
  'bounded',
  'estimated',
]);

export function isoUtc(date = new Date()) {
  return (date instanceof Date ? date : new Date(date)).toISOString();
}

/** Structured failure envelope. */
export function failure(status, code, message, param) {
  const error = { code, message };
  if (param !== undefined) error.param = param;
  return { ok: false, status, error };
}

/** A required server-side credential is absent — a documented 4xx, never a guess. */
export function missingAuth(envName, message) {
  return failure(
    401,
    'missing_auth',
    message ||
      `${envName} is not configured on the server; this source requires a key`,
    envName,
  );
}

function parseBoolean(value) {
  if (typeof value === 'boolean') return value;
  const v = String(value).trim().toLowerCase();
  if (['true', '1', 'yes'].includes(v)) return true;
  if (['false', '0', 'no'].includes(v)) return false;
  return undefined;
}

const ISO_DATE_RE =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;

/**
 * Validate a raw query object against a whitelist spec.
 *
 * spec: { <name>: { type: 'string'|'number'|'integer'|'boolean'|'enum'|'iso-date'|'csv',
 *                   required?: boolean, min?: number, max?: number,
 *                   values?: string[] (enum / csv members), default?: any,
 *                   maxLength?: number, pattern?: RegExp } }
 *
 * Unknown keys → 400 `unknown_param`; a missing required key → 400
 * `missing_param`; a bad value → 400 `invalid_param`. Defaults are applied
 * for absent optional keys. Numbers are coerced from strings.
 */
export function validateParams(raw, spec) {
  const input = raw && typeof raw === 'object' ? raw : {};
  for (const key of Object.keys(input)) {
    if (!Object.prototype.hasOwnProperty.call(spec, key)) {
      return failure(
        400,
        'unknown_param',
        `unknown parameter "${key}"; allowed: ${Object.keys(spec).join(', ')}`,
        key,
      );
    }
  }
  const params = {};
  for (const [key, rule] of Object.entries(spec)) {
    const present =
      Object.prototype.hasOwnProperty.call(input, key) &&
      input[key] !== undefined &&
      input[key] !== null &&
      String(input[key]) !== '';
    if (!present) {
      if (rule.required) {
        return failure(
          400,
          'missing_param',
          `parameter "${key}" is required`,
          key,
        );
      }
      if (rule.default !== undefined) params[key] = rule.default;
      continue;
    }
    const value = input[key];
    switch (rule.type) {
      case 'number':
      case 'integer': {
        const n = typeof value === 'number' ? value : Number(String(value));
        if (
          !Number.isFinite(n) ||
          (rule.type === 'integer' && !Number.isInteger(n))
        ) {
          return failure(
            400,
            'invalid_param',
            `parameter "${key}" must be ${rule.type === 'integer' ? 'an integer' : 'a number'}`,
            key,
          );
        }
        if (rule.min !== undefined && n < rule.min) {
          return failure(
            400,
            'invalid_param',
            `parameter "${key}" must be >= ${rule.min}`,
            key,
          );
        }
        if (rule.max !== undefined && n > rule.max) {
          return failure(
            400,
            'invalid_param',
            `parameter "${key}" must be <= ${rule.max}`,
            key,
          );
        }
        params[key] = n;
        break;
      }
      case 'boolean': {
        const b = parseBoolean(value);
        if (b === undefined) {
          return failure(
            400,
            'invalid_param',
            `parameter "${key}" must be true or false`,
            key,
          );
        }
        params[key] = b;
        break;
      }
      case 'enum': {
        const s = String(value);
        if (!rule.values.includes(s)) {
          return failure(
            400,
            'invalid_param',
            `parameter "${key}" must be one of: ${rule.values.join(', ')}`,
            key,
          );
        }
        params[key] = s;
        break;
      }
      case 'csv': {
        const parts = String(value)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        if (parts.length === 0) {
          return failure(
            400,
            'invalid_param',
            `parameter "${key}" must be a comma-separated list`,
            key,
          );
        }
        if (rule.values) {
          const bad = parts.find((p) => !rule.values.includes(p));
          if (bad) {
            return failure(
              400,
              'invalid_param',
              `parameter "${key}" contains "${bad}"; allowed: ${rule.values.join(', ')}`,
              key,
            );
          }
        }
        if (rule.max !== undefined && parts.length > rule.max) {
          return failure(
            400,
            'invalid_param',
            `parameter "${key}" accepts at most ${rule.max} values`,
            key,
          );
        }
        params[key] = parts;
        break;
      }
      case 'iso-date': {
        const s = String(value).trim();
        if (!ISO_DATE_RE.test(s) || Number.isNaN(Date.parse(s))) {
          return failure(
            400,
            'invalid_param',
            `parameter "${key}" must be an ISO-8601 UTC date or date-time`,
            key,
          );
        }
        params[key] = s;
        break;
      }
      case 'string':
      default: {
        const s = String(value);
        if (rule.maxLength !== undefined && s.length > rule.maxLength) {
          return failure(
            400,
            'invalid_param',
            `parameter "${key}" is longer than ${rule.maxLength} characters`,
            key,
          );
        }
        if (rule.pattern && !rule.pattern.test(s)) {
          return failure(
            400,
            'invalid_param',
            `parameter "${key}" has an invalid format`,
            key,
          );
        }
        params[key] = s;
        break;
      }
    }
  }
  return { ok: true, params };
}

function isAbortError(err) {
  return err?.name === 'AbortError' || err?.name === 'TimeoutError';
}

/**
 * fetch with a per-attempt timeout and ONE retry on network errors,
 * timeouts and 5xx responses. 4xx responses are returned immediately
 * (429 → `rate_limited` with `retry_after` seconds when the header is
 * present; 401/403 → `upstream_auth`; other 4xx → `upstream_rejected`).
 * A caller-supplied `signal` aborts everything at once and yields a
 * `cancelled` failure (499) — never retried.
 *
 * Returns { ok:true, response } or a structured failure.
 */
export async function fetchWithRetry(
  url,
  {
    fetchImpl = globalThis.fetch,
    timeoutMs = 8000,
    retries = 1,
    signal,
    headers,
    method = 'GET',
    body,
    provider = 'upstream',
  } = {},
) {
  let lastFailure = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (signal?.aborted) {
      return failure(499, 'cancelled', 'request cancelled by the caller');
    }
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers,
        body,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (signal?.aborted) {
        return failure(499, 'cancelled', 'request cancelled by the caller');
      }
      lastFailure = isAbortError(err)
        ? failure(
            504,
            'upstream_timeout',
            `${provider} did not answer within ${timeoutMs} ms`,
          )
        : failure(
            502,
            'upstream_unavailable',
            `${provider} network error: ${err?.message || err}`,
          );
      continue;
    }
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
    if (response.ok) return { ok: true, response };
    if (response.status === 429) {
      const retryAfter = Number(response.headers?.get?.('retry-after'));
      const f = failure(429, 'rate_limited', `${provider} rate limit exceeded`);
      if (Number.isFinite(retryAfter)) f.error.retry_after = retryAfter;
      return f;
    }
    if (response.status === 401 || response.status === 403) {
      return failure(
        response.status,
        'upstream_auth',
        `${provider} rejected the credentials (HTTP ${response.status})`,
      );
    }
    if (response.status >= 400 && response.status < 500) {
      return failure(
        502,
        'upstream_rejected',
        `${provider} rejected the request (HTTP ${response.status})`,
      );
    }
    lastFailure = failure(
      502,
      'upstream_unavailable',
      `${provider} answered HTTP ${response.status}`,
    );
  }
  return (
    lastFailure ||
    failure(502, 'upstream_unavailable', `${provider} unavailable`)
  );
}

/** Parse a JSON body; a non-JSON body is a 502 `malformed_upstream`. */
export async function parseJson(response, provider = 'upstream') {
  let text = '';
  try {
    text = await response.text();
  } catch {
    return failure(
      502,
      'malformed_upstream',
      `${provider} body could not be read`,
    );
  }
  try {
    return { ok: true, json: JSON.parse(text), text };
  } catch {
    return failure(
      502,
      'malformed_upstream',
      `${provider} returned a body that was not valid JSON`,
    );
  }
}

/** Read a text body; failure is a 502 `malformed_upstream`. */
export async function readText(response, provider = 'upstream') {
  try {
    return { ok: true, text: await response.text() };
  } catch {
    return failure(
      502,
      'malformed_upstream',
      `${provider} body could not be read`,
    );
  }
}

/**
 * The provenance envelope. `completeness.status` must be one of
 * COMPLETENESS_VALUES — 'complete' is rejected by construction.
 */
export function provenance({
  provider,
  source_url,
  license,
  fetched_at = isoUtc(),
  freshness = {},
  coverage = {},
  completeness = {},
}) {
  if (!provider) throw new TypeError('provenance: provider is required');
  if (!license || !license.name || !license.url || !license.attribution) {
    throw new TypeError(
      'provenance: license {name,url,attribution} is required',
    );
  }
  const status = completeness.status;
  if (!COMPLETENESS_VALUES.includes(status)) {
    throw new TypeError(
      `provenance: completeness.status must be one of ${COMPLETENESS_VALUES.join('|')} (never 'complete'); got ${String(status)}`,
    );
  }
  return {
    provider,
    source_url: source_url ?? null,
    license: {
      name: license.name,
      url: license.url,
      attribution: license.attribution,
    },
    fetched_at,
    freshness,
    coverage,
    completeness,
  };
}

/** Clamp a bbox object {south,west,north,east} — returns null when invalid. */
export function normalizeBbox({ south, west, north, east }) {
  const nums = [south, west, north, east].map(Number);
  if (nums.some((n) => !Number.isFinite(n))) return null;
  const [s, w, n, e] = nums;
  if (s < -90 || n > 90 || s > n || w < -180 || e > 180 || w > e) return null;
  return { south: s, west: w, north: n, east: e };
}
