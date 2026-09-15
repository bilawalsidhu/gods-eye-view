import { PROVIDER_CACHE_GLOB } from '../providers/common/cache-dir.js';

/**
 * Keep the provider disk cache out of the dev server's file watcher.
 *
 * The tile proxies write one file per tile, so a busy layer is hundreds of
 * writes into a directory the watcher would otherwise be walking. Left
 * watched, a cold Xweather tile costs 3-9 s instead of ~150 ms: the watcher's
 * stat calls hold the libuv threads `getaddrinfo` needs, so each fetch waits
 * on a DNS lookup that cannot get one. Nothing in the cache is source, so
 * nothing there should reload anything either.
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
