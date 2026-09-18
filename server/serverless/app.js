import os from 'node:os';
import { createMountRouter } from './router.js';
import { mountSourceRoutes } from './sources-mounts.js';

/** VITE_SERVERLESS_MODE / SERVERLESS_MODE mirror the client-side build-time flag; VERCEL is set by the platform itself. */
/** Accept the usual truthy spellings (`true`, `1`, `yes`) for an env flag. */
function flagOn(value) {
  return ['true', '1', 'yes'].includes(String(value ?? '').toLowerCase());
}

function resolveServerlessMode(explicit) {
  if (explicit !== undefined) return Boolean(explicit);
  return (
    flagOn(process.env.VITE_SERVERLESS_MODE) ||
    flagOn(process.env.SERVERLESS_MODE) ||
    Boolean(process.env.VERCEL)
  );
}

let cwdRedirected = false;

/**
 * Redirect `process.cwd()` to a writable directory, once, BEFORE the
 * provider modules are imported.
 *
 * Several provider modules compute a `.gev-cache` path from `process.cwd()`
 * at MODULE-EVALUATION time rather than inside their exported factory
 * function — e.g. `OVERPASS_DISK_DIR` in server/providers/overpass/constants.js
 * and `MILITARY_INSTALLATION_DISK_DIR` in
 * server/providers/military-installations/constants.js are top-level
 * `const`s. ES module static imports are fully evaluated before the
 * importing module's own body runs, so a plain top-level
 * `import { localProviderPlugins } from '../providers/local.js'` at the top
 * of THIS file would load those modules — and evaluate their top-level
 * `process.cwd()` reads — before any code in this file had a chance to
 * chdir. That is why `buildServerlessApi` below performs a DYNAMIC
 * `await import('../providers/local.js')` AFTER calling this, rather than a
 * static import: dynamic import is the only way to sequence "chdir, then
 * load the provider graph" for modules that read `process.cwd()` at import
 * time.
 *
 * Vercel's deployed function filesystem is read-only outside of `/tmp`, so
 * every provider's on-disk cache must resolve under the OS temp dir in
 * serverless mode. This does NOT affect `defaultSourceRoot`
 * (server/providers/common/source-root.js), which is derived from
 * `import.meta.url` rather than `process.cwd()` and keeps resolving to the
 * deployed bundle directory — which is what lets the cctv provider keep
 * reading its shipped `config/*.json` fixtures (see vercel.json
 * `functions["api/*.js"].includeFiles` — the glob that matches the
 * catch-all, since a literal `[...route]` key would be read as a character class).
 */
function ensureWritableCwd() {
  if (cwdRedirected) return;
  cwdRedirected = true;
  try {
    process.chdir(os.tmpdir());
  } catch (error) {
    console.warn(
      '[serverless] could not chdir to a writable cache directory:',
      error?.message || error,
    );
  }
}

/** JSON 501 helper for a feature this deployment deliberately does not support. */
function unavailableInServerless(feature, message) {
  return (req, res) => {
    res.statusCode = 501;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(
      JSON.stringify({ error: 'unavailable_in_serverless', feature, message }),
    );
  };
}

// Plugin names (server/providers/**'s `name:` field) that this router never
// mounts, regardless of mode. keySetupEndpoint() (server/standalone/key-setup.js,
// plugin name 'gev-key-setup') validates and writes credentials into the
// checkout's .env / pinokio/ENVIRONMENT and calls `server.restart()` — none of
// which is meaningful (or safe: the deployed filesystem is read-only) once
// this is not a real Vite dev server. `/api/setup/status` therefore 404s
// through the same not-found layer every other unknown route hits, which is
// exactly the signal src/keySetup.js already treats as "remove the panel".
const SKIP_ALWAYS = new Set(['gev-key-setup']);

// Plugin names skipped ONLY in serverless mode, because configureServer()
// itself has an eager side effect that cannot be undone by simply not
// forwarding requests to it:
//
//  - 'ais-live-proxy' (server/providers/vessels/ais-live.js): its
//    configureServer() calls startAisStreamWatchdogTick(), which starts an
//    (unref'd) setInterval THE MOMENT configureServer runs — independent of
//    any request — and that tick calls ensureAisStreamConnection(), which
//    opens the persistent outbound WebSocket to AISStream when
//    AISSTREAM_API_KEY is set. A Vercel Function instance can be frozen
//    between invocations and killed at any time; a live per-instance
//    WebSocket plus a per-instance in-memory vessel cache cannot be relied
//    on to exist across two calls, and AISStream allows only ONE connection
//    per key, so a fleet of function instances would fight over it. The
//    factory call `aisLiveProxy()` in server/providers/local.js itself is
//    inert (it only returns the plugin descriptor), so simply never calling
//    ITS `.configureServer()` is sufficient to prevent both the mount and
//    the timer/socket — nothing needs to be undone afterwards.
const SKIP_WHEN_SERVERLESS = new Set(['ais-live-proxy']);

/**
 * Build one serverless API instance: a Connect-compatible router with every
 * local provider plugin's middleware mounted on it, in the same order
 * server/standalone/vite.config.js uses.
 *
 * @param {{serverlessMode?: boolean}} [options]
 */
async function createServerlessApi({ serverlessMode: explicitMode } = {}) {
  const serverlessMode = resolveServerlessMode(explicitMode);
  if (serverlessMode) ensureWritableCwd();

  // Dynamic on purpose — see ensureWritableCwd's comment above.
  const [{ localProviderPlugins }, { apiNotFoundPlugin }] = await Promise.all([
    import('../providers/local.js'),
    import('../standalone/api-not-found.js'),
  ]);

  const router = createMountRouter();
  const fakeServer = {
    middlewares: router,
    httpServer: undefined,
    config: {},
    restart() {
      return Promise.resolve();
    },
  };

  if (serverlessMode) {
    // Registered BEFORE the provider layers below, so they intercept these
    // exact mounts unconditionally (Connect walks layers in registration
    // order and stops at the first one that responds without calling next()).
    router.use(
      '/api/ais-live',
      unavailableInServerless(
        'ais-live',
        'Live vessel relay (AISStream WebSocket) is unavailable in the serverless deployment',
      ),
    );
    router.use(
      '/api/realtime/token',
      unavailableInServerless(
        'voice-realtime',
        'Voice control (OpenAI Realtime ephemeral session) is unavailable in the serverless deployment',
      ),
    );
    // Best-effort diagnostic sink (server/providers/openai/debug-log.js
    // normally appends JSONL under `${sourceRoot}/.gev-logs`, which resolves
    // under the read-only deployment directory, not /tmp). The client already
    // avoids calling this under the serverless flag (src/voice/realtimeBackend.js
    // never reaches a connected session to begin with), so a residual call is
    // answered as a silent no-op rather than a 501 that would surface as a
    // console error for a purely cosmetic diagnostics line.
    router.use('/api/realtime/debug-log', (req, res) => {
      res.statusCode = 204;
      res.setHeader('Cache-Control', 'no-store');
      res.end();
    });
  }

  // Gate 3 — every /api/sources/* adapter (row 1 earthquakes onwards) is
  // served by this catch-all, not by separate functions (see sources-mounts.js).
  mountSourceRoutes(router);

  for (const plugin of localProviderPlugins()) {
    if (SKIP_ALWAYS.has(plugin.name)) continue;
    if (serverlessMode && SKIP_WHEN_SERVERLESS.has(plugin.name)) continue;
    if (typeof plugin.configureServer === 'function') {
      await plugin.configureServer(fakeServer);
    }
  }

  // Same 404 JSON as server/standalone/api-not-found.js, installed last so
  // it only ever answers a request no provider layer (or guard above)
  // already handled.
  apiNotFoundPlugin().configureServer(fakeServer);

  return {
    router,
    serverlessMode,
    /**
     * Run one request through the router and resolve once the response has
     * actually finished — `router.handle()` walks the layer stack
     * synchronously but a matched handler is usually `async` and calls
     * `res.end()` later, so waiting on `res`'s own lifecycle events is the
     * only way to know the request is really done.
     */
    handle(req, res) {
      return new Promise((resolve) => {
        res.once('finish', resolve);
        res.once('close', resolve);
        router.handle(req, res);
      });
    },
  };
}

let singleton = null;

/** Memoised singleton so a warm Vercel function instance reuses the constructed router. */
function getServerlessApi(options) {
  if (!singleton) singleton = createServerlessApi(options);
  return singleton;
}

export { createServerlessApi, getServerlessApi };
