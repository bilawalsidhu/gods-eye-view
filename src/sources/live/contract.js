/**
 * Browser live-source contract. Coordinates are WGS84 degrees; lengths and
 * velocities are metres and metres/second; times are Unix milliseconds.
 * Barometric altitude and ellipsoid altitude are separate, nullable observations.
 * A missing timestamp is unknown, never the time the response was received.
 *
 * Sources expose getSnapshot(query, { signal }) and optionally
 * getTrack(reference, { signal }). References are opaque to consumers.
 * Snapshots describe coverage and completeness independently of freshness.
 * Records contain observation data only, with no scene objects or transport data.
 */
export class LiveSourceError extends Error {
  constructor(
    code,
    message,
    { status = null, retryAfterMs = 20000, source = null } = {},
  ) {
    super(message);
    this.name = 'LiveSourceError';
    this.code = code;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.source = source;
  }
}

export function finite(value) {
  if (value == null || value === '' || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function epoch(value, scale = 1) {
  const number = finite(value);
  const milliseconds = number == null ? null : number * scale;
  return milliseconds != null &&
    milliseconds > 0 &&
    milliseconds <= 8640000000000000
    ? milliseconds
    : null;
}

export function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function coordinates(latitude, longitude) {
  return (
    Number.isFinite(latitude) &&
    Math.abs(latitude) <= 90 &&
    Number.isFinite(longitude) &&
    Math.abs(longitude) <= 180
  );
}

/** Admit a snapshot atomically; an all-invalid nonempty feed is unavailable. */
export function admitRecords(rows, normalize, label) {
  if (!Array.isArray(rows))
    throw new LiveSourceError('malformed', `Malformed ${label} response`);
  const records = [];
  const ids = new Set();
  for (const row of rows) {
    const record = normalize(row);
    if (record && !ids.has(record.id)) {
      records.push(record);
      ids.add(record.id);
    }
  }
  if (rows.length && !records.length) {
    throw new LiveSourceError('malformed', `Malformed ${label} aircraft rows`);
  }
  return {
    records,
    complete: records.length === rows.length,
    rejectedCount: rows.length - records.length,
  };
}

/** Cancellation is checked after body parsing even when a transport ignores it. */
export async function readResponse(
  fetchImpl,
  url,
  { signal, ...init } = {},
  source = 'Live source',
) {
  signal?.throwIfAborted();
  let response;
  try {
    response = await fetchImpl(url, { ...init, signal });
    signal?.throwIfAborted();
  } catch (error) {
    signal?.throwIfAborted();
    if (error?.name === 'AbortError') throw error;
    throw new LiveSourceError('unavailable', `${source} network error`, {
      source,
    });
  }
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    /* classified below */
  }
  signal?.throwIfAborted();
  return { response, payload };
}

export function httpError(response, source) {
  const status = response.status;
  const code =
    status === 429
      ? 'limited'
      : status === 401 || status === 403
        ? 'denied'
        : 'unavailable';
  return new LiveSourceError(
    code,
    status === 429 ? `${source} rate limited` : `${source} HTTP ${status}`,
    {
      status,
      source,
      retryAfterMs: code === 'limited' || code === 'denied' ? 45000 : 20000,
    },
  );
}

/** The four provider states the MOVEMENT proxies report (see server/providers/common/upstream.js). */
export const PROVIDER_STATUSES = Object.freeze([
  'live',
  'stale',
  'degraded',
  'unavailable',
]);

/**
 * Read the structured provider status a MOVEMENT proxy attaches to its
 * response — `X-Provider-Status` / `-Source` / `-Fetched-At` / `-Age-Sec` /
 * `-Error` / `-Count` headers (server/providers/common/upstream.js
 * `statusHeaders`), with a JSON body's `provider` object as the fallback for
 * transports that drop custom headers. Returns null when the response carries
 * neither, so callers can keep their pre-existing behaviour for legacy routes.
 *
 * @param {Response} response
 * @param {any} [payload] parsed JSON body, if any
 * @returns {{status:string,source:string|null,fetchedAtMs:number|null,ageSec:number|null,error:string|null,count:number|null}|null}
 */
export function providerStatusFromResponse(response, payload = null) {
  const header = (name) => response?.headers?.get?.(name) ?? null;
  const fromBody =
    payload && typeof payload === 'object' && payload.provider
      ? payload.provider
      : null;
  const rawStatus = String(
    header('x-provider-status') || fromBody?.status || '',
  ).toLowerCase();
  if (!PROVIDER_STATUSES.includes(rawStatus)) return null;
  const fetchedAtRaw = header('x-provider-fetched-at') || fromBody?.fetchedAt;
  const fetchedAtMs = fetchedAtRaw ? epoch(Date.parse(fetchedAtRaw)) : null;
  const ageSec = finite(header('x-provider-age-sec') ?? fromBody?.ageSec);
  const count = finite(header('x-provider-count') ?? fromBody?.count);
  const error = cleanText(header('x-provider-error') || fromBody?.error || '');
  return {
    status: rawStatus,
    source:
      cleanText(header('x-provider-source') || fromBody?.source || '') || null,
    fetchedAtMs,
    ageSec,
    error: error || null,
    count,
  };
}

/**
 * Human error for a MOVEMENT proxy response that carries no usable data
 * (HTTP 503 + structured status). Prefers the proxy's own reason over a raw
 * status code so the DATA LAYERS row never reads "HTTP 502".
 */
export function providerError(response, payload, source) {
  const status = providerStatusFromResponse(response, payload);
  const error = httpError(response, source);
  const reason = status?.error || payload?.error;
  if (typeof reason === 'string' && reason.trim())
    error.message = reason.trim();
  if (status?.source) error.source = status.source;
  return error;
}
