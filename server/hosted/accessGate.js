import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Password gate for a hosted (internet-facing) GEV deployment.
 *
 * Runs before every other route, static file and /api provider. Only the
 * login page, its POST, logout, and the few files a browser fetches before it
 * has a session (manifest, icons) are reachable without a valid session
 * cookie. Everything else answers 401: HTML navigations get the login page,
 * other requests get JSON.
 *
 * The session cookie is `v1.<expiresMs>.<nonce>.<hmac>` signed with
 * HMAC-SHA256 under GEV_SESSION_SECRET. Rotating the secret signs everyone out.
 */

export const SESSION_COOKIE = 'gev_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MIN_SECRET_LENGTH = 32;
const MAX_BODY_BYTES = 4096;

/** Paths served before authentication. Keep this list minimal. */
export const PUBLIC_PATHS = Object.freeze(
  new Set([
    '/login',
    '/logout',
    '/manifest.webmanifest',
    '/logo.svg',
    '/pwa-192.png',
    '/pwa-512.png',
    '/pwa-maskable-512.png',
    '/apple-touch-icon.png',
  ]),
);

/**
 * Validate hosted-mode configuration. Returns a list of problems; an empty
 * list means the gate can run. Never includes secret values.
 * @param {Record<string, string|undefined>} env
 * @returns {string[]}
 */
export function accessGateConfigProblems(env = process.env) {
  const problems = [];
  const password = env.GEV_ACCESS_PASSWORD ?? '';
  const secret = env.GEV_SESSION_SECRET ?? '';
  if (!password) problems.push('GEV_ACCESS_PASSWORD is not set');
  else if (password.length < 12)
    problems.push('GEV_ACCESS_PASSWORD must be at least 12 characters');
  if (!secret) problems.push('GEV_SESSION_SECRET is not set');
  else if (secret.length < MIN_SECRET_LENGTH)
    problems.push(
      `GEV_SESSION_SECRET must be at least ${MIN_SECRET_LENGTH} characters`,
    );
  else if (secret === password)
    problems.push('GEV_SESSION_SECRET must differ from GEV_ACCESS_PASSWORD');
  return problems;
}

function sign(secret, payload) {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

/** Constant-time string comparison that does not leak length via early exit. */
export function safeEqual(a, b) {
  const key = randomBytes(32);
  const da = createHmac('sha256', key).update(String(a)).digest();
  const db = createHmac('sha256', key).update(String(b)).digest();
  return timingSafeEqual(da, db);
}

/** Mint a signed session token. */
export function createSessionToken(secret, now = Date.now()) {
  const expires = now + SESSION_TTL_MS;
  const nonce = randomBytes(12).toString('base64url');
  const payload = `v1.${expires}.${nonce}`;
  return `${payload}.${sign(secret, payload)}`;
}

/** Verify a signed session token's signature and expiry. */
export function verifySessionToken(secret, token, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 256) return false;
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return false;
  const expires = Number(parts[1]);
  if (!Number.isFinite(expires) || expires <= now) return false;
  if (expires > now + SESSION_TTL_MS + 60_000) return false;
  const payload = parts.slice(0, 3).join('.');
  return safeEqual(parts[3], sign(secret, payload));
}

/** Parse a Cookie header into a plain object. */
export function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    const name = part.slice(0, index).trim();
    if (!name || name in out) continue;
    out[name] = part.slice(index + 1).trim();
  }
  return out;
}

/**
 * Failed-login limiter: per client key and a global ceiling. After
 * `maxPerKey` failures inside `windowMs` the key is locked out for the rest of
 * the window; the global ceiling slows down attempts spread over many IPs.
 */
export function createLoginLimiter({
  windowMs = 15 * 60 * 1000,
  maxPerKey = 5,
  maxGlobal = 50,
  now = () => Date.now(),
} = {}) {
  const failures = new Map();
  let global = [];
  const prune = (list, t) => list.filter((at) => t - at < windowMs);
  return {
    blocked(key) {
      const t = now();
      global = prune(global, t);
      const mine = prune(failures.get(key) || [], t);
      if (mine.length) failures.set(key, mine);
      else failures.delete(key);
      return mine.length >= maxPerKey || global.length >= maxGlobal;
    },
    fail(key) {
      const t = now();
      const mine = prune(failures.get(key) || [], t);
      mine.push(t);
      failures.set(key, mine);
      global = prune(global, t);
      global.push(t);
      if (failures.size > 10_000) failures.clear();
    },
    succeed(key) {
      failures.delete(key);
    },
  };
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (ch) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        ch
      ],
  );
}

/** Minimal login page: no script (the CSP forbids inline script anyway). */
export function loginPageHtml({ error = '' } = {}) {
  const message = error
    ? `<p class="error" role="alert">${escapeHtml(error)}</p>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="robots" content="noindex, nofollow" />
<meta name="theme-color" content="#05080c" />
<title>God's Eye View — Sign in</title>
<link rel="icon" type="image/svg+xml" href="/logo.svg" />
<link rel="manifest" href="/manifest.webmanifest" />
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
    padding: max(16px, env(safe-area-inset-top)) 16px max(16px, env(safe-area-inset-bottom));
    background: radial-gradient(circle at 50% 30%, #0b1a24, #05080c 70%);
    color: #d8f6ff; font-family: ui-monospace, 'JetBrains Mono', Menlo, Consolas, monospace; }
  form { width: min(360px, 100%); padding: 28px 24px; border: 1px solid rgba(0,212,255,.25);
    border-radius: 14px; background: rgba(5,12,18,.82); box-shadow: 0 0 40px rgba(0,212,255,.08); }
  .brand { display: flex; align-items: center; gap: 10px; margin: 0 0 4px; font-size: 15px; letter-spacing: 2px; }
  .brand img { width: 28px; height: 28px; }
  .brand span { color: #00d4ff; }
  .sub { margin: 0 0 22px; font-size: 10px; letter-spacing: 1.5px; color: rgba(216,246,255,.55); }
  label { display: block; font-size: 10px; letter-spacing: 1.5px; margin-bottom: 8px; color: rgba(216,246,255,.7); }
  input { width: 100%; min-height: 44px; padding: 10px 12px; font: inherit; font-size: 16px; color: inherit;
    background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.16); border-radius: 8px; }
  input:focus-visible, button:focus-visible { outline: 2px solid #00d4ff; outline-offset: 2px; }
  button { margin-top: 16px; width: 100%; min-height: 44px; font: inherit; font-size: 12px; letter-spacing: 2px;
    color: #021015; background: #00d4ff; border: 0; border-radius: 8px; cursor: pointer; }
  .error { margin: 0 0 14px; font-size: 12px; color: #ffd27d; }
</style>
</head>
<body>
<main>
<form method="post" action="/login" autocomplete="on">
  <h1 class="brand"><img src="/logo.svg" alt="" /> GOD'S EYE <span>VIEW</span></h1>
  <p class="sub">PRIVATE DEPLOYMENT · SIGN IN</p>
  ${message}
  <label for="password">ACCESS PASSWORD</label>
  <input id="password" name="password" type="password" autocomplete="current-password" required autofocus />
  <button type="submit">SIGN IN</button>
</form>
</main>
</body>
</html>`;
}

function readForm(req) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        finish(null);
        req.destroy?.();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () =>
      finish(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))),
    );
    req.on('error', () => finish(null));
  });
}

function wantsHtml(req) {
  const accept = String(req.headers?.accept || '');
  return (
    (req.method === 'GET' || req.method === 'HEAD') &&
    accept.includes('text/html')
  );
}

function sendLogin(res, status, error) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(loginPageHtml({ error }));
}

function clientKey(req, trustProxy) {
  if (trustProxy) {
    const forwarded = String(req.headers?.['x-forwarded-for'] || '')
      .split(',')[0]
      .trim();
    if (forwarded) return forwarded;
  }
  return req.socket?.remoteAddress || 'unknown';
}

/**
 * Build the gate middleware (connect-style `(req, res, next)`).
 * @param {object} options
 * @param {string} options.password Access password.
 * @param {string} options.secret HMAC key for session cookies.
 * @param {boolean} [options.secureCookie=true] Set the Secure attribute.
 * @param {boolean} [options.trustProxy=false] Read client IP from X-Forwarded-For.
 * @param {number} [options.failureDelayMs=750] Delay before answering a bad password.
 * @param {() => number} [options.now]
 */
export function createAccessGate({
  password,
  secret,
  secureCookie = true,
  trustProxy = false,
  failureDelayMs = 750,
  now = () => Date.now(),
  limiter = createLoginLimiter({ now }),
} = {}) {
  if (!password || !secret)
    throw new Error('Access gate requires a password and a session secret');
  const cookieAttrs = `Path=/; HttpOnly; SameSite=Lax${secureCookie ? '; Secure' : ''}`;
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const authed = (req) =>
    verifySessionToken(
      secret,
      parseCookies(req.headers?.cookie)[SESSION_COOKIE],
      now(),
    );

  return async function accessGate(req, res, next) {
    const url = new URL(req.url || '/', 'http://gate.invalid');
    const path = url.pathname;

    if (path === '/login') {
      if (req.method === 'POST') {
        const key = clientKey(req, trustProxy);
        if (limiter.blocked(key)) {
          await delay(failureDelayMs);
          res.setHeader('Retry-After', '900');
          return sendLogin(
            res,
            429,
            'Too many attempts. Try again in 15 minutes.',
          );
        }
        const form = await readForm(req);
        const supplied = form?.get('password') ?? '';
        if (!form || !safeEqual(supplied, password)) {
          limiter.fail(key);
          await delay(failureDelayMs);
          return sendLogin(res, 401, 'Incorrect password.');
        }
        limiter.succeed(key);
        const maxAge = Math.floor(SESSION_TTL_MS / 1000);
        res.statusCode = 303;
        res.setHeader(
          'Set-Cookie',
          `${SESSION_COOKIE}=${createSessionToken(secret, now())}; ${cookieAttrs}; Max-Age=${maxAge}`,
        );
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Location', '/');
        return res.end();
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        if (authed(req)) {
          res.statusCode = 303;
          res.setHeader('Location', '/');
          return res.end();
        }
        return sendLogin(res, 200, '');
      }
      res.statusCode = 405;
      res.setHeader('Allow', 'GET, POST');
      return res.end();
    }

    if (path === '/logout') {
      res.statusCode = 303;
      res.setHeader(
        'Set-Cookie',
        `${SESSION_COOKIE}=; ${cookieAttrs}; Max-Age=0`,
      );
      // Drop the cached app shell and unregister the service worker.
      res.setHeader('Clear-Site-Data', '"cache", "storage"');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Location', '/login');
      return res.end();
    }

    if (authed(req)) return next();
    if (
      PUBLIC_PATHS.has(path) &&
      (req.method === 'GET' || req.method === 'HEAD')
    )
      return next();

    if (wantsHtml(req)) return sendLogin(res, 401, '');
    res.statusCode = 401;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    return res.end(JSON.stringify({ error: 'Authentication required' }));
  };
}

/** Middleware that refuses everything: hosted mode without configuration. */
export function failClosedMiddleware(problems) {
  return (req, res) => {
    res.statusCode = 503;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(
      `GEV is not configured for hosted use:\n- ${problems.join('\n- ')}\n`,
    );
  };
}

/** Vite plugin wrapper so the gate runs before preview static files and /api. */
export function accessGatePlugin(middleware) {
  return {
    name: 'gev-access-gate',
    enforce: 'pre',
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
    configureServer(server) {
      server.middlewares.use(middleware);
    },
  };
}
