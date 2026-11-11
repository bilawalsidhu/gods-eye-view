// The packages only the Navara engine brings: the dependency closure of
// @navaramap/three and @navaramap/three-default-plugin (dependencies and
// peer dependencies, read from node_modules), without the packages the
// app's other bundled dependencies reach too (Cesium is external), plus
// three and postprocessing, which
// the Cesium-mode page never loads statically either. The initial-chunk
// guard (initialChunkGuard.js) fails the build when one of them is in an
// initial chunk.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const NAVARA_ROOTS = Object.freeze([
  '@navaramap/three',
  '@navaramap/three-default-plugin',
]);
const ALWAYS_ENGINE_ONLY = Object.freeze(['three', 'postprocessing']);
// Not bundled: vite-plugin-cesium serves Cesium as a script, so what only
// Cesium reaches (draco3d, …) is not in the app's bundled graph.
const EXTERNAL = Object.freeze(['cesium']);

function readManifest(root, name) {
  const file = path.join(root, 'node_modules', name, 'package.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}

/** Every package reachable from `names` through installed manifests. */
export function dependencyClosure(root, names) {
  const seen = new Set();
  const queue = [...names];
  while (queue.length) {
    const name = queue.pop();
    if (seen.has(name)) continue;
    const manifest = readManifest(root, name);
    if (!manifest) continue;
    seen.add(name);
    for (const next of Object.keys({
      ...manifest.dependencies,
      ...manifest.peerDependencies,
    }))
      queue.push(next);
  }
  return seen;
}

/** The engine-only package names, sorted. */
export function navaraOnlyPackages(root) {
  const app = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const navara = dependencyClosure(root, NAVARA_ROOTS);
  const appRoots = Object.keys(app.dependencies ?? {}).filter(
    (name) =>
      !navara.has(name) &&
      !ALWAYS_ENGINE_ONLY.includes(name) &&
      !EXTERNAL.includes(name),
  );
  const shared = dependencyClosure(root, appRoots);
  return [
    ...new Set([
      ...[...navara].filter((name) => !shared.has(name)),
      ...ALWAYS_ENGINE_ONLY,
    ]),
  ].sort();
}

/** A module-id pattern matching node_modules/<package>/ for the names. */
export function packagePattern(names) {
  const escaped = names.map((name) =>
    name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('/', '[\\\\/]'),
  );
  return new RegExp(
    `[\\\\/]node_modules[\\\\/](?:${escaped.join('|')})[\\\\/]`,
  );
}
