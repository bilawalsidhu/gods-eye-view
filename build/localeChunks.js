/**
 * The build check that the page loads only the language it starts in: no
 * translation catalog (src/i18n/locales/*.json) is in a chunk the entry loads
 * at startup, and each one is a chunk of its own, loaded when its locale is
 * chosen (src/i18n/index.js). A build that breaks either fails.
 */
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const LOCALES_DIR = fileURLToPath(
  new URL('../src/i18n/locales/', import.meta.url),
);

const CATALOG_ID = /[\\/]src[\\/]i18n[\\/]locales[\\/]([^\\/?]+)\.json(?:\?|$)/;
const I18N_ID = /[\\/]src[\\/]i18n[\\/]index\.js(?:\?|$)/;

/** The locale of a catalog's module id; null for any other module. */
function catalogLocale(id) {
  return CATALOG_ID.exec(id)?.[1] ?? null;
}

/** The shipped catalogs, by locale: one JSON file each. */
export function shippedCatalogLocales(dir = LOCALES_DIR) {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
    .sort();
}

/**
 * What is wrong with a bundle's locale chunks: catalogs in the startup
 * chunks (the entries and every chunk they import statically), catalogs that
 * share a chunk, and shipped catalogs with no chunk when the translator is in
 * the bundle.
 * @param {Record<string, {type: string, fileName: string, isEntry?: boolean,
 *   imports?: string[], modules?: Record<string, unknown>}>} bundle Rollup's
 *   output bundle.
 * @param {readonly string[]} [locales] Shipped catalog locales.
 * @returns {string[]} One sentence per problem; empty when all is well.
 */
export function localeChunkProblems(bundle, locales = shippedCatalogLocales()) {
  const chunks = Object.values(bundle).filter(
    (output) => output.type === 'chunk',
  );
  const byFile = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
  const startup = new Set();
  const visit = (chunk) => {
    if (!chunk || startup.has(chunk.fileName)) return;
    startup.add(chunk.fileName);
    for (const file of chunk.imports ?? []) visit(byFile.get(file));
  };
  for (const chunk of chunks) if (chunk.isEntry) visit(chunk);

  const problems = [];
  const chunked = new Set();
  let translator = false;
  for (const chunk of chunks) {
    const ids = Object.keys(chunk.modules ?? {});
    if (ids.some((id) => I18N_ID.test(id))) translator = true;
    const catalogs = ids.map(catalogLocale).filter(Boolean);
    if (!catalogs.length) continue;
    if (startup.has(chunk.fileName))
      problems.push(
        `${chunk.fileName} loads at startup and carries the ${catalogs.join(', ')} catalog${catalogs.length > 1 ? 's' : ''}`,
      );
    if (ids.length > 1)
      problems.push(
        `${chunk.fileName} is not a chunk of its own catalog: it carries ${ids.length} modules`,
      );
    for (const locale of catalogs) chunked.add(locale);
  }
  if (translator)
    for (const locale of locales)
      if (!chunked.has(locale))
        problems.push(`the ${locale} catalog has no chunk of its own`);
  return problems;
}

/**
 * Fail a build whose locale chunks are wrong (localeChunkProblems). A build
 * that inlines its dynamic imports into one file (the MCP Apps panel) has no
 * chunks to check.
 */
export function localeChunksPlugin() {
  return {
    name: 'locale-chunks',
    apply: 'build',
    generateBundle(outputOptions, bundle) {
      if (outputOptions.inlineDynamicImports) return;
      const problems = localeChunkProblems(bundle);
      if (problems.length)
        this.error(
          `Translation catalogs must load only when their locale is chosen:\n- ${problems.join('\n- ')}`,
        );
    },
  };
}
