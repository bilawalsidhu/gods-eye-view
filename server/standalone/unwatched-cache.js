import { PROVIDER_CACHE_GLOB } from '../providers/common/cache-dir.js';

/**
 * Keep the provider disk cache out of the dev server's file watcher.
 *
 * The tile proxies write one file per tile, so a busy layer produces hundreds
 * of writes into a directory the watcher would otherwise be walking. Measured
 * on this checkout, watching it took a cold Xweather tile from ~150 ms to
 * 3-9 s: the watcher's own stat calls occupy the libuv thread pool that
 * `getaddrinfo` needs, so each fetch waits for a DNS lookup that cannot get a
 * thread. Nothing in the cache is source, so nothing there should reload
 * anything.
 *
 * @returns {import('vite').Plugin} Config-only plugin; no server hooks.
 */
export function unwatchedProviderCachePlugin() {
  return {
    name: 'gev-unwatched-provider-cache',
    apply: 'serve',
    config: () => ({ server: { watch: { ignored: [PROVIDER_CACHE_GLOB] } } }),
  };
}
