// The main chunk of a Vite build and what the Cesium-mode page must not
// load: Navara and three belong in the lazy chunk navaraMode.js loads with
// import(). Pure helpers for scripts/check-main-chunk.mjs (which entry the
// page loads) and scripts/qa-strict-cold-chunks.mjs (which chunks a cold
// start fetches carry three or Navara code).

/**
 * Markers that only three or Navara code leaves in a bundle (minification
 * keeps string literals): three's own warnings name their classes, Navara's
 * package names, wasm modules and attribution card classes. Plain engine
 * names ('navara' as an engine kind) are not markers.
 */
export const FORBIDDEN_MARKERS = Object.freeze([
  Object.freeze({
    name: 'three',
    pattern: /THREE\.(?:WebGLRenderer|GLTFLoader|EXRLoader|Vector\d)/,
  }),
  Object.freeze({
    name: 'navara',
    pattern: /@navaramap\/|navara_wasm|navara-attr-/,
  }),
]);

/** The module script a built index.html loads, relative to dist ('assets/…'), or null. */
export function entryFromHtml(html) {
  const scripts = String(html).match(/<script\b[^>]*>/g) ?? [];
  for (const tag of scripts) {
    if (!/\btype\s*=\s*["']module["']/.test(tag)) continue;
    const src = tag.match(/\bsrc\s*=\s*["']([^"']+)["']/);
    if (src) return src[1].replace(/^\.?\//, '');
  }
  return null;
}

/** The file of the manifest chunk marked isEntry for index.html (or any entry), or null. */
export function entryFromManifest(manifest) {
  const chunks = Object.values(manifest ?? {});
  const entry =
    chunks.find((chunk) => chunk.isEntry && chunk.src === 'index.html') ??
    chunks.find((chunk) => chunk.isEntry);
  return entry?.file ?? null;
}

/** The names of FORBIDDEN_MARKERS found in code. */
export function forbiddenMarkersIn(code) {
  const text = String(code);
  return FORBIDDEN_MARKERS.filter(({ pattern }) => pattern.test(text)).map(
    ({ name }) => name,
  );
}
