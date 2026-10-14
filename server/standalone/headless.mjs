import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { localProviderPlugins } from '../providers/local.js';
import { apiNotFoundPlugin } from './api-not-found.js';
import { standaloneVoiceTools } from './voiceTools.js';
import { createConnectRouter, shadowedMounts } from './connectRouter.js';
import { API_ROUTES } from '../apiRoutes.js';
import {
  isAllowedHost,
  resolveAllowedHosts,
} from '../../build/allowedHosts.js';

const DEFAULT_PORT = 4174;
const DEFAULT_HOST = '127.0.0.1';
/** How long close() lets in-flight responses drain before force-closing them. */
const DEFAULT_SHUTDOWN_GRACE_MS = 5000;

/**
 * Run the same `/api/*` provider proxies `vite dev` / `vite preview` serve,
 * as a standalone Node process with no Vite involved.
 *
 * `CONTRIBUTING.md` is explicit that `vite preview` "is not a production
 * server" — this exists for anything that needs the provider layer running
 * unattended (a background collector, a second machine, a container) without
 * the dev-server semantics (HMR, the SPA history fallback, `vite`'s own
 * process lifecycle) that come with it.
 *
 * It listens on its own port (default 4174; `vite dev`/`vite preview` default
 * to 4173 per `.env.example`) so it can run *alongside* the normal app, not
 * instead of it — the two share the same `.gev-cache/` on disk and the same
 * `.env` keys without conflicting.
 *
 * Every provider plugin already exposes plain Connect-style middleware via
 * `configureServer(server)` / `configurePreviewServer(server)`, expecting
 * `server.middlewares` (a Connect app) and, optionally, `server.httpServer`
 * (used only to attach a `'close'` listener for graceful shutdown — see
 * `transit.js` and `vessels/ais-live.js`). `connectRouter.js` supplies a
 * standalone equivalent of the first; a real `http.Server` supplies the
 * second, so those shutdown hooks work unmodified.
 */

/**
 * `gev-key-setup` (`../standalone/key-setup.js`) backs the in-app "POWER UP"
 * panel: it writes credential files to disk from a POST body and, on save,
 * calls `server.restart()` — a real Vite dev-server method this process does
 * not provide (calling it would throw). `CONTRIBUTING.md` documents
 * `/api/setup/*` as development-only, so excluding it here is both required
 * for correctness and desirable for anything reachable outside a developer's
 * own machine: a write-capable configuration endpoint has no reason to exist
 * on a headless deployment.
 */
const DEV_ONLY_PLUGIN_NAMES = new Set(['gev-key-setup']);

/**
 * The provider plugins this server mounts: everything `localProviderPlugins`
 * returns, minus the dev-only key-setup panel. Filtering by name (rather
 * than re-listing providers here) means this stays in sync automatically as
 * `server/providers/local.js` adds new ones.
 *
 * Providers are built exactly as `server/standalone/vite.config.js` builds
 * them, including the voice tools offered in realtime sessions, so
 * `/api/realtime/token` hands out the same session here. That config's
 * `localMcpPlugin` (`/mcp`) is deliberately not mounted: it drives the app
 * itself and lives outside `/api`, while this server is the `/api` provider
 * surface only.
 */
export function headlessProviderPlugins() {
  return localProviderPlugins({
    realtime: { tools: standaloneVoiceTools() },
  }).filter((plugin) => !DEV_ONLY_PLUGIN_NAMES.has(plugin.name));
}

/** Liveness/readiness endpoint — for an orchestrator, and for a remote caller to check before it starts polling. */
export function healthzPlugin() {
  const startedAtMs = Date.now();
  return {
    name: 'gev-headless-healthz',
    configureServer(server) {
      server.middlewares.use('/healthz', (req, res, next) => {
        // The mount matches /healthz and everything below it (connect
        // semantics), but the contract is exactly GET /healthz. After the
        // router's rewrite, an exact hit is "/" (plus any query string);
        // anything deeper falls through to the router's 404 rather than
        // answering a misleading 200.
        const rest = (req.url || '/').split('?')[0];
        if (rest !== '/') return next();
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, {
            Allow: 'GET, HEAD',
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          });
          res.end(JSON.stringify({ error: 'method_not_allowed' }));
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        // HEAD gets the same status and headers without a body.
        res.end(
          req.method === 'HEAD'
            ? undefined
            : JSON.stringify({ ok: true, uptimeMs: Date.now() - startedAtMs }),
        );
      });
    },
  };
}

/**
 * Should a request carrying this `Host` header be served?
 *
 * Listening on 127.0.0.1 does not by itself stop a hostile web page from
 * reaching this server: through DNS rebinding, a hostname the attacker
 * controls can be made to resolve to 127.0.0.1, and the browser then sends
 * the page's requests here with that hostname in `Host`. This server has no
 * authentication and serves credential-backed routes, so it must reject
 * hostnames it does not expect (review feedback on #860).
 *
 * The rule is the one `vite dev`/`vite preview` apply to these same routes,
 * reused from `build/allowedHosts.js` rather than reimplemented, and fed by
 * the same `GEV_ALLOWED_HOSTS` variable:
 * - IP literals are always allowed (rebinding needs an attacker-controlled
 *   *name*, so an address cannot be abused this way).
 * - `localhost` and any `*.localhost` name are allowed.
 * - The configured bind host itself is allowed, when it is a name.
 * - Each explicitly listed host is allowed. `resolveAllowedHosts` drops
 *   suffix (`.example.com`) and wildcard entries on purpose, so every
 *   allowed name is spelled out.
 * - A missing `Host` header is rejected.
 *
 * @param {string|undefined} hostHeader
 * @param {{allowedHosts?: string[], bindHost?: string}} [options]
 */
export function isHostAllowed(
  hostHeader,
  { allowedHosts = [], bindHost = '' } = {},
) {
  const additional = bindHost ? [String(bindHost).toLowerCase()] : [];
  return isAllowedHost(hostHeader, allowedHosts, additional);
}

/**
 * Build the headless API app without starting it: a router with every given
 * plugin's middleware mounted, in the given order. Returns the pieces
 * unstarted so a test can drive requests through `router.handle` directly,
 * or supply a small stub plugin list instead of the real providers (most of
 * which touch real network/API-key state as soon as they're mounted).
 *
 * @param {object} [options]
 * @param {Array<object>} [options.plugins] Defaults to healthz + every
 *   non-dev-only provider + the same `/api` 404 fallback `vite preview` uses,
 *   in that order (matching `server/standalone/vite.config.js`'s composition).
 */
export function createHeadlessApiApp({
  plugins = [
    healthzPlugin(),
    ...headlessProviderPlugins(),
    apiNotFoundPlugin(),
  ],
  allowedHosts = [],
  bindHost = DEFAULT_HOST,
  shutdownGraceMs = DEFAULT_SHUTDOWN_GRACE_MS,
} = {}) {
  const router = createConnectRouter();
  // The Host check runs before any routing, so a rejected request never
  // reaches a provider (see isHostAllowed for what is accepted and why).
  const httpServer = http.createServer((req, res) => {
    if (!isHostAllowed(req.headers.host, { allowedHosts, bindHost })) {
      res.writeHead(403, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(
        JSON.stringify({
          error: 'host_not_allowed',
          host: String(req.headers.host ?? '').replace(/:\d+$/, ''),
          hint: 'Add this host to GEV_ALLOWED_HOSTS to allow it.',
        }),
      );
      return;
    }
    router.handle(req, res);
  });
  const fakeViteServer = { middlewares: router, httpServer };
  const teardowns = [];
  for (const plugin of plugins) {
    plugin.configureServer?.(fakeViteServer);
    if (typeof plugin.closeBundle === 'function')
      teardowns.push(plugin.closeBundle);
  }

  // Bounded shutdown. httpServer.close() stops accepting connections but
  // then waits for every open response to finish, and a long-lived CCTV
  // media response may never finish on its own, which would hold SIGTERM
  // open indefinitely. The CCTV puller, the AIS watchdog and the transit
  // service also wait for the server's 'close' event to clean up, so their
  // teardown was held hostage by the same connection. Instead: close idle
  // keep-alive sockets immediately, give in-flight responses a bounded
  // grace period to drain, then force-close whatever is left. The server's
  // 'close' event (and so every provider's cleanup) follows promptly, and
  // only then do the plugins' own teardowns run. close() is idempotent, so
  // a second signal does not start a second shutdown.
  let closing = null;
  function close({ graceMs = shutdownGraceMs } = {}) {
    if (!closing) closing = shutDown(graceMs);
    return closing;
  }
  async function shutDown(graceMs) {
    const closed = new Promise((resolve) => httpServer.close(() => resolve()));
    httpServer.closeIdleConnections?.();
    let timer;
    const drained = await Promise.race([
      closed.then(() => true),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), graceMs);
      }),
    ]);
    clearTimeout(timer);
    if (!drained) {
      console.warn(
        `[headless-api] responses still open after ${graceMs} ms; closing their connections`,
      );
      httpServer.closeAllConnections?.();
      await closed;
    }
    for (const closeBundle of teardowns) {
      try {
        await closeBundle();
      } catch (err) {
        console.warn(
          '[headless-api] plugin teardown failed:',
          err?.message || err,
        );
      }
    }
  }

  // Mount order is this module's contract, not something inherited from
  // connect: the router reimplements connect's first-match routing, so an
  // `/api` catch-all installed too early, or a path mounted twice, would
  // silently make providers unreachable while every handler still looks
  // correct. Refuse to build such an app rather than serve it. The real
  // composition is also pinned against server/apiRoutes.js by
  // src/tooling/apiRoutes.test.mjs; this check covers any composition.
  // Parents that pass nested paths on (server/apiRoutes.js `exactOnly`) are
  // allowed to precede their nested routes.
  const shadowed = shadowedMounts(router.mounts(), {
    exactOnly: API_ROUTES.filter((r) => r.exactOnly).map((r) => r.mount),
  });
  if (shadowed.length) {
    // Providers were already configured above, and some start background
    // work when mounted, so tear them down before refusing.
    close().catch(() => {});
    throw new Error(
      `[headless-api] unreachable mount(s): ${shadowed
        .map(
          ({ path, coveredBy }) => `${path} (covered by earlier ${coveredBy})`,
        )
        .join(
          ', ',
        )} — the /api fallback must be installed last, and each path once`,
    );
  }
  return { router, httpServer, close };
}

/**
 * Is `host` a loopback bind address, reachable only from this machine?
 *
 * Accepts `localhost`, any IPv4 address in 127.0.0.0/8 (also written as
 * IPv4-mapped IPv6, `::ffff:127.x.x.x`), and IPv6 `::1`, bracketed or not.
 * This mirrors the loopback sets in `src/keySetupCore.mjs` (`LOCAL_HOSTNAMES`,
 * `LOOPBACK_ADDRESSES`), which guard the dev-only key-setup endpoint the
 * same way. It is restated here rather than imported because those sets are
 * private to a `src/` module, and `server/` should not depend on `src/`
 * internals for a constant.
 *
 * Everything else counts as non-loopback, including the wildcard addresses
 * (`0.0.0.0`, `::`, an empty host) and any other hostname, since a name can
 * resolve to a routable address.
 */
export function isLoopbackHost(host) {
  const normalized = String(host ?? '')
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, '$1');
  if (normalized === 'localhost' || normalized === '::1') return true;
  const v4 = normalized.startsWith('::ffff:')
    ? normalized.slice(7)
    : normalized;
  return (
    /^127(\.\d{1,3}){3}$/.test(v4) &&
    v4.split('.').every((octet) => Number(octet) <= 255)
  );
}

/**
 * Fail closed on a non-loopback bind (review feedback from kvnloo on #860).
 *
 * This process has no authentication of its own, and several `/api` routes
 * are backed by operator credentials, so binding it to a routable address
 * turns a local provider process into an open network service. That should
 * be a deliberate, visible decision rather than a consequence of setting
 * `GEV_HEADLESS_HOST` and not reading the docs. A non-loopback host is
 * therefore refused unless `GEV_HEADLESS_UNSAFE_PUBLIC` is `1` or `true`.
 * There is no auth configuration to accept as an alternative yet; if one is
 * added, it should also satisfy this check.
 *
 * @returns {{ unsafePublic: boolean }} Whether the opt-in was used.
 * @throws {Error} For a non-loopback host without the opt-in.
 */
export function assertSafeBindHost(host, env = process.env) {
  if (isLoopbackHost(host)) return { unsafePublic: false };
  if (/^(1|true)$/i.test(String(env.GEV_HEADLESS_UNSAFE_PUBLIC || '').trim())) {
    return { unsafePublic: true };
  }
  throw new Error(
    `[headless-api] refusing to bind to "${host}": this server has no authentication, ` +
      'and binding to a non-loopback address would expose every /api route, including ' +
      'ones backed by operator credentials, to the network. Bind to a loopback address ' +
      '(the default is 127.0.0.1), or set GEV_HEADLESS_UNSAFE_PUBLIC=1 to accept that ' +
      'exposure deliberately.',
  );
}

/**
 * Start the headless API, bound to `127.0.0.1` by default. This process has
 * no auth of its own (matching the app's existing same-origin-only design).
 * Override the address with `GEV_HEADLESS_PORT` / `GEV_HEADLESS_HOST`; a
 * non-loopback host additionally requires `GEV_HEADLESS_UNSAFE_PUBLIC=1`
 * (see `assertSafeBindHost`). Requests whose `Host` is not an IP literal,
 * a localhost name, the bind host, or listed in the comma-separated
 * `GEV_ALLOWED_HOSTS` are rejected with 403 (see `isHostAllowed`).
 *
 * `env` and `plugins` exist for tests: `plugins` replaces the real provider
 * composition, which touches network and API-key state as soon as it is
 * mounted.
 */
export async function startHeadlessApi({
  env = process.env,
  port = Number.parseInt(env.GEV_HEADLESS_PORT || '', 10) || DEFAULT_PORT,
  host = env.GEV_HEADLESS_HOST || DEFAULT_HOST,
  plugins,
} = {}) {
  // Checked before createHeadlessApiApp(), so a refused start never
  // initializes a single provider.
  const { unsafePublic } = assertSafeBindHost(host, env);
  if (unsafePublic) {
    console.warn(
      `[headless-api] WARNING: binding to non-loopback host "${host}" with ` +
        'GEV_HEADLESS_UNSAFE_PUBLIC set. Every /api route is reachable from the ' +
        'network without authentication.',
    );
  }
  const app = createHeadlessApiApp({
    ...(plugins ? { plugins } : {}),
    allowedHosts: resolveAllowedHosts(env.GEV_ALLOWED_HOSTS),
    bindHost: host,
    shutdownGraceMs:
      Number.parseInt(env.GEV_HEADLESS_SHUTDOWN_GRACE_MS || '', 10) ||
      DEFAULT_SHUTDOWN_GRACE_MS,
  });
  // listen() reports failure (port in use, an address that cannot be bound)
  // by emitting 'error', never by calling its callback. Without a listener
  // that event crashes the process, and the providers that
  // createHeadlessApiApp() already initialized are never torn down. Reject
  // instead, tear down, and hand the original error to the caller.
  try {
    await new Promise((resolve, reject) => {
      const onError = (err) => {
        app.httpServer.off('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        app.httpServer.off('error', onError);
        resolve();
      };
      app.httpServer.once('error', onError);
      app.httpServer.once('listening', onListening);
      app.httpServer.listen(port, host);
    });
  } catch (err) {
    await app.close().catch(() => {});
    throw err;
  }
  console.log(`[headless-api] listening on http://${host}:${port}`);
  return app;
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : '';

if (import.meta.url === invokedPath) {
  try {
    // Matches the app's existing "no key required to start; .env is
    // optional" posture (see CONTRIBUTING.md) rather than requiring the
    // operator to remember `node --env-file=.env`.
    process.loadEnvFile();
  } catch {
    // No .env file, or a Node version without loadEnvFile — provider keys
    // may already be set directly in the environment (e.g. Docker's
    // `env_file:`), which is a normal and supported way to run this.
  }
  let app;
  try {
    app = await startHeadlessApi();
  } catch (err) {
    // A refused bind or a listen failure: providers are already torn down
    // by startHeadlessApi, so report the reason and exit non-zero.
    // Our own errors already carry the "[headless-api]" prefix; strip it so
    // the line does not repeat it ("failed to start: [headless-api] ...").
    const reason = String(err?.message || err).replace(
      /^\[headless-api\]\s*/,
      '',
    );
    console.error(`[headless-api] failed to start: ${reason}`);
    process.exit(1);
  }
  const shutdown = (signal) => {
    console.log(`[headless-api] ${signal} received, shutting down`);
    app.close().then(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
