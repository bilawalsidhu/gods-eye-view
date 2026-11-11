/**
 * Host header allowlist for the Vite dev/preview server. The configuration
 * factory passes the configured names in; this module reads no environment.
 *
 * Binding to a wildcard interface only controls which network interfaces accept
 * connections. It must not turn into a wildcard Host-header policy: this server
 * brokers configured API keys through local proxy routes.
 */

import { isIP } from 'node:net';

export const DEFAULT_ALLOWED_HOSTS = Object.freeze(['localhost', '127.0.0.1']);

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

/**
 * Whether a Host header names a host the server answers, by Vite's own rule:
 * IP addresses, `localhost` and `*.localhost` always; then `additional` names
 * (the configured server host) and `allowedHosts` (a leading dot allows a
 * domain and its subdomains). `allowedHosts === true` allows every host.
 *
 * @param {string|undefined} hostHeader
 * @param {string[]|true} allowedHosts
 * @param {string[]} [additional]
 * @returns {boolean}
 */
export function isAllowedHost(hostHeader, allowedHosts, additional = []) {
  if (allowedHosts === true) return true;
  const host = String(hostHeader ?? '').trim();
  if (!host) return false;
  if (host[0] === '[') {
    const end = host.indexOf(']');
    return end > 0 && isIP(host.slice(1, end)) === 6;
  }
  const colon = host.indexOf(':');
  const hostname = (colon === -1 ? host : host.slice(0, colon)).toLowerCase();
  if (isIP(hostname) === 4) return true;
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
  if (additional.includes(hostname)) return true;
  return (allowedHosts || []).some(
    (allowed) =>
      allowed === hostname ||
      (allowed[0] === '.' &&
        (allowed.slice(1) === hostname || hostname.endsWith(allowed))),
  );
}

/**
 * Vite plugin that applies the Host check before every other middleware.
 * Vite installs its own check after the middleware plugins add in
 * `configureServer`, so without this the app's `/api` routes would answer any
 * Host, including a DNS-rebinding name. It runs first (`enforce: 'pre'`) and
 * uses the same allowed hosts as Vite, on the dev and preview servers.
 */
export function hostCheckPlugin() {
  const middleware = (config, preview) => {
    const allowed = preview
      ? config.preview.allowedHosts
      : config.server.allowedHosts;
    const additional = [config.server.host, config.preview.host].filter(
      (value) => typeof value === 'string' && value,
    );
    return (req, res, next) => {
      if (isAllowedHost(req.headers.host, allowed, additional)) return next();
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Blocked request. This host is not allowed.');
    };
  };
  return {
    name: 'host-check',
    enforce: 'pre',
    configureServer(server) {
      server.middlewares.use(middleware(server.config, false));
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware(server.config, true));
    },
  };
}
