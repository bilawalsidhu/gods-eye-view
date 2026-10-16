// The main chunk of a Vite build and what it must not carry: the Cesium-mode
// page loads the entry chunk and every chunk it imports statically; Navara and
// three belong in the lazy chunk navaraMode.js loads with import(). Pure
// helpers for scripts/check-main-chunk.mjs.

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

/** Sibling chunks a chunk imports statically (`from"./x.js"`, `import"./x.js"`). */
export function staticImportsOf(code) {
  const found = [];
  const pattern = /(?:\bfrom|\bimport)\s*(["'])\.\/([^"']+\.js)\1/g;
  for (const match of String(code).matchAll(pattern)) {
    if (!found.includes(match[2])) found.push(match[2]);
  }
  return found;
}

/**
 * The entry and every chunk reachable from it by static imports, in
 * discovery order. `read(file)` returns a chunk's code (file relative to
 * dist, in the entry's directory).
 */
export function initialChunks(entry, read) {
  const directory = entry.includes('/')
    ? entry.slice(0, entry.lastIndexOf('/') + 1)
    : '';
  const seen = [entry];
  for (let index = 0; index < seen.length; index++) {
    const code = read(seen[index]);
    if (code == null) continue;
    for (const name of staticImportsOf(code)) {
      const file = directory + name;
      if (!seen.includes(file)) seen.push(file);
    }
  }
  return seen;
}

/** The names of FORBIDDEN_MARKERS found in code. */
export function forbiddenMarkersIn(code) {
  const text = String(code);
  return FORBIDDEN_MARKERS.filter(({ pattern }) => pattern.test(text)).map(
    ({ name }) => name,
  );
}
