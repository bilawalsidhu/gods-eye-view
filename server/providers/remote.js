/**
 * Live remote control.
 *
 *   GET  /api/remote/stream?session=<id>   SSE. Default session is "default".
 *        The page subscribes with no bearer token. Whatever already
 *        authenticates the site covers this stream too.
 *   POST /api/remote/push                  Bearer REMOTE_CONTROL_TOKEN.
 *        Body { session?: "default" | "*", view }. `view.link` may be a share
 *        URL or its query or hash; other view fields apply on top of it.
 *        Fan-out count comes back as { ok, delivered, sessions }.
 *   GET  /api/remote/sessions              Bearer required.
 *        [{ session, clients, connectedAt }].
 *
 * An unset token answers 503. The token is compared in constant time and is
 * never written to a log or a response.
 */

import { timingSafeEqual } from 'node:crypto';
import { readRequestBody } from './common/request.js';
import {
  normalizeRemoteView,
  remoteSessionId,
} from '../../src/remote/protocol.js';

export const REMOTE_HEARTBEAT_MS = 20_000;
const MAX_BODY_BYTES = 64 * 1024;

/** `ok`, `unauthorized` or `unconfigured`. Length mismatches do not throw. */
export function remoteAuthorization(header, token) {
  if (typeof token !== 'string' || token.length === 0) return 'unconfigured';
  const presented = typeof header === 'string' ? header : '';
  const space = presented.indexOf(' ');
  if (space <= 0 || presented.slice(0, space).toLowerCase() !== 'bearer')
    return 'unauthorized';
  const given = Buffer.from(presented.slice(space + 1));
  const expected = Buffer.from(token);
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    return 'unauthorized';
  return 'ok';
}

function configuredToken(options) {
  if (options && Object.hasOwn(options, 'token')) {
    return typeof options.token === 'string' ? options.token : '';
  }
  const env = process.env.REMOTE_CONTROL_TOKEN;
  return typeof env === 'string' ? env : '';
}

/**
 * Session fan-out. Heartbeats are SSE comments so proxies keep the stream
 * open without the browser treating them as views.
 */
export function createRemoteHub({
  heartbeatMs = REMOTE_HEARTBEAT_MS,
  now = () => Date.now(),
  setTimer = setInterval,
  clearTimer = clearInterval,
} = {}) {
  const sessions = new Map();

  function drop(client) {
    if (client.closed) return;
    client.closed = true;
    if (client.timer != null) clearTimer(client.timer);
    client.bucket.clients.delete(client);
    if (client.bucket.clients.size === 0) sessions.delete(client.session);
  }

  return {
    subscribe(session, req, res) {
      let bucket = sessions.get(session);
      if (!bucket) {
        bucket = {
          connectedAt: new Date(now()).toISOString(),
          clients: new Set(),
        };
        sessions.set(session, bucket);
      }
      const client = { session, bucket, res, closed: false, timer: null };
      bucket.clients.add(client);
      client.timer = setTimer(() => {
        if (client.closed || res.writableEnded || res.destroyed) {
          drop(client);
          return;
        }
        try {
          res.write(': heartbeat\n\n');
          if (typeof res.flush === 'function') res.flush();
        } catch {
          drop(client);
        }
      }, heartbeatMs);
      client.timer?.unref?.();
      const stop = () => drop(client);
      // `res` closes when the client disconnects. The request itself can
      // finish as soon as its headers arrive, which must not drop the stream.
      res?.on?.('close', stop);
      req?.on?.('aborted', stop);
      return stop;
    },
    publish(session, view) {
      const ids =
        session === '*'
          ? [...sessions.keys()]
          : sessions.has(session)
            ? [session]
            : [];
      const payload = `data: ${JSON.stringify({ view })}\n\n`;
      let delivered = 0;
      let sessionCount = 0;
      for (const id of ids) {
        const bucket = sessions.get(id);
        if (!bucket || bucket.clients.size === 0) continue;
        let wrote = 0;
        for (const client of [...bucket.clients]) {
          try {
            client.res.write(payload);
            if (typeof client.res.flush === 'function') client.res.flush();
            wrote += 1;
          } catch {
            drop(client);
          }
        }
        if (wrote > 0) {
          delivered += wrote;
          sessionCount += 1;
        }
      }
      return { delivered, sessions: sessionCount };
    },
    list() {
      return [...sessions.entries()]
        .map(([session, bucket]) => ({
          session,
          clients: bucket.clients.size,
          connectedAt: bucket.connectedAt,
        }))
        .sort((a, b) => a.session.localeCompare(b.session));
    },
  };
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function openStream(req, res) {
  req.socket?.setNoDelay?.(true);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Content-Encoding': 'identity',
    'X-Accel-Buffering': 'no',
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  res.write(': connected\n\n');
  if (typeof res.flush === 'function') res.flush();
}

function remoteRoute(url = '/') {
  const raw = String(url || '/');
  const queryAt = raw.indexOf('?');
  let path = queryAt === -1 ? raw : raw.slice(0, queryAt);
  const query = queryAt === -1 ? '' : raw.slice(queryAt + 1);
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  const marker = '/api/remote';
  const at = path.lastIndexOf(marker);
  if (at !== -1) path = path.slice(at + marker.length);
  if (!path.startsWith('/')) path = `/${path}`;
  if (path === '/') path = '/';
  return { path: path || '/', query };
}

function authorizationHeader(req) {
  const headers = req?.headers || {};
  return headers.authorization ?? headers.Authorization;
}

/**
 * Connect-style handler for `/api/remote`. `token` forces a credential;
 * omit it to read REMOTE_CONTROL_TOKEN per request.
 */
export function createRemoteMiddleware(options = {}) {
  const hub = options.hub ?? createRemoteHub(options);
  return async function remoteMiddleware(req, res, next) {
    try {
      const { path, query } = remoteRoute(req.url);
      if (path === '/stream' && req.method === 'GET') {
        const session = remoteSessionId(
          new URLSearchParams(query).get('session'),
          {
            fallback: 'default',
          },
        );
        if (!session) {
          sendJson(res, 400, { ok: false, error: 'invalid session' });
          return;
        }
        openStream(req, res);
        hub.subscribe(session, req, res);
        return;
      }
      if (path === '/push' && req.method === 'POST') {
        const auth = remoteAuthorization(
          authorizationHeader(req),
          configuredToken(options),
        );
        if (auth === 'unconfigured') {
          sendJson(res, 503, {
            ok: false,
            error: 'remote control is not configured',
          });
          return;
        }
        if (auth !== 'ok') {
          sendJson(res, 401, { ok: false, error: 'unauthorized' });
          return;
        }
        const text = await readRequestBody(req, MAX_BODY_BYTES);
        let parsed;
        try {
          parsed = JSON.parse(text || '');
        } catch {
          sendJson(res, 400, { ok: false, error: 'invalid json' });
          return;
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          sendJson(res, 400, { ok: false, error: 'body must be an object' });
          return;
        }
        for (const key of Object.keys(parsed)) {
          if (key !== 'session' && key !== 'view') {
            sendJson(res, 400, {
              ok: false,
              error: `unknown field: ${String(key).slice(0, 40)}`,
            });
            return;
          }
        }
        const session = remoteSessionId(parsed.session, {
          allowStar: true,
          fallback: 'default',
        });
        if (!session) {
          sendJson(res, 400, { ok: false, error: 'invalid session' });
          return;
        }
        const normalized = normalizeRemoteView(parsed.view);
        if (!normalized.ok) {
          sendJson(res, 400, { ok: false, error: normalized.error });
          return;
        }
        const result = hub.publish(session, normalized.view);
        sendJson(res, 200, { ok: true, ...result });
        return;
      }
      if (path === '/sessions' && req.method === 'GET') {
        const auth = remoteAuthorization(
          authorizationHeader(req),
          configuredToken(options),
        );
        if (auth === 'unconfigured') {
          sendJson(res, 503, {
            ok: false,
            error: 'remote control is not configured',
          });
          return;
        }
        if (auth !== 'ok') {
          sendJson(res, 401, { ok: false, error: 'unauthorized' });
          return;
        }
        sendJson(res, 200, hub.list());
        return;
      }
      if (path === '/stream' || path === '/push' || path === '/sessions') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' });
        return;
      }
      if (typeof next === 'function') next();
      else sendJson(res, 404, { ok: false, error: 'not found' });
    } catch (error) {
      if (res.headersSent || res.writableEnded) return;
      if (error?.code === 'BODY_TOO_LARGE') {
        sendJson(res, 413, { ok: false, error: 'body too large' });
        return;
      }
      sendJson(res, 500, { ok: false, error: 'remote control failed' });
    }
  };
}

/** Vite plugin. Mounts on the dev server and on `vite preview`. */
export function remoteControlPlugin(options = {}) {
  const hub = options.hub ?? createRemoteHub(options);
  const middleware = createRemoteMiddleware({ ...options, hub });
  const install = (server) => {
    server.middlewares.use('/api/remote', middleware);
  };
  return {
    name: 'remote-control',
    configureServer: install,
    configurePreviewServer: install,
  };
}
