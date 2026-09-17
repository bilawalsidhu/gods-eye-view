import path from 'node:path';

/**
 * @file The one directory every provider caches to.
 *
 * Gitignored, and safe to delete at any time: each provider treats a missing
 * or unreadable cache as a cold start.
 *
 * The name is shared rather than spelled out at each call site because the dev
 * server has to exclude this directory from its file watcher. The tile proxies
 * write a file per tile, and a watcher reacting to each of those starves the
 * very fetches producing them. A second spelling of the name would silently
 * opt one provider back into being watched, and the symptom — slow tiles, only
 * in development, only once a layer is busy — points nowhere near the cause.
 *
 * @module providers/common/cache-dir
 */

/** Directory name, relative to the repository root. */
export const PROVIDER_CACHE_DIR_NAME = '.gev-cache';

/** Glob matching everything cached, for watcher and tooling exclusions. */
export const PROVIDER_CACHE_GLOB = `**/${PROVIDER_CACHE_DIR_NAME}/**`;

/**
 * Absolute path to a provider's own corner of the cache.
 * @param {...string} segments Path segments below the cache root.
 * @returns {string} Absolute path.
 */
export const providerCacheDir = (...segments) =>
  path.join(process.cwd(), PROVIDER_CACHE_DIR_NAME, ...segments);
