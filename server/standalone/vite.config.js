import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { defineConfig, loadEnv } from 'vite';
import { resolveAllowedHosts } from '../../build/allowedHosts.js';
import { createBrowserViteConfig } from '../../build/vite.js';
import { localProviderPlugins } from '../providers/local.js';
import { localMcpPlugin } from '../mcp/plugin.js';
import { apiNotFoundPlugin } from './api-not-found.js';
import { googleTokenUnavailablePlugin } from './google-token-unavailable.js';
import { standaloneVoiceTools } from './voiceTools.js';
import { unwatchedRuntimeDirsPlugin } from './unwatched-cache.js';

const root = fileURLToPath(new URL('../../', import.meta.url));

/**
 * The dotenv files Vite reads for a mode, in the same order it reads them.
 * Kept here so the file values can be read WITHOUT the environment overlay
 * `loadEnv` applies (see readDotenvFiles).
 */
export function dotenvFilesForMode(mode, envDir = root) {
  return ['.env', '.env.local', `.env.${mode}`, `.env.${mode}.local`].map(
    (file) => path.join(envDir, file),
  );
}

/**
 * Read the checkout's dotenv files directly, with NO environment overlay.
 *
 * `loadEnv` resolves a key from `process.env` FIRST (an empty string there
 * counts as "resolved"), so the file's real value never survives the call —
 * the environment wins even when it holds nothing. This reads the files
 * themselves so the file's value is still available to be compared.
 *
 * @param {string} mode The Vite mode.
 * @param {string} [envDir] The directory holding the dotenv files.
 * @returns {Record<string, string>} The parsed values, later files winning.
 */
export function readDotenvFiles(mode, envDir = root) {
  const parsed = {};
  for (const file of dotenvFilesForMode(mode, envDir)) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch (error) {
      // A missing file is the normal case; anything else is a real fault and
      // must not silently read as "no value configured".
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    Object.assign(parsed, parseEnv(text));
  }
  return parsed;
}

/**
 * Merge the checkout's dotenv files into `process.env`, the file value
 * winning over an EMPTY environment variable.
 *
 * Why an empty variable must not win: a deployment that exports
 * `CESIUM_ION_TOKEN=""` (a compose `environment:` entry, a CI default, a
 * shell that names a variable with nothing after it) would otherwise SHADOW
 * the real value the same key has in the mounted `.env` file — the file is
 * only consulted when the variable is undefined, and "" IS defined. The app
 * then bakes an empty token into the browser bundle and the globe never
 * renders, even though the secret is right there on disk.
 *
 * A deliberately CLEARED key still stays empty: the POWER UP panel removes a
 * key by commenting its assignment out of the file (`upsertDotenvValues`
 * with a `null` value), so the file no longer defines that name at all and
 * this merge has nothing to adopt — the empty variable survives untouched.
 *
 * @param {Record<string, string>} loaded The dotenv values, read from the files.
 * @param {Record<string, string|undefined>} env The environment to merge into.
 * @returns {Record<string, string|undefined>} The same environment object.
 */
export function mergeDotenvIntoEnv(loaded, env = process.env) {
  for (const [key, value] of Object.entries(loaded)) {
    const current = env[key];
    // Undefined OR empty/whitespace-only: the file is the better answer.
    if (current === undefined || String(current).trim() === '')
      env[key] = value;
  }
  return env;
}

/**
 * Build the standalone configuration.
 *
 * @param {object} options The Vite config options.
 * @param {string} options.command The Vite command ('serve' or 'build').
 * @param {string} options.mode The Vite mode.
 * @param {string} [options.root] The checkout root; the repository's own by
 *   default, overridable so a test can point it at a fixture directory.
 */
export function standaloneViteConfig({
  command,
  mode,
  root: configRoot = root,
}) {
  // The files are read directly, because loadEnv resolves a key from
  // process.env first — an empty variable there would hide the file's real
  // value before the merge ever saw it.
  mergeDotenvIntoEnv(readDotenvFiles(mode, configRoot), process.env);
  // loadEnv still runs for everything else it contributes (the VITE_ prefixed
  // variables the client bundle reads, and the NODE_ENV/BROWSER markers).
  loadEnv(mode, configRoot, '');
  const tools = standaloneVoiceTools();
  return createBrowserViteConfig({
    plugins: [
      ...localProviderPlugins({ realtime: { tools }, gemini: { tools } }),
      localMcpPlugin(),
      googleTokenUnavailablePlugin(),
      apiNotFoundPlugin(),
      unwatchedRuntimeDirsPlugin(),
    ],
    googleApiKey: process.env.GOOGLE_MAPS_API_KEY,
    cesiumToken: process.env.CESIUM_ION_TOKEN,
    mapillaryToken: process.env.MAPILLARY_CLIENT_TOKEN,
    host: process.env.HOST,
    port: process.env.PORT,
    allowedHosts: resolveAllowedHosts(process.env.GEV_ALLOWED_HOSTS),
    command,
  });
}

/** Load this checkout's configuration and attach its local provider middleware. */
export default defineConfig((options) => standaloneViteConfig(options));
