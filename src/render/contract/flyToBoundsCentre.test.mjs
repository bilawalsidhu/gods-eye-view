import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../../', import.meta.url));

/** Every source file under `dir` that is not a test. */
function sources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.(js|mjs|vue)$/.test(entry.name) && !/\.test\./.test(entry.name)
      ? [path]
      : [];
  });
}

/** The text of the call's first argument: from `(` to its matching close. */
function firstArgument(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if ('({['.includes(text[i])) depth += 1;
    else if (')}]'.includes(text[i])) depth -= 1;
    if (depth === 1 && text[i] === ',') return text.slice(open + 1, i);
    if (depth === 0) return text.slice(open + 1, i);
  }
  return text.slice(open + 1);
}

// `Sphere.center` is `Ecef` (contract/common.d.ts). The Cesium camera also
// takes lon, lat and height there, so a caller that gives them works on
// Cesium and leaves another renderer's camera with no point to fly to.
test('no flyToBounds caller gives the sphere centre as lon, lat and height', () => {
  const geodetic = [];
  let calls = 0;
  for (const path of sources(SRC)) {
    const text = readFileSync(path, 'utf8');
    for (const match of text.matchAll(/\.flyToBounds\??\.?\(/g)) {
      calls += 1;
      const sphere = firstArgument(text, match.index + match[0].length - 1);
      if (/center\s*:\s*\{[^}]*\blon\b/.test(sphere))
        geodetic.push(
          `${relative(SRC, path)}:${text.slice(0, match.index).split('\n').length}`,
        );
    }
  }
  assert.ok(calls >= 10, `only ${calls} flyToBounds calls were found`);
  assert.deepEqual(geodetic, []);
});
