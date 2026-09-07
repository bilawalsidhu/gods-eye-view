/**
 * Error returned by a same-origin BFF endpoint.
 */
export class BffHttpError extends Error {
  constructor(message, { status = 0, code = null, details = null } = {}) {
    super(message);
    this.name = 'BffHttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function assertSameOriginPath(path) {
  const value = String(path ?? '');
  if (!value.startsWith('/') || value.startsWith('//') || /^[a-z][a-z\d+.-]*:/i.test(value)) {
    throw new TypeError(`BFF path must be same-origin: ${value || '(empty)'}`);
  }
  return value;
}

/**
 * Fetch JSON from a same-origin BFF endpoint.
 *
 * @param {string} path
 * @param {RequestInit & {fetchImpl?: typeof fetch}} options
 */
export async function fetchBffJson(path, {
  fetchImpl = globalThis.fetch,
  headers,
  body,
  ...init
} = {}) {
  assertSameOriginPath(path);
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');

  const requestHeaders = new Headers(headers);
  requestHeaders.set('Accept', 'application/json');
  let requestBody = body;
  if (body !== undefined && body !== null && typeof body !== 'string'
    && !(body instanceof ArrayBuffer) && !ArrayBuffer.isView(body)
    && !(typeof FormData !== 'undefined' && body instanceof FormData)) {
    requestHeaders.set('Content-Type', 'application/json');
    requestBody = JSON.stringify(body);
  }

  const response = await fetchImpl(path, {
    credentials: 'same-origin',
    ...init,
    headers: requestHeaders,
    body: requestBody,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const reason = typeof data?.error === 'string'
      ? data.error
      : data?.error?.message || data?.message;
    throw new BffHttpError(reason || `BFF request failed: HTTP ${response.status}`, {
      status: response.status,
      code: data?.code || data?.error?.code || null,
      details: data,
    });
  }
  if (data === null) {
    throw new BffHttpError('BFF returned a non-JSON response', { status: response.status });
  }
  return data;
}

export function finiteNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError(`${name} must be a finite number`);
  return number;
}

export function latitude(value) {
  const number = finiteNumber(value, 'latitude');
  if (number < -90 || number > 90) throw new RangeError('latitude must be between -90 and 90');
  return number;
}

export function longitude(value) {
  const number = finiteNumber(value, 'longitude');
  if (number < -180 || number > 180) throw new RangeError('longitude must be between -180 and 180');
  return number;
}

