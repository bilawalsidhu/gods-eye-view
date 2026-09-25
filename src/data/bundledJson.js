/**
 * @file Load a JSON file shipped beside the source modules.
 *
 * The browser fetches the file from `url` — a `new URL('./….json',
 * import.meta.url)` written in the calling module, which Vite serves as-is in
 * dev and emits as an asset in the production build. Under Node (node:test)
 * that URL is a `file:` URL, which `fetch` cannot read, so the caller's
 * JSON-attributed import runs instead.
 *
 * The attributed import cannot serve the browser: the Vite dev server answers
 * it with a JavaScript module, which the browser rejects for a JSON import.
 *
 * @module data/bundledJson
 */

/**
 * @param {URL} url - Resolved against the calling module's `import.meta.url`.
 * @param {() => Promise<{default: any}>} importJson - The caller's literal
 *   `import('./….json', { with: { type: 'json' } })`, used only under Node.
 * @returns {Promise<any>} The parsed JSON.
 */
export async function loadBundledJson(url, importJson) {
  if (url.protocol === 'file:') return (await importJson()).default;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url.pathname}`);
  }
  return response.json();
}
