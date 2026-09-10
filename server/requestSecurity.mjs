const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const PROXY_HEADERS = ['forwarded', 'via', 'x-forwarded-for', 'x-forwarded-host',
  'x-forwarded-port', 'x-forwarded-proto', 'x-real-ip', 'cf-connecting-ip', 'cf-ray'];

export function localRequestOrigin(req) {
  if (!LOOPBACK.has(req.socket?.remoteAddress)) return null;
  if (PROXY_HEADERS.some((name) => req.headers?.[name])) return null;
  const host = req.headers?.host;
  if (typeof host !== 'string' || /[\s/?#@\\]/.test(host)) return null;
  try {
    const url = new URL(`${req.socket?.encrypted ? 'https:' : 'http:'}//${host}`);
    return LOCAL_HOSTS.has(url.hostname) ? url.origin : null;
  } catch {
    return null;
  }
}

export function rejectRequest(res, status, error) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify({ error }));
}

/** Runs before every plugin, including on preview. Vite's Host check runs later. */
export function createRequestSecurityMiddleware({ maxConcurrent = 64 } = {}) {
  let active = 0;
  return (req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    const origin = localRequestOrigin(req);
    if (!origin) return rejectRequest(res, 403, 'This server accepts direct loopback requests only');
    if (req.headers.origin && req.headers.origin !== origin) {
      return rejectRequest(res, 403, 'Cross-origin requests are not allowed');
    }
    let pathname;
    // Connect matches mounted routes without regard to case.
    try { pathname = new URL(req.url, origin).pathname.toLowerCase(); }
    catch { return rejectRequest(res, 400, 'Invalid request URL'); }
    if (!/^\/api(?:\/|$)/.test(pathname)) return next();

    // API bodies are data, including the app-generated CCTV fallback SVG.
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox; frame-ancestors 'none'");
    res.setHeader('Cache-Control', 'no-store');
    const site = req.headers['sec-fetch-site'];
    if ((site && site !== 'same-origin') || req.headers['sec-fetch-mode'] === 'navigate') {
      return rejectRequest(res, 403, 'API requests must originate from the application');
    }
    if (!['GET', 'HEAD', 'POST'].includes(req.method)) {
      return rejectRequest(res, 405, 'Method not allowed');
    }
    if (req.method === 'POST' && req.headers.origin !== origin) {
      return rejectRequest(res, 403, 'A matching Origin is required');
    }
    if (req.method === 'POST' && /^\/api\/(?:realtime|setup)(?:\/|$)|^\/api\/openai\/hud-summary(?:\/|$)/.test(pathname)
      && req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      return rejectRequest(res, 415, 'JSON Content-Type is required');
    }
    if (active >= maxConcurrent) return rejectRequest(res, 429, 'Too many concurrent requests');
    active += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      active -= 1;
      res.off('finish', release);
      res.off('close', release);
    };
    res.once('finish', release);
    res.once('close', release);
    next();
  };
}

export function requestSecurityPlugin() {
  const install = (server) => { server.middlewares.use(createRequestSecurityMiddleware()); };
  return {
    name: 'gev-request-security',
    enforce: 'pre',
    configureServer: install,
    configurePreviewServer: install,
  };
}
