import { PROVIDER_CACHE_GLOB } from '../providers/common/cache-dir.js';
import { RUNTIME_LOG_DIR_NAME } from '../providers/openai/debug-log.js';

/**
 * Directories this app writes to while it runs. None of them is source, and
 * none should reload anything.
 */
const RUNTIME_WRITE_GLOBS = Object.freeze([
  PROVIDER_CACHE_GLOB,
  `**/${RUNTIME_LOG_DIR_NAME}/**`,
]);

/**
 * Keep the directories the app writes to out of the dev server's file watcher.
 *
 * The tile proxies write one file per tile, so a busy layer is hundreds of
 * writes into a directory the watcher would otherwise be walking. Left
 * watched, a cold Xweather tile costs 3-9 s instead of ~150 ms: the watcher's
 * stat calls hold the libuv threads `getaddrinfo` needs, so each fetch waits
 * on a DNS lookup that cannot get one. The voice debug log is appended to from
 * the same server and starves the same requests it is recording.
 *
 * @returns {import('vite').Plugin} Config-only plugin; no server hooks.
 */
export function unwatchedProviderCachePlugin() {
  return {
    name: 'gev-unwatched-provider-cache',
    apply: 'serve',
    config: () => ({ server: { watch: { ignored: [...RUNTIME_WRITE_GLOBS] } } }),
  };
}
