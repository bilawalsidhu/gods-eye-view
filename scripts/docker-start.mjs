#!/usr/bin/env node
/**
 * Docker launcher — the container's entry point (see Dockerfile).
 *
 * `compose.yaml` publishes the port on the host's loopback, but Docker still
 * delivers the host's own browser to the container FROM the container
 * network's gateway address, never from 127.0.0.1. Provider Settings admits
 * loopback only, so without this the POWER UP panel refuses the very machine
 * running the container. This launcher reads the gateway out of the kernel
 * routing table and declares exactly that one address trusted, then starts
 * Vite the way scripts/pinokio-start.mjs does.
 */
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectInvocation } from './pinokio-install.mjs';
import { loadViteFromCanonicalRoot } from './pinokio-start.mjs';

const MODULE_PATH = fileURLToPath(import.meta.url);
const ROOT = realpathSync(path.resolve(path.dirname(MODULE_PATH), '..'));
const ROUTE_TABLE = '/proc/net/route';
/** Host names the native launcher accepts; the container matches it. */
const LOCAL_ALLOWED_HOSTS = Object.freeze(['localhost', '127.0.0.1', '.local']);

/**
 * Extract the IPv4 default gateway from Linux `/proc/net/route` text. The
 * addresses there are little-endian hex and only the default route (a
 * destination of 00000000 on an interface flagged up) names a gateway.
 * Returns null when there is none — the `--network none` case, which must
 * never fabricate an address.
 * @param {string} text Raw routing-table contents.
 * @returns {string|null} Dotted-quad gateway, or null.
 */
export function defaultGatewayFromRouteTable(text) {
  const lines = String(text || '').split(/\r?\n/).slice(1);
  for (const line of lines) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 4) continue;
    const [, destination, gateway, flags] = fields;
    if (destination !== '00000000' || !/^[0-9a-f]{8}$/i.test(gateway)) continue;
    if ((Number.parseInt(flags, 16) & 0x1) === 0) continue; // RTF_UP
    const octets = [6, 4, 2, 0].map((offset) =>
      Number.parseInt(gateway.slice(offset, offset + 2), 16),
    );
    if (octets.every((octet) => octet === 0)) continue;
    return octets.join('.');
  }
  return null;
}

/**
 * Decide this launch's trusted-peer list. An operator value always wins, so a
 * compose override stays authoritative; otherwise the gateway alone is
 * trusted. No gateway trusts nothing and Provider Settings stays loopback-only,
 * exactly as under `npm run dev`.
 * @param {{env?: NodeJS.ProcessEnv, routeTable?: string}} input
 * @returns {string} Value for GEV_KEY_SETUP_TRUSTED_PEERS ('' trusts nothing).
 */
export function resolveTrustedPeers({ env = process.env, routeTable = '' } = {}) {
  const explicit = String(env.GEV_KEY_SETUP_TRUSTED_PEERS ?? '').trim();
  if (explicit) return explicit;
  return defaultGatewayFromRouteTable(routeTable) ?? '';
}

/**
 * Host headers this container answers to. A wildcard bind is unavoidable
 * inside a container, but build/vite.js reads that as "allow every Host"
 * (allowedHosts: true), dropping the DNS-rebinding protection `npm run dev`
 * keeps. The published port only ever delivers the host's own browser, so pin
 * the same names the native launcher uses, and still honour an operator's
 * GEV_ALLOWED_HOSTS so a LAN hostname stays addable here too. See issue #21.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]}
 */
export function resolveAllowedHosts(env = process.env) {
  const configured = String(env.GEV_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean);
  return [...new Set([...LOCAL_ALLOWED_HOSTS, ...configured])];
}

function readRouteTable() {
  try {
    return readFileSync(ROUTE_TABLE, 'utf8');
  } catch {
    return '';
  }
}

async function start() {
  const trustedPeers = resolveTrustedPeers({ routeTable: readRouteTable() });
  if (trustedPeers) {
    // Set before Vite is imported: the dev server snapshots process.env during
    // configuration, and the admission gate reads it per request.
    process.env.GEV_KEY_SETUP_TRUSTED_PEERS = trustedPeers;
    console.log(`[Docker] Provider Settings trusts the container gateway (${trustedPeers}).`);
  } else {
    console.log('[Docker] No default gateway; Provider Settings stays loopback-only.');
  }

  const port = Number.parseInt(process.env.PORT, 10) || 4173;
  const { createServer } = await loadViteFromCanonicalRoot(ROOT);
  const server = await createServer({
    root: ROOT,
    server: {
      // The container's own namespace. compose publishes this to the host's
      // 127.0.0.1 only; widening that mapping is the LAN opt-in.
      host: '0.0.0.0',
      port,
      strictPort: true,
      allowedHosts: resolveAllowedHosts(),
    },
  });
  await server.listen();
  server.printUrls();
  console.log(`[Docker] Ready at http://localhost:${port}/`);

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, async () => {
      await server.close();
      process.exit(0);
    });
  }
}

if (isDirectInvocation(process.argv[1], MODULE_PATH)) {
  start().catch((error) => {
    console.error(`[Docker] Start refused: ${error.message}`);
    process.exitCode = 1;
  });
}
