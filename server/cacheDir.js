import path from 'node:path';

/**
 * Root of the on-disk provider caches (`.gev-cache`). A checkout keeps it in
 * the working directory; the desktop app sets GEV_STATE_DIR so the caches
 * survive an upgrade instead of landing in the install directory.
 * @param {...string} parts path segments below the cache root
 */
export function gevCachePath(...parts) {
  const base = process.env.GEV_STATE_DIR
    ? path.resolve(process.env.GEV_STATE_DIR)
    : process.cwd();
  return path.join(base, '.gev-cache', ...parts);
}
