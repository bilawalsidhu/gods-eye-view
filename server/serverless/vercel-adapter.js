/**
 * Bridges Vercel's Node.js request object to the plain-Node `req` shape the
 * provider handlers in server/providers/** expect.
 *
 * Two gaps to close:
 *
 *  1. Path resolution. Vercel gives a dynamic catch-all function
 *     (`api/[...route].js`) the real `req.url` in the common case, but also
 *     decorates `req.query.route` with the matched path segments. We prefer
 *     `req.url` (it needs no reassembly and can't drop information a segment
 *     split would), and only fall back to `req.query.route` if `req.url`
 *     doesn't look like an API path.
 *
 *  2. Body re-materialisation. Vercel's Node runtime auto-parses JSON/text/
 *     urlencoded bodies into `req.body` and, in doing so, drains the
 *     underlying socket. The provider handlers read the body the "raw Node"
 *     way — `for await (const chunk of req)`
 *     (server/providers/common/request.js `readRequestBodyCapped`, used by
 *     the `/api/overpass` POST route) or `req.on('data'|'end', ...)`
 *     (`readRequestBody`, used by `/api/openai/hud-summary`) — so a request
 *     whose body Vercel already consumed would look empty to them.
 *     `rehydrateBody` replays the already-parsed body as a single chunk
 *     through both reading styles.
 */

const REHYDRATED = Symbol('gev.rehydrated');

/** Build the Buffer a parsed `req.body` should have produced on the wire. */
function bodyToBuffer(body) {
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  // Vercel gives already-parsed JSON as a plain object/array for a
  // `application/json` request. Re-serialising changes only insignificant
  // whitespace — every consumer of this body (readRequestBodyCapped /
  // readRequestBody) hands the raw bytes straight to JSON.parse.
  return Buffer.from(JSON.stringify(body ?? {}), 'utf8');
}

/**
 * Replay an already-parsed Vercel `req.body` through both the async-iterator
 * and the `.on('data'|'end')` request-reading styles used in this repo.
 *
 * No-op (returns `req` unchanged) when `req.body` is `undefined`/`null` —
 * the stream was never drained, so the normal Node reading path already
 * works.
 *
 * Limitation: the whole body is replayed as a SINGLE chunk/event. A consumer
 * that specifically depends on multi-chunk streaming (none in this repo —
 * see server/providers/common/request.js) would not be exercised the same
 * way a real socket would exercise it.
 *
 * @param {import('http').IncomingMessage & {body?: unknown}} req
 * @returns {import('http').IncomingMessage}
 */
function rehydrateBody(req) {
  if (req == null || req.body === undefined || req.body === null) return req;
  if (req[REHYDRATED]) return req;
  req[REHYDRATED] = true;

  const buffer = bodyToBuffer(req.body);

  // for await (const chunk of req)
  req[Symbol.asyncIterator] = function serverlessAsyncIterator() {
    let done = false;
    return {
      next() {
        if (done) return Promise.resolve({ value: undefined, done: true });
        done = true;
        return Promise.resolve({ value: buffer, done: false });
      },
      return(value) {
        done = true;
        return Promise.resolve({ value, done: true });
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  };

  // req.on('data'|'end'|'error', fn) / req.once(...) / req.removeListener(...)
  const listeners = { data: [], end: [], error: [] };
  let emitted = false;
  const emit = () => {
    if (emitted) return;
    emitted = true;
    for (const fn of listeners.data.slice()) fn(buffer);
    for (const fn of listeners.end.slice()) fn();
  };
  const originalOn = typeof req.on === 'function' ? req.on.bind(req) : null;
  const originalRemoveListener =
    typeof req.removeListener === 'function'
      ? req.removeListener.bind(req)
      : null;

  function on(event, fn) {
    if (event === 'data' || event === 'end' || event === 'error') {
      listeners[event].push(fn);
      // Registration for 'data'/'end' happens synchronously back-to-back in
      // every consumer in this repo (see readRequestBody); deferring the
      // emit to a microtask means both are always attached before it fires.
      if (event === 'data') queueMicrotask(emit);
      return req;
    }
    return originalOn ? originalOn(event, fn) : req;
  }

  req.on = on;
  req.once = on;
  req.addListener = on;
  req.removeListener = function removeListener(event, fn) {
    if (listeners[event]) {
      listeners[event] = listeners[event].filter(
        (registered) => registered !== fn,
      );
      return req;
    }
    return originalRemoveListener ? originalRemoveListener(event, fn) : req;
  };

  return req;
}

/**
 * Resolve the path `handle()` should route on: the real `req.url` when it
 * already looks like an API path, otherwise rebuilt from Vercel's
 * `req.query.route` catch-all segments plus the remaining query string.
 *
 * @param {import('http').IncomingMessage & {query?: Record<string, unknown>}} req
 * @returns {string}
 */
function resolveRequestUrl(req) {
  const url = typeof req.url === 'string' ? req.url : '';
  if (url.startsWith('/api/') || url === '/api') return url;

  const routeParam = req.query?.route;
  const segments = Array.isArray(routeParam)
    ? routeParam
    : typeof routeParam === 'string' && routeParam.length
      ? [routeParam]
      : [];
  const pathname = segments.length ? `/api/${segments.join('/')}` : '/api';

  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(req.query || {})) {
    if (key === 'route') continue;
    for (const entry of Array.isArray(value) ? value : [value]) {
      if (entry !== undefined) search.append(key, entry);
    }
  }
  const qs = search.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}

export { rehydrateBody, resolveRequestUrl };
