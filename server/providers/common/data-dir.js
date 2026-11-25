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

/**
 * Copy dotenv values into `env`, keeping anything the launch already set.
 * GEV_DATA_DIR is never copied: it chose the directory that `.env` came from,
 * so a line inside it would point Provider Settings at a different file.
 * @param {Record<string, string>} loaded
 * @param {NodeJS.ProcessEnv} [env]
 */
export function mergeDotenv(loaded, env = process.env) {
  for (const [key, value] of Object.entries(loaded)) {
    if (key === 'GEV_DATA_DIR') continue;
    if (env[key] === undefined) env[key] = value;
  }
}
