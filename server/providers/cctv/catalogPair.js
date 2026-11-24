import { readResponseTextCapped } from '../common/http.js';

/**
 * Read catalogs that are only useful together, because the pack joins them.
 *
 * The requests share one deadline and refuse redirects. Whichever fails first
 * (before its headers, on its status, or while its capped body is read or
 * parsed) aborts the others at once, so a stalled feed is not waited on until
 * the deadline. Every response body is released, including one that arrives
 * after another feed has already failed.
 *
 * @param {Array<{url: string, label: string}>} feeds `label` names the feed
 *   in the error ("locations download failed: 503").
 * @param {{accept: string, maxBytes: number, timeoutMs: number,
 *   parse?: (text: string) => unknown}} options
 * @returns {Promise<unknown[]>} The parsed bodies (texts without `parse`), in
 *   feed order.
 */
export async function readCatalogsTogether(
  feeds,
  { accept, maxBytes, timeoutMs, parse = (text) => text },
) {
  const sibling = new AbortController();
  const signal = AbortSignal.any([
    sibling.signal,
    AbortSignal.timeout(timeoutMs),
  ]);
  return Promise.all(
    feeds.map(async ({ url, label }) => {
      let response;
      try {
        response = await fetch(url, {
          headers: { Accept: accept },
          redirect: 'manual',
          signal,
        });
        signal.throwIfAborted();
        if (!response.ok) {
          throw new Error(
            response.status >= 300 && response.status < 400
              ? `${label} catalog redirected; redirects are not followed`
              : `${label} download failed: ${response.status}`,
          );
        }
        return parse(await readResponseTextCapped(response, maxBytes, signal));
      } catch (error) {
        sibling.abort();
        await response?.body?.cancel().catch(() => {});
        throw error;
      }
    }),
  );
}
