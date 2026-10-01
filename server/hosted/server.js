import http from 'node:http';
import path from 'node:path';
import { createAuth, clearCookie } from './auth.js';
import { createQuotas, parseQuotas } from './quotas.js';
import { createMiddlewareStack } from './middleware.js';
import { createStatic } from './static.js';
import { loginPage } from './loginPage.js';
import { readJson, sendJson, sendError } from '../providers/common/json.js';
import { makeRateLimiter } from '../providers/common/rate-limit.js';

/**
 * Hosted profile: one Node HTTP server that serves the built app and mounts
 * the same provider plugins the dev server uses, behind authentication,
 * per-user quotas, same-origin checks for writes and security headers.
 *
 * Plugins that only make sense on the operator's own machine are left out:
 * the in-app key setup (writes .env), local receivers (LAN devices) and the
 * realtime debug log (writes files).
 */

export const HOSTED_EXCLUDED_PLUGINS = Object.freeze([
  'gev-key-setup',
  'local-receivers-proxy',
  'api-not-found',
]);
const DENIED_ROUTES = [
  '/api/realtime/debug-log',
  '/api/setup',
  '/api/local-receivers',
];

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader(
    'Permissions-Policy',
    'camera=(), geolocation=(self), microphone=(self)',
  );
  if (req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted)
    res.setHeader(
      'Strict-Transport-Security',
      'max-age=31536000; includeSubDomains',
    );
  next();
}

/**
 * @param {object} o
 * @param {object} o.env Environment.
 * @param {string} o.distDir Built app directory.
 * @param {object[]} o.plugins Vite-style provider plugins.
 * @param {object} [o.auth] Injected authenticator (tests).
 */
export function createHostedServer({
  env = process.env,
  distDir,
  plugins = [],
  auth = createAuth(env),
}) {
  const quotas = createQuotas(parseQuotas(env.GEV_QUOTAS));
  const loginLimiter = makeRateLimiter({
    windowMs: 60_000,
    max: 10,
    globalMax: 200,
  });
  const publicOrigin = env.GEV_PUBLIC_ORIGIN
    ? new URL(env.GEV_PUBLIC_ORIGIN).origin
    : null;
  const app = createMiddlewareStack();
  const server = http.createServer((req, res) =>
    app.handle(req, res, (err) => {
      if (err) console.error('[hosted]', err?.message || err);
      if (res.headersSent) return res.end();
      res.statusCode = err ? 500 : 404;
      res.end(err ? 'Internal error' : 'Not found');
    }),
  );
  const clientIp = (req) =>
    String(
      env.GEV_TRUST_PROXY === '1'
        ? (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
            req.socket.remoteAddress
        : req.socket.remoteAddress,
    );

  app.use(securityHeaders);
  app.use('/healthz', (req, res) => sendJson(res, 200, { ok: true }));

  app.use('/login', (req, res, next) => {
    if (req.method !== 'GET') return next();
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy':
        auth.page.mode === 'supabase'
          ? `default-src 'none'; script-src 'unsafe-inline' https://cdn.jsdelivr.net; connect-src 'self' ${auth.page.supabaseUrl}; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`
          : "default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    });
    res.end(loginPage(auth.page));
  });

  const loginRoute = (req, res) => {
    if (req.method !== 'POST') return sendError(res, 405, 'method_not_allowed');
    if (!loginLimiter(clientIp(req)))
      return sendError(res, 429, 'too_many_attempts');
    readJson(req, 16 * 1024)
      .then((body) => auth.login(req, body))
      .then((result) => {
        if (!result) return sendError(res, 401, 'invalid_credentials');
        if (result.forbidden) return sendError(res, 403, 'not_allowed');
        res.setHeader('Set-Cookie', result.cookie);
        sendJson(res, 200, { ok: true, name: result.user.name });
      })
      .catch(() => sendError(res, 400, 'bad_request'));
  };
  app.use('/auth/login', loginRoute);
  app.use('/auth/session', loginRoute);
  app.use('/auth/logout', (req, res) => {
    res.setHeader('Set-Cookie', clearCookie(auth.secure));
    if (req.method === 'GET') {
      res.writeHead(302, { Location: '/login' });
      return res.end();
    }
    sendJson(res, 200, { ok: true });
  });

  // Everything below requires a session.
  app.use((req, res, next) => {
    const user = auth.authenticate(req);
    if (!user) {
      if ((req.url || '').startsWith('/api'))
        return sendError(res, 401, 'unauthenticated');
      res.writeHead(302, { Location: '/login' });
      return res.end();
    }
    req.gevUser = user;
    next();
  });

  app.use('/api', (req, res, next) => {
    const full = req.originalUrl.split('?')[0];
    if (DENIED_ROUTES.some((r) => full === r || full.startsWith(`${r}/`)))
      return sendError(res, 404, 'not_available');
    // Writes must come from our own pages (cookies are SameSite=Lax too).
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.headers.origin;
      const host =
        req.headers['x-forwarded-host'] && env.GEV_TRUST_PROXY === '1'
          ? req.headers['x-forwarded-host']
          : req.headers.host;
      const allowed = publicOrigin
        ? [publicOrigin]
        : [`https://${host}`, `http://${host}`];
      if (!origin || !allowed.includes(origin))
        return sendError(res, 403, 'cross_origin_write');
    }
    const q = quotas.take(req.gevUser.id, full);
    res.setHeader('X-RateLimit-Limit', String(q.limit));
    res.setHeader('X-RateLimit-Remaining', String(q.remaining));
    if (!q.ok) {
      res.setHeader('Retry-After', String(q.retryAfter));
      return sendError(res, 429, 'quota_exceeded');
    }
    next();
  });

  app.use('/api/me', (req, res) =>
    sendJson(res, 200, { name: req.gevUser.name, admin: req.gevUser.admin }),
  );

  const fakeVite = {
    middlewares: app,
    httpServer: server,
    config: { mode: 'production' },
  };
  for (const plugin of plugins) {
    if (HOSTED_EXCLUDED_PLUGINS.includes(plugin?.name)) continue;
    plugin.configurePreviewServer?.(fakeVite);
  }

  app.use('/api', (req, res) => sendError(res, 404, 'unknown_api_route'));
  if (distDir) app.use(createStatic(path.resolve(distDir)));
  return server;
}
