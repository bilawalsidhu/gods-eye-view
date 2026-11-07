/**
 * @file Load a JSON file shipped beside the source modules.
 *
 * The browser fetches the file from `url` — a `new URL('./….json',
 * import.meta.url)` written in the calling module, which Vite serves as-is in
 * dev and emits as an asset in the production build. Under Node (node:test)
 * that URL is a `file:` URL, which `fetch` cannot read, so the file is read
 * from disk instead.
 *
 * Nothing here imports the JSON as a module. A JSON-attributed import cannot
 * serve the browser (the Vite dev server answers it with a JavaScript module,
 * which the browser rejects), and a literal `import('./….json')` makes the
 * production build emit a JavaScript copy of every pack that the browser
 * never loads.
 *
 * @module data/bundledJson
 */

/**
 * @param {URL} url - Resolved against the calling module's `import.meta.url`.
 * @param {{signal?: AbortSignal}} [options]
 * @returns {Promise<any>} The parsed JSON.
 */
export async function loadBundledJson(url, { signal } = {}) {
  signal?.throwIfAborted();
  if (url.protocol === 'file:') {
    // Node's built-in, reached without an import, so the browser build never
    // bundles or rewrites it; only Node, reading `file:` URLs, gets here. The
    // read is synchronous so the result settles as promptly as the cached
    // module import it replaces; callers already memoize each pack.
    const getBuiltinModule = globalThis.process?.getBuiltinModule;
    if (typeof getBuiltinModule !== 'function')
      throw new Error(
        `God's Eye View needs Node 24.14 or newer to read ${url.pathname.split('/').pop()} (running ${globalThis.process?.version ?? 'an unknown runtime'})`,
      );
    const { readFileSync } = getBuiltinModule('node:fs');
    return JSON.parse(readFileSync(url, 'utf8'));
  }
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url.pathname}`);
  }
  return response.json();
}
