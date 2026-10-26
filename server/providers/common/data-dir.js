import path from 'node:path';

/**
 * Where the app writes at runtime: the saved `.env`, `.gev-cache` and
 * `.gev-logs`. Unset, that is `fallback` (the repository root), exactly as
 * before. The Docker image sets GEV_DATA_DIR=/data so the code under /app can
 * stay read-only and one volume holds everything the app keeps.
 *
 * Read from the real environment at call time. It is a launch setting, not a
 * Provider Settings key, so a `.env` line cannot move the `.env` it lives in.
 * @param {string} [fallback]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function dataDir(fallback = process.cwd(), env = process.env) {
  const configured = String(env.GEV_DATA_DIR ?? '').trim();
  return configured ? path.resolve(configured) : fallback;
}
