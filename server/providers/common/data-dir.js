import path from 'node:path';

/**
 * Where the app writes at runtime (`.env`, `.gev-cache`, `.gev-logs`): unset,
 * `fallback` (the repository root). The Docker image sets it to /data so /app
 * can stay read-only.
 *
 * Read from the real environment, not a `.env` line: a launch setting cannot
 * move the `.env` it would be read from.
 * @param {string} [fallback]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function dataDir(fallback = process.cwd(), env = process.env) {
  const configured = String(env.GEV_DATA_DIR ?? '').trim();
  return configured ? path.resolve(configured) : fallback;
}
