/**
 * Host header allowlist for the Vite dev/preview server.
 *
 * Binding to a wildcard interface only controls which network interfaces accept
 * connections. It must not turn into a wildcard Host-header policy: this server
 * brokers configured API keys through local proxy routes.
 */
export const DEFAULT_ALLOWED_HOSTS = Object.freeze([
  'localhost',
  '127.0.0.1',
]);

/**
 * Resolve Vite's allowedHosts setting from an optional comma-separated list.
 * Empty entries and suffix/wildcard entries are ignored; repeated names keep
 * their first occurrence. Vite treats leading-dot values as suffix wildcards,
 * which would defeat an explicit host policy.
 *
 * @param {string|undefined|null} configuredHosts
 * @returns {string[]}
 */
export function resolveAllowedHosts(configuredHosts) {
  const hosts = String(configuredHosts ?? '')
    .split(',')
    .map((host) => host.trim())
    .filter((host) => host && !host.startsWith('.') && !host.includes('*'));
  return [...new Set([...DEFAULT_ALLOWED_HOSTS, ...hosts])];
}
