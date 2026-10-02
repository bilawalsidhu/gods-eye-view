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
 * A pack split into many files passes no `importJson` (a literal import per
 * file would also bundle every file as a script chunk); under Node its file
 * is then read directly.
 *
 * @module data/bundledJson
 */

/**
 * @param {URL} url - Resolved against the calling module's `import.meta.url`.
 * @param {(() => Promise<{default: any}>)|null} [importJson] - The caller's
 *   literal `import('./….json', { with: { type: 'json' } })`, used only under
 *   Node; without it Node reads the file.
 * @returns {Promise<any>} The parsed JSON.
 */
export async function loadBundledJson(url, importJson, { signal } = {}) {
  if (url.protocol === 'file:') {
    if (importJson) return (await importJson()).default;
    const fs = globalThis.process.getBuiltinModule('node:fs');
    return JSON.parse(fs.readFileSync(url, 'utf8'));
  }
  signal?.throwIfAborted();
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url.pathname}`);
  }
  return response.json();
}
