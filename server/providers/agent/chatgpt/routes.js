import { admitSameSite } from '../../common/same-site.js';
import { readRequestBody } from '../../common/request.js';
import { ChatGptError } from './http.js';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function isLocalChatGptRequest(req) {
  if (!LOOPBACK.has(req.socket?.remoteAddress)) return false;
  try {
    const host = new URL(`http://${req.headers?.host}`).hostname;
    return ['localhost', '127.0.0.1', '[::1]'].includes(host);
  } catch {
    return false;
  }
}

function json(res, status, value) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(value));
}

/** Never make a local user's ChatGPT allowance available on the LAN. */
export function admitChatGptRequest(req, res) {
  if (admitSameSite(req, res)) return false;
  if (isLocalChatGptRequest(req)) return true;
  json(res, 403, {
    error: 'ChatGPT plan usage is available only from this machine.',
  });
  return false;
}

/** Credential management returns account labels and status, never tokens. */
export function createChatGptAuthHandler(auth) {
  return async (req, res) => {
    if (!admitChatGptRequest(req, res)) return;
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/status' && req.method === 'GET')
        return json(res, 200, auth.status());
      if (url.pathname === '/authorize' && req.method === 'GET') {
        res.setHeader(
          'Location',
          auth.authorize(url.searchParams.get('ticket')),
        );
        res.setHeader('Cache-Control', 'no-store');
        res.statusCode = 302;
        res.end();
        return;
      }
      if (!['/login', '/select', '/logout'].includes(url.pathname))
        return json(res, 404, { error: 'Unknown ChatGPT route.' });
      if (req.method !== 'POST')
        return json(res, 405, { error: 'Method not allowed' });
      const body = JSON.parse((await readRequestBody(req, 2048)) || '{}');
      if (!body || typeof body !== 'object' || Array.isArray(body))
        throw new SyntaxError();
      if (url.pathname === '/login')
        return json(res, 200, await auth.start(body.account || null));
      if (url.pathname === '/select')
        return json(res, 200, await auth.select(body.account));
      return json(res, 200, await auth.logout());
    } catch (error) {
      const status =
        error instanceof ChatGptError
          ? error.status
          : error instanceof SyntaxError
            ? 400
            : 503;
      json(res, status, {
        error:
          error instanceof ChatGptError
            ? error.message
            : 'ChatGPT account operation failed. Check local credential storage and try again.',
      });
    }
  };
}
