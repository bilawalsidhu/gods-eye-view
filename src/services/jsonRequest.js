/** Request a JSON response within the service and caller lifetimes. */
export function createJsonRequest({
  fetchImpl = (...args) => fetch(...args),
  signal: lifetime,
} = {}) {
  return async function request(endpoint, { signal, ...init } = {}) {
    signal = AbortSignal.any([lifetime, signal].filter(Boolean));
    signal.throwIfAborted();
    const response = await fetchImpl(endpoint, {
      ...init,
      signal,
      redirect: 'error',
    });
    signal.throwIfAborted();
    let data = null;
    try {
      data = await response.json();
    } catch {
      /* Status remains authoritative for non-JSON errors. */
    }
    signal.throwIfAborted();
    return {
      ok: response.ok,
      status: response.status,
      headers: response.headers,
      data,
    };
  };
}

export function requireOk(response, label) {
  if (!response.ok)
    throw new Error(`${label} unavailable (${response.status})`);
  return response.data;
}
