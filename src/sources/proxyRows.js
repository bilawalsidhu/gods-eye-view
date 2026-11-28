import { readResponseJsonCapped } from './httpBody.js';

/**
 * Read a same-origin proxy snapshot of rows: the proxy answers from its last
 * snapshot, marked stale, while its upstream is unreachable.
 * @param {typeof fetch} fetchImpl
 * @param {string} path Same-origin proxy path.
 * @param {{upstream: string, malformed: string, signal?: AbortSignal}} options
 *   `upstream` names the service in an HTTP error; `malformed` is the error
 *   for a body without rows.
 * @returns {Promise<{rows: object[], stale: boolean, fetchedAt: number|null}>}
 */
export async function fetchProxyRows(
  fetchImpl,
  path,
  { upstream, malformed, signal } = {},
) {
  signal?.throwIfAborted();
  const response = await fetchImpl(path, { signal });
  if (!response.ok) throw new Error(`${upstream} HTTP ${response.status}`);
  const payload = await readResponseJsonCapped(
    response,
    80 * 1024 * 1024,
    signal,
  );
  signal?.throwIfAborted();
  if (!Array.isArray(payload?.rows)) throw new Error(malformed);
  return {
    rows: payload.rows,
    stale: payload.stale === true,
    fetchedAt: Number.isFinite(payload.fetchedAt) ? payload.fetchedAt : null,
  };
}
