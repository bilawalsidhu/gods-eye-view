// Build guard: the Cesium-mode page must not load three or Navara. The
// initial chunks are every entry chunk and what it imports statically;
// navaraMode.js reaches Navara only through import(), so three and
// @navaramap/* belong to lazy chunks. This checks the bundle's module ids
// (what Rollup put in each chunk), and fails the build otherwise.

/**
 * Module ids that only the Navara engine may load, when no package list is
 * given (the browser build passes the full dependency closure,
 * navaraDependencies.js).
 */
export const ENGINE_ONLY_MODULES =
  /[\\/]node_modules[\\/](?:three|@navaramap[\\/][^\\/]+|postprocessing)[\\/]/;

/**
 * Engine-only modules in initial chunks of a Rollup bundle, sorted by chunk.
 * @param {Record<string, { type: string, isEntry?: boolean, imports?: string[], moduleIds?: string[] }>} bundle
 * @returns {{ chunk: string, module: string }[]}
 */
export function initialChunkViolations(bundle, pattern = ENGINE_ONLY_MODULES) {
  const initial = new Set();
  const visit = (fileName) => {
    const chunk = bundle[fileName];
    if (!chunk || chunk.type !== 'chunk' || initial.has(fileName)) return;
    initial.add(fileName);
    for (const imported of chunk.imports ?? []) visit(imported);
  };
  for (const [fileName, chunk] of Object.entries(bundle))
    if (chunk.type === 'chunk' && chunk.isEntry) visit(fileName);
  const violations = [];
  for (const fileName of [...initial].sort())
    for (const module of bundle[fileName].moduleIds ?? [])
      if (pattern.test(module)) violations.push({ chunk: fileName, module });
  return violations;
}

/** The Rollup plugin: fails generateBundle when an initial chunk holds three or Navara. */
export function initialChunkGuard({
  log = console.log,
  pattern = ENGINE_ONLY_MODULES,
} = {}) {
  return {
    name: 'gev-initial-chunk-guard',
    generateBundle(_options, bundle) {
      const violations = initialChunkViolations(bundle, pattern);
      if (violations.length) {
        this.error(
          'Navara-only modules in the Cesium-mode initial chunks:\n' +
            violations
              .map(({ chunk, module }) => `  ${chunk}: ${module}`)
              .join('\n'),
        );
        return;
      }
      log('[initial-chunks] no Navara-only modules in the initial chunks');
    },
  };
}
