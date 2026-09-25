/**
 * Directories the app writes to while it runs. None is source, and none
 * should reload anything.
 */
const RUNTIME_WRITE_GLOBS = Object.freeze([
  '**/.gev-cache/**',
  '**/.gev-logs/**',
]);

/**
 * Keep the directories the app writes to out of the dev server's file watcher.
 *
 * Disk-cached providers write a file per response into `.gev-cache`, and the
 * voice debug log appends to `.gev-logs`. Left watched, each write triggers
 * chokidar stat calls that hold the libuv threads `getaddrinfo` needs, so the
 * next upstream fetch waits on a DNS lookup that cannot get a thread.
 *
 * @returns {import('vite').Plugin} Config-only plugin; no server hooks.
 */
export function unwatchedRuntimeDirsPlugin() {
  return {
    name: 'gev-unwatched-runtime-dirs',
    apply: 'serve',
    config: () => ({
      server: { watch: { ignored: [...RUNTIME_WRITE_GLOBS] } },
    }),
  };
}
